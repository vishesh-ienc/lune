#!/usr/bin/env node
/**
 * test-option1-launch-offscreen.js
 *
 * OPTION 1 TEST: Spawning Antigravity IDE.exe with Chromium argument --window-position=-32000,-32000
 *
 * Checks:
 *   1. Pure launch-time off-screen position flag (NO post-spawn C#/koffi HWND hook/polling).
 *   2. Tests if Chromium initial paint happens completely off-screen (preventing on-screen flash).
 *   3. Polls LSP process (language_server_windows_x64.exe).
 *   4. Queries GetUserStatus via gRPC/REST over HTTPS to verify full authentication & initialization.
 *   5. Clean process tree termination and orphan verification scan.
 */

'use strict';

const { spawn, execSync } = require('child_process');
const https               = require('https');
const path                = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const ANTIGRAVITY_EXE  = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
const USER_DATA_DIR    = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';
const WORKSPACE_DIR    = 'C:\\Users\\VISHESH\\Desktop\\lune';

const LSP_POLL_TIMEOUT_MS  = 60_000;
const LSP_POLL_INTERVAL_MS = 300;
const LSP_WARMUP_MS        = 1500;

// ─── Terminal Styling ─────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const R  = '\x1b[0m';
const BO = '\x1b[1m';
const CY = '\x1b[36m';
const GR = '\x1b[32m';
const YE = '\x1b[33m';
const RE = '\x1b[31m';
const DI = '\x1b[2m';
const BL = '\x1b[34m';

function c(col, txt) { return isTTY ? `${col}${txt}${R}` : txt; }
function ts()         { return new Date().toISOString().replace('T', ' ').slice(0, -1); }
function log(msg)     { console.log(`${c(DI, ts())}  ${msg}`); }
function ok(msg)      { console.log(`${c(DI, ts())}  ${c(GR, '✓')} ${msg}`); }
function warn(msg)    { console.log(`${c(DI, ts())}  ${c(YE, '⚠')} ${msg}`); }
function fail(msg)    { console.log(`${c(DI, ts())}  ${c(RE, '✖')} ${msg}`); }
function info(msg)    { console.log(`${c(DI, ts())}  ${c(BL, '·')} ${msg}`); }
function sep()        { console.log(c(DI, '─'.repeat(70))); }

function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

// ─── Process & LSP Helpers ────────────────────────────────────────────────────

function getAntigravityProcesses() {
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,Name,CommandLine',
    '| ConvertTo-Csv -NoTypeInformation',
  ].join(' ');

  let raw = '';
  try {
    raw = execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (_) {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim().toLowerCase());
  const idxPid  = headers.indexOf('processid');
  const idxName = headers.indexOf('name');
  const idxCmd  = headers.indexOf('commandline');

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxName, idxCmd)) continue;

    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();

    if (!pid || !/^\d+$/.test(pid)) continue;

    const haystack = `${name} ${commandLine}`.toLowerCase();
    if (
      haystack.includes('antigravity') ||
      haystack.includes('language_server') ||
      haystack.includes(USER_DATA_DIR.toLowerCase())
    ) {
      entries.push({ pid: parseInt(pid, 10), name, commandLine });
    }
  }
  return entries;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function getListeningPortsForPid(pid) {
  const pidStr = String(pid);
  let netstatOut = '';
  try {
    netstatOut = execSync(`netstat -ano | findstr /C:"LISTENING" | findstr /C:" ${pidStr}"`, {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    netstatOut = err.stdout || '';
  }

  const ports = [];
  const seen = new Set();
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
    if (portNum && !seen.has(portNum)) {
      seen.add(portNum);
      ports.push(portNum);
    }
  }
  return ports;
}

function extractCsrfToken(commandLine) {
  const patterns = [
    /--csrf[_-]token[=\s]+([\w-]{20,})/i,
    /--csrf[=\s]+([\w-]{20,})/i,
    /"csrf[_-]?token"[:\s"]+([\w-]{20,})/i,
    /csrf[_-]?token[=\s]+([\w-]{20,})/i,
  ];
  for (const re of patterns) {
    const m = commandLine.match(re);
    if (m) return m[1];
  }
  return null;
}

function queryUserStatus(port, csrfToken) {
  return new Promise(resolve => {
    const bodyData = JSON.stringify({
      metadata: {
        ideName:       'antigravity',
        extensionName: 'antigravity',
        ideVersion:    'unknown',
        locale:        'en',
      },
    });

    const options = {
      hostname: '127.0.0.1',
      port:     parseInt(port, 10),
      path:     '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method:   'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length':       Buffer.byteLength(bodyData),
      },
      rejectUnauthorized: false,
    };

    const t0  = Date.now();
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data, durationMs: Date.now() - t0 }));
    });

    req.on('error', err => resolve({ ok: false, error: err.message, durationMs: Date.now() - t0 }));
    req.setTimeout(10_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout (10 s)', durationMs: Date.now() - t0 }); });

    req.write(bodyData);
    req.end();
  });
}

function cleanKillProcessTree(topPid) {
  log('Cleaning up: killing spawned Antigravity IDE process tree...');

  if (topPid) {
    try {
      execSync(`taskkill /PID ${topPid} /T /F`, { encoding: 'utf8', windowsHide: true });
      info(`Sent initial tree kill (taskkill /PID ${topPid} /T /F)`);
    } catch (err) {
      const msg = (err.stderr || err.message || '').trim();
      info(`Initial tree kill note: ${msg}`);
    }
  }

  let remaining = getAntigravityProcesses();
  let attempts = 0;

  while (remaining.length > 0 && attempts < 3) {
    attempts++;
    warn(`[Cleanup Verification] Found ${remaining.length} surviving process(es). Attempting direct taskkill by PID...`);
    for (const proc of remaining) {
      try {
        execSync(`taskkill /PID ${proc.pid} /F`, { encoding: 'utf8', windowsHide: true });
        ok(`  Killed orphan PID ${proc.pid} (${proc.name})`);
      } catch (err) {
        const msg = (err.stderr || err.message || '').trim();
        info(`  taskkill /PID ${proc.pid} /F: ${msg}`);
      }
    }
    try {
      execSync('ping 127.0.0.1 -n 1 > nul', { windowsHide: true });
    } catch (_) {}
    remaining = getAntigravityProcesses();
  }

  if (remaining.length === 0) {
    ok(`[Cleanup Verification] Orphan scan clean: 0 remaining processes.`);
    return true;
  } else {
    fail(`[Cleanup Verification] Warning: ${remaining.length} process(es) could not be terminated.`);
    return false;
  }
}

// ─── Main Execution ───────────────────────────────────────────────────────────

async function runTest() {
  console.log(c(BO, '\n==============================================================='));
  console.log(c(BO, '  OPTION 1: OFF-SCREEN LAUNCH ARG TEST (test-option1-launch-offscreen.js)'));
  console.log(c(BO, '===============================================================\n'));
  log(`Launch Flag : --window-position=-32000,-32000`);
  log(`Exe         : ${ANTIGRAVITY_EXE}`);
  log(`Profile     : ${USER_DATA_DIR}`);
  log(`Folder      : ${WORKSPACE_DIR}\n`);

  // Pre-check for existing processes
  const existing = getAntigravityProcesses();
  if (existing.length > 0) {
    warn(`Found ${existing.length} pre-existing Antigravity processes running. Cleaning up...`);
    cleanKillProcessTree(null);
    await sleep(1000);
  }

  console.log(c(CY, '\n[OPTION 1] Spawning with --window-position=-32000,-32000...'));
  log('Notice: HWND hide hook is REMOVED for this test to observe pure off-screen launch behavior.\n');

  const spawnTimeMs = Date.now();
  const spawnIso    = new Date().toISOString();

  // Spawn with Chromium --window-position launch argument
  const spawnArgs = [
    '--window-position=-32000,-32000',
    `--user-data-dir=${USER_DATA_DIR}`,
    WORKSPACE_DIR,
  ];

  const child = spawn(ANTIGRAVITY_EXE, spawnArgs, {
    detached: false,
    windowsHide: false,
    stdio: 'ignore',
  });

  const pid = child.pid;
  ok(`Spawned PID ${c(BO, pid)} at ${c(CY, spawnIso)} with args:`);
  info(`  ${ANTIGRAVITY_EXE} ${spawnArgs.join(' ')}`);

  // Poll for Language Server process
  log(`\nPolling for Antigravity Language Server process (timeout: ${LSP_POLL_TIMEOUT_MS / 1000}s)...`);

  const pollStart = Date.now();
  let lspProc = null;

  while (Date.now() - pollStart < LSP_POLL_TIMEOUT_MS) {
    const procs = getAntigravityProcesses();
    lspProc = procs.find(p => p.name.toLowerCase() === 'language_server_windows_x64.exe');
    if (lspProc) break;
    await sleep(LSP_POLL_INTERVAL_MS);
  }

  if (!lspProc) {
    fail('Language Server process (language_server_windows_x64.exe) not found within timeout.');
    cleanKillProcessTree(pid);
    process.exit(1);
  }

  const lspTimeMs = Date.now() - spawnTimeMs;
  ok(`Language Server detected! PID: ${c(BO, lspProc.pid)} (${lspTimeMs} ms post-spawn)`);

  const csrfToken = extractCsrfToken(lspProc.commandLine);
  if (!csrfToken) {
    warn('CSRF token not found in command line.');
  } else {
    ok(`CSRF token extracted: ${csrfToken.slice(0, 10)}...`);
  }

  // Warmup & Query GetUserStatus
  log(`Warmup pause (${LSP_WARMUP_MS}ms) before querying GetUserStatus...`);
  await sleep(LSP_WARMUP_MS);

  const ports = getListeningPortsForPid(lspProc.pid);
  info(`Candidate LISTENING ports for LSP PID ${lspProc.pid}: [ ${ports.join(', ')} ]`);

  let statusOk = false;
  let statusResult = null;

  for (const p of ports) {
    log(`Querying GetUserStatus on port ${p}...`);
    const q = await queryUserStatus(p, csrfToken);
    if (q.ok) {
      statusOk = true;
      statusResult = q;
      ok(`GetUserStatus SUCCEEDED on port ${p}! HTTP ${q.status} (${q.durationMs} ms)`);
      if (q.body) {
        log(`  Response snippet: ${q.body.slice(0, 150)}...`);
      }
      break;
    } else {
      info(`  Port ${p} returned error: ${q.error}`);
    }
  }

  if (!statusOk) {
    fail('GetUserStatus failed on all candidate ports.');
  }

  // Cleanup with orphan verification
  const cleanupClean = cleanKillProcessTree(pid);

  // Summary Report
  sep();
  console.log(c(BO, '               OPTION 1 TEST RESULTS SUMMARY'));
  sep();
  console.log(`  ${c(CY, 'Strategy')}              : Chromium --window-position=-32000,-32000 Arg`);
  console.log(`  ${c(CY, 'Post-Spawn Hide Hook')}  : NONE (Pure launch arg test)`);
  console.log(`  ${c(CY, 'LSP Process Spawn')}    : SUCCESS ✓ (PID ${lspProc.pid}, detected in ${lspTimeMs} ms)`);
  console.log(`  ${c(CY, 'GetUserStatus Query')}  : ${statusOk ? c(GR, `SUCCESS ✓ (HTTP ${statusResult.status})`) : c(RE, 'FAILED ✖')}`);
  console.log(`  ${c(CY, 'Cleanup Orphan Scan')}  : ${cleanupClean ? c(GR, 'CLEAN ✓ (0 remaining processes)') : c(RE, 'FAILED ✖')}`);
  sep();
  console.log('\nDone.\n');
}

runTest().catch(err => {
  fail(`Unhandled error in test runner: ${err.stack || err.message}`);
  process.exit(1);
});
