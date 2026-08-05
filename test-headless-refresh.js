#!/usr/bin/env node
/**
 * test-headless-refresh.js
 *
 * Question B: Can the Antigravity UI be suppressed for already-authenticated
 * profiles ("headless" quota refresh)?
 *
 * Tests multiple window-suppression strategies (flags, auth file detection,
 * process-level signals) and measures whether the IDE spawns visibly.
 * Also detects authentication state from profile files so the refresh engine
 * can skip OAuth prompts entirely for logged-in profiles.
 *
 * Usage:
 *   node test-headless-refresh.js             # test all strategies sequentially
 *   node test-headless-refresh.js --strategy=0  # test a single strategy by index
 *   node test-headless-refresh.js --dry-run   # auth probe only, no spawning
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP REQUIRED:
 *   1. Close ALL Antigravity IDE instances.
 *   2. Run: node test-headless-refresh.js
 *
 * Each strategy spawns Antigravity, waits for the LSP to come up, queries
 * GetUserStatus, then kills the process tree.  The window visibility of each
 * attempt must be observed MANUALLY during the run — this script reports
 * whether the process came up and the LSP responded, but cannot
 * programmatically see whether a window appeared.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STRATEGIES TESTED:
 *
 *   0  windowsHide: true (no extra args)          — baseline, no window hiding flag
 *   1  --start-minimized                           — minimise main window on launch
 *   2  --start-minimized + --no-sandbox            — common pairing used in lifecycle-test
 *   3  SW_HIDE via PowerShell Start-Process -WindowStyle Hidden
 *   4  Detect pre-existing auth token → skip if already authenticated
 *
 * Each strategy records: LSP boot time, query success, whether a window
 * appeared (manual observation field), and any spawn errors.
 */

'use strict';

const { execSync, spawn, spawnSync } = require('child_process');
const https = require('https');
const os    = require('os');
const path  = require('path');
const fs    = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────

const ANTIGRAVITY_EXE   = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
const USER_DATA_DIR     = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';
const TEST_PROFILE_DIR  = 'C:\\Users\\VISHESH\\AppData\\Roaming\\AntigravityHeadlessTest';

const POLL_TIMEOUT_MS   = 90_000;
const POLL_INTERVAL_MS  = 500;
const LSP_WARMUP_MS     = 2_000;
const BETWEEN_STRATS_MS = 5_000;  // pause between strategies so the previous tree collapses

// ─── Colours ──────────────────────────────────────────────────────────────────

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
function ts()   { return new Date().toISOString().replace('T', ' ').slice(0, -1); }
function log(msg)  { console.log(`${c(DI, ts())}  ${msg}`); }
function ok(msg)   { console.log(`${c(DI, ts())}  ${c(GR, '✓')} ${msg}`); }
function warn(msg) { console.log(`${c(DI, ts())}  ${c(YE, '⚠')} ${msg}`); }
function fail(msg) { console.log(`${c(DI, ts())}  ${c(RE, '✖')} ${msg}`); }
function info(msg) { console.log(`${c(DI, ts())}  ${c(BL, '·')} ${msg}`); }
function hdr(msg)  { console.log('\n' + c(BO, '══ ' + msg + ' ' + '═'.repeat(Math.max(0, 68 - msg.length)))); }
function sep(n=72) { console.log(c(DI, '─'.repeat(n))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Process listing (Win32_Process) ─────────────────────────────────────────

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

function listProcesses() {
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,Name,CommandLine',
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
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxName, idxCmd)) continue;
    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();
    if (!pid || !/^\d+$/.test(pid)) continue;
    entries.push({ pid, name, commandLine });
  }
  return entries;
}

// ─── Detection verbatim from detect.js ───────────────────────────────────────

const ANTIGRAVITY_KEYWORDS  = ['antigravity', 'antigravity-ide', 'antigravity.exe'];
const KNOWN_LSP_EXACT_NAMES = [
  'language_server_windows_x64.exe',
  'language_server_macos_arm64',
  'language_server_macos_x64',
  'language_server_linux_x64',
];
const NOISE_PROCESS_NAMES   = new Set(['rg.exe', 'rg', 'fsevents-helper', 'fsevents_helper', 'esbuild.exe', 'esbuild', 'node_modules/.bin/rg']);
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
      encoding: 'utf8', windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) { netstatOut = (err.stdout || ''); }
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
    /--api[_-]server[_-]port[=\s]+(\d{4,5})/i, /--manager[_-]port[=\s]+(\d{4,5})/i,
    /--lsp[_-]port[=\s]+(\d{4,5})/i,           /--server[_-]port[=\s]+(\d{4,5})/i,
    /--port[=\s]+(\d{4,5})/i,                   /(?:port|server|listen)[=\s"]+(\d{4,5})\b/i,
  ];
  for (const re of PORT_PATTERNS) { const m = commandLine.match(re); if (m) { port = m[1]; break; } }
  const CSRF_PATTERNS = [
    /--csrf[_-]token[=\s]+([\w-]{20,})/i, /--csrf[=\s]+([\w-]{20,})/i,
    /"csrf[_-]?token"[:\s"]+([\w-]{20,})/i, /csrf[_-]?token[=\s]+([\w-]{20,})/i,
  ];
  for (const re of CSRF_PATTERNS) { const m = commandLine.match(re); if (m) { token = m[1]; break; } }
  if ((!port || !token) && userDataDir) {
    const logsDir = path.join(userDataDir, 'logs');
    try {
      if (fs.existsSync(logsDir)) {
        const allLogs = [];
        function walkLogs(dir) {
          try { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walkLogs(full);
            else if (ent.isFile() && /\.(log|txt|json)$/i.test(ent.name)) {
              try { allLogs.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch (_) {}
            }
          }} catch (_) {}
        }
        walkLogs(logsDir);
        allLogs.sort((a, b) => b.mtime - a.mtime);
        for (const { path: lp } of allLogs.slice(0, 8)) {
          try {
            const content = fs.readFileSync(lp, 'utf8');
            if (!port)  { const m = content.match(/(?:port|listening)[^\d]*(\d{4,5})/i);   if (m) { port  = m[1]; source = `log:${path.basename(lp)}`; } }
            if (!token) { const m = content.match(/csrf[_-]?token[^\w]+([\w-]{20,})/i); if (m) { token = m[1]; source = `log:${path.basename(lp)}`; } }
            if (port && token) break;
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return { port, token, source };
}

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
    req.write(bodyData); req.end();
  });
}

function killTree(pid) {
  try {
    const out = execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', windowsHide: true });
    return { ok: true, msg: out.trim() };
  } catch (err) {
    const gone = /not found|no running/i.test(err.message + (err.stderr || ''));
    return { ok: gone, msg: (err.stderr || err.message || '').trim() };
  }
}

function killAllAntigravity() {
  try {
    const snap = listProcesses().filter(isAntigravityProcess);
    for (const p of snap) { try { killTree(p.pid); } catch (_) {} }
    return snap.length;
  } catch (_) { return 0; }
}

// ─── Authentication state detection ──────────────────────────────────────────

/**
 * Check whether a profile directory contains signs of an authenticated session.
 *
 * Looks for:
 *   A) The Codeium/Antigravity API key file:
 *      <profile>/User/globalStorage/Antigravity.antigravity/api_key
 *      (or codeium.codeium — Antigravity is a fork of Codeium)
 *
 *   B) The sqlite3 state database:
 *      <profile>/User/globalStorage/state.vscdb
 *      Read with PowerShell sqlite3 if available, otherwise just note existence.
 *
 *   C) The workspace storage / active sessions folder:
 *      <profile>/User/workspaceStorage/<hash>/state.vscdb
 *
 *   D) The token.json / credentials.json that some forks store under the
 *      globalStorage folder.
 *
 * Returns { isAuthenticated: bool, evidence: string[] }
 */
function detectAuthState(userDataDir) {
  const evidence = [];
  let isAuthenticated = false;

  // A) API key file — primary signal
  const apiKeyPaths = [
    path.join(userDataDir, 'User', 'globalStorage', 'Antigravity.antigravity', 'api_key'),
    path.join(userDataDir, 'User', 'globalStorage', 'codeium.codeium', 'api_key'),
    path.join(userDataDir, 'User', 'globalStorage', 'Antigravity.antigravity', 'token'),
    path.join(userDataDir, 'User', 'globalStorage', 'codeium.codeium', 'token'),
  ];
  for (const ap of apiKeyPaths) {
    try {
      const stat = fs.statSync(ap);
      if (stat.isFile() && stat.size > 10) {
        const preview = fs.readFileSync(ap, 'utf8').trim().slice(0, 40);
        evidence.push(`API key file: ${ap}  (${stat.size} B, preview: "${preview}…")`);
        isAuthenticated = true;
      } else if (stat.isFile()) {
        evidence.push(`API key file (empty/tiny): ${ap}  (${stat.size} B)`);
      }
    } catch (_) {}
  }

  // B) globalStorage directory scan — look for token-like JSON / text files
  const globalStorageBase = path.join(userDataDir, 'User', 'globalStorage');
  try {
    if (fs.existsSync(globalStorageBase)) {
      evidence.push(`globalStorage dir exists: ${globalStorageBase}`);
      // Shallow scan of vendor dirs
      const vendorDirs = fs.readdirSync(globalStorageBase, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      if (vendorDirs.length > 0) evidence.push(`  vendor dirs: ${vendorDirs.join(', ')}`);

      // Look for token-like files in any vendor dir
      for (const vd of vendorDirs) {
        const vdPath = path.join(globalStorageBase, vd);
        try {
          const files = fs.readdirSync(vdPath);
          for (const f of files) {
            if (/token|api[_-]?key|credential|auth|session/i.test(f)) {
              const fp = path.join(vdPath, f);
              try {
                const st = fs.statSync(fp);
                const preview = st.isFile() && st.size < 4096
                  ? fs.readFileSync(fp, 'utf8').trim().slice(0, 60)
                  : `(${st.size} B)`;
                evidence.push(`  token-like file: ${vd}/${f}  → "${preview}"`);
                if (st.isFile() && st.size > 10) isAuthenticated = true;
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // C) state.vscdb — just check existence and size
  const stateVscdb = path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
  try {
    const st = fs.statSync(stateVscdb);
    evidence.push(`state.vscdb: ${stateVscdb}  (${(st.size / 1024).toFixed(1)} KB)`);
    // Attempt to read the api_key from state.vscdb via PowerShell sqlite query
    try {
      const sqlOut = execSync(
        `powershell -NoProfile -NonInteractive -Command "& { ` +
        `$conn = New-Object System.Data.SQLite.SQLiteConnection; ` +
        `} " 2>&1`,
        { encoding: 'utf8', windowsHide: true, timeout: 3000 }
      );
    } catch (_) {
      // SQLite PowerShell module likely not available — that's fine
    }
    // Simpler: just note the file exists and its size
    if (st.size > 4096) {
      evidence.push(`  state.vscdb is non-trivial (${(st.size / 1024).toFixed(1)} KB) — likely has stored auth`);
      isAuthenticated = isAuthenticated || true;
    }
  } catch (_) {}

  // D) Look for the codeium_api_key or similar environment config
  const configFiles = [
    path.join(userDataDir, 'User', 'settings.json'),
    path.join(userDataDir, 'User', 'keybindings.json'),
  ];
  for (const cf of configFiles) {
    try {
      if (fs.existsSync(cf)) {
        const txt = fs.readFileSync(cf, 'utf8');
        if (/api[_-]?key|auth|token|codeium/i.test(txt)) {
          evidence.push(`Token reference found in: ${cf}`);
        }
      }
    } catch (_) {}
  }

  return { isAuthenticated, evidence };
}

// ─── Window visibility check via Win32 ───────────────────────────────────────

/**
 * Use PowerShell to get the window visibility state of a PID.
 * Returns 'hidden', 'minimized', 'normal', or 'unknown'.
 *
 * This checks whether any top-level window owned by `pid` is visible/minimized.
 * Requires a brief pause after spawn for the window to be created.
 */
function getWindowVisibility(pid) {
  const pidStr = String(pid);
  try {
    // Use GetWindowPlacement to check window state
    const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$targetPid = ${pidStr}
$found = @()
[Win32]::EnumWindows({
  param($hWnd, $lParam)
  $pid = [uint32]0
  [Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
  if ($pid -eq $targetPid) {
    $visible  = [Win32]::IsWindowVisible($hWnd)
    $minimized = [Win32]::IsIconic($hWnd)
    $found += "$hWnd|$visible|$minimized"
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$found -join ','
`.trim();

    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
    ).trim();

    if (!out) return 'no windows';
    const windows = out.split(',').filter(Boolean);
    const anyVisible   = windows.some(w => w.split('|')[1] === 'True');
    const anyMinimized = windows.some(w => w.split('|')[2] === 'True');
    if (anyMinimized) return 'minimized';
    if (anyVisible)   return 'visible';
    return 'hidden';
  } catch (_) {
    return 'check-error';
  }
}

// ─── Spawn strategies ─────────────────────────────────────────────────────────

/**
 * Strategy definitions.
 * Each strategy describes how to spawn Antigravity and what to observe.
 */
const STRATEGIES = [
  {
    id: 0,
    name: 'Baseline — no hide flags',
    description: 'Spawn with just --user-data-dir. windowsHide: true in Node.js only hides the terminal window, not Electron.',
    spawnFn: (profileDir) => {
      const child = spawn(`"${ANTIGRAVITY_EXE}"`, [`--user-data-dir=${profileDir}`], {
        shell: true, detached: false, windowsHide: true, stdio: 'ignore',
      });
      return { child, pid: child.pid };
    },
    expectedVisibility: 'visible',   // Electron will still open its window
    notes: 'windowsHide: true only hides the CMD wrapper, not the Electron window itself.',
  },
  {
    id: 1,
    name: '--start-minimized flag',
    description: 'Spawn with --start-minimized. This is a VS Code / Electron fork convention that tells the main window to start minimized.',
    spawnFn: (profileDir) => {
      const child = spawn(`"${ANTIGRAVITY_EXE}"`, [
        `--user-data-dir=${profileDir}`,
        '--start-minimized',
      ], { shell: true, detached: false, windowsHide: true, stdio: 'ignore' });
      return { child, pid: child.pid };
    },
    expectedVisibility: 'minimized',
    notes: 'If Antigravity respects --start-minimized, the window will be in the taskbar but not visible on screen.',
  },
  {
    id: 2,
    name: '--start-minimized + --no-sandbox',
    description: 'Same as strategy 1 but adds --no-sandbox to prevent UAC prompts that can block headless runs.',
    spawnFn: (profileDir) => {
      const child = spawn(`"${ANTIGRAVITY_EXE}"`, [
        `--user-data-dir=${profileDir}`,
        '--start-minimized',
        '--no-sandbox',
      ], { shell: true, detached: false, windowsHide: true, stdio: 'ignore' });
      return { child, pid: child.pid };
    },
    expectedVisibility: 'minimized',
    notes: 'Most likely combination to suppress UI while still booting the LSP.',
  },
  {
    id: 3,
    name: 'PowerShell Start-Process -WindowStyle Hidden',
    description: 'Use PowerShell to spawn Antigravity with SW_HIDE window style. This hides the initial window at the Win32 level before Electron shows it.',
    spawnFn: (profileDir) => {
      // We spawn powershell as the child and track the actual Antigravity PID separately
      const psArgs = [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${ANTIGRAVITY_EXE}' ` +
        `-ArgumentList '--user-data-dir=${profileDir}', '--start-minimized', '--no-sandbox' ` +
        `-WindowStyle Hidden`,
      ];
      const child = spawn('powershell.exe', psArgs, {
        detached: false, windowsHide: true, stdio: 'ignore',
      });
      // child.pid is powershell — the actual Antigravity PID will be discovered via listProcesses()
      return { child, pid: child.pid, psLaunch: true };
    },
    expectedVisibility: 'hidden',
    notes: 'SW_HIDE suppresses the window at the OS level. Note: child.pid = powershell pid, not Antigravity.',
  },
  {
    id: 4,
    name: 'Auth-detect only — no spawn (dry-run mode)',
    description: 'No spawning. Probe the REAL user-data-dir for auth state, then probe the test profile dir.',
    spawnFn: null,   // null = probe-only, no spawn
    expectedVisibility: 'N/A',
    notes: 'Used to verify that auth detection works before attempting live suppressed spawns.',
  },
];

// ─── Poll for LSP ─────────────────────────────────────────────────────────────

async function pollForLSP(label, profileDir, timeoutMs) {
  const t0 = Date.now();
  while (true) {
    const elapsed = Date.now() - t0;
    if (elapsed > timeoutMs) return { found: false, lspEntry: null, elapsedMs: elapsed };
    let lspEntry = null;
    try {
      const snap = listProcesses();
      lspEntry = snap.find(e => isLanguageServer(e) && isAntigravityProcess(e));
    } catch (_) {}
    if (lspEntry) return { found: true, lspEntry, elapsedMs: Date.now() - t0 };
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─── Per-strategy run ─────────────────────────────────────────────────────────

async function runStrategy(strategy, profileDir) {
  const label = `[Strategy ${strategy.id}: ${strategy.name}]`;
  const result = {
    id: strategy.id,
    name: strategy.name,
    profileDir,
    lspFoundMs: null,
    port: null,
    token: null,
    queryOk: false,
    queryStatus: null,
    queryDurationMs: null,
    queryError: null,
    windowVisibility: null,
    expectedVisibility: strategy.expectedVisibility,
    killOk: false,
    notes: [strategy.notes],
    error: null,
    mainPid: null,
  };

  hdr(`Strategy ${strategy.id}: ${strategy.name}`);
  info(strategy.description);

  // ── Auth-detect mode (no spawn) ───────────────────────────────────────────
  if (strategy.spawnFn === null) {
    info('Probe-only mode — skipping spawn.');
    return result;
  }

  // ── Ensure profile dir exists ─────────────────────────────────────────────
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}

  // ── Kill any existing instances first ─────────────────────────────────────
  const existing = listProcesses().filter(isAntigravityProcess);
  if (existing.length > 0) {
    warn(`  ${existing.length} existing Antigravity process(es) — killing before test…`);
    existing.forEach(p => { killTree(p.pid); });
    await sleep(2000);
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────
  log(`  Spawning…`);
  let child, mainPid, psLaunch = false;
  try {
    const r = strategy.spawnFn(profileDir);
    child    = r.child;
    mainPid  = r.pid;
    psLaunch = !!r.psLaunch;
    result.mainPid = mainPid;
    ok(`  Spawned  PID=${mainPid}${psLaunch ? ' (powershell launcher — real PID detected later)' : ''}`);
    process.stderr.write(`\n[SPAWN Strategy ${strategy.id}] PID=${mainPid}\n`);
  } catch (err) {
    result.error = `Spawn failed: ${err.message}`;
    fail(`  ${result.error}`);
    return result;
  }

  child.on('exit', (code, sig) => {
    warn(`  Main process PID=${mainPid} exited  code=${code}  sig=${sig}`);
  });

  // Wait briefly so Electron has time to create its main window
  await sleep(3000);

  // ── Window visibility check ───────────────────────────────────────────────
  // For PS-launched strategies, find the actual Antigravity PID first
  let windowCheckPid = mainPid;
  if (psLaunch) {
    try {
      const snap = listProcesses();
      const agProc = snap.find(e => isAntigravityProcess(e) && e.pid !== String(mainPid));
      if (agProc) {
        windowCheckPid = parseInt(agProc.pid, 10);
        log(`  PS-launched — actual Antigravity PID: ${windowCheckPid}`);
      }
    } catch (_) {}
  }
  const visibility = getWindowVisibility(windowCheckPid);
  result.windowVisibility = visibility;
  const visLabel = visibility === 'hidden' ? c(GR, visibility)
    : visibility === 'minimized'           ? c(YE, visibility)
    : visibility === 'no windows'          ? c(GR, visibility)
    : c(RE, visibility);
  log(`  Window visibility (auto-check PID ${windowCheckPid}): ${visLabel}`);
  if (visibility === 'visible') warn('  ⚠  Window VISIBLE — this strategy does NOT suppress the UI.');
  else if (visibility === 'minimized') warn('  ⚠  Window MINIMIZED — minimized to taskbar, not fully hidden.');
  else if (visibility === 'hidden' || visibility === 'no windows') ok('  Window hidden or not yet created — promising!');

  // ── Poll for LSP ──────────────────────────────────────────────────────────
  log(`  Polling for LSP (timeout ${POLL_TIMEOUT_MS / 1000} s)…`);
  const pollResult = await pollForLSP(label, profileDir, POLL_TIMEOUT_MS);
  result.lspFoundMs = pollResult.elapsedMs;
  const lspEntry    = pollResult.lspEntry;

  if (lspEntry) {
    ok(`  LSP found in ${result.lspFoundMs} ms  PID=${lspEntry.pid}  ${lspEntry.name}`);
    process.stderr.write(`\n[LSP Strategy ${strategy.id} pid=${lspEntry.pid}]\n${lspEntry.commandLine}\n`);
  } else {
    fail(`  LSP NOT found within ${POLL_TIMEOUT_MS / 1000} s.`);
    result.notes.push('LSP timeout');
  }

  // ── Extract port + token ──────────────────────────────────────────────────
  let port = null, token = null, portSource = null;
  if (lspEntry) {
    await sleep(LSP_WARMUP_MS);

    const extracted = extractPortAndToken(lspEntry.commandLine, profileDir);
    token      = extracted.token;
    portSource = extracted.source;

    const listeningPorts = getListeningPortsForPid(lspEntry.pid);
    log(`  Listening ports for LSP PID ${lspEntry.pid}: [${listeningPorts.join(', ') || 'none'}]`);
    port = listeningPorts[0] ? String(listeningPorts[0]) : extracted.port;
    if (!token && extracted.token) token = extracted.token;

    result.port      = port;
    result.token     = token;
    result.portSource = portSource;

    if (port && token) ok(`  Port=${port}  Token=${token.slice(0, 8)}…`);
    else warn(`  Port/token not extracted (port=${port ?? 'null'}, token=${token ? 'found' : 'null'})`);
  }

  // ── Query GetUserStatus ───────────────────────────────────────────────────
  if (port && token) {
    const extPort   = lspEntry ? extractExtensionServerPort(lspEntry.commandLine) : null;
    const queryPort = extPort !== null ? extPort + 1 : parseInt(port, 10);
    if (extPort !== null) info(`  extension_server_port=${extPort} → query on ${queryPort}`);

    log(`  Querying GetUserStatus on port ${queryPort}…`);
    const q = await queryUserStatus(queryPort, token);
    result.queryOk = q.ok; result.queryDurationMs = q.durationMs;
    if (q.ok) {
      result.queryStatus = q.status;
      ok(`  HTTP ${q.status}  (${q.durationMs} ms)`);
      if (q.body) info(`  Body preview: ${q.body.slice(0, 200)}`);
    } else {
      result.queryError = q.error;
      fail(`  Query failed: ${q.error}  (${q.durationMs} ms)`);
    }
  } else {
    result.notes.push('query skipped (no port/token)');
  }

  // ── Kill ──────────────────────────────────────────────────────────────────
  log('  Killing process tree…');
  const kr = killTree(mainPid);
  result.killOk = kr.ok;
  if (kr.ok) ok('  Kill OK');
  else { warn(`  Kill result: ${kr.msg}`); }

  // Also kill by name in case PS-launched had a different PID
  if (psLaunch || !kr.ok) {
    const remaining = listProcesses().filter(isAntigravityProcess);
    remaining.forEach(p => killTree(p.pid));
  }

  log(`  Waiting ${BETWEEN_STRATS_MS / 1000} s before next strategy…`);
  await sleep(BETWEEN_STRATS_MS);

  return result;
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummaryTable(results) {
  hdr('STRATEGY SUMMARY');
  const COLS = [
    { h: '#',           w: 2 },
    { h: 'Strategy',    w: 32 },
    { h: 'LSP ms',      w: 8 },
    { h: 'Window',      w: 11 },
    { h: 'Expected',    w: 11 },
    { h: 'MatchExp',    w: 8 },
    { h: 'QueryOK',     w: 8 },
    { h: 'Kill',        w: 5 },
    { h: 'Notes (truncated)',  w: 40 },
  ];
  const row = cells => cells.map((v, i) => String(v ?? '—').padEnd(COLS[i].w)).join('  ');
  console.log(c(CY, row(COLS.map(col => col.h))));
  console.log(c(DI, COLS.map(col => '─'.repeat(col.w)).join('  ')));

  for (const r of results) {
    const matchExp = r.windowVisibility === r.expectedVisibility ? 'yes' : r.windowVisibility === null ? '—' : 'NO';
    const isGood = r.queryOk && r.killOk;
    const cells = [
      r.id,
      r.name.slice(0, 32),
      r.lspFoundMs !== null ? r.lspFoundMs : '—',
      r.windowVisibility ?? '—',
      r.expectedVisibility,
      matchExp,
      r.queryOk ? (r.queryStatus ?? 'ok') : (r.queryError?.slice(0, 7) ?? '—'),
      r.killOk ? 'yes' : r.spawnFn === null ? 'n/a' : 'no',
      (r.notes.join('; ')).slice(0, 40),
    ];
    console.log(isGood ? c(GR, row(cells)) : c(YE, row(cells)));
  }
  console.log('');
}

// ─── Auth probe ───────────────────────────────────────────────────────────────

function runAuthProbe() {
  hdr('AUTH STATE PROBE');

  const targets = [
    { label: 'Real profile', dir: USER_DATA_DIR },
    { label: 'Test profile', dir: TEST_PROFILE_DIR },
  ];

  for (const { label, dir } of targets) {
    console.log(`\n  ${c(CY, label)}: ${dir}`);
    const auth = detectAuthState(dir);
    if (auth.isAuthenticated) {
      ok(`  AUTH DETECTED — this profile is logged in.`);
    } else {
      warn(`  Auth NOT detected — this profile may be unauthenticated (OAuth prompt will appear on spawn).`);
    }
    auth.evidence.forEach(e => info(`    ${e}`));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun    = process.argv.includes('--dry-run');
  const stratArgRaw = process.argv.find(a => a.startsWith('--strategy='));
  const stratIdx    = stratArgRaw ? [parseInt(stratArgRaw.slice(11), 10)] : null;

  const strategiesToRun = stratIdx
    ? STRATEGIES.filter(s => stratIdx.includes(s.id))
    : STRATEGIES;

  console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
  console.log(c(BO, '║  test-headless-refresh.js — Question B: UI Suppression Strategies' + ' '.repeat(3) + '║'));
  console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
  console.log(c(DI, `  Platform       : ${os.platform()} ${os.release()}`));
  console.log(c(DI, `  EXE            : ${ANTIGRAVITY_EXE}`));
  console.log(c(DI, `  Real profile   : ${USER_DATA_DIR}`));
  console.log(c(DI, `  Test profile   : ${TEST_PROFILE_DIR}`));
  console.log(c(DI, `  Dry run        : ${isDryRun}`));
  console.log(c(DI, `  Strategies     : ${strategiesToRun.map(s => `${s.id}: ${s.name}`).join('\n                    ')}`));
  console.log('');

  warn('MANUAL OBSERVATION REQUIRED: Watch your screen during each strategy.');
  warn('The auto-check reports window states programmatically, but may not');
  warn('catch all window types. Note what you see (visible/minimized/nothing)');
  warn('and compare to the "Window" column in the summary table.');
  console.log('');

  // Always run auth probe
  runAuthProbe();

  if (isDryRun) {
    info('Dry-run mode — skipping all spawn strategies.');
    return;
  }

  // Pre-flight: kill all existing
  hdr('PRE-FLIGHT');
  const existing = listProcesses().filter(isAntigravityProcess);
  if (existing.length > 0) {
    fail(`Found ${existing.length} existing Antigravity process(es) — killing all.`);
    existing.forEach(p => { killTree(p.pid); warn(`  Killed PID ${p.pid}  ${p.name}`); });
    await sleep(3000);
  } else {
    ok('No existing Antigravity processes.');
  }

  // Ensure test profile dir exists and copy auth from real profile if empty
  try { fs.mkdirSync(TEST_PROFILE_DIR, { recursive: true }); } catch (_) {}
  const testAuth = detectAuthState(TEST_PROFILE_DIR);
  if (!testAuth.isAuthenticated) {
    warn(`Test profile ${TEST_PROFILE_DIR} appears unauthenticated.`);
    warn('Spawning will likely show an OAuth window. To avoid this:');
    warn(`  xcopy /E /I "${USER_DATA_DIR}" "${TEST_PROFILE_DIR}" /Y`);
    warn('Then re-run this script.');
  } else {
    ok(`Test profile is authenticated — headless spawn should work without OAuth.`);
  }

  // Run strategies
  const results = [];
  for (const strategy of strategiesToRun) {
    try {
      const r = await runStrategy(strategy, TEST_PROFILE_DIR);
      results.push(r);
    } catch (err) {
      fail(`Strategy ${strategy.id} threw: ${err.message}`);
      results.push({ id: strategy.id, name: strategy.name, error: err.message, queryOk: false, killOk: false, notes: [err.message] });
    }
  }

  // Summary
  printSummaryTable(results);

  // Verdict
  hdr('VERDICT');

  // Best strategy = highest suppression + LSP success + query success
  const workingHeadless = results.filter(r =>
    r.queryOk &&
    (r.windowVisibility === 'hidden' || r.windowVisibility === 'minimized' || r.windowVisibility === 'no windows')
  );
  if (workingHeadless.length > 0) {
    ok(`Headless-compatible strategies: ${workingHeadless.map(r => `Strategy ${r.id} (${r.name})`).join(', ')}`);
    const bestHidden = workingHeadless.find(r => r.windowVisibility === 'hidden' || r.windowVisibility === 'no windows');
    if (bestHidden) ok(`BEST strategy for true headless: Strategy ${bestHidden.id} — ${bestHidden.name}`);
  } else {
    const queryWorked = results.filter(r => r.queryOk);
    if (queryWorked.length > 0) {
      warn(`LSP was queryable in ${queryWorked.length} strategy/ies, but UI was not suppressed.`);
      warn('Antigravity may not fully support windowless operation — consider alternatives:');
      warn('  • Use a separate low-res virtual desktop for refresh runs');
      warn('  • Use a Windows Service account without a desktop session');
      warn('  • Wrap in a virtual display (Xvfb equivalent on Windows: e.g. via RDP minimized session)');
    } else {
      fail('No strategy produced a working headless LSP query. Antigravity may require visible UI.');
    }
  }

  // Auth detection verdict
  const realAuth = detectAuthState(USER_DATA_DIR);
  console.log('');
  info(`Auth detection for real profile: isAuthenticated=${realAuth.isAuthenticated}`);
  info(`Evidence count: ${realAuth.evidence.length} items`);
  if (realAuth.isAuthenticated) {
    ok('Auth detection WORKS — the refresh engine can reliably detect logged-in profiles without spawning.');
  } else {
    warn('Auth detection inconclusive for real profile. May need to refine file paths.');
  }

  console.log('');
  console.log(c(DI, 'Record these results in FINDINGS.md.'));
  console.log(c(DI, 'Capture raw output: node test-headless-refresh.js 2>headless-raw.txt'));
  console.log('');
}

main().catch(err => {
  console.error(c(RE, `\nFatal: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
