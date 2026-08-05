'use strict';

const fs                  = require('fs');
const path                = require('path');
const https               = require('https');
const { execSync, spawn } = require('child_process');
const koffi               = require('koffi');

// ─── Default Configuration & Constants ────────────────────────────────────────

const DEFAULT_ANTIGRAVITY_EXE = process.env.ANTIGRAVITY_EXE ||
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\VISHESH\\AppData\\Local', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe');

const DEFAULT_USER_DATA_DIR = process.env.ANTIGRAVITY_USER_DATA ||
  path.join(process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming', 'Antigravity IDE');

// Win32 CreateDesktopW dwDesiredAccess
const DESKTOP_READOBJECTS     = 0x0001;
const DESKTOP_CREATEWINDOW    = 0x0002;
const DESKTOP_CREATEMENU      = 0x0004;
const DESKTOP_HOOKCONTROL     = 0x0008;
const DESKTOP_JOURNALRECORD   = 0x0010;
const DESKTOP_JOURNALPLAYBACK = 0x0020;
const DESKTOP_ENUMERATE       = 0x0040;
const DESKTOP_WRITEOBJECTS    = 0x0080;

const DESKTOP_ACCESS =
  DESKTOP_READOBJECTS    |
  DESKTOP_CREATEWINDOW   |
  DESKTOP_CREATEMENU     |
  DESKTOP_HOOKCONTROL    |
  DESKTOP_ENUMERATE      |
  DESKTOP_WRITEOBJECTS;   // 0xCF

// Win32 CreateProcessW dwCreationFlags & STARTUPINFOW dwFlags
const NORMAL_PRIORITY_CLASS = 0x00000020;
const STARTF_USESHOWWINDOW  = 0x00000001;
const SW_HIDE               = 0;

// ─── Module-Level Koffi Win32 FFI Binding Initialization ──────────────────────

const user32   = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const CreateDesktopW = user32.func('__stdcall', 'CreateDesktopW', 'void *', [
  'str16',    // lpszDesktop
  'void *',   // lpszDevice
  'void *',   // pDevmode
  'uint32',   // dwFlags
  'uint32',   // dwDesiredAccess
  'void *',   // lpsa
]);

const CloseDesktop        = user32.func('__stdcall', 'CloseDesktop', 'bool', ['void *']);
const GetLastError        = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const CloseHandle         = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
const TerminateProcess    = kernel32.func('__stdcall', 'TerminateProcess', 'bool', ['void *', 'uint32']);
const WaitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32']);

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb:              'uint32',
  _pad1:           'uint32',
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
  _pad2:           'uint32',
  lpReserved2:     'void *',
  hStdInput:       'void *',
  hStdOutput:      'void *',
  hStdError:       'void *',
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess:    'void *',
  hThread:     'void *',
  dwProcessId: 'uint32',
  dwThreadId:  'uint32',
});

const CreateProcessW = kernel32.func('__stdcall', 'CreateProcessW', 'bool', [
  'str16',                              // lpApplicationName
  'void *',                             // lpCommandLine (mutable wide Buffer)
  'void *',                             // lpProcessAttributes
  'void *',                             // lpThreadAttributes
  'bool',                               // bInheritHandles
  'uint32',                             // dwCreationFlags
  'void *',                             // lpEnvironment
  'void *',                             // lpCurrentDirectory
  koffi.pointer(STARTUPINFOW),          // lpStartupInfo
  koffi.out(koffi.pointer(PROCESS_INFORMATION)), // lpProcessInformation
]);

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function toWide(str) {
  const buf = Buffer.alloc((str.length + 1) * 2);
  buf.write(str, 0, 'utf16le');
  return buf;
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

function listProcesses() {
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine',
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
  const idxPpid = headers.indexOf('parentprocessid');
  const idxName = headers.indexOf('name');
  const idxCmd  = headers.indexOf('commandline');

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxPpid, idxName, idxCmd)) continue;

    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const ppid        = (cols[idxPpid] || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();

    if (!pid || !/^\d+$/.test(pid)) continue;
    entries.push({
      pid: parseInt(pid, 10),
      ppid: ppid && /^\d+$/.test(ppid) ? parseInt(ppid, 10) : 0,
      name,
      commandLine
    });
  }
  return entries;
}

function getAntigravityProcesses(matchUserDataDir = null) {
  const allProcs = listProcesses();
  const agProcs = allProcs.filter(proc => {
    const hay = `${proc.name} ${proc.commandLine}`.toLowerCase();
    return (
      hay.includes('antigravity') ||
      hay.includes('language_server') ||
      hay.includes('codeium')
    );
  });

  if (!matchUserDataDir) {
    return agProcs;
  }

  const targetDir = path.normalize(matchUserDataDir).toLowerCase();
  const pidMap = new Map(allProcs.map(p => [p.pid, p]));

  function matchesProfile(proc) {
    let curr = proc;
    const visited = new Set();
    while (curr && !visited.has(curr.pid)) {
      visited.add(curr.pid);
      const normCmd = path.normalize(curr.commandLine || '').toLowerCase();
      if (normCmd.includes(targetDir) || (curr.commandLine || '').toLowerCase().includes(matchUserDataDir.toLowerCase())) {
        return true;
      }
      curr = pidMap.get(curr.ppid);
    }
    return false;
  }

  return agProcs.filter(matchesProfile);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Detect authentication status of a profile directory by inspecting stored credentials.
 *
 * @param {string} [userDataDir] - Profile directory path
 * @returns {{ isAuthenticated: boolean, evidence: string[] }}
 */
function detectAuthState(userDataDir) {
  const dir = userDataDir || DEFAULT_USER_DATA_DIR;
  const evidence = [];
  let isAuthenticated = false;

  const apiKeyPaths = [
    path.join(dir, 'User', 'globalStorage', 'Antigravity.antigravity', 'api_key'),
    path.join(dir, 'User', 'globalStorage', 'codeium.codeium', 'api_key'),
    path.join(dir, 'User', 'globalStorage', 'Antigravity.antigravity', 'token'),
    path.join(dir, 'User', 'globalStorage', 'codeium.codeium', 'token'),
  ];
  for (const ap of apiKeyPaths) {
    try {
      const stat = fs.statSync(ap);
      if (stat.isFile() && stat.size > 10) {
        const preview = fs.readFileSync(ap, 'utf8').trim().slice(0, 40);
        evidence.push(`API key file: ${ap} (${stat.size} B, preview: "${preview}…")`);
        isAuthenticated = true;
      } else if (stat.isFile()) {
        evidence.push(`API key file (empty/tiny): ${ap} (${stat.size} B)`);
      }
    } catch (_) {}
  }

  const globalStorageBase = path.join(dir, 'User', 'globalStorage');
  try {
    if (fs.existsSync(globalStorageBase)) {
      evidence.push(`globalStorage dir exists: ${globalStorageBase}`);
      const vendorDirs = fs.readdirSync(globalStorageBase, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      if (vendorDirs.length > 0) evidence.push(`  vendor dirs: ${vendorDirs.join(', ')}`);

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
                evidence.push(`  token-like file: ${vd}/${f} → "${preview}"`);
                if (st.isFile() && st.size > 10) isAuthenticated = true;
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  const stateVscdb = path.join(dir, 'User', 'globalStorage', 'state.vscdb');
  try {
    const st = fs.statSync(stateVscdb);
    evidence.push(`state.vscdb: ${stateVscdb} (${(st.size / 1024).toFixed(1)} KB)`);
    if (st.size > 4096) {
      evidence.push(`  state.vscdb is non-trivial (${(st.size / 1024).toFixed(1)} KB) — likely has stored auth`);
      isAuthenticated = isAuthenticated || true;
    }
  } catch (_) {}

  const configFiles = [
    path.join(dir, 'User', 'settings.json'),
    path.join(dir, 'User', 'keybindings.json'),
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

/**
 * Launch Antigravity IDE on a hidden Win32 desktop via Koffi CreateProcessW.
 *
 * @param {string|object} profile - Profile directory path or profile object
 * @param {object} [options] - Launch options (workspaceDir, exePath, desktopName)
 * @returns {{ pid: number, hProcess: any, hDesktop: any, desktopName: string, desktopFullName: string }}
 */
function spawnHidden(profile, options = {}) {
  const userDataDir = typeof profile === 'string'
    ? profile
    : (profile?.userDataDir || profile?.path || DEFAULT_USER_DATA_DIR);

  const workspaceDir = options.workspaceDir || (typeof profile === 'object' ? profile?.workspaceDir : null) || process.cwd();
  const exePath = options.exePath || DEFAULT_ANTIGRAVITY_EXE;

  const desktopName = options.desktopName || 'AntigravityHidden';
  const desktopFullName = `Winsta0\\${desktopName}`;

  const hDesktop = CreateDesktopW(
    desktopName,
    null,
    null,
    0,
    DESKTOP_ACCESS,
    null
  );

  if (!hDesktop) {
    const lastErr = GetLastError();
    if (lastErr !== 183) { // 183 = ERROR_ALREADY_EXISTS (hDesktop is still valid if 183)
      throw new Error(`CreateDesktopW failed with GetLastError() = ${lastErr} (0x${lastErr.toString(16).toUpperCase()})`);
    }
  }

  const cmdArgs = [`--user-data-dir=${userDataDir}`, workspaceDir].filter(Boolean);
  const cmdLine = `"${exePath}" ${cmdArgs.join(' ')}`;
  const cmdLineBuf = toWide(cmdLine);
  const desktopBuf = toWide(desktopFullName);

  const si = {
    cb:              koffi.sizeof(STARTUPINFOW),
    _pad1:           0,
    lpReserved:      null,
    lpDesktop:       desktopBuf,
    lpTitle:         null,
    dwX:             0,
    dwY:             0,
    dwXSize:         0,
    dwYSize:         0,
    dwXCountChars:   0,
    dwYCountChars:   0,
    dwFillAttribute: 0,
    dwFlags:         STARTF_USESHOWWINDOW,
    wShowWindow:     SW_HIDE,
    cbReserved2:     0,
    _pad2:           0,
    lpReserved2:     null,
    hStdInput:       null,
    hStdOutput:      null,
    hStdError:       null,
  };

  const pi = {
    hProcess:    null,
    hThread:     null,
    dwProcessId: 0,
    dwThreadId:  0,
  };

  const createOk = CreateProcessW(
    exePath,
    cmdLineBuf,
    null,
    null,
    false,
    NORMAL_PRIORITY_CLASS,
    null,
    null,
    si,
    pi
  );

  if (!createOk) {
    const lastErr = GetLastError();
    CloseDesktop(hDesktop);
    throw new Error(`CreateProcessW failed with GetLastError() = ${lastErr} (0x${lastErr.toString(16).toUpperCase()})`);
  }

  if (pi.hThread) {
    CloseHandle(pi.hThread);
  }

  return {
    pid: pi.dwProcessId,
    hProcess: pi.hProcess,
    hDesktop: hDesktop,
    desktopName: desktopName,
    desktopFullName: desktopFullName,
  };
}

/**
 * Launch Antigravity IDE normally (visible window) for interactive login.
 *
 * @param {string|object} profile - Profile directory path or profile object
 * @param {object} [options] - Launch options (workspaceDir, exePath)
 * @returns {{ pid: number, childProcess: any }}
 */
function spawnVisible(profile, options = {}) {
  const userDataDir = typeof profile === 'string'
    ? profile
    : (profile?.userDataDir || profile?.path || DEFAULT_USER_DATA_DIR);

  const workspaceDir = options.workspaceDir || (typeof profile === 'object' ? profile?.workspaceDir : null) || process.cwd();
  const exePath = options.exePath || DEFAULT_ANTIGRAVITY_EXE;

  const args = [`--user-data-dir=${userDataDir}`, workspaceDir].filter(Boolean);

  const child = spawn(exePath, args, {
    shell: false,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  return {
    pid: child.pid,
    childProcess: child,
  };
}

/**
 * Poll for the Antigravity Language Server background process.
 *
 * @param {number} [pid] - Main process PID (unused for filtering, kept for interface symmetry)
 * @param {number} [timeoutMs=90000] - Max polling duration in ms
 * @param {number} [intervalMs=300] - Polling interval in ms
 * @returns {Promise<{ pid: number, name: string, commandLine: string, elapsedMs: number }|null>}
 */
async function waitForLanguageServer(pid = null, timeoutMs = 90000, intervalMs = 300, matchUserDataDir = null) {
  const pollStart = Date.now();
  while (Date.now() - pollStart < timeoutMs) {
    const procs = getAntigravityProcesses(matchUserDataDir);
    let lspProc = null;

    if (pid) {
      const allProcs = listProcesses();
      const pidMap = new Map(allProcs.map(p => [p.pid, p]));

      lspProc = procs.find(p => {
        const isLsp = p.name.toLowerCase().includes('language_server');
        if (!isLsp) return false;

        let curr = p;
        const visited = new Set();
        while (curr && !visited.has(curr.pid)) {
          if (curr.pid === pid || curr.ppid === pid) return true;
          visited.add(curr.pid);
          curr = pidMap.get(curr.ppid);
        }
        return false;
      });
    }

    if (!lspProc) {
      lspProc = procs.find(p => p.name.toLowerCase() === 'language_server_windows_x64.exe') ||
                procs.find(p => p.name.toLowerCase().includes('language_server'));
    }

    if (lspProc) {
      return {
        pid: lspProc.pid,
        name: lspProc.name,
        commandLine: lspProc.commandLine,
        elapsedMs: Date.now() - pollStart,
      };
    }
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Extract CSRF token from command line flags or logs.
 *
 * @param {string} commandLine - Process command line string
 * @param {string} [userDataDir] - Profile directory path for log fallback
 * @returns {string|null}
 */
function getCsrfToken(commandLine, userDataDir = null) {
  if (commandLine) {
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
  }

  if (userDataDir) {
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
            const m = content.match(/csrf[_-]?token[^\w]+([\w-]{20,})/i);
            if (m) return m[1];
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Find LISTENING TCP ports for a given PID using netstat.
 *
 * @param {number} pid - Process ID
 * @returns {number[]} Array of listening port numbers
 */
function findListeningPorts(pid) {
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

/**
 * Query GetUserStatus endpoint on an Antigravity Language Server port.
 *
 * @param {number} port - Local TCP port
 * @param {string} csrfToken - CSRF token
 * @returns {Promise<{ ok: boolean, status?: number, body?: string, error?: string, durationMs: number }>}
 */
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

/**
 * Kill process tree and verify zero orphan processes remain.
 *
 * @param {number} [topPid] - Top-level process ID to kill
 * @returns {{ ok: boolean, remainingCount: number, remaining: Array<{ pid: number, name: string }> }}
 */
function killProcessTree(topPid = null, userDataDir = null) {
  // 1. Primary tree kill on specific topPid if provided
  if (topPid) {
    try {
      execSync(`taskkill /PID ${topPid} /T /F`, { encoding: 'utf8', windowsHide: true });
    } catch (_) {}
  }

  // 2. Scoped fallback orphan-cleanup loop:
  // ONLY search and kill processes matching the exact userDataDir profile path.
  // Never fall back to un-scoped system-wide name matching.
  if (!userDataDir) {
    return { ok: true, remainingCount: 0, remaining: [] };
  }

  let remaining = getAntigravityProcesses(userDataDir);
  let attempts = 0;

  while (remaining.length > 0 && attempts < 3) {
    attempts++;
    for (const proc of remaining) {
      console.warn(`[Lune Audit Log] Fallback killing scoped orphan process (PID: ${proc.pid}, Name: ${proc.name}) matching profile '${userDataDir}':\n  CommandLine: ${proc.commandLine}`);
      try {
        execSync(`taskkill /PID ${proc.pid} /F`, { encoding: 'utf8', windowsHide: true });
      } catch (_) {}
    }
    try {
      execSync('ping 127.0.0.1 -n 1 > nul', { windowsHide: true });
    } catch (_) {}
    remaining = getAntigravityProcesses(userDataDir);
  }

  return {
    ok: remaining.length === 0,
    remainingCount: remaining.length,
    remaining: remaining.map(p => ({ pid: p.pid, name: p.name, commandLine: p.commandLine })),
  };
}

/**
 * Close Win32 process handle and destroy hidden desktop handle.
 *
 * @param {any} hDesktop - Win32 HDESK handle
 * @param {any} [hProcess] - Win32 process handle
 * @returns {{ desktopClosed: boolean, processHandleClosed: boolean }}
 */
function closeHiddenDesktop(hDesktop, hProcess = null) {
  let processHandleClosed = false;
  if (hProcess) {
    try {
      processHandleClosed = CloseHandle(hProcess);
    } catch (_) {}
  }

  let desktopClosed = false;
  if (hDesktop) {
    try {
      desktopClosed = CloseDesktop(hDesktop);
    } catch (_) {}
  }

  return {
    desktopClosed,
    processHandleClosed,
  };
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  detectAuthState,
  spawnHidden,
  spawnVisible,
  waitForLanguageServer,
  getCsrfToken,
  findListeningPorts,
  queryUserStatus,
  killProcessTree,
  closeHiddenDesktop,
};
