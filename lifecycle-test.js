#!/usr/bin/env node
/**
 * lifecycle-test.js  v4
 *
 * Measures the cold-boot lifecycle of Antigravity IDE:
 *   pre-check → spawn → poll for LSP → extract port/token → query → kill → orphan check
 *
 * Runs the sequence RUN_COUNT times and prints a summary table for each run.
 *
 * Usage:
 *   node lifecycle-test.js              # AUTOMATIC hidden mode (windowsHide: true, shell: false, hands-free)
 *   node lifecycle-test.js --auto-hidden# explicit automatic hidden mode
 *   node lifecycle-test.js --multi-run  # 3-run lifecycle measurement (windowsHide: true, shell: false)
 *   node lifecycle-test.js --variant-d  # Variant D: bare workspace-folder arg, 30 s timeout
 *   node lifecycle-test.js --manual     # MANUAL mode: spawn with visible window, wait for ENTER
 *   node lifecycle-test.js --manual-hidden  # MANUAL hidden mode: hidden window, wait for ENTER
 *   node lifecycle-test.js 2>&1         # merge stderr into stdout so RAW lines appear together
 *   node lifecycle-test.js 2>raw.txt    # capture raw cmdlines separately
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE RUNNING:
 *   Close Antigravity IDE completely so the pre-check passes and timings
 *   reflect a real cold boot.  The script warns and exits if it's still open.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LSP DETECTION (sourced verbatim from detect.js — do NOT hand-edit these):
 *   isAntigravityProcess(): name/cmdline contains 'antigravity', 'antigravity-ide',
 *                           or 'antigravity.exe' (case-insensitive).
 *   isLanguageServer():     Layered detection (see function JSDoc for full detail):
 *                             1. Noise blocklist  — skip rg.exe and other bundled tools.
 *                             2. Exact name match — entry.name === 'language_server_windows_x64.exe'
 *                                (or other KNOWN_LSP_EXACT_NAMES entries).
 *                             3. Keyword fallback — LANGUAGE_SERVER_HINTS substring scan
 *                                (retained for non-Windows or renamed builds).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { execSync, spawn } = require('child_process');
const https               = require('https');
const os                  = require('os');
const path                = require('path');
const fs                  = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────

const ANTIGRAVITY_EXE = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
const USER_DATA_DIR   = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';

/** Maximum time to poll for the LSP process (ms) */
const POLL_TIMEOUT_MS  = 90_000;   // 90 s — give it plenty of time to boot
/** How often to poll (ms) */
const POLL_INTERVAL_MS = 300;
/** How many full lifecycle runs to perform */
const RUN_COUNT        = 3;
/** Seconds to wait between runs */
const BETWEEN_RUNS_S   = 6;
/** ms to wait after LSP is detected before hitting its HTTP endpoint */
const LSP_WARMUP_MS    = 1500;

// ─── Variant D configuration ──────────────────────────────────────────────────

/**
 * Variant D: spawn with --user-data-dir ONLY (no --start-minimized, no --no-sandbox)
 * PLUS a bare workspace-folder path as a trailing positional argument.
 *
 * VS Code and almost every fork support:  code <folder-path>
 * where the folder path is the last positional argument with no flag prefix.
 * We try that convention first (VARIANT_D_WORKSPACE_ARG placed at the end).
 *
 * If this still doesn't trigger the LSP, the next thing to try is --folder-uri.
 */
const VARIANT_D_WORKSPACE   = 'C:\\Users\\VISHESH\\Desktop\\lune';
/** Timeout for Variant D (shorter — 30 s — since we're iterating fast) */
const VARIANT_D_TIMEOUT_MS  = 30_000;

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

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts()         { return new Date().toISOString().replace('T', ' ').slice(0, -1); }
function log(msg)     { console.log(`${c(DI, ts())}  ${msg}`); }
function ok(msg)      { console.log(`${c(DI, ts())}  ${c(GR, '✓')} ${msg}`); }
function warn(msg)    { console.log(`${c(DI, ts())}  ${c(YE, '⚠')} ${msg}`); }
function fail(msg)    { console.log(`${c(DI, ts())}  ${c(RE, '✖')} ${msg}`); }
function info(msg)    { console.log(`${c(DI, ts())}  ${c(BL, '·')} ${msg}`); }
function sep(n = 72)  { console.log(c(DI, '─'.repeat(n))); }
function raw(pid, cmd) { process.stderr.write(`\n[RAW pid=${pid}]\n${cmd}\n`); }

/** Print a string word-wrapped at `width` chars, indented by `indent` */
function wrapPrint(str, indent = '      ', width = 120) {
  let line = indent;
  for (const tok of str.split(' ')) {
    if (line.length + tok.length + 1 > width && line.trim().length > 0) {
      console.log(line); line = indent;
    }
    line += (line.trim().length > 0 ? ' ' : '') + tok;
  }
  if (line.trim().length > 0) console.log(line);
}

// ─── Process listing (Win32_Process via PowerShell) ───────────────────────────

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

// ─── Process filters — sourced verbatim from detect.js ───────────────────────
//
// These constants and functions are copied exactly from detect.js so that
// lifecycle-test.js uses the SAME detection logic that successfully found the
// LSP in earlier sessions.  Do NOT change these without also updating detect.js.

/**
 * Keywords used to decide whether a process belongs to Antigravity.
 * A process matches if ANY of its command-line tokens contain one of these
 * strings (case-insensitive).
 *
 * SOURCE: detect.js → ANTIGRAVITY_KEYWORDS
 */
const ANTIGRAVITY_KEYWORDS = [
  'antigravity',
  'antigravity-ide',
  'antigravity.exe',
];

/**
 * Exact executable names (lower-cased) that are known to be the Antigravity
 * Language Server binary on specific platforms.  On Windows the primary
 * detection path checks entry.name against this list BEFORE falling back to
 * keyword heuristics, so transient helper processes (e.g. rg.exe) that happen
 * to carry LSP-like substrings in their command lines cannot produce false
 * positives.
 *
 * SOURCE: detect.js → KNOWN_LSP_EXACT_NAMES
 */
const KNOWN_LSP_EXACT_NAMES = [
  'language_server_windows_x64.exe',   // Windows — confirmed live process name
  'language_server_macos_arm64',        // macOS Apple Silicon (guard for future)
  'language_server_macos_x64',          // macOS Intel (guard for future)
  'language_server_linux_x64',          // Linux (guard for future)
];

/**
 * Process names (lower-cased) that are known bundled CLI tools or OS helpers
 * and must NEVER be classified as a Language Server, even if their argv
 * accidentally contains an LSP-like substring.
 *
 * Root cause of bug: rg.exe (ripgrep) is spawned transiently during workspace
 * indexing; its glob flags (e.g. "-g !**\/.ruby-lsp") contain "lsp", which
 * falsely triggered the keyword match in earlier versions.
 *
 * SOURCE: detect.js → NOISE_PROCESS_NAMES
 */
const NOISE_PROCESS_NAMES = new Set([
  'rg.exe',               // ripgrep — Antigravity's bundled search tool
  'rg',                   // ripgrep on macOS / Linux
  'fsevents-helper',      // macOS FSEvents helper
  'fsevents_helper',      // alternate casing
  'esbuild.exe',          // bundled JS bundler
  'esbuild',
  'node_modules/.bin/rg', // in case argv[0] is the full path variant
]);

/**
 * A secondary keyword used to narrow matches down to the Language Server
 * specifically.  Hints discovered from a live Antigravity IDE process scan:
 *   - serverWorkerMain  : language server worker
 *   - --node-ipc        : VS Code IPC channel used by all LSP worker processes
 *   - --clientProcessId : companion flag to --node-ipc, always present on LSP workers
 *   - typingsInstaller  : TypeScript language server component
 *   - extensionHost     : main extension host (hosts LSP clients)
 *
 * NOTE: the actual confirmed-working LSP process is
 *   name  = language_server_windows_x64.exe
 *   flags = --enable_lsp  --csrf_token  --lsp_port  --extension_server_port
 * All of 'lsp', 'language-server', 'languageserver' hit that executable name,
 * so it is matched by the generic patterns below.
 *
 * IMPORTANT: These hints are a FALLBACK only (Step 3).  The primary detection
 * path is an exact match against KNOWN_LSP_EXACT_NAMES (Step 2), preceded by
 * a noise-blocklist check (Step 1).  See isLanguageServer() for details.
 *
 * SOURCE: detect.js → LANGUAGE_SERVER_HINTS
 */
const LANGUAGE_SERVER_HINTS = [
  // Generic patterns
  'languageserver',
  'language-server',
  'lsp',
  'server.js',
  'server/main',
  'remoteagent',
  // VS Code / Electron fork patterns (observed in live Antigravity scan)
  '--type=extensionHost',   // main extension host process
  'extensionhost',
  '--ms-enable-electron-run-as-node',
  '--node-ipc',             // IPC channel used by all VS Code LSP workers
  '--clientProcessId',      // always paired with --node-ipc on LSP workers
  'serverWorkerMain',       // e.g. markdown-language-features/dist/serverWorkerMain
  'typingsInstaller',       // TypeScript language server / typings installer
];

/** True if process references this profile's user-data-dir anywhere in its cmdline */
function isProfileProcess(entry) {
  return entry.commandLine.toLowerCase().includes(USER_DATA_DIR.toLowerCase());
}

/**
 * Returns true if the process entry looks like an Antigravity process.
 * Mirrors detect.js isAntigravityProcess() exactly.
 *
 * @param {ProcessEntry} entry
 * @returns {boolean}
 */
function isAntigravityProcess(entry) {
  const haystack = `${entry.name} ${entry.commandLine}`.toLowerCase();
  return ANTIGRAVITY_KEYWORDS.some(kw => haystack.includes(kw.toLowerCase()));
}

/**
 * Returns true if the process looks like the Language Server specifically.
 *
 * Detection is layered — evaluated in order, short-circuiting on the first
 * definitive answer:
 *
 *   1. NOISE BLOCKLIST — if entry.name is a known bundled CLI tool (rg.exe,
 *      esbuild, fsevents-helper, …) return false immediately, regardless of
 *      what its command line contains.  This prevents transient helper
 *      processes from producing false positives when their argv happens to
 *      include LSP-like substrings (e.g. ripgrep glob flags like
 *      "-g !**\/.ruby-lsp" containing the substring "lsp").
 *
 *   2. EXACT NAME MATCH — if entry.name (lower-cased) is in KNOWN_LSP_EXACT_NAMES,
 *      return true unconditionally.  This is the primary, high-confidence path
 *      on Windows where the binary is always named
 *      language_server_windows_x64.exe.
 *
 *   3. KEYWORD FALLBACK — if no exact match exists, apply the original
 *      substring-keyword heuristics against name + commandLine.  Kept for
 *      other platforms or renamed builds where the exact filename may differ.
 *
 * Mirrors detect.js isLanguageServer() exactly.
 *
 * @param {ProcessEntry} entry
 * @returns {boolean}
 */
function isLanguageServer(entry) {
  const nameLower = entry.name.toLowerCase();

  // ── Step 1: noise blocklist ───────────────────────────────────────────────
  if (NOISE_PROCESS_NAMES.has(nameLower)) {
    return false;
  }

  // ── Step 2: exact name match (high-confidence, platform-aware) ───────────
  if (KNOWN_LSP_EXACT_NAMES.includes(nameLower)) {
    return true;
  }

  // ── Step 3: keyword-hint fallback (other platforms / renamed builds) ──────
  const haystack = `${entry.name} ${entry.commandLine}`.toLowerCase();
  return LANGUAGE_SERVER_HINTS.some(hint => haystack.includes(hint.toLowerCase()));
}

/**
 * True if this process is both an Antigravity process AND the Language Server.
 * This is the corrected replacement for the old isProfileLSP().
 * (We do NOT require user-data-dir to be in the cmdline because the actual
 *  language_server_windows_x64.exe process may not inherit the UDD arg.)
 */
function isProfileLSP(entry) {
  return isAntigravityProcess(entry) && isLanguageServer(entry);
}

/** Print the detection criteria so the user can verify the fix before running. */
function printDetectionCriteria() {
  console.log(c(CY, '  ┌─── LSP Detection Criteria (sourced from detect.js) ──────────────────────'));
  console.log(c(CY, '  │'));
  console.log(c(CY, '  │  Step 1 — isAntigravityProcess():'));
  ANTIGRAVITY_KEYWORDS.forEach(kw =>
    console.log(c(DI,  `  │    • name or cmdline contains: "${kw}"  (case-insensitive)`)));
  console.log(c(CY, '  │'));
  console.log(c(CY, '  │  Step 2 — isLanguageServer()  [LAYERED — evaluated in order]:'));
  console.log(c(DI,  '  │'));
  console.log(c(MA,  '  │    2a. NOISE BLOCKLIST — skip immediately if name is one of:'));
  [...NOISE_PROCESS_NAMES].forEach(n =>
    console.log(c(DI,  `  │        • "${n}"`)));
  console.log(c(DI,  '  │'));
  console.log(c(GR,  '  │    2b. EXACT NAME MATCH (primary / high-confidence) — return true if:'));
  KNOWN_LSP_EXACT_NAMES.forEach(n =>
    console.log(c(GR,  `  │        • entry.name.toLowerCase() === "${n}"`)));
  console.log(c(DI,  '  │'));
  console.log(c(YE,  '  │    2c. KEYWORD FALLBACK (other platforms / renamed builds only):'));
  LANGUAGE_SERVER_HINTS.forEach(h =>
    console.log(c(DI,  `  │        • "${h}"  (case-insensitive)`)));
  console.log(c(CY, '  │'));
  console.log(c(CY, '  │  Confirmed-working LSP signature (Windows):'));
  console.log(c(GR, '  │    name  = language_server_windows_x64.exe  ← matched by exact-name check (2b)'));
  console.log(c(GR, '  │    flags = --enable_lsp  --csrf_token  --lsp_port  --extension_server_port'));
  console.log(c(MA, '  │  False-positive now blocked: rg.exe  ← stopped by noise blocklist (2a)'));
  console.log(c(CY, '  └' + '─'.repeat(74)));
  console.log('');
}

// ─── Port + CSRF token extraction ─────────────────────────────────────────────

/**
 * Extract the raw value of --extension_server_port from a command-line string.
 * Returns the numeric port value, or null if the flag is absent.
 *
 * NOTE: As of the current build this is the ONLY port flag in the cmdline.
 * Port-offset guessing (+1, +2, etc.) is unreliable — use getListeningPortsForPid()
 * instead to ask the OS what ports the process is actually LISTENING on.
 */
function extractExtensionServerPort(commandLine) {
  const m = commandLine.match(/--extension[_-]server[_-]port[=\s]+(\d{4,5})/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Query the OS (via netstat) for every local port that `pid` is actively
 * LISTENING on.  Returns an array of integer port numbers in the order netstat
 * reported them (duplicates removed).
 *
 * Strategy:
 *   netstat -ano | findstr <PID>
 * Each output line has the form:
 *   Proto  LocalAddr:port  ForeignAddr:port  State  PID
 * We keep only lines where State === LISTENING and PID matches exactly.
 *
 * @param {string|number} pid
 * @returns {number[]}  sorted unique listening ports for that PID
 */
function getListeningPortsForPid(pid) {
  const pidStr = String(pid);
  let netstatOut = '';
  try {
    netstatOut = execSync(`netstat -ano | findstr ${pidStr}`, {
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
      // findstr exits non-zero when there are zero matches — that's fine
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // execSync throws if the command exits non-zero (findstr with 0 matches)
    netstatOut = (err.stdout || '');
  }

  const ports = [];
  const seen  = new Set();
  for (const line of netstatOut.split(/\r?\n/)) {
    // Typical line:
    //   TCP    127.0.0.1:55329    0.0.0.0:0    LISTENING    24108
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const state     = parts[parts.length - 2]?.toUpperCase();
    const linePid   = parts[parts.length - 1];
    if (state !== 'LISTENING') continue;
    if (linePid !== pidStr)    continue;  // only this PID

    // Local address is parts[1], e.g. "127.0.0.1:55329" or "[::]:55329"
    const localAddr = parts[1] || '';
    const colonIdx  = localAddr.lastIndexOf(':');
    if (colonIdx === -1) continue;
    const portNum = parseInt(localAddr.slice(colonIdx + 1), 10);
    if (!portNum || seen.has(portNum)) continue;
    seen.add(portNum);
    ports.push(portNum);
  }
  return ports;
}

/**
 * Extract port and CSRF token from a command-line string.
 * Returns { port: string|null, token: string|null, source: string }.
 *
 * We try multiple flag name patterns — exact names vary between Codeium/Antigravity
 * releases.  Falls back to scanning the LSP log directory if cmdline yields nothing.
 */
function extractPortAndToken(commandLine, pid = null) {
  let port  = null;
  let token = null;
  let source = 'cmdline';

  const PORT_PATTERNS = [
    /--api[_-]server[_-]port[=\s]+(\d{4,5})/i,
    /--manager[_-]port[=\s]+(\d{4,5})/i,
    /--lsp[_-]port[=\s]+(\d{4,5})/i,
    /--server[_-]port[=\s]+(\d{4,5})/i,
    /--port[=\s]+(\d{4,5})/i,
    // Codeium uses --channel_id which sometimes contains port info; skip for now
    // Bare 5-digit number preceded by any port-like flag word
    /(?:port|server|listen)[=\s"]+(\d{4,5})\b/i,
  ];
  for (const re of PORT_PATTERNS) {
    const m = commandLine.match(re);
    if (m) { port = m[1]; break; }
  }

  const CSRF_PATTERNS = [
    /--csrf[_-]token[=\s]+([\w-]{20,})/i,
    /--csrf[=\s]+([\w-]{20,})/i,
    /"csrf[_-]?token"[:\s"]+([\w-]{20,})/i,
    /csrf[_-]?token[=\s]+([\w-]{20,})/i,
  ];
  for (const re of CSRF_PATTERNS) {
    const m = commandLine.match(re);
    if (m) { token = m[1]; break; }
  }

  // ── Fallback: scan LSP log files for port/token ──────────────────────────
  // Antigravity writes logs to %APPDATA%\Antigravity IDE\logs\<session>\
  // The Language Server's log often contains its bind address and token.
  if (!port || !token) {
    const logsDir = path.join(USER_DATA_DIR, 'logs');
    try {
      if (fs.existsSync(logsDir)) {
        // Grab the most recently modified log file anywhere under logs/
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

        // Read up to 5 most recent logs, look for port/token patterns
        for (const { path: logPath } of allLogs.slice(0, 5)) {
          try {
            const content = fs.readFileSync(logPath, 'utf8');
            if (!port) {
              const m = content.match(/(?:port|listening)[^\d]*(\d{4,5})/i);
              if (m) { port = m[1]; source = `log:${path.basename(logPath)}`; }
            }
            if (!token) {
              const m = content.match(/csrf[_-]?token[^\w]+([\w-]{20,})/i);
              if (m) { token = m[1]; source = `log:${path.basename(logPath)}`; }
            }
            if (port && token) break;
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  return { port, token, source };
}

// ─── GetUserStatus HTTP request ───────────────────────────────────────────────

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
    req.setTimeout(15_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout (15 s)', durationMs: Date.now() - t0 }); });

    req.write(bodyData);
    req.end();
  });
}

// ─── Kill ─────────────────────────────────────────────────────────────────────

function killTree(pid) {
  try {
    const out = execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', windowsHide: true });
    return { ok: true, stdout: out.trim() };
  } catch (err) {
    const gone = /not found|no running/i.test(err.message + (err.stderr || ''));
    return { ok: gone, stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message || '').trim() };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Pause until the user presses ENTER.  Works even when stdin has no TTY
 * (readline still reads from the underlying fd).
 *
 * @param {string} prompt  Message to print before waiting
 * @returns {Promise<void>}
 */
function waitForEnter(prompt) {
  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write(`\n${c(YE, '▶')}  ${prompt}\n${c(DI, '   (waiting for ENTER…)')} `);
    rl.once('line', () => { rl.close(); resolve(); });
  });
}

/**
 * Pretty-print all profile processes with FULL untruncated command lines.
 * Called both during normal flow (for visibility) and on failure (for debugging).
 */
function dumpProfileProcesses(label, procs) {
  console.log('');
  console.log(c(MA, `  ┌─── ${label} (${procs.length} processes) ${'─'.repeat(Math.max(0, 55 - label.length))}`));
  if (procs.length === 0) {
    console.log(c(DI, '  │   (none)'));
    console.log(c(MA, '  └' + '─'.repeat(68)));
    return;
  }
  procs.forEach((p, idx) => {
    const { port, token } = extractPortAndToken(p.commandLine, p.pid);
    const isLast = idx === procs.length - 1;
    console.log(c(MA, `  ├─ PID ${p.pid}  ${p.name}`));
    console.log(`  │    port=${port ?? c(DI, 'none')}   token=${token ?? c(DI, 'none')}`);
    console.log(`  │    CMD (full, untruncated):`);
    // Word-wrap at 114 chars with │ prefix
    const IND = '  │      ';
    const W   = 114;
    let line  = IND;
    for (const tok of p.commandLine.split(' ')) {
      if (line.length + tok.length + 1 > W && line.trim().length > 0) {
        console.log(c(DI, line)); line = IND;
      }
      line += (line.trim().length > 0 ? ' ' : '') + tok;
    }
    if (line.trim().length > 0) console.log(c(DI, line));
    // Untruncated raw to stderr
    raw(p.pid, p.commandLine);
    if (!isLast) console.log(c(MA, '  ├' + '─'.repeat(68)));
  });
  console.log(c(MA, '  └' + '─'.repeat(68)));
  console.log('');
}

// ─── Variant D lifecycle run ──────────────────────────────────────────────────

/**
 * Variant D — single run:
 *   - Args: [ '--user-data-dir=<path>', '<workspace-folder>' ]
 *   - No --start-minimized (isolating that variable)
 *   - No --no-sandbox
 *   - 30 s poll timeout instead of 90 s
 *   - Logs the exact final command line so the workspace arg is visually confirmed
 */
async function lifecycleRunVariantD() {
  console.log('\n' + c(BO, '═'.repeat(72)));
  console.log(c(BO, '  VARIANT D — bare workspace-folder arg  (1 run, 30 s timeout)'));
  console.log(c(BO, '═'.repeat(72)));

  const R = {
    run:             'D',
    coldBoot:        false,
    spawnMs:         null,
    pollCount:       0,
    timeToLspMs:     null,
    lspPid:          null,
    port:            null,
    token:           null,
    portSource:      null,
    queryOk:         false,
    queryStatus:     null,
    queryDurationMs: null,
    queryError:      null,
    killOk:          false,
    orphansFound:    null,
    notes:           [],
    totalMs:         null,
  };
  const t0 = Date.now();

  // ── 1. Pre-flight ────────────────────────────────────────────────────────────
  sep();
  log(`[1/7] Pre-flight: scanning for existing Antigravity profile processes…`);

  const existing = listProcesses().filter(isProfileProcess);
  if (existing.length > 0) {
    fail(`Found ${existing.length} existing process(es) using this profile:`);
    existing.forEach(p => fail(`      PID ${p.pid}  ${p.name}`));
    warn('Non-interactive mode: proceeding with WARM start. Timings will be inflated.');
    R.notes.push('WARM start');
  } else {
    ok('No existing profile processes — cold-boot confirmed.');
    R.coldBoot = true;
  }

  // ── 2. Spawn ─────────────────────────────────────────────────────────────────
  sep();
  log(`[2/7] Spawning Antigravity (Variant D)…`);
  log(`      EXE       : ${ANTIGRAVITY_EXE}`);
  log(`      Workspace : ${VARIANT_D_WORKSPACE}  (bare positional arg — VS Code convention)`);
  log(`      Omitted   : --start-minimized, --no-sandbox  (isolating one variable at a time)`);

  //
  // ⬇  The workspace folder is the LAST positional argument — no flag prefix.
  //    This mirrors the standard  "code <folder>"  invocation that every VS Code
  //    fork supports.  The IDE should open that folder and activate its extension
  //    host / language-server for the workspace.
  //
  const spawnArgs = [
    `--user-data-dir=${USER_DATA_DIR}`,
    VARIANT_D_WORKSPACE,          // bare trailing path — standard VS Code form
  ];

  // ── Log the EXACT command line that will be executed ──────────────────────
  const exactCmdLine = `"${ANTIGRAVITY_EXE}" ${spawnArgs.join(' ')}`;
  log(`      ─── EXACT COMMAND LINE ───────────────────────────────────────────────`);
  log(`      ${exactCmdLine}`);
  log(`      ─────────────────────────────────────────────────────────────────────`);
  // Also emit to stderr so it appears in any 2>raw.txt capture
  process.stderr.write(`\n[VARIANT-D CMDLINE]\n${exactCmdLine}\n`);

  let child, mainPid;
  const spawnT0 = Date.now();
  try {
    child  = spawn(`"${ANTIGRAVITY_EXE}"`, spawnArgs, {
      shell:       true,
      detached:    false,
      windowsHide: false,   // allow window to appear — not trying to hide this time
      stdio:       'ignore',
    });
    mainPid   = child.pid;
    R.spawnMs = Date.now() - spawnT0;
    ok(`Spawned  PID=${mainPid}  (spawn() returned in ${R.spawnMs} ms)`);
  } catch (err) {
    fail(`Spawn failed: ${err.message}`);
    R.totalMs = Date.now() - t0;
    return R;
  }

  child.on('exit', (code, sig) => warn(`Main process PID=${mainPid} exited early  code=${code}  signal=${sig}`));

  // ── 3. Poll for LSP ──────────────────────────────────────────────────────────
  sep();
  log(`[3/7] Polling every ${POLL_INTERVAL_MS} ms for Language Server (timeout ${VARIANT_D_TIMEOUT_MS / 1000} s)…`);
  log(`      Matching: isAntigravityProcess() AND isLanguageServer() — detect.js logic (see criteria above).`);

  const pollT0 = Date.now();
  let lspEntry = null;
  let timedOut = false;

  while (true) {
    R.pollCount++;
    const elapsed = Date.now() - pollT0;
    if (elapsed > VARIANT_D_TIMEOUT_MS) { timedOut = true; break; }

    try {
      const snap = listProcesses();
      lspEntry   = snap.find(isProfileLSP);
    } catch (err) {
      warn(`Poll #${R.pollCount}: scan error — ${err.message}`);
    }

    if (lspEntry) break;

    if (R.pollCount % 10 === 0) log(`      Poll #${R.pollCount}  (${elapsed} ms)…`);
    await sleep(POLL_INTERVAL_MS);
  }

  R.timeToLspMs = Date.now() - pollT0;
  R.lspPid      = lspEntry?.pid ?? null;

  if (lspEntry) {
    ok(`LSP found!  ${R.pollCount} polls / ${R.timeToLspMs} ms`);
    ok(`      PID  : ${lspEntry.pid}  ${lspEntry.name}`);
  } else {
    fail(`LSP NOT found within ${VARIANT_D_TIMEOUT_MS / 1000} s (${R.pollCount} polls).`);
    if (timedOut) fail('  → Timeout reached. The workspace arg may still not be triggering the extension host.');
    R.notes.push('LSP not detected');
  }

  // ── Diagnostic: dump all profile processes ───────────────────────────────────
  sep();
  log(`[diag] Full process dump — ALL profile processes currently running:`);
  const currentProcs = listProcesses().filter(isProfileProcess);
  dumpProfileProcesses('Profile processes at poll-end', currentProcs);

  if (!lspEntry) {
    const nodeServiceProcs = currentProcs.filter(p =>
      p.commandLine.toLowerCase().includes('node.mojom.nodeservice')
    );
    if (nodeServiceProcs.length > 0) {
      warn(`Using first NodeService process (PID ${nodeServiceProcs[0].pid}) as LSP stand-in.`);
      lspEntry = nodeServiceProcs[0];
      R.notes.push(`LSP stand-in: NodeService PID ${lspEntry.pid}`);
    } else {
      warn('No NodeService process either. Skipping port/token/query steps.');
    }
  }

  // ── 4. Extract port + CSRF ────────────────────────────────────────────────────
  sep();
  log(`[4/7] Extracting port and CSRF token…`);

  if (lspEntry) {
    const extracted = extractPortAndToken(lspEntry.commandLine, lspEntry.pid);
    R.port       = extracted.port;
    R.token      = extracted.token;
    R.portSource = extracted.source;

    if (R.port && R.token) {
      ok(`Port  : ${c(YE, R.port)}  (source: ${R.portSource})`);
      ok(`Token : ${c(YE, R.token)}`);
    } else {
      warn(`Could not extract from primary process (port=${R.port ?? 'null'}, token=${R.token ?? 'null'}).`);
      const nodeProcs = currentProcs.filter(p => p.commandLine.toLowerCase().includes('node.mojom.nodeservice'));
      for (const np of nodeProcs) {
        if (np.pid === lspEntry.pid) continue;
        const { port, token, source } = extractPortAndToken(np.commandLine, np.pid);
        if (port || token) {
          warn(`  → Found port=${port} / token=${token} on NodeService PID ${np.pid} (${source})`);
          if (!R.port  && port)  { R.port  = port;  R.portSource = source; }
          if (!R.token && token) { R.token = token; }
        }
      }
      if (!R.port && !R.token) {
        warn('Port/token NOT found in any cmdline or log file.');
        R.notes.push('port/token not extracted');
      }
    }
  } else {
    warn('No LSP process — skipping port/token extraction.');
    R.notes.push('no LSP process');
  }

  // ── 5. Query GetUserStatus ────────────────────────────────────────────────────
  sep();
  log(`[5/7] Querying GetUserStatus…`);

  if (R.port && R.token) {
    // The secure GetUserStatus endpoint listens on extension_server_port + 1,
    // NOT on extension_server_port itself.  Compute queryPort accordingly.
    const extPort = lspEntry ? extractExtensionServerPort(lspEntry.commandLine) : null;
    const queryPort = extPort !== null ? extPort + 1 : parseInt(R.port, 10);
    if (extPort !== null) {
      info(`extension_server_port = ${extPort}  →  queryPort = ${queryPort}  (extPort + 1)`);
    } else {
      warn(`--extension_server_port not found in cmdline; falling back to extracted port ${R.port}.`);
    }

    log(`      Waiting ${LSP_WARMUP_MS} ms for LSP HTTP server to finish initialising…`);
    await sleep(LSP_WARMUP_MS);
    log(`      POST https://127.0.0.1:${queryPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`);

    const q = await queryUserStatus(queryPort, R.token);
    R.queryOk         = q.ok;
    R.queryDurationMs = q.durationMs;

    if (q.ok) {
      R.queryStatus = q.status;
      ok(`HTTP ${q.status}  (${q.durationMs} ms)`);
      let body = q.body;
      if (body.length > 3000) body = body.slice(0, 3000) + '\n  … (truncated)';
      console.log(c(DI, body));
    } else {
      R.queryError = q.error;
      fail(`Query failed: ${q.error}  (${q.durationMs} ms)`);
      if (/ECONNREFUSED|ECONNRESET/.test(q.error)) {
        warn('Connection refused — LSP HTTP server may not have started yet, or wrong port.');
      }
    }
  } else {
    warn('No port/token — skipping query.');
    R.notes.push('query skipped');
  }

  // ── 6. Kill ───────────────────────────────────────────────────────────────────
  sep();
  log(`[6/7] Killing process tree  PID=${mainPid}  (taskkill /T /F)…`);

  const kr = killTree(mainPid);
  R.killOk = kr.ok;

  if (kr.ok) { ok('Kill succeeded.'); if (kr.stdout) log(`      ${kr.stdout.slice(0, 200)}`); }
  else        { fail('Kill reported error.'); if (kr.stderr) fail(`      ${kr.stderr.slice(0, 200)}`); }

  // ── 7. Orphan check ───────────────────────────────────────────────────────────
  sep();
  log(`[7/7] Waiting 2 s then scanning for orphaned processes…`);
  await sleep(2000);

  let orphans = [];
  try {
    orphans        = listProcesses().filter(isProfileProcess);
    R.orphansFound = orphans.length;
  } catch (err) {
    warn(`Orphan scan error: ${err.message}`);
    R.orphansFound = -1;
  }

  if (R.orphansFound === 0) {
    ok('No orphans — clean shutdown.');
  } else if (R.orphansFound > 0) {
    warn(`${R.orphansFound} orphaned process(es) still reference this profile:`);
    orphans.forEach(p => {
      warn(`  PID ${p.pid}  ${p.name}`);
      const k = killTree(p.pid);
      log(`  → kill ${k.ok ? 'OK' : 'FAILED: ' + k.stderr}`);
    });
  }

  R.totalMs = Date.now() - t0;
  return R;
}

// ─── Single lifecycle run ─────────────────────────────────────────────────────

async function lifecycleRun(runIndex) {
  console.log('\n' + c(BO, '═'.repeat(72)));
  console.log(c(BO, `  RUN ${runIndex} / ${RUN_COUNT}`));
  console.log(c(BO, '═'.repeat(72)));

  const R = {
    run: runIndex,
    coldBoot:        false,
    spawnMs:         null,
    pollCount:       0,
    timeToLspMs:     null,
    lspPid:          null,
    port:            null,
    token:           null,
    portSource:      null,
    queryOk:         false,
    queryStatus:     null,
    queryDurationMs: null,
    queryError:      null,
    killOk:          false,
    orphansFound:    null,
    notes:           [],
    totalMs:         null,
  };
  const t0 = Date.now();

  // ── 1. Pre-flight ──────────────────────────────────────────────────────────
  sep();
  log(`[1/7] Pre-flight: scanning for existing Antigravity profile processes…`);

  const existing = listProcesses().filter(isProfileProcess);
  if (existing.length > 0) {
    fail(`Found ${existing.length} existing process(es) using this profile:`);
    existing.forEach(p => fail(`      PID ${p.pid}  ${p.name}`));
    fail('');
    fail('  ► Please close Antigravity IDE completely, then re-run this script.');
    fail('    For a true cold-boot measurement all profile processes must be absent.');
    fail('');
    fail('  If you want to proceed anyway (WARM start), type  yes  and press Enter.');
    fail('  Any other key will exit.');

    // Non-interactive: just warn and continue so the script is runnable headlessly
    warn('Non-interactive mode: proceeding with WARM start. Timings will be inflated.');
    R.notes.push('WARM start');
  } else {
    ok('No existing profile processes — cold-boot confirmed.');
    R.coldBoot = true;
  }

  // ── 2. Spawn ───────────────────────────────────────────────────────────────
  sep();
  log(`[2/7] Spawning Antigravity (hidden mode — shell:false + windowsHide:true + --start-minimized)…`);
  log(`      EXE       : ${ANTIGRAVITY_EXE}`);
  log(`      Profile   : --user-data-dir=${USER_DATA_DIR}`);
  log(`      Workspace : ${VARIANT_D_WORKSPACE}`);

  const spawnArgs = [
    `--user-data-dir=${USER_DATA_DIR}`,
    '--start-minimized',   // Electron app-level: suppress window on startup
    '--no-sandbox',        // harmless if unsupported
    VARIANT_D_WORKSPACE,
  ];

  let child, mainPid;
  const spawnT0 = Date.now();
  try {
    child   = spawn(ANTIGRAVITY_EXE, spawnArgs, {
      shell:       false,   // shell:false so windowsHide applies to Electron directly
      detached:    false,
      windowsHide: true,   // OS-level flag to suppress console window
      stdio:       'ignore',
    });
    mainPid    = child.pid;
    R.spawnMs  = Date.now() - spawnT0;
    ok(`Spawned  PID=${mainPid}  (spawn() returned in ${R.spawnMs} ms)`);
    info('shell:false + windowsHide:true — NO window should appear on screen.');
  } catch (err) {
    fail(`Spawn failed: ${err.message}`);
    R.totalMs = Date.now() - t0;
    return R;
  }

  child.on('exit', (code, sig) => warn(`Main process PID=${mainPid} exited early  code=${code}  signal=${sig}`));

  // ── 3. Poll for LSP ────────────────────────────────────────────────────────
  sep();
  log(`[3/7] Polling every ${POLL_INTERVAL_MS} ms for Language Server (timeout ${POLL_TIMEOUT_MS / 1000} s)…`);
  log(`      Matching: isAntigravityProcess() AND isLanguageServer() — detect.js logic (see criteria above).`);

  const pollT0 = Date.now();
  let lspEntry = null;
  let timedOut = false;

  while (true) {
    R.pollCount++;
    const elapsed = Date.now() - pollT0;
    if (elapsed > POLL_TIMEOUT_MS) { timedOut = true; break; }

    try {
      const snap = listProcesses();
      lspEntry   = snap.find(isProfileLSP);
    } catch (err) {
      warn(`Poll #${R.pollCount}: scan error — ${err.message}`);
    }

    if (lspEntry) break;

    if (R.pollCount % 10 === 0) log(`      Poll #${R.pollCount}  (${elapsed} ms)…`);
    await sleep(POLL_INTERVAL_MS);
  }

  R.timeToLspMs = Date.now() - pollT0;
  R.lspPid      = lspEntry?.pid ?? null;

  if (lspEntry) {
    ok(`LSP found!  ${R.pollCount} polls / ${R.timeToLspMs} ms`);
    ok(`      PID  : ${lspEntry.pid}  ${lspEntry.name}`);
  } else {
    fail(`LSP NOT found within ${POLL_TIMEOUT_MS / 1000} s (${R.pollCount} polls).`);
    R.notes.push('LSP not detected');
  }

  // ── Diagnostic: always dump ALL profile processes at this point ────────────
  sep();
  log(`[diag] Full process dump — ALL profile processes currently running:`);
  const currentProcs = listProcesses().filter(isProfileProcess);
  dumpProfileProcesses('Profile processes at poll-end', currentProcs);

  if (!lspEntry) {
    // Try to use any NodeService process as a best-effort LSP stand-in
    const nodeServiceProcs = currentProcs.filter(p =>
      p.commandLine.toLowerCase().includes('node.mojom.nodeservice')
    );
    if (nodeServiceProcs.length > 0) {
      warn(`Using first NodeService process (PID ${nodeServiceProcs[0].pid}) as LSP stand-in for port/token extraction.`);
      lspEntry = nodeServiceProcs[0];
      R.notes.push(`LSP stand-in: NodeService PID ${lspEntry.pid}`);
    } else {
      warn('No NodeService process either. Skipping port/token/query steps.');
      // Still kill and orphan-check
    }
  }

  // ── 4. Extract port + CSRF ─────────────────────────────────────────────────
  sep();
  log(`[4/7] Extracting port and CSRF token…`);

  if (lspEntry) {
    const extracted = extractPortAndToken(lspEntry.commandLine, lspEntry.pid);
    R.port       = extracted.port;
    R.token      = extracted.token;
    R.portSource = extracted.source;

    if (R.port && R.token) {
      ok(`Port  : ${c(YE, R.port)}  (source: ${R.portSource})`);
      ok(`Token : ${c(YE, R.token)}`);
    } else {
      warn(`Could not extract from primary LSP process (port=${R.port ?? 'null'}, token=${R.token ?? 'null'}).`);
      warn(`Source tried: ${R.portSource}`);
      // Try ALL NodeService processes
      const nodeProcs = currentProcs.filter(p => p.commandLine.toLowerCase().includes('node.mojom.nodeservice'));
      for (const np of nodeProcs) {
        if (np.pid === lspEntry.pid) continue;
        const { port, token, source } = extractPortAndToken(np.commandLine, np.pid);
        if (port || token) {
          warn(`  → Found port=${port} / token=${token} on NodeService PID ${np.pid} (${source})`);
          if (!R.port  && port)  { R.port  = port;  R.portSource = source; }
          if (!R.token && token) { R.token = token; }
        }
      }

      if (!R.port && !R.token) {
        warn('Port/token NOT found in any cmdline or log file.');
        warn('Check the [diag] dump above — if the flags exist they will be visible there.');
        R.notes.push('port/token not extracted');
      }
    }
  } else {
    warn('No LSP process — skipping port/token extraction.');
    R.notes.push('no LSP process');
  }

  // ── 5. Query GetUserStatus ─────────────────────────────────────────────────
  sep();
  log(`[5/7] Querying GetUserStatus…`);

  if (R.port && R.token) {
    // The secure GetUserStatus endpoint listens on extension_server_port + 1,
    // NOT on extension_server_port itself.  Compute queryPort accordingly.
    const extPort = lspEntry ? extractExtensionServerPort(lspEntry.commandLine) : null;
    const queryPort = extPort !== null ? extPort + 1 : parseInt(R.port, 10);
    if (extPort !== null) {
      info(`extension_server_port = ${extPort}  →  queryPort = ${queryPort}  (extPort + 1)`);
    } else {
      warn(`--extension_server_port not found in cmdline; falling back to extracted port ${R.port}.`);
    }

    log(`      Waiting ${LSP_WARMUP_MS} ms for LSP HTTP server to finish initialising…`);
    await sleep(LSP_WARMUP_MS);
    log(`      POST https://127.0.0.1:${queryPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`);

    const q = await queryUserStatus(queryPort, R.token);
    R.queryOk         = q.ok;
    R.queryDurationMs = q.durationMs;

    if (q.ok) {
      R.queryStatus = q.status;
      ok(`HTTP ${q.status}  (${q.durationMs} ms)`);
      // Print response — trim if enormous
      let body = q.body;
      if (body.length > 3000) body = body.slice(0, 3000) + '\n  … (truncated)';
      console.log(c(DI, body));
    } else {
      R.queryError = q.error;
      fail(`Query failed: ${q.error}  (${q.durationMs} ms)`);

      if (/ECONNREFUSED|ECONNRESET/.test(q.error)) {
        warn('Connection refused — the LSP HTTP server may not have started yet,');
        warn('or the port we extracted is wrong.  Check the [diag] dump for the real port.');
      }
    }
  } else {
    warn('No port/token — skipping query.');
    R.notes.push('query skipped');
  }

  // ── 6. Kill process tree ───────────────────────────────────────────────────
  sep();
  log(`[6/7] Killing process tree  PID=${mainPid}  (taskkill /T /F)…`);

  const kr = killTree(mainPid);
  R.killOk = kr.ok;

  if (kr.ok) { ok('Kill succeeded.'); if (kr.stdout) log(`      ${kr.stdout.slice(0, 200)}`); }
  else        { fail('Kill reported error.'); if (kr.stderr) fail(`      ${kr.stderr.slice(0, 200)}`); }

  // ── 7. Orphan check ────────────────────────────────────────────────────────
  sep();
  log(`[7/7] Waiting 2 s then scanning for orphaned processes…`);
  await sleep(2000);

  let orphans = [];
  try {
    orphans      = listProcesses().filter(isProfileProcess);
    R.orphansFound = orphans.length;
  } catch (err) {
    warn(`Orphan scan error: ${err.message}`);
    R.orphansFound = -1;
  }

  if (R.orphansFound === 0) {
    ok('No orphans — clean shutdown.');
  } else if (R.orphansFound > 0) {
    warn(`${R.orphansFound} orphaned process(es) still reference this profile:`);
    orphans.forEach(p => {
      warn(`  PID ${p.pid}  ${p.name}`);
      const k = killTree(p.pid);
      log(`  → kill ${k.ok ? 'OK' : 'FAILED: ' + k.stderr}`);
    });
  }

  R.totalMs = Date.now() - t0;
  return R;
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummaryTable(results) {
  console.log('\n' + c(BO, '╔' + '═'.repeat(110) + '╗'));
  console.log(c(BO, '║  LIFECYCLE MEASUREMENT SUMMARY' + ' '.repeat(80) + '║'));
  console.log(c(BO, '╚' + '═'.repeat(110) + '╝'));

  const COLS = [
    { h: 'Run',        w: 4  },
    { h: 'ColdBoot',   w: 9  },
    { h: 'SpawnMs',    w: 9  },
    { h: 'LSP ms',     w: 8  },
    { h: 'Polls',      w: 6  },
    { h: 'Port',       w: 7  },
    { h: 'QueryOK',    w: 10 },
    { h: 'Query ms',   w: 9  },
    { h: 'Kill',       w: 6  },
    { h: 'Orphans',    w: 8  },
    { h: 'Total ms',   w: 9  },
    { h: 'Notes',      w: 30 },
  ];

  function row(cells) {
    return cells.map((v, i) => String(v ?? '—').padEnd(COLS[i].w)).join('  ');
  }

  console.log(c(CY,  row(COLS.map(c => c.h))));
  console.log(c(DI,  COLS.map(c => '─'.repeat(c.w)).join('  ')));

  for (const r of results) {
    const cells = [
      r.run,
      r.coldBoot      ? 'cold' : 'WARM',
      r.spawnMs       ?? '—',
      r.timeToLspMs   ?? '—',
      r.pollCount     ?? '—',
      r.port          ? r.port : '—',
      r.queryOk       ? `HTTP ${r.queryStatus}` : (r.queryError?.slice(0, 9) ?? '—'),
      r.queryDurationMs ?? '—',
      r.killOk        ? 'yes'  : 'no',
      r.orphansFound  === null ? '—' : r.orphansFound === -1 ? 'err' : String(r.orphansFound),
      r.totalMs       ?? '—',
      r.notes.join('; ') || '—',
    ];
    const allGood = r.coldBoot && r.port && r.queryOk && r.killOk && r.orphansFound === 0;
    console.log(allGood ? c(GR, row(cells)) : c(YE, row(cells)));
  }

  console.log(c(DI, COLS.map(c => '─'.repeat(c.w)).join('  ')));
  console.log('');

  // Averages
  const valid = results.filter(r => r.timeToLspMs !== null && r.spawnMs !== null);
  if (valid.length > 0) {
    const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0);
    console.log(c(MA, `  Averages over ${valid.length} run(s) where LSP was detected:`));
    console.log(c(MA, `    Spawn time      : ${avg(valid.map(r => r.spawnMs))} ms`));
    console.log(c(MA, `    Time-to-LSP     : ${avg(valid.map(r => r.timeToLspMs))} ms`));
    const qRuns = valid.filter(r => r.queryDurationMs !== null);
    if (qRuns.length > 0) {
      console.log(c(MA, `    Query latency   : ${avg(qRuns.map(r => r.queryDurationMs))} ms`));
    }
    console.log('');
  }
}

// ─── Manual-mode lifecycle run ────────────────────────────────────────────────

/**
 * MANUAL mode — single run:
 *   1. Pre-flight check
 *   2. Spawn with --user-data-dir=<profile> + bare workspace path (same as Variant D)
 *   3. PAUSE — wait for ENTER (user inspects Agents panel)
 *   4. Poll for LSP (60 s timeout) using detect.js isAntigravityProcess+isLanguageServer
 *   5. Extract port/token, run GetUserStatus query, report result
 *   6. PAUSE — wait for another ENTER before killing
 *   7. Kill process tree + orphan check
 */
async function lifecycleRunManual() {
  const MANUAL_TIMEOUT_MS = 60_000;

  console.log('\n' + c(BO, '═'.repeat(72)));
  console.log(c(BO, '  MANUAL MODE — spawn → ENTER → poll 60 s → query → ENTER → kill'));
  console.log(c(BO, '═'.repeat(72)));

  const R = {
    run:             'MANUAL',
    coldBoot:        false,
    spawnMs:         null,
    pollCount:       0,
    timeToLspMs:     null,
    lspPid:          null,
    port:            null,
    token:           null,
    portSource:      null,
    queryOk:         false,
    queryStatus:     null,
    queryDurationMs: null,
    queryError:      null,
    killOk:          false,
    orphansFound:    null,
    notes:           [],
    totalMs:         null,
  };
  const t0 = Date.now();

  // ── 1. Pre-flight ────────────────────────────────────────────────────────────
  sep();
  log('[1/7] Pre-flight: scanning for existing Antigravity profile processes…');

  const existing = listProcesses().filter(isProfileProcess);
  if (existing.length > 0) {
    fail(`Found ${existing.length} existing process(es) using this profile:`);
    existing.forEach(p => fail(`      PID ${p.pid}  ${p.name}`));
    warn('Proceeding with WARM start — timings will be inflated.');
    R.notes.push('WARM start');
  } else {
    ok('No existing profile processes — cold-boot confirmed.');
    R.coldBoot = true;
  }

  // ── 2. Spawn ─────────────────────────────────────────────────────────────────
  sep();
  log('[2/7] Spawning Antigravity (MANUAL mode, same args as Variant D)…');
  log(`      EXE       : ${ANTIGRAVITY_EXE}`);
  log(`      Profile   : --user-data-dir=${USER_DATA_DIR}`);
  log(`      Workspace : ${VARIANT_D_WORKSPACE}  (bare positional arg — VS Code convention)`);

  const spawnArgs = [
    `--user-data-dir=${USER_DATA_DIR}`,
    VARIANT_D_WORKSPACE,
  ];

  const exactCmdLine = `"${ANTIGRAVITY_EXE}" ${spawnArgs.join(' ')}`;
  log('      ─── EXACT COMMAND LINE ──────────────────────────────────────────────');
  log(`      ${exactCmdLine}`);
  log('      ─────────────────────────────────────────────────────────────────────');
  process.stderr.write(`\n[MANUAL CMDLINE]\n${exactCmdLine}\n`);

  let child, mainPid;
  const spawnT0 = Date.now();
  try {
    child = spawn(`"${ANTIGRAVITY_EXE}"`, spawnArgs, {
      shell:       true,
      detached:    false,
      windowsHide: false,   // window WILL appear — needed for manual inspection
      stdio:       'ignore',
    });
    mainPid   = child.pid;
    R.spawnMs = Date.now() - spawnT0;
    ok(`Spawned  PID=${mainPid}  (spawn() returned in ${R.spawnMs} ms)`);
  } catch (err) {
    fail(`Spawn failed: ${err.message}`);
    R.totalMs = Date.now() - t0;
    return R;
  }

  child.on('exit', (code, sig) => warn(`Main process PID=${mainPid} exited early  code=${code}  signal=${sig}`));

  // ── 3. PAUSE — let user inspect Agents panel ─────────────────────────────────
  sep();
  log('[3/7] Antigravity is now running.  Check the Agents panel now.');
  await waitForEnter('Press ENTER once you have checked the Agents panel state and are ready to proceed…');
  console.log('');
  ok('ENTER received — continuing to LSP poll.');

  // ── 4. Poll for LSP ──────────────────────────────────────────────────────────
  sep();
  log(`[4/7] Polling every ${POLL_INTERVAL_MS} ms for Language Server (timeout ${MANUAL_TIMEOUT_MS / 1000} s)…`);
  log('      Matching: isAntigravityProcess() AND isLanguageServer() — detect.js logic (see criteria above).');

  const pollT0 = Date.now();
  let lspEntry = null;
  let timedOut = false;

  while (true) {
    R.pollCount++;
    const elapsed = Date.now() - pollT0;
    if (elapsed > MANUAL_TIMEOUT_MS) { timedOut = true; break; }

    try {
      const snap = listProcesses();
      lspEntry   = snap.find(isProfileLSP);
    } catch (err) {
      warn(`Poll #${R.pollCount}: scan error — ${err.message}`);
    }

    if (lspEntry) break;

    if (R.pollCount % 10 === 0) log(`      Poll #${R.pollCount}  (${elapsed} ms)…`);
    await sleep(POLL_INTERVAL_MS);
  }

  R.timeToLspMs = Date.now() - pollT0;
  R.lspPid      = lspEntry?.pid ?? null;

  if (lspEntry) {
    ok(`LSP found!  ${R.pollCount} polls / ${R.timeToLspMs} ms`);
    ok(`      PID  : ${lspEntry.pid}  ${lspEntry.name}`);
    raw(lspEntry.pid, lspEntry.commandLine);
  } else {
    fail(`LSP NOT found within ${MANUAL_TIMEOUT_MS / 1000} s (${R.pollCount} polls).`);
    if (timedOut) fail('  → Timeout reached.');
    R.notes.push('LSP not detected');
  }

  // Diagnostic dump
  sep();
  log('[diag] Full process dump — ALL profile processes currently running:');
  const currentProcs = listProcesses().filter(isProfileProcess);
  dumpProfileProcesses('Profile processes at poll-end', currentProcs);

  if (!lspEntry) {
    const nodeServiceProcs = currentProcs.filter(p =>
      p.commandLine.toLowerCase().includes('node.mojom.nodeservice')
    );
    if (nodeServiceProcs.length > 0) {
      warn(`Using first NodeService process (PID ${nodeServiceProcs[0].pid}) as LSP stand-in.`);
      lspEntry = nodeServiceProcs[0];
      R.notes.push(`LSP stand-in: NodeService PID ${lspEntry.pid}`);
    } else {
      warn('No NodeService process either. Skipping port/token/query steps.');
    }
  }

  // ── 5. Extract CSRF token + discover ports via OS netstat ────────────────────
  sep();
  log('[5/7] Extracting CSRF token from cmdline + discovering listening ports via netstat…');

  // CSRF token is still carried in the cmdline; extract it first.
  let csrfToken = null;
  if (lspEntry) {
    const extracted = extractPortAndToken(lspEntry.commandLine, lspEntry.pid);
    csrfToken    = extracted.token;
    R.token      = csrfToken;
    R.portSource = 'netstat';

    if (csrfToken) {
      ok(`Token : ${c(YE, csrfToken)}  (source: cmdline)`);
    } else {
      warn('CSRF token NOT found in LSP cmdline.');
      // Try NodeService siblings as fallback
      const nodeProcs = currentProcs.filter(p =>
        p.commandLine.toLowerCase().includes('node.mojom.nodeservice') &&
        p.pid !== lspEntry.pid
      );
      for (const np of nodeProcs) {
        const { token, source } = extractPortAndToken(np.commandLine, np.pid);
        if (token) {
          warn(`  → Token found on NodeService PID ${np.pid} (${source}): ${token}`);
          csrfToken = token;
          R.token   = token;
          break;
        }
      }
      if (!csrfToken) {
        warn('CSRF token NOT found in any cmdline or log file.');
        R.notes.push('token not extracted');
      }
    }

    // ── Netstat port discovery ────────────────────────────────────────────────
    info(`Running: netstat -ano | findstr ${lspEntry.pid}  (looking for LISTENING ports)`);
    const listeningPorts = getListeningPortsForPid(lspEntry.pid);

    if (listeningPorts.length === 0) {
      warn(`No LISTENING ports found for PID ${lspEntry.pid} — process may not have bound its HTTP server yet.`);
      R.notes.push('no listening ports found');
    } else {
      ok(`Listening ports for PID ${lspEntry.pid}:  [ ${listeningPorts.join(', ')} ]`);
      // Store the first one as the canonical port for the summary table
      R.port = String(listeningPorts[0]);
    }
  } else {
    warn('No LSP process — skipping token/port extraction.');
    R.notes.push('no LSP process');
  }

  // ── 6. Query GetUserStatus — try EACH listening port ─────────────────────────
  sep();
  log('[6/7] Querying GetUserStatus against each listening port found…');

  if (lspEntry && csrfToken) {
    const listeningPorts = getListeningPortsForPid(lspEntry.pid);

    if (listeningPorts.length === 0) {
      warn('No listening ports to try — skipping query.');
      R.notes.push('query skipped (no ports)');
    } else {
      log(`      Waiting ${LSP_WARMUP_MS} ms for LSP HTTP server to finish initialising…`);
      await sleep(LSP_WARMUP_MS);

      // Re-fetch ports after warmup in case new ones appeared
      const candidatePorts = getListeningPortsForPid(lspEntry.pid);
      info(`Candidate ports after warmup for PID ${lspEntry.pid}:  [ ${candidatePorts.join(', ')} ]`);

      let winnerPort = null;
      let winnerResult = null;

      for (const port of candidatePorts) {
        log(`      Trying port ${port} → POST https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`);
        const q = await queryUserStatus(port, csrfToken);

        if (q.ok) {
          // Got an HTTP response (any status) — this is the real endpoint
          ok(`  ✔ port ${port}: HTTP ${q.status}  (${q.durationMs} ms)  ← REAL ENDPOINT`);
          if (q.body) {
            let body = q.body;
            if (body.length > 3000) body = body.slice(0, 3000) + '\n  … (truncated)';
            console.log(c(DI, body));
          }
          winnerPort   = port;
          winnerResult = q;
        } else {
          // No HTTP response — ECONNREFUSED / SSL error / timeout
          info(`  ✘ port ${port}: ${q.error}  (${q.durationMs} ms)  — not the query endpoint`);
        }

        if (winnerPort !== null) break;  // stop at first working port
      }

      if (winnerPort !== null) {
        R.port            = String(winnerPort);
        R.portSource      = 'netstat-probe';
        R.queryOk         = winnerResult.ok;
        R.queryStatus     = winnerResult.status;
        R.queryDurationMs = winnerResult.durationMs;
        ok(`GetUserStatus succeeded on port ${winnerPort}  (HTTP ${winnerResult.status}).`);
      } else {
        fail('GetUserStatus FAILED on all candidate ports.');
        R.queryError = 'all ports refused / errored';
        R.notes.push('all ports failed');
      }
    }
  } else if (!csrfToken) {
    warn('No CSRF token — skipping query.');
    R.notes.push('query skipped (no token)');
  } else {
    warn('No LSP process — skipping query.');
    R.notes.push('query skipped (no LSP)');
  }

  // ── PAUSE before kill — confirm result first ──────────────────────────────────
  sep();
  log('[pre-kill] Query complete. Review results above.');
  await waitForEnter('Press ENTER to kill the process tree and proceed to orphan check…');
  console.log('');

  // ── 7. Kill ───────────────────────────────────────────────────────────────────
  sep();
  log(`[7/7] Killing process tree  PID=${mainPid}  (taskkill /T /F)…`);

  const kr = killTree(mainPid);
  R.killOk = kr.ok;

  if (kr.ok) { ok('Kill succeeded.'); if (kr.stdout) log(`      ${kr.stdout.slice(0, 200)}`); }
  else        { fail('Kill reported error.'); if (kr.stderr) fail(`      ${kr.stderr.slice(0, 200)}`); }

  // ── Orphan check ──────────────────────────────────────────────────────────────
  sep();
  log('[orphan] Waiting 2 s then scanning for orphaned processes…');
  await sleep(2000);

  let orphans = [];
  try {
    orphans        = listProcesses().filter(isProfileProcess);
    R.orphansFound = orphans.length;
  } catch (err) {
    warn(`Orphan scan error: ${err.message}`);
    R.orphansFound = -1;
  }

  if (R.orphansFound === 0) {
    ok('No orphans — clean shutdown.');
  } else if (R.orphansFound > 0) {
    warn(`${R.orphansFound} orphaned process(es) still reference this profile:`);
    orphans.forEach(p => {
      warn(`  PID ${p.pid}  ${p.name}`);
      const k = killTree(p.pid);
      log(`  → kill ${k.ok ? 'OK' : 'FAILED: ' + k.stderr}`);
    });
  }

  R.totalMs = Date.now() - t0;
  return R;
}

// ─── Manual-hidden-mode lifecycle run ───────────────────────────────────────

/**
 * MANUAL-HIDDEN mode — single run:
 *
 * Identical to lifecycleRunManual() in every detail EXCEPT:
 *   - spawn() uses windowsHide: true  (OS suppresses the console/window)
 *
 * Use this to verify that the IDE still boots and the LSP still appears
 * when the process is started invisibly, which is how the Electron main
 * process will launch it in the next phase.
 *
 * Steps:
 *   1. Pre-flight check
 *   2. Spawn with windowsHide: true (no window will appear)
 *   3. PAUSE — wait for ENTER
 *   4. Poll for LSP (60 s timeout)
 *   5. Extract CSRF token + discover listening ports via netstat
 *   6. Query GetUserStatus against each listening port
 *   7. PAUSE — wait for ENTER before killing
 *   8. Kill process tree + orphan check
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoMode=false]  If true, replace ENTER pauses with
 *                                         automatic timed waits (fully hands-free).
 */
async function lifecycleRunManualHidden({ autoMode = false } = {}) {
  const MANUAL_TIMEOUT_MS = 60_000;

  const modeLabel = autoMode
    ? 'AUTO-HIDDEN MODE — windowsHide:true → spawn → auto-wait → poll 60 s → query → kill'
    : 'MANUAL-HIDDEN MODE — windowsHide:true → spawn → ENTER → poll 60 s → query → ENTER → kill';

  console.log('\n' + c(BO, '═'.repeat(72)));
  console.log(c(BO, `  ${modeLabel}`));
  console.log(c(BO, '═'.repeat(72)));

  const R = {
    run:             'MANUAL-HIDDEN',
    coldBoot:        false,
    spawnMs:         null,
    pollCount:       0,
    timeToLspMs:     null,
    lspPid:          null,
    port:            null,
    token:           null,
    portSource:      null,
    queryOk:         false,
    queryStatus:     null,
    queryDurationMs: null,
    queryError:      null,
    killOk:          false,
    orphansFound:    null,
    notes:           [],
    totalMs:         null,
  };
  const t0 = Date.now();

  // ── 1. Pre-flight ────────────────────────────────────────────────────────────
  sep();
  log('[1/7] Pre-flight: scanning for existing Antigravity profile processes…');

  const existing = listProcesses().filter(isProfileProcess);
  if (existing.length > 0) {
    fail(`Found ${existing.length} existing process(es) using this profile:`);
    existing.forEach(p => fail(`      PID ${p.pid}  ${p.name}`));
    warn('Proceeding with WARM start — timings will be inflated.');
    R.notes.push('WARM start');
  } else {
    ok('No existing profile processes — cold-boot confirmed.');
    R.coldBoot = true;
  }

  // ── 2. Spawn (windowsHide: true, shell: false) ──────────────────────────────
  //
  //  IMPORTANT — why shell:false is required to truly hide the window:
  //    When shell:true is used, Node spawns a cmd.exe intermediary first.
  //    windowsHide hides that cmd.exe window, but Electron (the child of cmd.exe)
  //    still creates its own GUI window via the OS because it is not a child of
  //    the hidden shell — it is a grandchild that inherits no window-hide flag.
  //
  //    With shell:false, Node calls CreateProcess() directly on the EXE, and the
  //    CREATE_NO_WINDOW / DETACHED_PROCESS flags that windowsHide sets apply
  //    directly to the Electron process, which suppresses its initial window.
  //
  //    Additionally, --start-minimized is passed as an Electron argv flag so the
  //    app-level window manager also knows not to show a window on startup.
  //
  sep();
  log('[2/7] Spawning Antigravity (hidden mode — shell:false + windowsHide:true + --start-minimized)…');
  log(`      EXE       : ${ANTIGRAVITY_EXE}`);
  log(`      Profile   : --user-data-dir=${USER_DATA_DIR}`);
  log(`      Workspace : ${VARIANT_D_WORKSPACE}  (bare positional arg — VS Code convention)`);
  log('      shell:false + windowsHide:true + --start-minimized — NO visible window should appear');

  const spawnArgs = [
    `--user-data-dir=${USER_DATA_DIR}`,
    '--start-minimized',   // Electron app-level: suppress window on startup
    '--no-sandbox',        // harmless if unsupported; avoids sandbox init window
    VARIANT_D_WORKSPACE,
  ];

  const exactCmdLine = `"${ANTIGRAVITY_EXE}" ${spawnArgs.join(' ')}`;
  log('      ─── EXACT COMMAND LINE ──────────────────────────────────────────────');
  log(`      ${exactCmdLine}`);
  log('      ─────────────────────────────────────────────────────────────────────');
  process.stderr.write(`\n[AUTO-HIDDEN CMDLINE]\n${exactCmdLine}\n`);

  let child, mainPid;
  const spawnT0 = Date.now();
  try {
    // shell:false → Node calls CreateProcess() directly on the EXE.
    // windowsHide:true → sets CREATE_NO_WINDOW so the Electron process has no
    //   visible window from the very first OS call.
    child = spawn(ANTIGRAVITY_EXE, spawnArgs, {
      shell:       false,   // ← critical: skip cmd.exe so windowsHide applies to Electron
      detached:    false,
      windowsHide: true,    // ← suppress window at OS level (CREATE_NO_WINDOW)
      stdio:       'ignore',
    });
    mainPid   = child.pid;
    R.spawnMs = Date.now() - spawnT0;
    ok(`Spawned  PID=${mainPid}  (spawn() returned in ${R.spawnMs} ms)`);
    info('shell:false + windowsHide:true — NO new window should appear on your desktop.');
  } catch (err) {
    fail(`Spawn failed: ${err.message}`);
    R.totalMs = Date.now() - t0;
    return R;
  }

  child.on('exit', (code, sig) => warn(`Main process PID=${mainPid} exited early  code=${code}  signal=${sig}`));

  // ── 3. Wait for process to initialise ────────────────────────────────────────
  sep();
  if (autoMode) {
    const INIT_WAIT_S = 5;
    log(`[3/7] Auto-mode: waiting ${INIT_WAIT_S} s for process to initialise (no ENTER needed).`);
    await sleep(INIT_WAIT_S * 1000);
    ok(`${INIT_WAIT_S} s elapsed — continuing to LSP poll.`);
  } else {
    log('[3/7] Antigravity should now be running WITHOUT a visible window.');
    log('      Open Task Manager → Details tab and verify the process exists.');
    await waitForEnter('Press ENTER once you have verified the process is running (or not) and are ready to proceed…');
    console.log('');
    ok('ENTER received — continuing to LSP poll.');
  }

  // ── 4. Poll for LSP ──────────────────────────────────────────────────────────
  sep();
  log(`[4/7] Polling every ${POLL_INTERVAL_MS} ms for Language Server (timeout ${MANUAL_TIMEOUT_MS / 1000} s)…`);
  log('      Matching: isAntigravityProcess() AND isLanguageServer() — detect.js logic (see criteria above).');

  const pollT0 = Date.now();
  let lspEntry = null;
  let timedOut = false;

  while (true) {
    R.pollCount++;
    const elapsed = Date.now() - pollT0;
    if (elapsed > MANUAL_TIMEOUT_MS) { timedOut = true; break; }

    try {
      const snap = listProcesses();
      lspEntry   = snap.find(isProfileLSP);
    } catch (err) {
      warn(`Poll #${R.pollCount}: scan error — ${err.message}`);
    }

    if (lspEntry) break;

    if (R.pollCount % 10 === 0) log(`      Poll #${R.pollCount}  (${elapsed} ms)…`);
    await sleep(POLL_INTERVAL_MS);
  }

  R.timeToLspMs = Date.now() - pollT0;
  R.lspPid      = lspEntry?.pid ?? null;

  if (lspEntry) {
    ok(`LSP found!  ${R.pollCount} polls / ${R.timeToLspMs} ms`);
    ok(`      PID  : ${lspEntry.pid}  ${lspEntry.name}`);
    raw(lspEntry.pid, lspEntry.commandLine);
  } else {
    fail(`LSP NOT found within ${MANUAL_TIMEOUT_MS / 1000} s (${R.pollCount} polls).`);
    if (timedOut) fail('  → Timeout reached.');
    R.notes.push('LSP not detected');
  }

  // Diagnostic dump
  sep();
  log('[diag] Full process dump — ALL profile processes currently running:');
  const currentProcs = listProcesses().filter(isProfileProcess);
  dumpProfileProcesses('Profile processes at poll-end', currentProcs);

  if (!lspEntry) {
    const nodeServiceProcs = currentProcs.filter(p =>
      p.commandLine.toLowerCase().includes('node.mojom.nodeservice')
    );
    if (nodeServiceProcs.length > 0) {
      warn(`Using first NodeService process (PID ${nodeServiceProcs[0].pid}) as LSP stand-in.`);
      lspEntry = nodeServiceProcs[0];
      R.notes.push(`LSP stand-in: NodeService PID ${lspEntry.pid}`);
    } else {
      warn('No NodeService process either. Skipping port/token/query steps.');
    }
  }

  // ── 5. Extract CSRF token + discover ports via OS netstat ────────────────────
  sep();
  log('[5/7] Extracting CSRF token from cmdline + discovering listening ports via netstat…');

  let csrfToken = null;
  if (lspEntry) {
    const extracted = extractPortAndToken(lspEntry.commandLine, lspEntry.pid);
    csrfToken    = extracted.token;
    R.token      = csrfToken;
    R.portSource = 'netstat';

    if (csrfToken) {
      ok(`Token : ${c(YE, csrfToken)}  (source: cmdline)`);
    } else {
      warn('CSRF token NOT found in LSP cmdline.');
      // Try NodeService siblings as fallback
      const nodeProcs = currentProcs.filter(p =>
        p.commandLine.toLowerCase().includes('node.mojom.nodeservice') &&
        p.pid !== lspEntry.pid
      );
      for (const np of nodeProcs) {
        const { token, source } = extractPortAndToken(np.commandLine, np.pid);
        if (token) {
          warn(`  → Token found on NodeService PID ${np.pid} (${source}): ${token}`);
          csrfToken = token;
          R.token   = token;
          break;
        }
      }
      if (!csrfToken) {
        warn('CSRF token NOT found in any cmdline or log file.');
        R.notes.push('token not extracted');
      }
    }

    // ── Netstat port discovery ────────────────────────────────────────────────
    info(`Running: netstat -ano | findstr ${lspEntry.pid}  (looking for LISTENING ports)`);
    const listeningPorts = getListeningPortsForPid(lspEntry.pid);

    if (listeningPorts.length === 0) {
      warn(`No LISTENING ports found for PID ${lspEntry.pid} — process may not have bound its HTTP server yet.`);
      R.notes.push('no listening ports found');
    } else {
      ok(`Listening ports for PID ${lspEntry.pid}:  [ ${listeningPorts.join(', ')} ]`);
      R.port = String(listeningPorts[0]);
    }
  } else {
    warn('No LSP process — skipping token/port extraction.');
    R.notes.push('no LSP process');
  }

  // ── 6. Query GetUserStatus — try EACH listening port ─────────────────────────
  sep();
  log('[6/7] Querying GetUserStatus against each listening port found…');

  if (lspEntry && csrfToken) {
    const listeningPorts = getListeningPortsForPid(lspEntry.pid);

    if (listeningPorts.length === 0) {
      warn('No listening ports to try — skipping query.');
      R.notes.push('query skipped (no ports)');
    } else {
      log(`      Waiting ${LSP_WARMUP_MS} ms for LSP HTTP server to finish initialising…`);
      await sleep(LSP_WARMUP_MS);

      const candidatePorts = getListeningPortsForPid(lspEntry.pid);
      info(`Candidate ports after warmup for PID ${lspEntry.pid}:  [ ${candidatePorts.join(', ')} ]`);

      let winnerPort = null;
      let winnerResult = null;

      for (const port of candidatePorts) {
        log(`      Trying port ${port} → POST https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`);
        const q = await queryUserStatus(port, csrfToken);

        if (q.ok) {
          ok(`  ✔ port ${port}: HTTP ${q.status}  (${q.durationMs} ms)  ← REAL ENDPOINT`);
          if (q.body) {
            let body = q.body;
            if (body.length > 3000) body = body.slice(0, 3000) + '\n  … (truncated)';
            console.log(c(DI, body));
          }
          winnerPort   = port;
          winnerResult = q;
        } else {
          info(`  ✘ port ${port}: ${q.error}  (${q.durationMs} ms)  — not the query endpoint`);
        }

        if (winnerPort !== null) break;
      }

      if (winnerPort !== null) {
        R.port            = String(winnerPort);
        R.portSource      = 'netstat-probe';
        R.queryOk         = winnerResult.ok;
        R.queryStatus     = winnerResult.status;
        R.queryDurationMs = winnerResult.durationMs;
        ok(`GetUserStatus succeeded on port ${winnerPort}  (HTTP ${winnerResult.status}).`);
      } else {
        fail('GetUserStatus FAILED on all candidate ports.');
        R.queryError = 'all ports refused / errored';
        R.notes.push('all ports failed');
      }
    }
  } else if (!csrfToken) {
    warn('No CSRF token — skipping query.');
    R.notes.push('query skipped (no token)');
  } else {
    warn('No LSP process — skipping query.');
    R.notes.push('query skipped (no LSP)');
  }

  // ── PAUSE before kill (or auto-proceed) ─────────────────────────────────────
  sep();
  log('[pre-kill] Query complete. Review results above.');
  if (autoMode) {
    log('Auto-mode: proceeding to kill immediately.');
  } else {
    await waitForEnter('Press ENTER to kill the process tree and proceed to orphan check…');
    console.log('');
  }

  // ── 7. Kill ───────────────────────────────────────────────────────────────────
  sep();
  log(`[7/7] Killing process tree  PID=${mainPid}  (taskkill /T /F)…`);

  const kr = killTree(mainPid);
  R.killOk = kr.ok;

  if (kr.ok) { ok('Kill succeeded.'); if (kr.stdout) log(`      ${kr.stdout.slice(0, 200)}`); }
  else        { fail('Kill reported error.'); if (kr.stderr) fail(`      ${kr.stderr.slice(0, 200)}`); }

  // ── Orphan check ──────────────────────────────────────────────────────────────
  sep();
  log('[orphan] Waiting 2 s then scanning for orphaned processes…');
  await sleep(2000);

  let orphans = [];
  try {
    orphans        = listProcesses().filter(isProfileProcess);
    R.orphansFound = orphans.length;
  } catch (err) {
    warn(`Orphan scan error: ${err.message}`);
    R.orphansFound = -1;
  }

  if (R.orphansFound === 0) {
    ok('No orphans — clean shutdown.');
  } else if (R.orphansFound > 0) {
    warn(`${R.orphansFound} orphaned process(es) still reference this profile:`);
    orphans.forEach(p => {
      warn(`  PID ${p.pid}  ${p.name}`);
      const k = killTree(p.pid);
      log(`  → kill ${k.ok ? 'OK' : 'FAILED: ' + k.stderr}`);
    });
  }

  R.totalMs = Date.now() - t0;
  return R;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isVariantD     = process.argv.includes('--variant-d');
  const isManual       = process.argv.includes('--manual');
  const isManualHidden = process.argv.includes('--manual-hidden');
  const isMultiRun     = process.argv.includes('--multi-run');
  // Default to AUTO-HIDDEN (automatic hands-free execution with windowsHide: true) unless another mode flag is specified
  const isAutoHidden   = process.argv.includes('--auto-hidden') || (!isVariantD && !isManual && !isManualHidden && !isMultiRun);

  if (isAutoHidden) {
    // ── AUTO-HIDDEN mode (fully hands-free, no ENTER prompts) ──────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4  [AUTO-HIDDEN]' + ' '.repeat(11) + '║'));
    console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
    console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
    console.log(c(DI, '  Mode          : AUTO-HIDDEN (shell:false + windowsHide:true + --start-minimized, no ENTER needed)'));
    console.log(c(DI, `  Poll interval : ${POLL_INTERVAL_MS} ms`));
    console.log(c(DI, '  Poll timeout  : 60 s'));
    console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
    console.log(c(DI, `  Profile dir   : ${USER_DATA_DIR}`));
    console.log(c(DI, `  Workspace arg : ${VARIANT_D_WORKSPACE}  (bare positional, no flag)`));
    console.log(c(YE, '  NOTE          : shell:false + windowsHide:true + --start-minimized'));
    console.log(c(YE, '                  NO window should appear. Runs fully unattended.'));
    console.log('');
    printDetectionCriteria();

    const result = await lifecycleRunManualHidden({ autoMode: true });
    log(`Auto-hidden run complete. Total: ${result.totalMs} ms.`);
    printSummaryTable([result]);

    sep();
    if (result.timeToLspMs !== null && result.lspPid) {
      ok(c(GR, `AUTO-HIDDEN RESULT: Language Server WAS detected in ${result.timeToLspMs} ms.`));
      ok('shell:false + windowsHide:true does NOT prevent the LSP from starting — safe to use in Electron main.');
    } else {
      fail(c(RE, 'AUTO-HIDDEN RESULT: Language Server was NOT detected within 60 s.'));
      fail('Check the [diag] process dump above for clues.');
    }
    sep();

  } else if (isManualHidden) {
    // ── MANUAL-HIDDEN mode ──────────────────────────────────────────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4  [MANUAL-HIDDEN]' + ' '.repeat(9) + '║'));
    console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
    console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
    console.log(c(DI, '  Mode          : MANUAL-HIDDEN (windowsHide:true → spawn → ENTER → poll 60 s → query → ENTER → kill)'));
    console.log(c(DI, `  Poll interval : ${POLL_INTERVAL_MS} ms`));
    console.log(c(DI, '  Poll timeout  : 60 s'));
    console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
    console.log(c(DI, `  Profile dir   : ${USER_DATA_DIR}`));
    console.log(c(DI, `  Workspace arg : ${VARIANT_D_WORKSPACE}  (bare positional, no flag)`));
    console.log(c(YE, '  NOTE          : windowsHide=true — NO window should appear on screen'));
    console.log('');
    printDetectionCriteria();

    const result = await lifecycleRunManualHidden({ autoMode: false });
    log(`Manual-hidden run complete. Total: ${result.totalMs} ms.`);
    printSummaryTable([result]);

    sep();
    if (result.timeToLspMs !== null && result.lspPid) {
      ok(c(GR, `MANUAL-HIDDEN RESULT: Language Server WAS detected in ${result.timeToLspMs} ms.`));
      ok('windowsHide:true does NOT prevent the LSP from starting — safe to use in Electron main.');
    } else {
      fail(c(RE, 'MANUAL-HIDDEN RESULT: Language Server was NOT detected within 60 s.'));
      fail('Check the [diag] process dump above for clues.');
    }
    sep();

  } else if (isManual) {
    // ── MANUAL mode ────────────────────────────────────────────────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4  [MANUAL]' + ' '.repeat(17) + '║'));
    console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
    console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
    console.log(c(DI, '  Mode          : MANUAL (spawn → ENTER → poll 60 s → query → ENTER → kill)'));
    console.log(c(DI, `  Poll interval : ${POLL_INTERVAL_MS} ms`));
    console.log(c(DI, '  Poll timeout  : 60 s'));
    console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
    console.log(c(DI, `  Profile dir   : ${USER_DATA_DIR}`));
    console.log(c(DI, `  Workspace arg : ${VARIANT_D_WORKSPACE}  (bare positional, no flag)`));
    console.log(c(YE, '  NOTE          : windowsHide=false — window WILL appear visibly on screen'));
    console.log('');
    printDetectionCriteria();

    const result = await lifecycleRunManual();
    log(`Manual run complete. Total: ${result.totalMs} ms.`);
    printSummaryTable([result]);

    sep();
    if (result.timeToLspMs !== null && result.lspPid) {
      ok(c(GR, `MANUAL RESULT: Language Server WAS detected in ${result.timeToLspMs} ms.`));
    } else {
      fail(c(RE, 'MANUAL RESULT: Language Server was NOT detected within 60 s.'));
      fail('Check the [diag] process dump above for clues.');
    }
    sep();

  } else if (isVariantD) {
    // ── Variant D mode ─────────────────────────────────────────────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4  [VARIANT D]' + ' '.repeat(14) + '║'));
    console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
    console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
    console.log(c(DI, `  Mode          : Variant D (bare workspace-folder arg, 30 s timeout)`));
    console.log(c(DI, `  Poll interval : ${POLL_INTERVAL_MS} ms`));
    console.log(c(DI, `  Poll timeout  : ${VARIANT_D_TIMEOUT_MS / 1000} s  ← shorter for fast iteration`));
    console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
    console.log(c(DI, `  Profile dir   : ${USER_DATA_DIR}`));
    console.log(c(DI, `  Workspace arg : ${VARIANT_D_WORKSPACE}  (bare positional, no flag)`));
    console.log(c(YE, `  NOTE          : windowsHide=false — window WILL appear visibly on screen`));
    console.log('');
    printDetectionCriteria();

    const result = await lifecycleRunVariantD();
    log(`Variant D complete. Total: ${result.totalMs} ms.`);
    printSummaryTable([result]);

    // Final verdict
    sep();
    if (result.timeToLspMs !== null && result.lspPid) {
      ok(c(GR, `VARIANT D RESULT: Language Server WAS detected in ${result.timeToLspMs} ms.`));
      ok('The workspace argument appears to have triggered the extension host.');
    } else {
      fail(c(RE, 'VARIANT D RESULT: Language Server was NOT detected within 30 s.'));
      fail('Next steps to try:');
      fail('  1. Check the [diag] process dump above — does an extension host process exist');
      fail('     but with a different cmdline signature not matched by isProfileLSP()?');
      fail('  2. Try --folder-uri=file:///C:/Users/VISHESH/Desktop/lune instead of a bare path.');
      fail('  3. Increase VARIANT_D_TIMEOUT_MS and try again.');
    }
    sep();

  } else if (isMultiRun) {
    // ── Multi-run mode ──────────────────────────────────────────────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4  [MULTI-RUN]' + ' '.repeat(13) + '║'));
    console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
    console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
    console.log(c(DI, `  Runs          : ${RUN_COUNT}`));
    console.log(c(DI, `  Poll interval : ${POLL_INTERVAL_MS} ms`));
    console.log(c(DI, `  Poll timeout  : ${POLL_TIMEOUT_MS / 1000} s`));
    console.log(c(DI, `  Between runs  : ${BETWEEN_RUNS_S} s`));
    console.log(c(DI, `  EXE           : ${ANTIGRAVITY_EXE}`));
    console.log(c(DI, `  Profile dir   : ${USER_DATA_DIR}`));
    console.log('');
    printDetectionCriteria();

    const allResults = [];

    for (let i = 1; i <= RUN_COUNT; i++) {
      const result = await lifecycleRun(i);
      allResults.push(result);
      log(`Run ${i} complete. Total: ${result.totalMs} ms.`);

      if (i < RUN_COUNT) {
        sep();
        log(`Waiting ${BETWEEN_RUNS_S} s before run ${i + 1}…`);
        await sleep(BETWEEN_RUNS_S * 1000);
      }
    }

    printSummaryTable(allResults);
  }
}

main().catch(err => {
  console.error(c(RE, `\nFatal: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
