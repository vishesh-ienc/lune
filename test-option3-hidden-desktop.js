#!/usr/bin/env node
/**
 * test-option3-hidden-desktop.js
 *
 * OPTION 3 TEST: Hidden Win32 Desktop
 *
 * Strategy:
 *   Windows renders everything for a process on whichever desktop object it was
 *   started on.  By creating a NEW desktop object in the current window station
 *   (WinSta0) that the user is never switched to, every window Chromium creates
 *   exists only on that hidden desktop — no race, no flash, not even a brief
 *   frame visible on the real screen.
 *
 * Implementation:
 *   1. koffi → user32.dll  : CreateDesktopW, CloseDesktop
 *   2. koffi → kernel32.dll: CreateProcessW (sets STARTUPINFOW.lpDesktop),
 *                             CloseHandle, GetLastError, WaitForSingleObject,
 *                             TerminateProcess
 *   3. Node child_process.spawn is NOT used for the main IDE process; we call
 *      CreateProcessW directly so we can control STARTUPINFOW.lpDesktop.
 *   4. After successful launch: polls LSP → extracts CSRF → GetUserStatus →
 *      kills process tree → CloseDesktop.
 *
 * What to check when running:
 *   Watch your ENTIRE screen for the full duration of the command.
 *   If this approach works you should see NOTHING — not even a brief flash —
 *   because the Chromium window is created on a desktop the OS never shows you.
 */

'use strict';

const { execSync }        = require('child_process');
const https               = require('https');
const { performance }     = require('perf_hooks');

// ─── Configuration ────────────────────────────────────────────────────────────

const ANTIGRAVITY_EXE  = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
const USER_DATA_DIR    = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';
const WORKSPACE_DIR    = 'C:\\Users\\VISHESH\\Desktop\\lune';

// Name of the hidden desktop we will create.
// Format must be "WinStationName\\DesktopName" for STARTUPINFO.lpDesktop.
// We stay inside the current interactive window station (WinSta0) so the
// process can still access resources (fonts, etc.) but is never visible.
const HIDDEN_DESKTOP_NAME     = 'AntigravityHidden';
const HIDDEN_DESKTOP_FULLNAME = `Winsta0\\${HIDDEN_DESKTOP_NAME}`;

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
const MA = '\x1b[35m';
const BL = '\x1b[34m';

function c(col, txt) { return isTTY ? `${col}${txt}${R}` : txt; }
function ts()         { return new Date().toISOString().replace('T', ' ').slice(0, -1); }
function log(msg)     { console.log(`${c(DI, ts())}  ${msg}`); }
function ok(msg)      { console.log(`${c(DI, ts())}  ${c(GR, '✓')} ${msg}`); }
function warn(msg)    { console.log(`${c(DI, ts())}  ${c(YE, '⚠')} ${msg}`); }
function fail(msg)    { console.log(`${c(DI, ts())}  ${c(RE, '✖')} ${msg}`); }
function info(msg)    { console.log(`${c(DI, ts())}  ${c(BL, '·')} ${msg}`); }
function sep()        { console.log(c(DI, '─'.repeat(70))); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Wide-String Buffer Helper ────────────────────────────────────────────────

/**
 * Encode a JavaScript string as a null-terminated UTF-16LE Buffer.
 * This is what Windows W-suffix APIs expect for LPWSTR / LPCWSTR inputs.
 */
function toWide(str) {
  const buf = Buffer.alloc((str.length + 1) * 2); // +1 for null terminator
  buf.write(str, 0, 'utf16le');
  return buf; // last two bytes are already 0x00 0x00 from Buffer.alloc
}

// ─── Win32 Constant Definitions ───────────────────────────────────────────────

// CreateDesktopW dwDesiredAccess — combination needed for a process to render
// windows on the desktop.  We do NOT request DESKTOP_SWITCHDESKTOP so the user
// can never accidentally switch to it via Ctrl+Alt+Tab or similar hotkeys.
const DESKTOP_READOBJECTS    = 0x0001;
const DESKTOP_CREATEWINDOW   = 0x0002;
const DESKTOP_CREATEMENU     = 0x0004;
const DESKTOP_HOOKCONTROL    = 0x0008;
const DESKTOP_JOURNALRECORD  = 0x0010;
const DESKTOP_JOURNALPLAYBACK= 0x0020;
const DESKTOP_ENUMERATE      = 0x0040;
const DESKTOP_WRITEOBJECTS   = 0x0080;

// Access mask we request — all rights that Chromium/CEF needs to actually paint,
// minus DESKTOP_SWITCHDESKTOP (0x0100) so the user can't flip to it.
const DESKTOP_ACCESS =
  DESKTOP_READOBJECTS    |
  DESKTOP_CREATEWINDOW   |
  DESKTOP_CREATEMENU     |
  DESKTOP_HOOKCONTROL    |
  DESKTOP_ENUMERATE      |
  DESKTOP_WRITEOBJECTS;   // 0xCF

// CreateProcessW dwCreationFlags
const CREATE_NEW_CONSOLE       = 0x00000010;  // Give the process its own console (keeps it independent)
const NORMAL_PRIORITY_CLASS    = 0x00000020;
const CREATE_NO_WINDOW         = 0x08000000;  // No console window for the launcher itself
const DETACHED_PROCESS         = 0x00000008;

// STARTUPINFO dwFlags
const STARTF_USESHOWWINDOW     = 0x00000001;

// ShowWindow values
const SW_HIDE = 0;

// ─── Process & LSP Helpers (identical to test-hide-hook.js baseline) ──────────

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
    /"csrf[_-]?token"[:\s"]+(\w[\w-]{19,})/i,
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

// ─── Verified Multi-Pass Cleanup & Orphan Removal ────────────────────────────

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
    warn(`[Cleanup Verification] Found ${remaining.length} surviving child/profile process(es) after tree-kill. Attempting direct taskkill by PID...`);
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
    fail(`[Cleanup Verification] Warning: ${remaining.length} process(es) could not be terminated: ${remaining.map(p => `${p.pid} (${p.name})`).join(', ')}`);
    return false;
  }
}

// ─── Win32 FFI Layer: CreateDesktopW + CreateProcessW ─────────────────────────

function initWin32() {
  const koffi = require('koffi');

  // ── Load DLLs ──────────────────────────────────────────────────────────────
  const user32   = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  // ── user32 functions ────────────────────────────────────────────────────────

  // HDESK CreateDesktopW(
  //   LPCWSTR               lpszDesktop,   -- desktop name (no backslashes)
  //   LPCWSTR               lpszDevice,    -- reserved, must be NULL
  //   DEVMODEW*             pDevmode,       -- reserved, must be NULL
  //   DWORD                 dwFlags,
  //   ACCESS_MASK           dwDesiredAccess,
  //   LPSECURITY_ATTRIBUTES lpsa            -- NULL = inherit from window station
  // );
  const CreateDesktopW = user32.func('__stdcall', 'CreateDesktopW', 'void *', [
    'str16',    // lpszDesktop — koffi auto-encodes JS string to UTF-16
    'void *',   // lpszDevice  — NULL
    'void *',   // pDevmode    — NULL
    'uint32',   // dwFlags
    'uint32',   // dwDesiredAccess
    'void *',   // lpsa        — NULL
  ]);

  // BOOL CloseDesktop(HDESK hDesktop);
  const CloseDesktop = user32.func('__stdcall', 'CloseDesktop', 'bool', ['void *']);

  // ── kernel32 functions ──────────────────────────────────────────────────────

  // DWORD GetLastError(void);
  const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);

  // BOOL CloseHandle(HANDLE hObject);
  const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);

  // BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode);
  const TerminateProcess = kernel32.func('__stdcall', 'TerminateProcess', 'bool', ['void *', 'uint32']);

  // DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);
  const WaitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32']);

  // ── STARTUPINFOW struct ─────────────────────────────────────────────────────
  //
  // We store lpDesktop (and other LPWSTR fields) as 'void *' pointer fields in
  // the koffi struct.  Before the CreateProcessW call we convert the desktop name
  // string to a UTF-16LE Buffer and keep that Buffer alive for the duration of
  // the call (local variable reference keeps GC from collecting it).
  //
  // Full STARTUPINFOW layout (68 bytes on x64):
  //   DWORD  cb;              +0   4 bytes
  //   LPWSTR lpReserved;      +4   8 bytes (ptr)
  //   LPWSTR lpDesktop;       +12  8 bytes (ptr)
  //   LPWSTR lpTitle;         +20  8 bytes (ptr)
  //   DWORD  dwX;             +28  4 bytes
  //   DWORD  dwY;             +32  4 bytes
  //   DWORD  dwXSize;         +36  4 bytes
  //   DWORD  dwYSize;         +40  4 bytes
  //   DWORD  dwXCountChars;   +44  4 bytes
  //   DWORD  dwYCountChars;   +48  4 bytes
  //   DWORD  dwFillAttribute; +52  4 bytes
  //   DWORD  dwFlags;         +56  4 bytes
  //   WORD   wShowWindow;     +60  2 bytes
  //   WORD   cbReserved2;     +62  2 bytes
  //   LPBYTE lpReserved2;     +64  8 bytes (ptr)  — makes total 72 bytes
  //   HANDLE hStdInput;       +72  8 bytes (ptr)
  //   HANDLE hStdOutput;      +80  8 bytes (ptr)
  //   HANDLE hStdError;       +88  8 bytes (ptr)
  // Total: 96 bytes on 64-bit
  //
  // koffi maps JS 'void *' to a pointer-sized integer (8 bytes on 64-bit),
  // which is exactly what we need for the HANDLE / LPWSTR fields.

  const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
    cb:              'uint32',
    _pad1:           'uint32',   // explicit 4-byte padding to align next pointer to 8 bytes
    lpReserved:      'void *',
    lpDesktop:       'void *',
    lpTitle:         'void *',
    dwX:             'uint32',
    dwY:             'uint32',
    dwXSize:         'uint32',
    dwYSize:         'uint32',
    dwXCountChars:   'uint32',
    dwYCountChars:   'uint32',
    dwFillAttribute: 'uint32',
    dwFlags:         'uint32',
    wShowWindow:     'uint16',
    cbReserved2:     'uint16',
    _pad2:           'uint32',   // explicit 4-byte padding to align next pointer to 8 bytes
    lpReserved2:     'void *',
    hStdInput:       'void *',
    hStdOutput:      'void *',
    hStdError:       'void *',
  });

  // ── PROCESS_INFORMATION struct ──────────────────────────────────────────────
  // HANDLE hProcess;    +0   8 bytes
  // HANDLE hThread;     +8   8 bytes
  // DWORD  dwProcessId; +16  4 bytes
  // DWORD  dwThreadId;  +20  4 bytes
  // Total: 24 bytes

  const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
    hProcess:    'void *',
    hThread:     'void *',
    dwProcessId: 'uint32',
    dwThreadId:  'uint32',
  });

  // ── CreateProcessW ──────────────────────────────────────────────────────────
  // BOOL CreateProcessW(
  //   LPCWSTR               lpApplicationName,
  //   LPWSTR                lpCommandLine,
  //   LPSECURITY_ATTRIBUTES lpProcessAttributes,
  //   LPSECURITY_ATTRIBUTES lpThreadAttributes,
  //   BOOL                  bInheritHandles,
  //   DWORD                 dwCreationFlags,
  //   LPVOID                lpEnvironment,
  //   LPCWSTR               lpCurrentDirectory,
  //   LPSTARTUPINFOW        lpStartupInfo,
  //   LPPROCESS_INFORMATION lpProcessInformation
  // );
  //
  // We pass lpApplicationName as 'str16' (auto-converted by koffi) and
  // lpCommandLine as a void* (pointer to our pre-built mutable Buffer).
  // lpStartupInfo is passed as a koffi pointer to STARTUPINFOW struct.
  // lpProcessInformation is passed as koffi.out pointer to PROCESS_INFORMATION.

  const CreateProcessW = kernel32.func('__stdcall', 'CreateProcessW', 'bool', [
    'str16',                              // lpApplicationName
    'void *',                             // lpCommandLine (mutable wide Buffer)
    'void *',                             // lpProcessAttributes (NULL)
    'void *',                             // lpThreadAttributes  (NULL)
    'bool',                               // bInheritHandles
    'uint32',                             // dwCreationFlags
    'void *',                             // lpEnvironment (NULL = inherit)
    'void *',                             // lpCurrentDirectory (NULL = inherit)
    koffi.pointer(STARTUPINFOW),          // lpStartupInfo (in)
    koffi.out(koffi.pointer(PROCESS_INFORMATION)), // lpProcessInformation (out)
  ]);

  return {
    koffi,
    CreateDesktopW,
    CloseDesktop,
    GetLastError,
    CloseHandle,
    TerminateProcess,
    WaitForSingleObject,
    CreateProcessW,
    STARTUPINFOW,
    PROCESS_INFORMATION,
  };
}

// ─── Main Execution ───────────────────────────────────────────────────────────

async function runTest() {
  console.log(c(BO, '\n==============================================================='));
  console.log(c(BO, '  OPTION 3: HIDDEN WIN32 DESKTOP TEST  (test-option3-hidden-desktop.js)'));
  console.log(c(BO, '===============================================================\n'));
  log(`Strategy       : CreateDesktopW("${HIDDEN_DESKTOP_NAME}") → CreateProcessW with STARTUPINFO.lpDesktop`);
  log(`Hidden Desktop : ${HIDDEN_DESKTOP_FULLNAME}`);
  log(`Exe            : ${ANTIGRAVITY_EXE}`);
  log(`Profile        : ${USER_DATA_DIR}`);
  log(`Folder         : ${WORKSPACE_DIR}\n`);

  // ── Pre-check for existing processes ──────────────────────────────────────
  const existing = getAntigravityProcesses();
  if (existing.length > 0) {
    warn(`Found ${existing.length} pre-existing Antigravity processes running. Cleaning up before test...`);
    cleanKillProcessTree(null);
    await sleep(1000);
  }

  // ── [Step 1] Init Win32 FFI ───────────────────────────────────────────────
  log('[1/6] Initialising koffi Win32 FFI bindings...');
  let win32;
  try {
    win32 = initWin32();
    ok('koffi loaded: user32.dll (CreateDesktopW, CloseDesktop), kernel32.dll (CreateProcessW, CloseHandle, GetLastError)');
  } catch (err) {
    fail(`Failed to initialise koffi Win32 FFI: ${err.message}`);
    if (err.stack) info(`Stack: ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
    process.exit(1);
  }

  const {
    koffi,
    CreateDesktopW, CloseDesktop,
    GetLastError,
    CloseHandle, TerminateProcess, WaitForSingleObject,
    CreateProcessW,
    STARTUPINFOW, PROCESS_INFORMATION,
  } = win32;

  // ── [Step 2] Create hidden desktop ───────────────────────────────────────
  log(`[2/6] Creating hidden Win32 desktop "${HIDDEN_DESKTOP_NAME}" in WinSta0...`);
  log(`      Access mask  : 0x${DESKTOP_ACCESS.toString(16).toUpperCase().padStart(2, '0')} (all rights except DESKTOP_SWITCHDESKTOP)`);
  log(`      dwFlags      : 0 (no DF_ALLOWOTHERACCOUNTHOOK — no cross-account hook access needed)`);

  const hDesktop = CreateDesktopW(
    HIDDEN_DESKTOP_NAME,  // desktop name — no backslashes allowed here
    null,                 // lpszDevice — reserved, must be NULL
    null,                 // pDevmode   — reserved, must be NULL
    0,                    // dwFlags
    DESKTOP_ACCESS,       // dwDesiredAccess
    null,                 // lpsa — NULL = inherit from window station
  );

  if (!hDesktop) {
    const lastErr = GetLastError();
    fail(`CreateDesktopW FAILED. GetLastError() = ${lastErr} (0x${lastErr.toString(16).toUpperCase()})`);
    if (lastErr === 5)   fail('  Error 5 = ERROR_ACCESS_DENIED — insufficient privileges to create desktop');
    if (lastErr === 87)  fail('  Error 87 = ERROR_INVALID_PARAMETER — check access mask / flags');
    if (lastErr === 183) warn('  Error 183 = ERROR_ALREADY_EXISTS — desktop with this name already exists; handle returned is valid, proceeding...');
    if (lastErr !== 183) process.exit(1);
  }

  // Handle ERROR_ALREADY_EXISTS (183): CreateDesktop still returns a valid handle
  const lastErrAfterCreate = GetLastError();
  if (lastErrAfterCreate === 183) {
    warn(`Desktop "${HIDDEN_DESKTOP_NAME}" already existed (ERROR_ALREADY_EXISTS=183). Using returned handle — it is still valid.`);
  } else {
    ok(`Hidden desktop created successfully. hDesktop handle = ${hDesktop}`);
  }

  // ── [Step 3] Build command line and launch via CreateProcessW ─────────────
  //
  // Command: "Antigravity IDE.exe" --user-data-dir=<dir> <workspace>
  //
  // We pass the application path as lpApplicationName (str16, NULL-terminated)
  // and build the full command line as a mutable UTF-16LE Buffer for
  // lpCommandLine (required by CreateProcessW spec for modifiable cmdline).
  //
  // The key part: si.lpDesktop points to our desktop name Buffer so the kernel
  // routes the new process to our hidden desktop instead of the default.

  const cmdArgs   = [`--user-data-dir=${USER_DATA_DIR}`, WORKSPACE_DIR];
  const cmdLine   = `"${ANTIGRAVITY_EXE}" ${cmdArgs.join(' ')}`;
  const cmdLineBuf = toWide(cmdLine);         // mutable wide Buffer for lpCommandLine
  const desktopBuf = toWide(HIDDEN_DESKTOP_FULLNAME); // wide Buffer for lpDesktop pointer

  // Build STARTUPINFOW object.
  // koffi maps 'void *' struct fields from JS numbers / BigInts / Buffers.
  // We pass desktopBuf directly — koffi will use its underlying memory address
  // as the LPWSTR pointer value for the lpDesktop field.
  const si = {
    cb:              koffi.sizeof(STARTUPINFOW),
    _pad1:           0,
    lpReserved:      null,
    lpDesktop:       desktopBuf,   // ← pointer to our UTF-16LE desktop name buffer
    lpTitle:         null,
    dwX:             0,
    dwY:             0,
    dwXSize:         0,
    dwYSize:         0,
    dwXCountChars:   0,
    dwYCountChars:   0,
    dwFillAttribute: 0,
    dwFlags:         STARTF_USESHOWWINDOW,
    wShowWindow:     SW_HIDE,  // request hidden initial window state as belt-and-suspenders
    cbReserved2:     0,
    _pad2:           0,
    lpReserved2:     null,
    hStdInput:       null,
    hStdOutput:      null,
    hStdError:       null,
  };

  // PROCESS_INFORMATION will be filled in by CreateProcessW
  const pi = {
    hProcess:    null,
    hThread:     null,
    dwProcessId: 0,
    dwThreadId:  0,
  };

  const spawnTimeMs = Date.now();
  const spawnIso    = new Date().toISOString();

  log(`[3/6] Calling CreateProcessW on hidden desktop "${HIDDEN_DESKTOP_FULLNAME}"...`);
  log(`      Application  : ${ANTIGRAVITY_EXE}`);
  log(`      Command Line : ${cmdLine}`);
  log(`      lpDesktop    : ${HIDDEN_DESKTOP_FULLNAME}`);
  log(`      dwFlags      : STARTF_USESHOWWINDOW | wShowWindow=SW_HIDE (belt-and-suspenders)`);

  let createOk = false;
  try {
    createOk = CreateProcessW(
      ANTIGRAVITY_EXE,  // lpApplicationName
      cmdLineBuf,       // lpCommandLine (mutable wide Buffer)
      null,             // lpProcessAttributes
      null,             // lpThreadAttributes
      false,            // bInheritHandles
      NORMAL_PRIORITY_CLASS, // dwCreationFlags
      null,             // lpEnvironment
      null,             // lpCurrentDirectory
      si,               // lpStartupInfo
      pi,               // lpProcessInformation (output)
    );
  } catch (err) {
    fail(`CreateProcessW threw an exception: ${err.message}`);
    if (err.stack) info(`Stack: ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
    CloseDesktop(hDesktop);
    process.exit(1);
  }

  if (!createOk) {
    const lastErr = GetLastError();
    fail(`CreateProcessW FAILED. GetLastError() = ${lastErr} (0x${lastErr.toString(16).toUpperCase()})`);
    if (lastErr === 2)   fail('  Error 2 = ERROR_FILE_NOT_FOUND — EXE path does not exist');
    if (lastErr === 5)   fail('  Error 5 = ERROR_ACCESS_DENIED');
    if (lastErr === 87)  fail('  Error 87 = ERROR_INVALID_PARAMETER');
    if (lastErr === 740) fail('  Error 740 = ERROR_ELEVATION_REQUIRED — EXE requires elevation');
    CloseDesktop(hDesktop);
    process.exit(1);
  }

  const mainPid  = pi.dwProcessId;
  const hProcess = pi.hProcess;
  const hThread  = pi.hThread;

  ok(`[3/6] CreateProcessW succeeded!`);
  log(`      PID          : ${c(BO, String(mainPid))}`);
  log(`      TID          : ${pi.dwThreadId}`);
  log(`      hProcess     : ${hProcess}`);
  log(`      hThread      : ${hThread}`);
  log(`      Spawn time   : ${spawnIso}\n`);

  // Close thread handle immediately — we don't need it.
  if (hThread) {
    CloseHandle(hThread);
    info('Closed hThread handle (not needed).');
  }

  // ── [Step 4] Poll for Language Server process ──────────────────────────────
  log(`[4/6] Polling for Antigravity Language Server process (timeout: ${LSP_POLL_TIMEOUT_MS / 1000}s)...`);

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
    if (hProcess) CloseHandle(hProcess);
    CloseDesktop(hDesktop);
    cleanKillProcessTree(mainPid);
    process.exit(1);
  }

  const lspTimeMs = Date.now() - spawnTimeMs;
  ok(`Language Server detected! PID: ${c(BO, String(lspProc.pid))} (${lspTimeMs} ms post-spawn)`);

  const csrfToken = extractCsrfToken(lspProc.commandLine);
  if (!csrfToken) {
    warn('CSRF token not found in LSP command line.');
  } else {
    ok(`CSRF token extracted: ${csrfToken.slice(0, 10)}...`);
  }

  // ── [Step 5] Query GetUserStatus ───────────────────────────────────────────
  log(`[5/6] Warmup pause (${LSP_WARMUP_MS}ms) before querying GetUserStatus...`);
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

  // ── [Step 6] Cleanup: kill process tree, close handles, destroy desktop ────
  log('[6/6] Cleanup: killing process tree, closing handles, destroying hidden desktop...');

  const cleanupClean = cleanKillProcessTree(mainPid);

  // Close the hProcess handle we kept for Win32 management
  if (hProcess) {
    CloseHandle(hProcess);
    info('Closed hProcess handle.');
  }

  // CloseDesktop — destroys the hidden desktop and frees its heap allocation
  const desktopClosed = CloseDesktop(hDesktop);
  if (desktopClosed) {
    ok(`Hidden desktop "${HIDDEN_DESKTOP_NAME}" destroyed (CloseDesktop succeeded).`);
  } else {
    const lastErr = GetLastError();
    warn(`CloseDesktop returned false. GetLastError() = ${lastErr}. Desktop may still persist until session end.`);
  }

  // ── Summary Report ─────────────────────────────────────────────────────────
  sep();
  console.log(c(BO, '               OPTION 3 TEST RESULTS SUMMARY'));
  sep();
  console.log(`  ${c(CY, 'Strategy')}              : Hidden Win32 Desktop (CreateDesktopW + CreateProcessW)`);
  console.log(`  ${c(CY, 'Hidden Desktop')}        : ${HIDDEN_DESKTOP_FULLNAME}`);
  console.log(`  ${c(CY, 'Process Launch')}        : ${c(BO, `PID ${mainPid}`)} via CreateProcessW`);
  console.log(`  ${c(CY, 'Window Visibility')}     : ${c(BO, 'NONE — window created on hidden desktop, never on real screen')}`);
  console.log(`  ${c(CY, 'LSP Process Spawn')}     : SUCCESS ✓ (PID ${lspProc.pid}, detected in ${lspTimeMs} ms)`);
  console.log(`  ${c(CY, 'GetUserStatus Query')}   : ${statusOk ? c(GR, `SUCCESS ✓ (HTTP ${statusResult?.status})`) : c(RE, 'FAILED ✖')}`);
  console.log(`  ${c(CY, 'Process Tree Cleanup')}  : ${cleanupClean ? c(GR, 'CLEAN ✓ (0 remaining processes)') : c(RE, 'FAILED ✖ (check orphan warning above)')}`);
  console.log(`  ${c(CY, 'Desktop Cleanup')}       : ${desktopClosed ? c(GR, 'CloseDesktop ✓') : c(YE, 'CloseDesktop returned false — see warning')}`);
  sep();
  console.log('\nDone.\n');
}

runTest().catch(err => {
  fail(`Unhandled error in test runner: ${err.stack || err.message}`);
  process.exit(1);
});
