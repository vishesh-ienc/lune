#!/usr/bin/env node
/**
 * test-concurrent.js
 *
 * Question A: Can multiple Antigravity IDE instances run concurrently?
 *
 * Tests whether N independent Antigravity instances (each with a distinct
 * --user-data-dir) can be booted in parallel, each producing a working LSP
 * that responds to GetUserStatus independently without port collision or
 * session cross-contamination.
 *
 * Usage:
 *   node test-concurrent.js          # test 2 instances (default)
 *   node test-concurrent.js --n=3    # test 3 instances
 *   node test-concurrent.js 2>raw.txt
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP REQUIRED before running:
 *
 *   1. Close ALL Antigravity IDE instances.
 *
 *   2. Create at least 2 test profile directories that are COPIES of your
 *      real profile (so they're pre-authenticated). The script will create
 *      them as empty dirs if they don't exist, but empty dirs = no auth =
 *      OAuth window will appear.
 *
 *      Recommended: copy your real profile to TEST_PROFILES[0] / [1] first:
 *        xcopy /E /I "C:\Users\VISHESH\AppData\Roaming\Antigravity IDE" "C:\Users\VISHESH\AppData\Roaming\AntigravityTest0"
 *        xcopy /E /I "C:\Users\VISHESH\AppData\Roaming\Antigravity IDE" "C:\Users\VISHESH\AppData\Roaming\AntigravityTest1"
 *
 *   3. Run: node test-concurrent.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TESTS:
 *
 *   • Electron single-instance lock: does a second spawn with a *different*
 *     --user-data-dir succeed, or does the first instance reject it?
 *   • Port collision: do both LSPs bind different ports?
 *   • Session isolation: does each LSP return data from its OWN profile?
 *   • Resource overhead: RAM per instance (WorkingSetSize from Win32_Process)
 *   • Timing: does instance 2 boot slower than instance 1 (contention)?
 *   • Clean kill: can both process trees be killed independently?
 */

'use strict';

const { execSync, spawn } = require('child_process');
const https               = require('https');
const os                  = require('os');
const path                = require('path');
const fs                  = require('fs');

// ─── Configuration — edit these paths ─────────────────────────────────────────

const ANTIGRAVITY_EXE = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';

/**
 * One entry per instance to test.
 * Each must be a separate user-data-dir (ideally a copy of a real
 * authenticated profile — see SETUP REQUIRED above).
 */
const TEST_PROFILES = [
  'C:\\Users\\VISHESH\\AppData\\Roaming\\AntigravityTest0',
  'C:\\Users\\VISHESH\\AppData\\Roaming\\AntigravityTest1',
  'C:\\Users\\VISHESH\\AppData\\Roaming\\AntigravityTest2',  // only used with --n=3
];

const POLL_TIMEOUT_MS  = 90_000;   // 90 s per instance
const POLL_INTERVAL_MS = 500;
const LSP_WARMUP_MS    = 2_000;

// ─── Colours ──────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const R  = '\x1b[0m';
const BO = '\x1b[1m';
const CY = '\x1b[36m';
const GR = '\x1b[32m';
const YE = '\x1b[33m';
const RE = '\x1b[31m';
const DI = '\x1b[2m';
const MA = '\x1b[35m';
const BL = '\x1b[34m';

function c(col, txt) { return isTTY ? `${col}${txt}${R}` : txt; }
function ts()   { return new Date().toISOString().replace('T', ' ').slice(0, -1); }
function log(msg)  { console.log(`${c(DI, ts())}  ${msg}`); }
function ok(msg)   { console.log(`${c(DI, ts())}  ${c(GR, '✓')} ${msg}`); }
function warn(msg) { console.log(`${c(DI, ts())}  ${c(YE, '⚠')} ${msg}`); }
function fail(msg) { console.log(`${c(DI, ts())}  ${c(RE, '✖')} ${msg}`); }
function info(msg) { console.log(`${c(DI, ts())}  ${c(BL, '·')} ${msg}`); }
function sep(n=72) { console.log(c(DI, '─'.repeat(n))); }
function hdr(msg)  { console.log('\n' + c(BO, '══ ' + msg + ' ' + '═'.repeat(Math.max(0, 68 - msg.length)))); }

// ─── Process listing ──────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

/**
 * Returns all running processes with pid, name, commandLine, and workingSetKB.
 * WorkingSet gives per-process RAM (shared pages counted once per process,
 * so it overstates slightly but is good enough for ballpark comparison).
 */
function listProcesses() {
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,Name,CommandLine,WorkingSetSize',
    '| ConvertTo-Csv -NoTypeInformation',
  ].join(' ');

  const raw = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
    { encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 }
  );

  const lines   = raw.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim().toLowerCase());
  const idxPid  = headers.indexOf('processid');
  const idxName = headers.indexOf('name');
  const idxCmd  = headers.indexOf('commandline');
  const idxWS   = headers.indexOf('workingsetsize');

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxName, idxCmd)) continue;
    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();
    const wsRaw       = idxWS >= 0 ? (cols[idxWS] || '').replace(/"/g, '').trim() : '0';
    const workingSetKB = Math.round(parseInt(wsRaw || '0', 10) / 1024);
    if (!pid || !/^\d+$/.test(pid)) continue;
    entries.push({ pid, name, commandLine, workingSetKB });
  }
  return entries;
}

// ─── Detection — verbatim from detect.js / lifecycle-test.js ─────────────────

const ANTIGRAVITY_KEYWORDS = ['antigravity', 'antigravity-ide', 'antigravity.exe'];

const KNOWN_LSP_EXACT_NAMES = [
  'language_server_windows_x64.exe',
  'language_server_macos_arm64',
  'language_server_macos_x64',
  'language_server_linux_x64',
];

const NOISE_PROCESS_NAMES = new Set([
  'rg.exe', 'rg', 'fsevents-helper', 'fsevents_helper', 'esbuild.exe', 'esbuild',
  'node_modules/.bin/rg',
]);

const LANGUAGE_SERVER_HINTS = [
  'languageserver', 'language-server', 'lsp', 'server.js', 'server/main', 'remoteagent',
  '--type=extensionHost', 'extensionhost', '--ms-enable-electron-run-as-node',
  '--node-ipc', '--clientProcessId', 'serverWorkerMain', 'typingsInstaller',
];

function isAntigravityProcess(entry) {
  const hay = `${entry.name} ${entry.commandLine}`.toLowerCase();
  return ANTIGRAVITY_KEYWORDS.some(kw => hay.includes(kw));
}

function isLanguageServer(entry) {
  const nameLower = entry.name.toLowerCase();
  if (NOISE_PROCESS_NAMES.has(nameLower)) return false;
  if (KNOWN_LSP_EXACT_NAMES.includes(nameLower)) return true;
  const hay = `${entry.name} ${entry.commandLine}`.toLowerCase();
  return LANGUAGE_SERVER_HINTS.some(h => hay.includes(h.toLowerCase()));
}

/** True if this process belongs to a given profile dir */
function isProfileProcess(entry, userDataDir) {
  return entry.commandLine.toLowerCase().includes(userDataDir.toLowerCase());
}

/** True if process is an Antigravity LSP belonging to a specific profile */
function isProfileLSP(entry, userDataDir) {
  return isAntigravityProcess(entry) && isLanguageServer(entry);
  // Note: the LSP binary itself may NOT carry --user-data-dir in its cmdline
  // (it's spawned by the extension host, not the main Electron process).
  // We rely on the extension host being detected first to know the LSP is up.
  // See note in lifecycleRun in lifecycle-test.js.
}

// ─── Port/token extraction (verbatim from lifecycle-test.js) ──────────────────

function extractExtensionServerPort(commandLine) {
  const m = commandLine.match(/--extension[_-]server[_-]port[=\s]+(\d{4,5})/i);
  return m ? parseInt(m[1], 10) : null;
}

function getListeningPortsForPid(pid) {
  const pidStr = String(pid);
  let netstatOut = '';
  try {
    netstatOut = execSync(`netstat -ano | findstr ${pidStr}`, {
      encoding: 'utf8', windowsHide: true, shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    netstatOut = (err.stdout || '');
  }
  const ports = []; const seen = new Set();
  for (const line of netstatOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const state   = parts[parts.length - 2]?.toUpperCase();
    const linePid = parts[parts.length - 1];
    if (state !== 'LISTENING' || linePid !== pidStr) continue;
    const localAddr = parts[1] || '';
    const colonIdx  = localAddr.lastIndexOf(':');
    if (colonIdx === -1) continue;
    const portNum = parseInt(localAddr.slice(colonIdx + 1), 10);
    if (!portNum || seen.has(portNum)) continue;
    seen.add(portNum); ports.push(portNum);
  }
  return ports;
}

function extractPortAndToken(commandLine, userDataDir) {
  let port = null, token = null, source = 'cmdline';

  const PORT_PATTERNS = [
    /--api[_-]server[_-]port[=\s]+(\d{4,5})/i,
    /--manager[_-]port[=\s]+(\d{4,5})/i,
    /--lsp[_-]port[=\s]+(\d{4,5})/i,
    /--server[_-]port[=\s]+(\d{4,5})/i,
    /--port[=\s]+(\d{4,5})/i,
    /(?:port|server|listen)[=\s"]+(\d{4,5})\b/i,
  ];
  for (const re of PORT_PATTERNS) { const m = commandLine.match(re); if (m) { port = m[1]; break; } }

  const CSRF_PATTERNS = [
    /--csrf[_-]token[=\s]+([\w-]{20,})/i,
    /--csrf[=\s]+([\w-]{20,})/i,
    /"csrf[_-]?token"[:\s"]+([\w-]{20,})/i,
    /csrf[_-]?token[=\s]+([\w-]{20,})/i,
  ];
  for (const re of CSRF_PATTERNS) { const m = commandLine.match(re); if (m) { token = m[1]; break; } }

  // Fallback: scan LSP log directory for this profile
  if ((!port || !token) && userDataDir) {
    const logsDir = path.join(userDataDir, 'logs');
    try {
      if (fs.existsSync(logsDir)) {
        const allLogs = [];
        function walkLogs(dir) {
          try {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) walkLogs(full);
              else if (ent.isFile() && /\.(log|txt|json)$/i.test(ent.name)) {
                try { allLogs.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch (_) {}
              }
            }
          } catch (_) {}
        }
        walkLogs(logsDir);
        allLogs.sort((a, b) => b.mtime - a.mtime);
        for (const { path: lp } of allLogs.slice(0, 8)) {
          try {
            const content = fs.readFileSync(lp, 'utf8');
            if (!port) { const m = content.match(/(?:port|listening)[^\d]*(\d{4,5})/i); if (m) { port = m[1]; source = `log:${path.basename(lp)}`; } }
            if (!token) { const m = content.match(/csrf[_-]?token[^\w]+([\w-]{20,})/i); if (m) { token = m[1]; source = `log:${path.basename(lp)}`; } }
            if (port && token) break;
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return { port, token, source };
}

// ─── HTTP query ───────────────────────────────────────────────────────────────

function queryUserStatus(port, csrfToken) {
  return new Promise(resolve => {
    const bodyData = JSON.stringify({
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' },
    });
    const options = {
      hostname: '127.0.0.1', port: parseInt(port, 10),
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(bodyData),
      },
      rejectUnauthorized: false,
    };
    const t0 = Date.now();
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data, durationMs: Date.now() - t0 }));
    });
    req.on('error', err => resolve({ ok: false, error: err.message, durationMs: Date.now() - t0 }));
    req.setTimeout(15_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout (15 s)', durationMs: Date.now() - t0 }); });
    req.write(bodyData);
    req.end();
  });
}

// ─── Kill ─────────────────────────────────────────────────────────────────────

function killTree(pid) {
  try {
    const out = execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', windowsHide: true });
    return { ok: true, msg: out.trim() };
  } catch (err) {
    const gone = /not found|no running/i.test(err.message + (err.stderr || ''));
    return { ok: gone, msg: (err.stderr || err.message || '').trim() };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── RAM measurement ──────────────────────────────────────────────────────────

/**
 * Sum WorkingSetSize for all processes whose commandLine contains userDataDir
 * OR whose name matches Antigravity-related names that appeared after spawn.
 * We use userDataDir as the anchor because that's in the main Electron cmdline.
 */
function measureRamForProfile(userDataDir) {
  try {
    const all = listProcesses();
    // Profile processes: those whose cmdline mentions this user-data-dir
    const profileProcs = all.filter(e => isProfileProcess(e, userDataDir));
    const totalKB = profileProcs.reduce((sum, e) => sum + (e.workingSetKB || 0), 0);
    return { totalKB, processCount: profileProcs.length, processes: profileProcs.map(p => ({ pid: p.pid, name: p.name, workingSetKB: p.workingSetKB })) };
  } catch (_) {
    return { totalKB: 0, processCount: 0, processes: [] };
  }
}

// ─── Single-instance lock probe ───────────────────────────────────────────────

/**
 * Electron apps that use app.requestSingleInstanceLock() will refuse to
 * spawn a second instance with the SAME user-data-dir. With a DIFFERENT
 * --user-data-dir this lock is per-dir, so two instances should coexist.
 *
 * We check for the lock file Electron creates under the user-data-dir:
 *   <user-data-dir>\SingletonLock   (Windows: a symlink / empty file)
 *   <user-data-dir>\SingletonSocket
 *   <user-data-dir>\SingletonCookie
 *
 * If these files exist while the app is running, the app is using the lock.
 * If they exist but the PID they point to is NOT running, it's a stale lock
 * from a crash — Electron will steal it on next launch.
 */
function probeSingletonLock(userDataDir) {
  const files = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  const found = files.filter(f => {
    try { fs.statSync(path.join(userDataDir, f)); return true; } catch (_) { return false; }
  });
  return { lockFilesFound: found, hasSingletonLock: found.length > 0 };
}

// ─── Per-instance lifecycle ───────────────────────────────────────────────────

/**
 * Spawn one Antigravity instance, wait for its LSP, query it, return results.
 * Runs concurrently with other instances via Promise.all.
 *
 * @param {number} idx        0-based instance index
 * @param {string} profileDir absolute path to user-data-dir
 * @param {number} spawnDelayMs small stagger delay before spawning (ms)
 */
async function runInstance(idx, profileDir, spawnDelayMs) {
  const label = `[Instance ${idx}]`;
  const result = {
    idx,
    profileDir,
    spawnDelayMs,
    spawnMs: null,
    lspFoundMs: null,
    lspPid: null,
    port: null,
    token: null,
    portSource: null,
    queryOk: false,
    queryStatus: null,
    queryDurationMs: null,
    queryError: null,
    queryBody: null,
    ramKB: null,
    processCount: null,
    killOk: false,
    orphansFound: null,
    singletonLock: null,
    lockFilesFound: [],
    notes: [],
    error: null,
    mainPid: null,
  };

  // Ensure profile dir exists (empty dirs are fine — will trigger OAuth)
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}

  // ── Pre-spawn: check singleton lock file state ─────────────────────────────
  const lockBefore = probeSingletonLock(profileDir);
  result.lockFilesFound = lockBefore.lockFilesFound;
  log(`${label} SingletonLock files BEFORE spawn: [${lockBefore.lockFilesFound.join(', ') || 'none'}]`);

  // ── Stagger delay (so spawns aren't perfectly simultaneous) ───────────────
  if (spawnDelayMs > 0) {
    log(`${label} Staggering spawn by ${spawnDelayMs} ms…`);
    await sleep(spawnDelayMs);
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const spawnArgs = [
    `--user-data-dir=${profileDir}`,
    '--start-minimized',
    '--no-sandbox',
  ];
  log(`${label} Spawning: "${ANTIGRAVITY_EXE}" ${spawnArgs.join(' ')}`);
  process.stderr.write(`\n[SPAWN ${label}] "${ANTIGRAVITY_EXE}" ${spawnArgs.join(' ')}\n`);

  const t0 = Date.now();
  let child;
  try {
    child = spawn(`"${ANTIGRAVITY_EXE}"`, spawnArgs, {
      shell: true, detached: false, windowsHide: true, stdio: 'ignore',
    });
    result.mainPid = child.pid;
    result.spawnMs = Date.now() - t0;
    ok(`${label} Spawned  PID=${child.pid}  (${result.spawnMs} ms)`);
  } catch (err) {
    result.error = `Spawn failed: ${err.message}`;
    fail(`${label} ${result.error}`);
    return result;
  }

  child.on('exit', (code, sig) => {
    warn(`${label} Main process PID=${result.mainPid} exited early  code=${code}  sig=${sig}`);
    // If it exits immediately (< 5s), likely Electron single-instance lock rejection
    if ((Date.now() - t0) < 5000) {
      result.notes.push('process exited immediately — possible single-instance lock rejection');
    }
  });

  // Small pause after spawn so Electron has time to write the singleton lock
  await sleep(2000);
  const lockAfter = probeSingletonLock(profileDir);
  result.singletonLock = lockAfter.hasSingletonLock;
  log(`${label} SingletonLock files AFTER spawn: [${lockAfter.lockFilesFound.join(', ') || 'none'}]`);

  // ── Poll for LSP ──────────────────────────────────────────────────────────
  log(`${label} Polling for LSP (timeout ${POLL_TIMEOUT_MS / 1000} s)…`);
  const pollT0 = Date.now();
  let lspEntry = null;

  while (true) {
    const elapsed = Date.now() - pollT0;
    if (elapsed > POLL_TIMEOUT_MS) {
      fail(`${label} LSP not found within ${POLL_TIMEOUT_MS / 1000} s.`);
      result.notes.push('LSP timeout');
      break;
    }
    try {
      const snap = listProcesses();
      // Primary: look for the known LSP binary name among ALL processes
      // (LSP process may not carry --user-data-dir in its cmdline)
      lspEntry = snap.find(e => isLanguageServer(e) && isAntigravityProcess(e));
      if (lspEntry) {
        // Disambiguate when multiple instances are running: prefer the one
        // whose parent-chain leads back to our mainPid if possible.
        // Since we can't do parent-chain easily here, rely on the fact that
        // we'll detect BOTH and de-duplicate after all polling finishes.
        // For now just take the first match — note any ambiguity.
      }
    } catch (err) {
      warn(`${label} Poll scan error: ${err.message}`);
    }
    if (lspEntry) break;
    await sleep(POLL_INTERVAL_MS);
  }

  result.lspFoundMs = Date.now() - pollT0;
  result.lspPid     = lspEntry?.pid ?? null;

  if (lspEntry) {
    ok(`${label} LSP found in ${result.lspFoundMs} ms  PID=${lspEntry.pid}  ${lspEntry.name}`);
    process.stderr.write(`\n[LSP ${label} pid=${lspEntry.pid}]\n${lspEntry.commandLine}\n`);
  } else {
    result.notes.push('no LSP detected');
    // Still try to measure RAM and kill
  }

  // ── Measure RAM now (while everything is running) ─────────────────────────
  const ram = measureRamForProfile(profileDir);
  result.ramKB         = ram.totalKB;
  result.processCount  = ram.processCount;
  log(`${label} RAM (WorkingSet): ${(ram.totalKB / 1024).toFixed(0)} MB  (${ram.processCount} profile processes)`);

  // ── Extract port + token ──────────────────────────────────────────────────
  if (lspEntry) {
    await sleep(LSP_WARMUP_MS);

    // First try cmdline / log fallback
    const extracted = extractPortAndToken(lspEntry.commandLine, profileDir);
    result.token     = extracted.token;
    result.portSource = extracted.source;

    // Then probe netstat for LISTENING ports on the LSP PID
    const listeningPorts = getListeningPortsForPid(lspEntry.pid);
    log(`${label} Listening ports for PID ${lspEntry.pid}: [${listeningPorts.join(', ') || 'none'}]`);

    if (listeningPorts.length > 0) {
      result.port = String(listeningPorts[0]);
      result.portSource = 'netstat';
    } else if (extracted.port) {
      result.port = extracted.port;
    }

    if (!result.token && extracted.token) result.token = extracted.token;

    if (result.port && result.token) {
      ok(`${label} Port=${result.port}  Token=${result.token.slice(0, 8)}…  (source: ${result.portSource})`);
    } else {
      warn(`${label} Could not extract port/token  (port=${result.port ?? 'null'}, token=${result.token ? 'found' : 'null'})`);
      result.notes.push('port/token not extracted');
    }
  }

  // ── Query GetUserStatus ───────────────────────────────────────────────────
  if (result.port && result.token) {
    // Also try extension_server_port+1 pattern
    const extPort   = lspEntry ? extractExtensionServerPort(lspEntry.commandLine) : null;
    const queryPort = extPort !== null ? extPort + 1 : parseInt(result.port, 10);

    if (extPort !== null) info(`${label} extension_server_port=${extPort} → queryPort=${queryPort}`);

    log(`${label} Querying GetUserStatus on port ${queryPort}…`);
    const q = await queryUserStatus(queryPort, result.token);
    result.queryOk         = q.ok;
    result.queryDurationMs = q.durationMs;

    if (q.ok) {
      result.queryStatus = q.status;
      result.queryBody   = q.body ? q.body.slice(0, 800) : '';
      ok(`${label} HTTP ${q.status}  (${q.durationMs} ms)`);
      if (result.queryBody) console.log(c(DI, `  ${result.queryBody.slice(0, 300)}`));
    } else {
      result.queryError = q.error;
      fail(`${label} Query failed: ${q.error}  (${q.durationMs} ms)`);
    }
  } else {
    result.notes.push('query skipped (no port/token)');
  }

  return result;
}

// ─── Kill all instances ───────────────────────────────────────────────────────

async function killAndCheckOrphans(results) {
  hdr('KILLING ALL INSTANCES');

  for (const r of results) {
    if (r.mainPid) {
      log(`[Instance ${r.idx}] Killing PID=${r.mainPid} tree…`);
      const kr = killTree(r.mainPid);
      r.killOk = kr.ok;
      if (kr.ok) ok(`[Instance ${r.idx}] Kill succeeded`);
      else        fail(`[Instance ${r.idx}] Kill failed: ${kr.msg}`);
    } else {
      warn(`[Instance ${r.idx}] No mainPid recorded — skipping kill`);
    }
    await sleep(500);
  }

  log('Waiting 3 s for process trees to collapse…');
  await sleep(3000);

  // Orphan check per profile
  for (const r of results) {
    try {
      const orphans = listProcesses().filter(e => isProfileProcess(e, r.profileDir));
      r.orphansFound = orphans.length;
      if (orphans.length === 0) {
        ok(`[Instance ${r.idx}] No orphans — clean shutdown`);
      } else {
        warn(`[Instance ${r.idx}] ${orphans.length} orphan(s):`);
        orphans.forEach(p => {
          warn(`    PID ${p.pid}  ${p.name}`);
          const k = killTree(p.pid);
          log(`    → kill ${k.ok ? 'OK' : 'FAILED: ' + k.msg}`);
        });
      }
    } catch (err) {
      warn(`[Instance ${r.idx}] Orphan scan error: ${err.message}`);
      r.orphansFound = -1;
    }
  }
}

// ─── Port collision check ─────────────────────────────────────────────────────

function checkPortCollisions(results) {
  const portsFound = results.filter(r => r.port).map(r => r.port);
  const portSet    = new Set(portsFound);
  const collision  = portSet.size < portsFound.length;
  return { portsFound, collision, uniquePorts: [...portSet] };
}

// ─── Session isolation check ──────────────────────────────────────────────────

/**
 * Very basic check: if two instances both return HTTP 200 with non-empty
 * bodies, compare a snippet of each to see if they're identical (which
 * would suggest session cross-contamination) or different (isolated).
 */
function checkSessionIsolation(results) {
  const succeeded = results.filter(r => r.queryOk && r.queryBody);
  if (succeeded.length < 2) return { checkable: false, reason: 'fewer than 2 successful queries' };
  const bodies = succeeded.map(r => r.queryBody.slice(0, 200).trim());
  const allSame = bodies.every(b => b === bodies[0]);
  return { checkable: true, allSame, bodies };
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummaryTable(results) {
  hdr('SUMMARY TABLE');
  const COLS = [
    { h: 'Inst',       w: 5  },
    { h: 'SpawnMs',    w: 8  },
    { h: 'LSP ms',     w: 8  },
    { h: 'Port',       w: 7  },
    { h: 'QueryOK',    w: 9  },
    { h: 'Qry ms',     w: 7  },
    { h: 'RAM MB',     w: 7  },
    { h: 'Procs',      w: 6  },
    { h: 'Kill',       w: 5  },
    { h: 'Orphans',    w: 8  },
    { h: 'Notes',      w: 40 },
  ];
  const row = cells => cells.map((v, i) => String(v ?? '—').padEnd(COLS[i].w)).join('  ');
  console.log(c(CY, row(COLS.map(col => col.h))));
  console.log(c(DI, COLS.map(col => '─'.repeat(col.w)).join('  ')));

  for (const r of results) {
    const ramMB = r.ramKB !== null ? (r.ramKB / 1024).toFixed(0) : '—';
    const cells = [
      r.idx,
      r.spawnMs ?? '—',
      r.lspFoundMs ?? '—',
      r.port ?? '—',
      r.queryOk ? `${r.queryStatus}` : (r.queryError?.slice(0, 8) ?? '—'),
      r.queryDurationMs ?? '—',
      ramMB,
      r.processCount ?? '—',
      r.killOk ? 'yes' : 'no',
      r.orphansFound === null ? '—' : r.orphansFound === -1 ? 'err' : String(r.orphansFound),
      (r.notes.join('; ') || '—').slice(0, 40),
    ];
    const allGood = r.queryOk && r.killOk && r.orphansFound === 0;
    console.log(allGood ? c(GR, row(cells)) : c(YE, row(cells)));
  }
  console.log(c(DI, COLS.map(col => '─'.repeat(col.w)).join('  ')));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const nArg = process.argv.find(a => a.startsWith('--n='));
  const N    = nArg ? Math.min(parseInt(nArg.slice(4), 10), TEST_PROFILES.length) : 2;
  const profiles = TEST_PROFILES.slice(0, N);

  console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
  console.log(c(BO, `║  test-concurrent.js — Question A: ${N} Concurrent Instances` + ' '.repeat(Math.max(0, 70 - 36 - String(N).length)) + '║'));
  console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
  console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
  console.log(c(DI, `  Instances     : ${N}`));
  console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
  profiles.forEach((p, i) => console.log(c(DI, `  Profile[${i}]    : ${p}`)));
  console.log('');

  // ── Pre-flight: ensure NO existing Antigravity processes ──────────────────
  hdr('PRE-FLIGHT');
  const existingAll = listProcesses().filter(isAntigravityProcess);
  if (existingAll.length > 0) {
    fail(`Found ${existingAll.length} existing Antigravity process(es) — please close all instances first.`);
    existingAll.forEach(p => fail(`  PID ${p.pid}  ${p.name}`));
    warn('Proceeding anyway — timings and isolation checks may be unreliable.');
  } else {
    ok('No existing Antigravity processes.');
  }

  // ── Ensure test profile dirs exist ────────────────────────────────────────
  for (const p of profiles) {
    try { fs.mkdirSync(p, { recursive: true }); ok(`Profile dir ready: ${p}`); }
    catch (e) { warn(`Could not create ${p}: ${e.message}`); }
    const lock = probeSingletonLock(p);
    if (lock.hasSingletonLock) {
      warn(`Stale SingletonLock files in ${p}: [${lock.lockFilesFound.join(', ')}]`);
      warn('  These may be left from a crashed session. They should be cleared automatically on first launch.');
    }
  }

  // ── Spawn all instances concurrently ──────────────────────────────────────
  hdr(`SPAWNING ${N} INSTANCES CONCURRENTLY`);
  log('Launching all instances within a ~1 s window (100 ms stagger each)…');

  const instancePromises = profiles.map((profileDir, idx) =>
    runInstance(idx, profileDir, idx * 100)   // 100 ms stagger
  );

  // Wait for all instances to finish their lifecycle (poll → query)
  const results = await Promise.all(instancePromises);

  // ── Kill all instances ────────────────────────────────────────────────────
  await killAndCheckOrphans(results);

  // ── Analysis ──────────────────────────────────────────────────────────────
  hdr('ANALYSIS');

  // Port collision
  const portCheck = checkPortCollisions(results);
  if (portCheck.portsFound.length === 0) {
    warn('No ports were extracted — cannot check for collision.');
  } else if (portCheck.collision) {
    fail(`PORT COLLISION DETECTED: multiple instances bound to same port(s)!`);
    fail(`  Ports found: ${portCheck.portsFound.join(', ')}`);
  } else {
    ok(`No port collision. Each instance got a unique port: ${portCheck.uniquePorts.join(', ')}`);
  }

  // Session isolation
  const isoCheck = checkSessionIsolation(results);
  if (!isoCheck.checkable) {
    warn(`Session isolation: not checkable — ${isoCheck.reason}`);
  } else if (isoCheck.allSame) {
    fail('SESSION ISOLATION FAILURE: both instances returned identical response bodies!');
    fail('  This may indicate port collision / session cross-contamination.');
  } else {
    ok('Session isolation OK: instances returned different response bodies.');
  }

  // Singleton lock verdict
  const lockedInstances = results.filter(r => r.singletonLock);
  info(`SingletonLock detected in: ${lockedInstances.map(r => `Instance ${r.idx}`).join(', ') || 'none'}`);
  const allGotLSP = results.every(r => r.lspPid !== null);
  if (allGotLSP) {
    ok('All instances spawned an LSP — Electron single-instance lock is NOT blocking multi-profile launches.');
  } else {
    const failed = results.filter(r => r.lspPid === null);
    warn(`${failed.length} instance(s) did NOT produce an LSP. Possible single-instance lock rejection:`);
    failed.forEach(r => warn(`  Instance ${r.idx}  notes: ${r.notes.join('; ')}`));
  }

  // RAM summary
  const totalRamKB = results.reduce((s, r) => s + (r.ramKB || 0), 0);
  const validRam   = results.filter(r => r.ramKB !== null && r.ramKB > 0);
  if (validRam.length > 0) {
    info(`Total RAM across ${N} instances: ${(totalRamKB / 1024).toFixed(0)} MB`);
    info(`Average RAM per instance: ${(totalRamKB / validRam.length / 1024).toFixed(0)} MB`);
  }

  // Timing: did instance 1 boot slower due to contention?
  const timings = results.filter(r => r.lspFoundMs !== null);
  if (timings.length >= 2) {
    info('Time-to-LSP per instance:');
    timings.forEach(r => info(`  Instance ${r.idx}: ${r.lspFoundMs} ms`));
    const times = timings.map(r => r.lspFoundMs);
    const spread = Math.max(...times) - Math.min(...times);
    info(`  Spread (max-min): ${spread} ms`);
    if (spread > 15_000) warn('High spread — later instances booted significantly slower (resource contention).');
    else ok('Spread is acceptable — parallel boot overhead is modest.');
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  printSummaryTable(results);

  // ── Verdict ───────────────────────────────────────────────────────────────
  hdr('VERDICT');
  const allSucceeded = results.every(r => r.queryOk && r.killOk && r.orphansFound === 0 && r.lspPid !== null);
  const noneQueryOk  = results.every(r => !r.queryOk);

  if (allSucceeded && !portCheck.collision && isoCheck.checkable && !isoCheck.allSame) {
    ok(c(GR, `✅ ${N} concurrent instances: SAFE. Parallel up to ${N} confirmed.`));
    ok(`   Record this in FINDINGS.md: max_safe_concurrent >= ${N}`);
  } else if (allGotLSP && !portCheck.collision) {
    warn(`⚠  LSP booted for all ${N} instances without port collision, but query success was partial.`);
    warn(`   Parallel boot appears viable; check individual query errors above.`);
  } else {
    fail(`❌ ${N} concurrent instances: issues detected. Sequential-only or lower concurrency recommended.`);
    fail(`   Check ANALYSIS section above for specific failure modes.`);
  }

  console.log('');
  console.log(c(DI, 'Run with --n=3 to test a third instance if 2 succeeded.'));
  console.log(c(DI, 'Capture full output: node test-concurrent.js 2>concurrent-raw.txt'));
  console.log('');
}

main().catch(err => {
  console.error(c(RE, `\nFatal: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
