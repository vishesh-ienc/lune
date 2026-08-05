#!/usr/bin/env node

/**
 * detect.js
 *
 * Detects the Antigravity IDE background Language Server process.
 * Antigravity is a VS Code fork (Electron-based); it spawns a separate
 * Language Server process we want to identify.
 *
 * Usage:
 *   node detect.js
 *
 * Supports: Windows (wmic), macOS / Linux (ps)
 */

'use strict';

const { execSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Keywords used to decide whether a process belongs to Antigravity.
 * A process matches if ANY of its command-line tokens contain one of these
 * strings (case-insensitive).
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
 * Add platform-specific variants here if Antigravity ships renamed binaries
 * in future releases.
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
 * Example: rg.exe (ripgrep) is spawned transiently during workspace indexing;
 * its glob exclusion flags (e.g. "-g !**\/.ruby-lsp") contain the substring
 * "lsp", which previously triggered a false positive in isLanguageServer().
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
 * specifically. If no process matches these, we still report all Antigravity
 * processes so the user can inspect them manually.
 *
 * Hints discovered from a live Antigravity IDE process scan:
 *   - serverWorkerMain  : language server worker (e.g. markdown-language-features)
 *   - --node-ipc        : VS Code IPC channel used by all LSP worker processes
 *   - --clientProcessId : companion flag to --node-ipc, always present on LSP workers
 *   - typingsInstaller  : TypeScript language server component
 *   - extensionHost     : main extension host (hosts LSP clients)
 *
 * NOTE: These hints are a FALLBACK only.  The primary detection path is an
 * exact match against KNOWN_LSP_EXACT_NAMES (see isLanguageServer()).
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

// ─── Platform detection ───────────────────────────────────────────────────────

const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'

// ─── Process listing ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProcessEntry
 * @property {string} pid         - Process ID
 * @property {string} name        - Executable / image name
 * @property {string} commandLine - Full command line string
 */

/**
 * Fetch all running processes with their PIDs and full command lines.
 * Returns an array of ProcessEntry objects.
 *
 * @returns {ProcessEntry[]}
 */
function listProcesses() {
  if (PLATFORM === 'win32') {
    return listProcessesWindows();
  }
  return listProcessesUnix();
}

// ── Windows via PowerShell (Get-CimInstance) ─────────────────────────────────
// wmic is deprecated / removed on Windows 11 24H2+; PowerShell works everywhere.

function listProcessesWindows() {
  // Ask PowerShell to emit CSV so we don't have to deal with fixed-width columns.
  // ConvertTo-Csv always uses a comma delimiter and double-quotes fields that
  // contain commas, making splitCsvLine() safe to use.
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,Name,CommandLine',
    '| ConvertTo-Csv -NoTypeInformation',
  ].join(' ');

  const raw = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
    { encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 }
  );

  const lines = raw.split(/\r?\n/).filter(Boolean);

  // First line is the header: "ProcessId","Name","CommandLine"
  const headerLine = lines[0];
  if (!headerLine || !headerLine.toLowerCase().includes('processid')) {
    throw new Error('Could not parse PowerShell output – unexpected format.');
  }

  const headers = splitCsvLine(headerLine).map((h) => h.replace(/"/g, '').trim().toLowerCase());
  const idxPid  = headers.indexOf('processid');
  const idxName = headers.indexOf('name');
  const idxCmd  = headers.indexOf('commandline');

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxName, idxCmd)) continue;

    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim(); // strip outer quotes only

    if (!pid || !/^\d+$/.test(pid)) continue; // skip non-numeric PIDs

    entries.push({ pid, name, commandLine });
  }

  return entries;
}

/**
 * Minimal CSV line splitter that respects double-quoted fields.
 * Handles the comma-inside-quotes case produced by WMIC.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Handle escaped double-quote ("") inside a quoted field
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

// ── macOS / Linux via ps ──────────────────────────────────────────────────────

function listProcessesUnix() {
  // -A  : every process
  // -o  : custom output columns (no headers with =)
  // comm: basename of the executable
  // args: full argument list (includes executable path)
  const raw = execSync('ps -A -o pid=,comm=,args=', {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50 MB – plenty for large process lists
  });

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Format: <pid> <comm> <args…>
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)/);
    if (!match) continue;

    const [, pid, name, rest] = match;
    // args column from `ps` already includes argv[0], so the full command
    // line is just `rest`.
    entries.push({ pid, name, commandLine: rest.trim() });
  }

  return entries;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Returns true if the process entry looks like an Antigravity process.
 *
 * @param {ProcessEntry} entry
 * @returns {boolean}
 */
function isAntigravityProcess(entry) {
  const haystack = `${entry.name} ${entry.commandLine}`.toLowerCase();
  return ANTIGRAVITY_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
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
  return LANGUAGE_SERVER_HINTS.some((hint) => haystack.includes(hint.toLowerCase()));
}

// ─── Port extraction ──────────────────────────────────────────────────────────

/**
 * Scans the command-line string for arguments that look like they specify a
 * port number, e.g.:
 *   --port=1234
 *   --port 1234
 *   --lsp-port=5678
 *   :3000
 *
 * @param {string} commandLine
 * @returns {{ flag: string; port: string }[]}
 */
function extractPorts(commandLine) {
  const results = [];

  // Pattern 1: --<something>port[=| ]<number>
  const flagPattern = /(-{1,2}[\w-]*port[\w-]*)[=\s]+(\d{2,5})/gi;
  let m;
  while ((m = flagPattern.exec(commandLine)) !== null) {
    results.push({ flag: m[1], port: m[2] });
  }

  // Pattern 2: standalone port-like arguments: --<flag> followed by a bare
  // number in the valid port range (1024–65535) that wasn't caught above.
  const barePattern = /(-{1,2}[\w-]+)\s+(\d{4,5})\b/g;
  while ((m = barePattern.exec(commandLine)) !== null) {
    const portNum = parseInt(m[2], 10);
    if (portNum >= 1024 && portNum <= 65535) {
      // Avoid duplicates already captured by flagPattern
      const alreadyCaptured = results.some((r) => r.port === m[2]);
      if (!alreadyCaptured) {
        results.push({ flag: m[1], port: m[2] });
      }
    }
  }

  // Pattern 3: host:port notation (e.g. localhost:8080 or 127.0.0.1:3000)
  const hostPortPattern = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g;
  while ((m = hostPortPattern.exec(commandLine)) !== null) {
    const portNum = parseInt(m[1], 10);
    if (portNum >= 1 && portNum <= 65535) {
      const alreadyCaptured = results.some((r) => r.port === m[1]);
      if (!alreadyCaptured) {
        results.push({ flag: 'host:port', port: m[1] });
      }
    }
  }

  return results;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';

function c(color, text) {
  // Gracefully degrade when stdout is not a TTY (e.g. piped to a file).
  return process.stdout.isTTY ? `${color}${text}${RESET}` : text;
}

function printMatch(entry, isLSP) {
  const ports = extractPorts(entry.commandLine);
  const tag   = isLSP
    ? c(GREEN,  '[Language Server ✓]')
    : c(YELLOW, '[Antigravity process]');

  console.log(`\n${c(BOLD, '━'.repeat(70))}`);
  console.log(`${tag}`);
  console.log(`  ${c(CYAN, 'PID')}         : ${c(BOLD, entry.pid)}`);
  console.log(`  ${c(CYAN, 'Name')}        : ${entry.name}`);

  // ── Full command line (untruncated) ────────────────────────────────────────
  // Print raw string first so nothing is ever cut off, then a word-wrapped
  // pretty version for readability.  We intentionally avoid any slicing.
  console.log(`  ${c(CYAN, 'Command')}     : (full, untruncated)`);
  // Split on spaces only to get tokens; re-join with newline + indent every
  // ~110 chars so very long CLIs remain readable in a narrow terminal.
  const WRAP = 110;
  const INDENT = '      ';
  let line = INDENT;
  for (const token of entry.commandLine.split(' ')) {
    if (line.length + token.length + 1 > WRAP && line.trim().length > 0) {
      console.log(c(DIM, line));
      line = INDENT;
    }
    line += (line.trim().length > 0 ? ' ' : '') + token;
  }
  if (line.trim().length > 0) console.log(c(DIM, line));

  // Also write the raw, truly untruncated string to stderr so it can be
  // captured with `node detect.js 2>cmdline.txt` without any wrapping.
  process.stderr.write(`[RAW CMD pid=${entry.pid}] ${entry.commandLine}\n`);

  if (ports.length > 0) {
    const portStr = ports.map((p) => `${c(YELLOW, p.port)} (via ${p.flag})`).join(', ');
    console.log(`  ${c(CYAN, 'Ports')}       : ${portStr}`);
  } else {
    console.log(`  ${c(CYAN, 'Ports')}       : ${c(DIM, 'none detected')}`);
  }
}

// ─── Profile directory check ─────────────────────────────────────────────────

/**
 * Checks whether an "Antigravity IDE" folder exists under the user's
 * Roaming and/or Local AppData directories and lists their top-level entries.
 *
 * Only relevant on Windows; on other platforms it prints a note.
 */
function checkProfileDirs() {
  console.log(`\n${c(BOLD, '━'.repeat(70))}`);
  console.log(c(BOLD, '◆ Antigravity IDE profile directory check'));

  if (PLATFORM !== 'win32') {
    console.log(c(DIM, '  (Skipped — AppData paths only apply on Windows.)'));
    return;
  }

  const appData  = process.env.APPDATA  || path.join(os.homedir(), 'AppData', 'Roaming');
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  const candidates = [
    { label: 'Roaming', dir: path.join(appData,  'Antigravity IDE') },
    { label: 'Local',   dir: path.join(localApp, 'Antigravity IDE') },
  ];

  let anyFound = false;

  for (const { label, dir } of candidates) {
    console.log(`\n  ${c(CYAN, label)} : ${dir}`);

    let exists = false;
    try {
      const stat = fs.statSync(dir);
      exists = stat.isDirectory();
    } catch (_) {
      exists = false;
    }

    if (!exists) {
      console.log(c(DIM, `    ✗  Does not exist.`));
      continue;
    }

    anyFound = true;
    console.log(c(GREEN, `    ✓  Exists.`));

    // List top-level entries only (no recursion)
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.log(c(RED, `    ✖  Could not read directory: ${err.message}`));
      continue;
    }

    if (entries.length === 0) {
      console.log(c(DIM, '    (empty)'));
      continue;
    }

    // Sort: directories first, then files; alphabetical within each group
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const COL_WIDTH = 52;
    for (const ent of entries) {
      const icon = ent.isDirectory() ? '📁' : '📄';
      const kind = ent.isDirectory() ? c(CYAN, 'dir ') : c(DIM,  'file');

      // For files, also show size
      let sizeStr = '';
      if (ent.isFile()) {
        try {
          const { size } = fs.statSync(path.join(dir, ent.name));
          sizeStr = size < 1024
            ? `${size} B`
            : size < 1024 * 1024
              ? `${(size / 1024).toFixed(1)} KB`
              : `${(size / 1024 / 1024).toFixed(1)} MB`;
        } catch (_) { /* ignore */ }
      }

      const namePadded = ent.name.padEnd(COL_WIDTH);
      console.log(`    ${icon} ${kind}  ${namePadded}  ${c(DIM, sizeStr)}`);
    }
  }

  if (!anyFound) {
    console.log(c(YELLOW,
      '\n  ⚠  Neither Roaming nor Local "Antigravity IDE" directory found.'
    ));
    console.log(c(DIM,
      '     Antigravity may use a different folder name, or may not have'
    ));
    console.log(c(DIM,
      '     been launched yet (first-run profile creation happens on startup).'
    ));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(c(BOLD, `\nAntigravity Language Server Detector`));
  console.log(c(DIM,  `Platform : ${PLATFORM}`));
  console.log(c(DIM,  `Time     : ${new Date().toISOString()}`));
  console.log(c(DIM,  '─'.repeat(70)));

  let processes;
  try {
    console.log(c(DIM, 'Fetching process list…'));
    processes = listProcesses();
    console.log(c(DIM, `  → ${processes.length} processes found.`));
  } catch (err) {
    console.error(c(RED, `\n✖  Failed to list processes: ${err.message}`));
    process.exit(1);
  }

  // Filter to Antigravity processes
  const antigravityProcs = processes.filter(isAntigravityProcess);

  if (antigravityProcs.length === 0) {
    console.log(
      c(YELLOW, '\n⚠  No Antigravity processes found.')
    );
    console.log(
      c(DIM, '   Make sure Antigravity IDE is running, then try again.')
    );
    console.log(
      c(DIM, '   If the process uses a different name, add it to ANTIGRAVITY_KEYWORDS at the top of this script.')
    );
    return;
  }

  // Separate Language Server matches from generic Antigravity processes
  const lspProcs    = antigravityProcs.filter(isLanguageServer);
  const otherProcs  = antigravityProcs.filter((p) => !isLanguageServer(p));

  console.log(
    `\nFound ${c(BOLD, String(antigravityProcs.length))} Antigravity process(es): ` +
    `${c(GREEN, String(lspProcs.length))} likely Language Server, ` +
    `${c(YELLOW, String(otherProcs.length))} other.`
  );

  // Print Language Server matches first
  if (lspProcs.length > 0) {
    console.log(`\n${c(GREEN, '◆ Language Server candidates:')}`);
    for (const proc of lspProcs) {
      printMatch(proc, true);
    }
  }

  // Then print remaining Antigravity processes
  if (otherProcs.length > 0) {
    console.log(`\n${c(YELLOW, '◆ Other Antigravity processes (may include main window, GPU helper, etc.):')} `);
    for (const proc of otherProcs) {
      printMatch(proc, false);
    }
  }

  console.log(`\n${c(BOLD, '━'.repeat(70))}`);
  console.log(c(DIM, '\nTip: If the Language Server is not highlighted, look for a process'));
  console.log(c(DIM, '     with flags like --type=extensionHost, --ms-enable-electron-run-as-node,'));
  console.log(c(DIM, '     or a path containing "languageserver" / "server.js" in the command.'));
  console.log(c(DIM, '     Add any new hints to LANGUAGE_SERVER_HINTS at the top of this script.'));
  console.log('');

  // ── Profile directory check ───────────────────────────────────────────────
  checkProfileDirs();

  console.log('');
}

main();
