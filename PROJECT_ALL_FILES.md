# Lune — Combined Codebase

This document contains all project files with their respective title and complete code.

---

## `.gitignore`

```
# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/

# Production / Build
build/
dist/
out/

# Misc
.DS_Store
*.pem

# Debug / Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
logs/

# Environment variables
.env
.env*.local
```

---

## `README.md`

```markdown
# Lune

Project initialized.
```

---

## `detect.js`

```javascript
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
```

---

## `dump-procs.js`

```javascript
#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');

const USER_DATA_DIR = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';

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
  result.push(current); return result;
}

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

// Filter: all processes referencing the profile directory
const procs = entries.filter(e =>
  e.commandLine.toLowerCase().includes(USER_DATA_DIR.toLowerCase())
);

console.log(`Total profile processes: ${procs.length}\n`);

procs.forEach(p => {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`PID  : ${p.pid}`);
  console.log(`Name : ${p.name}`);
  console.log(`CMD  :`);
  // Print word-wrapped at 120 chars with indentation
  const WRAP = 120;
  const IND  = '       ';
  let line = IND;
  for (const tok of p.commandLine.split(' ')) {
    if (line.length + tok.length + 1 > WRAP && line.trim().length > 0) {
      console.log(line); line = IND;
    }
    line += (line.trim().length > 0 ? ' ' : '') + tok;
  }
  if (line.trim().length > 0) console.log(line);
  // Raw untruncated to stderr
  process.stderr.write(`\n[RAW pid=${p.pid}]\n${p.commandLine}\n`);
});
```

---

## `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lune — AI Quota Dashboard</title>
<meta name="description" content="Monitor AI usage quota across multiple IDE accounts in a unified local dashboard.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
<style>

/* ═══════════════════════════════════════════════════════
   RESET & BASE
═══════════════════════════════════════════════════════ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
button { font-family: inherit; cursor: pointer; }

body {
  font-family: 'Inter', sans-serif;
  background: #11131A;
  color: #E8E9EE;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-width: 900px;
}

/* ═══════════════════════════════════════════════════════
   APP LAYOUT — 3-COLUMN GRID
═══════════════════════════════════════════════════════ */
.app {
  display: grid;
  grid-template-columns: 64px 430px 1fr;
  height: 100vh;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════════════
   LEFT RAIL / SIDEBAR
═══════════════════════════════════════════════════════ */
.sidebar {
  background: #181B25;
  border-right: 1px solid #262A38;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  z-index: 10;
}

.sidebar-logo {
  width: 36px;
  height: 36px;
  background: linear-gradient(145deg, #4FD9BC 0%, #7FB8A8 60%, #5AB0C8 100%);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  flex-shrink: 0;
  box-shadow: 0 0 20px rgba(79,217,188,.25), 0 2px 8px rgba(0,0,0,.4);
  transition: box-shadow .2s;
}
.sidebar-logo:hover { box-shadow: 0 0 28px rgba(79,217,188,.4), 0 2px 8px rgba(0,0,0,.4); }

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  width: 100%;
  padding: 0 8px;
  align-items: center;
}

.sidebar-bottom {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 10px 8px 0;
  align-items: center;
  border-top: 1px solid #262A38;
  margin-top: 10px;
}

.nav-btn {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #5A6072;
  border: none;
  background: transparent;
  transition: background .15s, color .15s, transform .1s;
  position: relative;
}
.nav-btn:hover { background: #1D202C; color: #9298A8; transform: translateY(-1px); }
.nav-btn.active { background: rgba(127,184,168,.12); color: #7FB8A8; }
.nav-btn.active::before {
  content: '';
  position: absolute;
  left: -8px; top: 50%;
  transform: translateY(-50%);
  width: 3px; height: 20px;
  background: #7FB8A8;
  border-radius: 0 3px 3px 0;
}

/* ═══════════════════════════════════════════════════════
   SHARED PANEL HEADER — exactly 84px tall
═══════════════════════════════════════════════════════ */
.panel-header {
  height: 84px;
  min-height: 84px;
  max-height: 84px;
  border-bottom: 1px solid #262A38;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 20px;
  flex-shrink: 0;
  background: #181B25;
}

/* ═══════════════════════════════════════════════════════
   MIDDLE COLUMN — ACCOUNTS LIST
═══════════════════════════════════════════════════════ */
.accounts-panel {
  border-right: 1px solid #262A38;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panel-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 15px;
  font-weight: 700;
  color: #E8E9EE;
  letter-spacing: -.01em;
}

.panel-subtitle {
  font-size: 11.5px;
  color: #5A6072;
  margin-top: 4px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #1D202C;
  border: 1px solid #262A38;
  color: #9298A8;
  font-size: 11.5px;
  font-weight: 500;
  padding: 5px 11px;
  border-radius: 8px;
  transition: all .15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.refresh-btn:hover { background: #262A38; color: #E8E9EE; border-color: #3A3F52; }
.refresh-icon { transition: transform .55s cubic-bezier(.4,0,.2,1); }
.refresh-btn.spinning .refresh-icon { transform: rotate(360deg); }

.add-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(127,184,168,.12);
  border: 1px solid rgba(127,184,168,.28);
  color: #7FB8A8;
  font-size: 11.5px;
  font-weight: 600;
  padding: 5px 11px;
  border-radius: 8px;
  transition: all .15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.add-btn:hover { background: rgba(127,184,168,.22); border-color: rgba(127,184,168,.45); }

.unsynced-label {
  font-size: 10.5px;
  color: #5A6072;
  font-style: italic;
}

.accounts-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.accounts-list::-webkit-scrollbar { width: 4px; }
.accounts-list::-webkit-scrollbar-track { background: transparent; }
.accounts-list::-webkit-scrollbar-thumb { background: #262A38; border-radius: 2px; }

/* ═══════════════════════════════════════════════════════
   ACCOUNT CARDS
═══════════════════════════════════════════════════════ */
.account-card {
  background: #181B25;
  border: 1px solid #262A38;
  border-left: 3px solid transparent;
  border-radius: 10px;
  padding: 12px 12px 10px;
  margin-bottom: 7px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 9px;
  transition: background .12s, border-color .12s, transform .1s;
  user-select: none;
  outline: none;
}
.account-card:hover  { background: #1D202C; transform: translateX(1px); }
.account-card:focus-visible { outline: 2px solid #7FB8A8; outline-offset: 2px; }
.account-card:active { transform: translateX(0); }

.account-card.selected             { background: rgba(127,184,168,.05); border-left-color: #7FB8A8; }
.account-card.selected.status-warn { background: rgba(234,179, 8,.05); border-left-color: #EAB308; }
.account-card.selected.status-crit { background: rgba(239, 68, 68,.05); border-left-color: #EF4444; }

.card-top-row { display: flex; align-items: center; gap: 9px; }

.card-rank {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #5A6072;
  width: 14px;
  flex-shrink: 0;
  text-align: center;
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255,255,255,.88);
  flex-shrink: 0;
  border: 1px solid rgba(255,255,255,.08);
}

.card-info { flex: 1; min-width: 0; }
.card-name  { font-size: 12.5px; font-weight: 600; color: #E8E9EE; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-email { font-size: 11px; color: #5A6072; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }

.launch-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid #262A38;
  color: #5A6072;
  font-size: 10.5px;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 6px;
  transition: all .15s;
  flex-shrink: 0;
  white-space: nowrap;
}
.launch-btn:hover { background: #1D202C; color: #9298A8; border-color: #3A3F52; }

.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: 1px solid #262A38;
  color: #5A6072;
  border-radius: 6px;
  transition: all .15s;
  flex-shrink: 0;
  cursor: pointer;
}
.remove-btn:hover {
  background: rgba(239, 68, 68, .12);
  color: #EF4444;
  border-color: rgba(239, 68, 68, .3);
}

.card-quota-row { display: flex; align-items: center; gap: 9px; padding-left: 23px; }

.quota-bar-wrap {
  flex: 1;
  height: 4px;
  background: #262A38;
  border-radius: 99px;
  overflow: visible;
}
.quota-bar-fill {
  height: 100%;
  border-radius: 99px;
  transition: width .6s cubic-bezier(.4,0,.2,1);
}
/* Vivid traffic-light colors — these list bars are the "at a glance" signal */
.quota-bar-fill.healthy  { background: #22C55E; box-shadow: 0 0 5px 1px rgba(34,197, 94,.35); }
.quota-bar-fill.warn     { background: #EAB308; box-shadow: 0 0 5px 1px rgba(234,179,  8,.35); }
.quota-bar-fill.critical { background: #EF4444; box-shadow: 0 0 5px 1px rgba(239, 68, 68,.35); }

.quota-pct {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: #9298A8;
  min-width: 30px;
  text-align: right;
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════
   RIGHT — DETAIL PANEL
═══════════════════════════════════════════════════════ */
.detail-panel { display: flex; flex-direction: column; overflow: hidden; background: #11131A; }

.detail-panel .panel-header {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 0 22px;
}

.detail-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 13px;
  font-weight: 700;
  color: rgba(255,255,255,.88);
  flex-shrink: 0;
  border: 1px solid rgba(255,255,255,.1);
}

.detail-name-wrap { flex: 1; min-width: 0; }
.detail-name  { font-family: 'Space Grotesk', sans-serif; font-size: 14px; font-weight: 700; color: #E8E9EE; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-email { font-size: 11.5px; color: #5A6072; margin-top: 2px; }

.plan-badge {
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 99px;
  white-space: nowrap;
  border: 1px solid;
  flex-shrink: 0;
  letter-spacing: .01em;
}
.plan-badge.healthy  { background: rgba(127,184,168,.10); color: #7FB8A8; border-color: rgba(127,184,168,.28); }
.plan-badge.warn     { background: rgba(217,166, 98,.10); color: #D9A662; border-color: rgba(217,166, 98,.28); }
.plan-badge.critical { background: rgba(206,132,132,.10); color: #CE8484; border-color: rgba(206,132,132,.28); }

.launch-main-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(127,184,168,.28);
  color: #7FB8A8;
  background: rgba(127,184,168,.08);
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 8px;
  transition: all .18s;
  white-space: nowrap;
  flex-shrink: 0;
}
.launch-main-btn:hover {
  background: rgba(127,184,168,.15);
  border-color: rgba(127,184,168,.45);
  box-shadow: 0 0 18px rgba(127,184,168,.12);
  transform: translateY(-1px);
}
.launch-main-btn:active { transform: translateY(0); }

/* ─── Detail scrollable content ─── */
.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px 16px;
}
.detail-content::-webkit-scrollbar { width: 4px; }
.detail-content::-webkit-scrollbar-track { background: transparent; }
.detail-content::-webkit-scrollbar-thumb { background: #262A38; border-radius: 2px; }

.section-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: #3A3F52;
  margin-bottom: 10px;
}

/* ═══════════════════════════════════════════════════════
   QUOTA POOL CARDS
═══════════════════════════════════════════════════════ */
.pools-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 18px;
}

.pool-column {
  display: flex;
  flex-direction: column;
}

.pool-card {
  background: #181B25;
  border: 1px solid #262A38;
  border-radius: 12px;
  padding: 18px 14px 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 13px;
  transition: border-radius .2s, border-color .15s, background .15s;
  cursor: pointer;
  user-select: none;
}
.pool-card:hover { background: #1D202C; border-color: #2F3447; }
.pool-column.expanded .pool-card {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-color: #3A3F52;
  background: #181B25;
}

/* Pool expand chevron */
.pool-chevron {
  width: 14px; height: 14px;
  color: #5A6072;
  transition: transform .25s cubic-bezier(.4,0,.2,1), color .15s;
  flex-shrink: 0;
}
.pool-column.expanded .pool-chevron { transform: rotate(180deg); color: #7FB8A8; }

/* Expandable stats panel beneath a pool card — height set inline via JS (scrollHeight)
   so it fits real content instead of a guessed fixed max-height */
.pool-stats-panel {
  background: #141620;
  border: 1px solid #3A3F52;
  border-top: none;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  padding: 0 14px;
  transition: max-height .32s cubic-bezier(.4,0,.2,1), opacity .25s ease, padding .32s cubic-bezier(.4,0,.2,1);
}
.pool-column.expanded .pool-stats-panel {
  opacity: 1;
  padding: 12px 14px 14px;
}

.pool-unit-breakdown {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pool-unit-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.pool-unit-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.pool-unit-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}
.pool-unit-fraction {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #3A3F52;
}
.pool-unit-label {
  font-size: 10.5px;
  color: #9298A8;
  font-weight: 500;
}
.pool-unit-consumed {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #5A6072;
}
.pool-bar-wrap { height: 4px; background: #262A38; border-radius: 99px; overflow: hidden; }
.pool-bar-fill { height: 100%; border-radius: 99px; transition: width .5s cubic-bezier(.4,0,.2,1); }
.pool-bar-fill.healthy  { background: #4FD9BC; }
.pool-bar-fill.warn     { background: #F2B84D; }
.pool-bar-fill.critical { background: #F27878; }

/* Per-model breakdown list inside the expanded panel */
.model-breakdown {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 2px;
  border-top: 1px solid #1D202C;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-row-name {
  font-size: 10.5px;
  color: #9298A8;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-tag {
  font-size: 8.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .04em;
  padding: 1.5px 5px;
  border-radius: 4px;
  background: rgba(127,184,168,.12);
  color: #7FB8A8;
  border: 1px solid rgba(127,184,168,.25);
  flex-shrink: 0;
}
.model-tag.fast {
  background: rgba(90,176,200,.12);
  color: #5AB0C8;
  border-color: rgba(90,176,200,.25);
}
.model-row-frac {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #5A6072;
  flex-shrink: 0;
  width: 40px;
  text-align: right;
}

.ring-container { position: relative; width: 90px; height: 90px; flex-shrink: 0; }
.ring-container svg { position: absolute; inset: 0; overflow: visible; }
.ring-label {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 1px;
}
.ring-pct { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 600; line-height: 1; }
.ring-sublabel { font-size: 9px; color: #5A6072; text-transform: uppercase; letter-spacing: .06em; }

.pool-info { text-align: center; width: 100%; }
.pool-name { font-family: 'Space Grotesk', sans-serif; font-size: 12.5px; font-weight: 700; color: #E8E9EE; margin-bottom: 5px; }
.pool-models { font-size: 10.5px; color: #5A6072; line-height: 1.65; margin-bottom: 7px; }
.pool-reset { font-size: 10.5px; color: #5A6072; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px; }
.pool-reset-val { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: #9298A8; }

/* ═══════════════════════════════════════════════════════
   STAT GRID (4 columns)
═══════════════════════════════════════════════════════ */
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 16px; }

.stat-card {
  background: #181B25;
  border: 1px solid #262A38;
  border-radius: 10px;
  padding: 13px 12px 11px;
  transition: border-color .15s, background .15s;
}
.stat-card:hover { background: #1D202C; }

.stat-label {
  font-size: 10.5px;
  color: #5A6072;
  margin-bottom: 9px;
  display: inline-block;
  line-height: 1.3;
}
.stat-label.has-tooltip {
  border-bottom: 1px dashed #3A3F52;
  cursor: help;
  transition: border-color .15s, color .15s;
}
.stat-label.has-tooltip:hover { border-bottom-color: #5A6072; color: #9298A8; }

.stat-value { font-family: 'JetBrains Mono', monospace; font-size: 19px; font-weight: 600; color: #E8E9EE; line-height: 1; display: block; }
.stat-sub { font-size: 10px; color: #5A6072; margin-top: 5px; }

/* ═══════════════════════════════════════════════════════
   SYNC ROW
═══════════════════════════════════════════════════════ */
.sync-row { display: flex; align-items: center; gap: 8px; padding-top: 14px; border-top: 1px solid #1D202C; }
.sync-text { font-size: 11.5px; color: #5A6072; flex: 1; }
.sync-time { font-family: 'JetBrains Mono', monospace; color: #9298A8; }

.refresh-acc-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid #262A38;
  color: #7FB8A8;
  font-size: 11px;
  font-weight: 500;
  padding: 5px 11px;
  border-radius: 8px;
  transition: all .15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.refresh-acc-btn:hover { background: rgba(127,184,168,.08); border-color: rgba(127,184,168,.35); color: #A9D4C6; }
.refresh-acc-btn .refresh-icon { width: 11px; height: 11px; transition: transform .55s cubic-bezier(.4,0,.2,1); }
.refresh-acc-btn.spinning .refresh-icon { transform: rotate(360deg); }

.pulse-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; position: relative; }
.pulse-dot::after { content: ''; position: absolute; inset: 0; border-radius: 50%; animation: pulse-ring 2.2s ease-out infinite; }
.pulse-dot.healthy  { background: #4FD9BC; }
.pulse-dot.healthy::after  { background: rgba( 79,217,188,.45); }
.pulse-dot.warn     { background: #F2B84D; }
.pulse-dot.warn::after     { background: rgba(242,184, 77,.45); }
.pulse-dot.critical { background: #F27878; }
.pulse-dot.critical::after { background: rgba(242,120,120,.45); }

@keyframes pulse-ring {
  0%   { transform: scale(1);   opacity: .9; }
  65%  { transform: scale(2.8); opacity: 0;  }
  100% { transform: scale(1);   opacity: 0;  }
}

/* ═══════════════════════════════════════════════════════
   FLOATING TOOLTIP
═══════════════════════════════════════════════════════ */
.tooltip {
  position: fixed;
  z-index: 9999;
  background: #1D202C;
  border: 1px solid #2F3447;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11.5px;
  color: #9298A8;
  max-width: 230px;
  line-height: 1.55;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .15s ease, transform .15s ease;
  box-shadow: 0 8px 28px rgba(0,0,0,.5);
}
.tooltip.visible { opacity: 1; transform: translateY(0); }

/* ═══════════════════════════════════════════════════════
   MODAL DIALOG
═══════════════════════════════════════════════════════ */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity .2s ease;
}
.modal-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}
.modal-card {
  background: #181B25;
  border: 1px solid #262A38;
  border-radius: 14px;
  width: 380px;
  max-width: 90vw;
  padding: 22px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.6);
  transform: translateY(8px);
  transition: transform .2s ease;
}
.modal-backdrop.open .modal-card {
  transform: translateY(0);
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.modal-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 16px;
  font-weight: 700;
  color: #E8E9EE;
}
.modal-close {
  background: transparent;
  border: none;
  color: #5A6072;
  font-size: 20px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 6px;
  transition: color .15s, background .15s;
}
.modal-close:hover { color: #E8E9EE; background: #262A38; }
.modal-sub {
  font-size: 11.5px;
  color: #5A6072;
  margin-bottom: 18px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.form-group label {
  font-size: 11px;
  font-weight: 600;
  color: #9298A8;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.form-group input {
  background: #11131A;
  border: 1px solid #262A38;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 12.5px;
  color: #E8E9EE;
  outline: none;
  transition: border-color .15s;
}
.form-group input:focus {
  border-color: #7FB8A8;
}
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.modal-cancel-btn {
  background: transparent;
  border: 1px solid #262A38;
  color: #9298A8;
  font-size: 12px;
  font-weight: 500;
  padding: 7px 14px;
  border-radius: 8px;
  transition: all .15s;
}
.modal-cancel-btn:hover { background: #262A38; color: #E8E9EE; }
.modal-submit-btn {
  background: #7FB8A8;
  border: none;
  color: #11131A;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 8px;
  transition: background .15s;
}
.modal-submit-btn:hover { background: #92D4C2; }

/* ═══════════════════════════════════════════════════════
   EMPTY PROMPT STATE
═══════════════════════════════════════════════════════ */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}
.empty-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #181B25;
  border: 1px solid #262A38;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.empty-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 16px;
  font-weight: 700;
  color: #E8E9EE;
  margin-bottom: 6px;
}
.empty-sub {
  font-size: 12px;
  color: #5A6072;
  max-width: 280px;
  margin-bottom: 20px;
  line-height: 1.5;
}
.empty-sync-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #7FB8A8;
  color: #11131A;
  border: none;
  font-size: 12px;
  font-weight: 600;
  padding: 8px 18px;
  border-radius: 8px;
  transition: background .15s;
}
.empty-sync-btn:hover { background: #92D4C2; }

/* ═══════════════════════════════════════════════════════
   DELTA BADGES
═══════════════════════════════════════════════════════ */
.pool-delta-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.pool-delta-tag.down {
  background: rgba(239, 68, 68, .12);
  color: #EF4444;
  border: 1px solid rgba(239, 68, 68, .25);
}
.pool-delta-tag.up {
  background: rgba(34, 197, 94, .12);
  color: #22C55E;
  border: 1px solid rgba(34, 197, 94, .25);
}
.pool-delta-tag.same {
  background: rgba(90, 96, 114, .12);
  color: #9298A8;
  border: 1px solid rgba(90, 96, 114, .25);
}

.sync-delta-text {
  color: #9298A8;
  font-weight: 500;
}

</style>
</head>
<body>

<!-- Floating tooltip -->
<div class="tooltip" id="tooltip" role="tooltip" aria-hidden="true"></div>

<!-- Add Account Modal -->
<div class="modal-backdrop" id="add-modal" aria-hidden="true">
  <div class="modal-card" role="dialog" aria-labelledby="modal-title">
    <div class="modal-header">
      <span class="modal-title" id="modal-title">Add Account</span>
      <button class="modal-close" id="modal-close-btn" aria-label="Close modal">&times;</button>
    </div>
    <p class="modal-sub">Simulate Google OAuth login by entering account credentials.</p>
    <form id="add-acc-form">
      <div class="form-group">
        <label for="acc-name-input">Display Name</label>
        <input type="text" id="acc-name-input" placeholder="e.g. Jordan Smith" required autocomplete="off">
      </div>
      <div class="form-group">
        <label for="acc-email-input">Email Address</label>
        <input type="email" id="acc-email-input" placeholder="jordan@company.com" required autocomplete="off">
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-cancel-btn" id="modal-cancel-btn">Cancel</button>
        <button type="submit" class="modal-submit-btn">Add Account</button>
      </div>
    </form>
  </div>
</div>

<div class="app">

  <!-- ═══ LEFT RAIL ═══ -->
  <nav class="sidebar" aria-label="Main navigation">
    <div class="sidebar-logo" title="Lune">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M9 1.5C9 1.5 13.5 5.5 13.5 9C13.5 12.5 9 16.5 9 16.5C9 16.5 4.5 12.5 4.5 9C4.5 5.5 9 1.5 9 1.5Z" fill="white" opacity="0.92"/>
        <ellipse cx="9" cy="9" rx="2.8" ry="2.8" fill="#11131A" opacity="0.55"/>
      </svg>
    </div>
    <div class="sidebar-nav">
      <button class="nav-btn active" id="nav-accounts" title="Accounts" aria-label="Accounts">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.87"/>
        </svg>
      </button>
      <button class="nav-btn" id="nav-analytics" title="Analytics" aria-label="Analytics">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
      </button>
    </div>
    <div class="sidebar-bottom">
      <button class="nav-btn" title="Settings" aria-label="Settings">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <button class="nav-btn" title="Log out" aria-label="Log out">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
  </nav>

  <!-- ═══ MIDDLE COLUMN ═══ -->
  <div class="accounts-panel">
    <div class="panel-header">
      <div class="panel-header-row">
        <span class="panel-title">Accounts</span>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="add-btn" id="add-acc-btn" aria-label="Add account">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add account
          </button>
          <button class="refresh-btn" id="refresh-btn" aria-label="Refresh all accounts">
            <svg class="refresh-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Refresh all
          </button>
        </div>
      </div>
      <div class="panel-subtitle" id="sync-subtitle">Last synced just now</div>
    </div>
    <div class="accounts-list" id="accounts-list" role="list" aria-label="Accounts"></div>
  </div>

  <!-- ═══ RIGHT DETAIL PANEL ═══ -->
  <div class="detail-panel">
    <div class="panel-header" id="detail-header"></div>
    <div class="detail-content" id="detail-content"></div>
  </div>

</div>

<script>
'use strict';

/* ═══════════════════════════════════════════════════════
   MOCK DATA — shaped to match the real API response:
   each pool exposes a remainingFraction (0–1), and each
   model within a pool has its own independent fraction.
═══════════════════════════════════════════════════════ */
const ACCOUNTS = [
  {
    id: 1, rank: 1,
    name: 'Alex Johnson',  email: 'alex.johnson@gmail.com',
    initials: 'AJ', avatarBg: '#1A4038',
    plan: 'Google AI Pro', quotaPercent: 94,
    lastSync: Date.now() - 2  * 60 * 1000,
    pools: [
      { name: 'Gemini Pool', remainingFraction: 0.9600, resetIn: '14d 6h',
        models: [
          { name: 'Gemini 2.0 Flash', tag: 'fast',        fraction: 0.9820 },
          { name: 'Gemini 1.5 Pro',   tag: null,           fraction: 0.9410 },
          { name: 'Gemini 2.0 Pro',   tag: 'recommended',  fraction: 0.9550 },
        ] },
      { name: 'Claude / GPT-OSS Pool', remainingFraction: 0.9130, resetIn: '14d 6h',
        models: [
          { name: 'Claude 3.5 Sonnet', tag: 'recommended', fraction: 0.9280 },
          { name: 'GPT-4o',            tag: null,          fraction: 0.9010 },
          { name: 'Claude 3 Opus',     tag: null,          fraction: 0.8940 },
        ] },
    ],
    stats: { promptCredits: { rem: 4820, tot: 5000 }, flowCredits: { rem: 452, tot: 500 }, maxInputTokens: 128000, nextReset: '14d 6h' },
  },
  {
    id: 2, rank: 2,
    name: 'Sarah Chen',    email: 'sarah.chen@company.io',
    initials: 'SC', avatarBg: '#142040',
    plan: 'Anthropic Teams', quotaPercent: 76,
    lastSync: Date.now() - 14 * 60 * 1000,
    pools: [
      { name: 'Gemini Pool', remainingFraction: 0.7800, resetIn: '8d 12h',
        models: [
          { name: 'Gemini 2.0 Flash', tag: 'fast', fraction: 0.8120 },
          { name: 'Gemini 1.5 Pro',   tag: null,   fraction: 0.7480 },
        ] },
      { name: 'Claude / GPT-OSS Pool', remainingFraction: 0.7420, resetIn: '8d 12h',
        models: [
          { name: 'Claude 3.5 Sonnet', tag: 'recommended', fraction: 0.7690 },
          { name: 'Claude 3.5 Haiku',  tag: 'fast',         fraction: 0.7810 },
          { name: 'GPT-4o Mini',       tag: null,           fraction: 0.6780 },
        ] },
    ],
    stats: { promptCredits: { rem: 3800, tot: 5000 }, flowCredits: { rem: 380, tot: 500 }, maxInputTokens: 200000, nextReset: '8d 12h' },
  },
  {
    id: 3, rank: 3,
    name: 'Marcus Rivera', email: 'marcus@devstudio.co',
    initials: 'MR', avatarBg: '#3D2010',
    plan: 'OpenAI Developer', quotaPercent: 41,
    lastSync: Date.now() - 41 * 60 * 1000,
    pools: [
      { name: 'Gemini Pool', remainingFraction: 0.4520, resetIn: '3d 18h',
        models: [
          { name: 'Gemini 2.0 Flash', tag: 'fast', fraction: 0.4890 },
          { name: 'Gemini 1.5 Flash', tag: null,   fraction: 0.4150 },
        ] },
      { name: 'Claude / GPT-OSS Pool', remainingFraction: 0.3690, resetIn: '3d 18h',
        models: [
          { name: 'GPT-4o',      tag: 'recommended', fraction: 0.3920 },
          { name: 'GPT-4o Mini', tag: 'fast',         fraction: 0.4010 },
          { name: 'o1-mini',     tag: null,           fraction: 0.3140 },
        ] },
    ],
    stats: { promptCredits: { rem: 2050, tot: 5000 }, flowCredits: { rem: 205, tot: 500 }, maxInputTokens: 128000, nextReset: '3d 18h' },
  },
  {
    id: 4, rank: 4,
    name: 'Emma Wilson',   email: 'emma.w@personal.me',
    initials: 'EW', avatarBg: '#3D1212',
    plan: 'Free Tier', quotaPercent: 12,
    lastSync: Date.now() - 3  * 60 * 60 * 1000,
    pools: [
      { name: 'Gemini Pool', remainingFraction: 0.1540, resetIn: '1d 2h',
        models: [
          { name: 'Gemini 2.0 Flash Lite', tag: 'fast', fraction: 0.1540 },
        ] },
      { name: 'Claude / GPT-OSS Pool', remainingFraction: 0.0870, resetIn: '1d 2h',
        models: [
          { name: 'Claude 3.5 Haiku', tag: 'fast', fraction: 0.0910 },
          { name: 'GPT-4o Mini',      tag: null,   fraction: 0.0830 },
        ] },
    ],
    stats: { promptCredits: { rem: 600, tot: 5000 }, flowCredits: { rem: 55, tot: 500 }, maxInputTokens: 32000, nextReset: '1d 2h' },
  },
];

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */
const AVATAR_PALETTE = ['#1A4038', '#142040', '#3D2010', '#3D1212', '#2A1B40', '#1B3D38', '#382E1B', '#143840'];

function deriveInitials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

function status(pct) { return pct >= 60 ? 'healthy' : pct >= 25 ? 'warn' : 'critical'; }
const MUTED = { healthy: '#7FB8A8', warn: '#D9A662', critical: '#CE8484' };
const fmt   = n  => (n || 0).toLocaleString();
const words = tk => Math.round((tk || 0) * 0.75).toLocaleString();
const esc   = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const pctOf = frac => +(frac * 100).toFixed(2);

function getClockTime(str) {
  if (!str) return '';
  const dMatch = str.match(/(\d+)d/);
  const hMatch = str.match(/(\d+)h/);
  const days = dMatch ? parseInt(dMatch[1], 10) : 0;
  const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
  const target = new Date(Date.now() + (days * 86400 + hours * 3600) * 1000);
  const month = target.toLocaleDateString('en-US', { month: 'short' });
  const day = target.getDate();
  const timeStr = target.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${month} ${day}, ${timeStr}`;
}

/* Mock refresh helper — nudges numbers and records previousSnapshot for diffing */
function refreshAccountObj(acc) {
  if (!acc) return;
  // If account has existing pools & stats, snapshot them before updating
  if (acc.pools && acc.pools.length > 0 && acc.stats) {
    acc.previousSnapshot = {
      pools: acc.pools.map(p => ({
        name: p.name,
        remainingFraction: p.remainingFraction,
        resetIn: p.resetIn
      })),
      promptCredits: acc.stats.promptCredits ? acc.stats.promptCredits.rem : 0,
      flowCredits: acc.stats.flowCredits ? acc.stats.flowCredits.rem : 0,
      capturedAt: acc.lastSync || Date.now()
    };
  }

  // If brand-new unlinked account being synced for first time:
  if (!acc.pools || acc.pools.length === 0) {
    acc.plan = 'Google AI Pro';
    acc.pools = [
      { name: 'Gemini Pool', remainingFraction: 0.9500, resetIn: '14d 6h',
        models: [
          { name: 'Gemini 2.0 Flash', tag: 'fast', fraction: 0.9650 },
          { name: 'Gemini 1.5 Pro', tag: null, fraction: 0.9350 },
          { name: 'Gemini 2.0 Pro', tag: 'recommended', fraction: 0.9500 },
        ] },
      { name: 'Claude / GPT-OSS Pool', remainingFraction: 0.9000, resetIn: '14d 6h',
        models: [
          { name: 'Claude 3.5 Sonnet', tag: 'recommended', fraction: 0.9150 },
          { name: 'GPT-4o', tag: null, fraction: 0.8850 },
          { name: 'Claude 3 Opus', tag: null, fraction: 0.8750 },
        ] },
    ];
    acc.stats = {
      promptCredits: { rem: 4750, tot: 5000 },
      flowCredits: { rem: 450, tot: 500 },
      maxInputTokens: 128000,
      nextReset: '14d 6h'
    };
    acc.quotaPercent = 95;
    acc.lastSync = Date.now();
    return;
  }

  // Update existing pool & stat values with small realistic deltas
  const isReset = Math.random() < 0.25; // 25% chance of quota reset to test new cycle logic

  acc.pools.forEach(p => {
    if (isReset) {
      // Advance resetIn to simulate a new cycle starting
      const resetCycle = ['14d 6h', '14d 12h', '15d 0h', '14d 18h'];
      const nextIdx = (resetCycle.indexOf(p.resetIn) + 1) % resetCycle.length;
      p.resetIn = resetCycle[nextIdx === -1 ? 0 : nextIdx];
      p.remainingFraction = 1.0000;
      p.models.forEach(m => m.fraction = 1.0000);
    } else {
      // Normal usage case: keep resetIn SAME as before, decrease fraction
      const drop = +(Math.random() * 0.035 + 0.005).toFixed(4); // 0.5% to 4.0% drop
      p.remainingFraction = Math.max(0.0100, +(p.remainingFraction - drop).toFixed(4));
      p.models.forEach(m => {
        m.fraction = Math.max(0.0100, +(m.fraction - drop * (0.8 + Math.random() * 0.4)).toFixed(4));
      });
    }
  });

  if (isReset) {
    acc.stats.nextReset = acc.pools[0].resetIn;
    acc.stats.promptCredits.rem = acc.stats.promptCredits.tot;
    acc.stats.flowCredits.rem = acc.stats.flowCredits.tot;
  } else {
    const promptDrop = Math.floor(Math.random() * 180 + 20);
    const flowDrop = Math.floor(Math.random() * 20 + 2);
    acc.stats.promptCredits.rem = Math.max(0, acc.stats.promptCredits.rem - promptDrop);
    acc.stats.flowCredits.rem = Math.max(0, acc.stats.flowCredits.rem - flowDrop);
  }

  const maxFrac = Math.max(...acc.pools.map(p => p.remainingFraction));
  acc.quotaPercent = Math.round(maxFrac * 100);
  acc.lastSync = Date.now();
}

function getPoolDeltaInfo(acc, pool) {
  if (!acc.previousSnapshot || !acc.previousSnapshot.pools) return null;
  const prevP = acc.previousSnapshot.pools.find(x => x.name === pool.name);
  if (!prevP) return null;

  // Key off resetTime (resetIn) equality first
  if (pool.resetIn !== prevP.resetIn) {
    return { text: '▲ Quota reset — new cycle', cls: 'up' };
  }

  // Same cycle: compare remainingFraction
  const deltaFrac = pool.remainingFraction - prevP.remainingFraction;
  const deltaPct = Math.abs(deltaFrac * 100);

  if (deltaFrac < -0.001) {
    return { text: `▼ ${deltaPct.toFixed(1)}% used`, cls: 'down' };
  } else {
    return { text: 'No change since last sync', cls: 'same' };
  }
}

function getSyncDeltaSummary(acc) {
  if (!acc.previousSnapshot) return '';
  const prevPrompts = acc.previousSnapshot.promptCredits;
  const currPrompts = acc.stats ? acc.stats.promptCredits.rem : 0;
  const usedPrompts = prevPrompts - currPrompts;

  if (usedPrompts > 0) {
    return `used ${fmt(usedPrompts)} prompt credits since then`;
  } else if (usedPrompts < 0) {
    return `Quota reset — new cycle`;
  } else {
    return `No change since last sync`;
  }
}

/* ═══════════════════════════════════════════════════════
   SVG RING
═══════════════════════════════════════════════════════ */
function ring(pct, st) {
  const r    = 37;
  const circ = 2 * Math.PI * r;
  const arc  = +(circ * pct / 100).toFixed(3);
  const gap  = +(circ - arc).toFixed(3);
  const col  = MUTED[st];
  const uid  = 'f' + Math.random().toString(36).slice(2, 8);
  return `
    <svg viewBox="0 0 100 100" width="90" height="90" style="overflow:visible" aria-hidden="true">
      <defs>
        <filter id="${uid}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="#1D202C" stroke-width="9"/>
      <circle cx="50" cy="50" r="${r}" fill="none"
        stroke="${col}" stroke-width="8"
        stroke-dasharray="${arc} ${gap}" stroke-linecap="round"
        transform="rotate(-90, 50, 50)" filter="url(#${uid})"/>
    </svg>
    <div class="ring-label">
      <span class="ring-pct" style="color:${col}">${pct}%</span>
      <span class="ring-sublabel">left</span>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let selectedId = ACCOUNTS[0].id;
let lastSync   = Date.now();

/* ═══════════════════════════════════════════════════════
   RENDER — ACCOUNT CARDS
═══════════════════════════════════════════════════════ */
function renderCards() {
  const list = document.getElementById('accounts-list');
  if (ACCOUNTS.length === 0) {
    list.innerHTML = `<div style="padding: 30px 14px; text-align: center; color: #5A6072; font-size: 12px; line-height: 1.5;">No accounts registered.<br>Click <strong style="color:#7FB8A8">Add account</strong> above to add one.</div>`;
    return;
  }

  list.innerHTML = ACCOUNTS.map(acc => {
    const isUnsynced = acc.quotaPercent === null || acc.quotaPercent === undefined;
    const st  = isUnsynced ? '' : status(acc.quotaPercent);
    const sel = acc.id === selectedId;
    const cls = 'account-card' +
      (sel ? ' selected' + (st === 'warn' ? ' status-warn' : st === 'critical' ? ' status-crit' : '') : '');
    return `
      <div class="${cls}" data-id="${acc.id}" id="card-${acc.id}" role="listitem" tabindex="0" aria-selected="${sel}">
        <div class="card-top-row">
          <span class="card-rank">${acc.rank}</span>
          <div class="avatar" style="background:${acc.avatarBg}">${acc.initials}</div>
          <div class="card-info">
            <div class="card-name">${esc(acc.name)}</div>
            <div class="card-email">${esc(acc.email)}</div>
          </div>
          <div class="card-actions">
            <button class="launch-btn" data-lid="${acc.id}" aria-label="Launch ${esc(acc.name)}">
              Launch
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>
              </svg>
            </button>
            <button class="remove-btn" data-rid="${acc.id}" title="Remove account" aria-label="Remove ${esc(acc.name)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="card-quota-row">
          ${!isUnsynced ? `
            <div class="quota-bar-wrap"><div class="quota-bar-fill ${st}" style="width:${acc.quotaPercent}%"></div></div>
            <span class="quota-pct">${acc.quotaPercent}%</span>
          ` : `
            <span class="unsynced-label">Not synced yet</span>
          `}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.account-card').forEach(card => {
    card.addEventListener('click', () => pick(+card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(+card.dataset.id); } });
  });
  list.querySelectorAll('.launch-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const a = ACCOUNTS.find(x => x.id === +btn.dataset.lid);
      console.info('[Lune] Launch →', a.name, a.email);
    });
  });
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeAccount(+btn.dataset.rid);
    });
  });
}

function removeAccount(id) {
  const index = ACCOUNTS.findIndex(a => a.id === id);
  if (index === -1) return;

  ACCOUNTS.splice(index, 1);
  ACCOUNTS.forEach((a, i) => { a.rank = i + 1; });

  if (selectedId === id) {
    if (ACCOUNTS.length > 0) {
      selectedId = ACCOUNTS[Math.min(index, ACCOUNTS.length - 1)].id;
    } else {
      selectedId = null;
    }
  }

  renderCards();
  renderDetail();
}

function pick(id) { selectedId = id; renderCards(); renderDetail(); }

/* ═══════════════════════════════════════════════════════
   RENDER — DETAIL PANEL
═══════════════════════════════════════════════════════ */
const TIPS = {
  promptCredits:  'Consumed each time you send a message or request a completion from the model.',
  flowCredits:    'Used up when the agent takes autonomous actions for you — like editing files or running commands.',
  maxInputTokens: 'The maximum amount of text (your message + code context) the model can receive in one request.',
  nextReset:      'The two pools reset independently — this shows whichever comes first.',
};

function renderDetail() {
  const acc = ACCOUNTS.find(a => a.id === selectedId);
  if (!acc) {
    document.getElementById('detail-header').innerHTML = `
      <div class="detail-name-wrap">
        <div class="detail-name">No Accounts</div>
        <div class="detail-email">Add an account to get started</div>
      </div>`;
    document.getElementById('detail-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5A6072" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div class="empty-title">No accounts registered</div>
        <div class="empty-sub">Click 'Add account' in the accounts panel to register an IDE profile and track its quotas.</div>
      </div>`;
    return;
  }
  const isUnsynced = !acc.stats || !acc.pools || acc.pools.length === 0;
  const st  = isUnsynced ? 'healthy' : status(acc.quotaPercent);

  /* Header */
  document.getElementById('detail-header').innerHTML = `
    <div class="detail-avatar" style="background:${acc.avatarBg}">${acc.initials}</div>
    <div class="detail-name-wrap">
      <div class="detail-name">${esc(acc.name)}</div>
      <div class="detail-email">${esc(acc.email)}</div>
    </div>
    <span class="plan-badge ${st}">${esc(acc.plan)}</span>
    <button class="launch-main-btn" id="launch-main" aria-label="Launch Antigravity for ${esc(acc.name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Launch Antigravity
    </button>`;
  document.getElementById('launch-main').addEventListener('click', () => console.info('[Lune] Main launch →', acc.name));

  /* Content */
  if (isUnsynced) {
    document.getElementById('detail-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5A6072" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </div>
        <div class="empty-title">Not synced yet</div>
        <div class="empty-sub">Refresh this account to load quota data and active model pools.</div>
        <button class="empty-sync-btn" id="empty-sync-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Sync / Refresh Account
        </button>
      </div>`;

    document.getElementById('empty-sync-btn')?.addEventListener('click', () => {
      refreshAccountObj(acc);
      renderDetail();
      renderCards();
    });
    return;
  }

  const s  = acc.stats;
  const ps = status(s.promptCredits.rem / s.promptCredits.tot * 100);
  const fs = status(s.flowCredits.rem   / s.flowCredits.tot   * 100);
  const syncSummary = getSyncDeltaSummary(acc);

  document.getElementById('detail-content').innerHTML = `
    <div class="section-title">Quota Pools</div>
    <div class="pools-grid" id="pools-grid-${acc.id}">
      ${acc.pools.map((p, pi) => {
        const pct = pctOf(p.remainingFraction);
        const pst = status(pct);
        const deltaInfo = getPoolDeltaInfo(acc, p);
        return `
        <div class="pool-column" id="pool-col-${acc.id}-${pi}">
          <div class="pool-card" id="pool-card-${acc.id}-${pi}">
            <div class="ring-container">${ring(Math.round(pct), pst)}</div>
            <div class="pool-info">
              <div class="pool-name">${esc(p.name)}</div>
              <div class="pool-models">${p.models.map(m => esc(m.name)).join(' · ')}</div>
              <div class="pool-reset" style="margin-bottom:4px">Resets in&nbsp;<span class="pool-reset-val">${esc(p.resetIn)} · ${getClockTime(p.resetIn)}</span></div>
              <div style="display:flex;align-items:center;justify-content:center;gap:4px;color:#5A6072;font-size:10px;margin-top:2px">
                <svg class="pool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                <span style="font-size:10px">details</span>
              </div>
            </div>
          </div>
          <div class="pool-stats-panel">
            <div class="pool-unit-breakdown">
              <div class="pool-unit-header">
                <div class="pool-unit-main">
                  <span class="pool-unit-num" style="color:${MUTED[pst]}">${pct.toFixed(2)}%</span>
                  <span class="pool-unit-fraction">(remainingFraction: ${p.remainingFraction.toFixed(4)})</span>
                </div>
                ${deltaInfo ? `<span class="pool-delta-tag ${deltaInfo.cls}">${deltaInfo.text}</span>` : ''}
              </div>
              <div class="pool-bar-wrap">
                <div class="pool-bar-fill ${pst}" style="width:${pct}%"></div>
              </div>
              <div class="model-breakdown">
                ${p.models.map(m => {
                  const mpct = pctOf(m.fraction);
                  const mst  = status(mpct);
                  return `
                  <div class="model-row">
                    <span class="model-row-name">${esc(m.name)}</span>
                    ${m.tag ? `<span class="model-tag${m.tag === 'fast' ? ' fast' : ''}">${esc(m.tag)}</span>` : ''}
                    <span class="model-row-frac" style="color:${MUTED[mst]}">${mpct.toFixed(1)}%</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="section-title">Usage Stats</div>
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-label has-tooltip" data-tip="promptCredits">Prompt credits</span>
        <span class="stat-value" style="color:${MUTED[ps]}">${fmt(s.promptCredits.rem)}</span>
        <div class="stat-sub">of ${fmt(s.promptCredits.tot)} total</div>
      </div>
      <div class="stat-card">
        <span class="stat-label has-tooltip" data-tip="flowCredits">Flow credits</span>
        <span class="stat-value" style="color:${MUTED[fs]}">${fmt(s.flowCredits.rem)}</span>
        <div class="stat-sub">of ${fmt(s.flowCredits.tot)} total</div>
      </div>
      <div class="stat-card">
        <span class="stat-label has-tooltip" data-tip="maxInputTokens">Max input tokens</span>
        <span class="stat-value" style="font-size:15px;line-height:1.2">${fmt(s.maxInputTokens)}</span>
        <div class="stat-sub">≈ ${words(s.maxInputTokens)} words</div>
      </div>
      <div class="stat-card">
        <span class="stat-label has-tooltip" data-tip="nextReset">Next reset</span>
        <span class="stat-value" style="font-size:12px;line-height:1.35">${esc(s.nextReset)} <span style="font-size:10.5px;font-weight:400;color:#9298A8">· ${getClockTime(s.nextReset)}</span></span>
        <div class="stat-sub">soonest pool</div>
      </div>
    </div>

    <div class="sync-row">
      <div class="pulse-dot ${st}" aria-hidden="true"></div>
      <span class="sync-text">
        Last synced <span class="sync-time" id="det-sync">${timeSince(acc.lastSync)}</span>
        ${syncSummary ? ` · <span class="sync-delta-text">${syncSummary}</span>` : ''}
      </span>
      <button class="refresh-acc-btn" id="refresh-acc-btn" aria-label="Refresh this account">
        <svg class="refresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Refresh this account
      </button>
    </div>`;

  document.getElementById('refresh-acc-btn').addEventListener('click', e => {
    const btn = e.currentTarget;
    btn.classList.remove('spinning'); void btn.offsetWidth; btn.classList.add('spinning');
    refreshAccountObj(acc);
    console.info('[Lune] Refresh this account →', acc.name, acc.email);
    setTimeout(() => { renderDetail(); renderCards(); }, 550);
  });

  document.getElementById('detail-content').querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', showTip);
    el.addEventListener('mousemove',  moveTip);
    el.addEventListener('mouseleave', hideTip);
  });

  /* Pool card expand/collapse — height driven by real content (scrollHeight),
     not a guessed fixed max-height, since the model list length varies per pool */
  document.getElementById('detail-content').querySelectorAll('.pool-column').forEach(col => {
    const card  = col.querySelector('.pool-card');
    const panel = col.querySelector('.pool-stats-panel');
    if (card && panel) {
      card.addEventListener('click', () => {
        const isExpanded = col.classList.contains('expanded');
        if (isExpanded) {
          panel.style.maxHeight = '0px';
          col.classList.remove('expanded');
        } else {
          col.classList.add('expanded');
          panel.style.maxHeight = panel.scrollHeight + 'px';
        }
      });
    }
  });
}

/* ═══════════════════════════════════════════════════════
   TOOLTIP
═══════════════════════════════════════════════════════ */
const tipEl = document.getElementById('tooltip');
function showTip(e) { tipEl.textContent = TIPS[e.currentTarget.dataset.tip] || ''; tipEl.classList.add('visible'); moveTip(e); }
function hideTip()  { tipEl.classList.remove('visible'); }
function moveTip(e) {
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight, pad = 14;
  let x = e.clientX - tw / 2, y = e.clientY - th - pad;
  x = Math.max(6, Math.min(x, innerWidth  - tw - 6));
  y = y < 6 ? e.clientY + pad : y;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}

/* ═══════════════════════════════════════════════════════
   SYNC CLOCK
═══════════════════════════════════════════════════════ */
function timeSince(ts) {
  const from = ts === undefined ? lastSync : ts;
  const s = Math.round((Date.now() - from) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
function tickSync() {
  const sub = document.getElementById('sync-subtitle');
  const det = document.getElementById('det-sync');
  if (sub) sub.textContent = 'Last synced ' + timeSince(lastSync);
  const acc = ACCOUNTS.find(a => a.id === selectedId);
  if (det && acc) det.textContent = timeSince(acc.lastSync);
}
setInterval(tickSync, 5000);

document.getElementById('refresh-btn').addEventListener('click', () => {
  const now = Date.now();
  lastSync = now;
  ACCOUNTS.forEach(a => refreshAccountObj(a));
  const btn = document.getElementById('refresh-btn');
  btn.classList.remove('spinning');
  void btn.offsetWidth;
  btn.classList.add('spinning');
  setTimeout(() => {
    btn.classList.remove('spinning');
    renderCards();
    renderDetail();
  }, 600);
});

/* Modal event bindings */
const addModal = document.getElementById('add-modal');
const addForm  = document.getElementById('add-acc-form');

function openAddModal() {
  addForm.reset();
  addModal.classList.add('open');
  document.getElementById('acc-name-input').focus();
}
function closeAddModal() {
  addModal.classList.remove('open');
}

document.getElementById('add-acc-btn').addEventListener('click', openAddModal);
document.getElementById('modal-close-btn').addEventListener('click', closeAddModal);
document.getElementById('modal-cancel-btn').addEventListener('click', closeAddModal);
addModal.addEventListener('click', e => { if (e.target === addModal) closeAddModal(); });
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && addModal.classList.contains('open')) closeAddModal();
});

addForm.addEventListener('submit', e => {
  e.preventDefault();
  const name  = document.getElementById('acc-name-input').value.trim();
  const email = document.getElementById('acc-email-input').value.trim();
  if (!name || !email) return;

  const newAccount = {
    id: Date.now(),
    rank: ACCOUNTS.length + 1,
    name: name,
    email: email,
    initials: deriveInitials(name),
    avatarBg: AVATAR_PALETTE[ACCOUNTS.length % AVATAR_PALETTE.length],
    plan: 'Unlinked',
    quotaPercent: null,
    lastSync: null,
    pools: [],
    stats: null,
    previousSnapshot: null
  };

  ACCOUNTS.push(newAccount);
  selectedId = newAccount.id;
  closeAddModal();
  renderCards();
  renderDetail();
});

/* ═══════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════ */
renderCards();
renderDetail();
</script>
</body>
</html>
```

---

## `lifecycle-test.js`

```javascript
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
 *   node lifecycle-test.js              # full 3-run measurement
 *   node lifecycle-test.js --variant-d  # Variant D: bare workspace-folder arg, 30 s timeout
 *   node lifecycle-test.js --manual     # MANUAL mode: spawn, pause for ENTER, poll 60 s,
 *                                       #   query, pause for ENTER, then kill
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
  log(`[2/7] Spawning Antigravity…`);
  log(`      EXE : ${ANTIGRAVITY_EXE}`);
  log(`      Flags tested: --start-minimized  +  windowsHide:true`);

  const spawnArgs = [
    `--user-data-dir=${USER_DATA_DIR}`,
    '--start-minimized',   // Electron flag — may or may not be honoured
    '--no-sandbox',        // harmless if unsupported
  ];

  let child, mainPid;
  const spawnT0 = Date.now();
  try {
    child   = spawn(`"${ANTIGRAVITY_EXE}"`, spawnArgs, {
      shell:       true,
      detached:    false,
      windowsHide: true,   // Node OS-level flag to suppress console window
      stdio:       'ignore',
    });
    mainPid    = child.pid;
    R.spawnMs  = Date.now() - spawnT0;
    ok(`Spawned  PID=${mainPid}  (spawn() returned in ${R.spawnMs} ms)`);
    info('Observe manually whether a visible window appeared (windowsHide:true + --start-minimized both tried).');
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isVariantD = process.argv.includes('--variant-d');
  const isManual   = process.argv.includes('--manual');

  if (isManual) {
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

  } else {
    // ── Normal 3-run mode ──────────────────────────────────────────────────────
    console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
    console.log(c(BO, '║  Antigravity IDE Lifecycle Measurement  v4' + ' '.repeat(27) + '║'));
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
```

---

## `probe.js`

```javascript
const https = require('https');

const PORT = 54779;
const CSRF_TOKEN = "f151dcd5-1544-4ebf-941c-564f8be1dc74"; // your main --csrf_token

const bodyData = JSON.stringify({
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en"
  }
});

const options = {
  hostname: '127.0.0.1',
  port: PORT,
  path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-codeium-csrf-token': CSRF_TOKEN,
    'Content-Length': Buffer.byteLength(bodyData)
  },
  rejectUnauthorized: false // accept the local self-signed cert
};

const req = https.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Response body:');
    console.log(data);
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
});

req.write(bodyData);
req.end();
```
