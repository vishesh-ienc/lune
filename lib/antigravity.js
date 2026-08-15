'use strict';

const fs                  = require('fs');
const path                = require('path');
const https               = require('https');
const { execSync, exec, execFile, spawn } = require('child_process');
const util                = require('util');
const execAsync           = util.promisify(exec);
const execFileAsync       = util.promisify(execFile);
const koffi               = require('koffi');
const logger              = require('./logger');

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

const EnumWindows     = user32.func('__stdcall', 'EnumWindows', 'bool', ['void *', 'intptr']);
const GetWindowTextW  = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'uint16 *', 'int']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['void *']);
const PostMessageW    = user32.func('__stdcall', 'PostMessageW', 'bool', ['void *', 'uint32', 'intptr', 'intptr']);
const WM_CLOSE        = 0x0010;

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hWnd, intptr lParam)');

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

let _procCache = null;
let _procCacheTime = 0;
const PROC_CACHE_TTL = 2500; // 2.5s TTL cache to prevent CPU spikes on main thread

async function listProcesses(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _procCache && (now - _procCacheTime < PROC_CACHE_TTL)) {
    return _procCache;
  }

  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate',
    '| ConvertTo-Csv -NoTypeInformation',
  ].join(' ');

  let raw = '';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    raw = stdout || '';
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
  const idxCd   = headers.indexOf('creationdate');

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idxPid, idxPpid, idxName, idxCmd)) continue;

    const pid         = (cols[idxPid]  || '').replace(/"/g, '').trim();
    const ppid        = (cols[idxPpid] || '').replace(/"/g, '').trim();
    const name        = (cols[idxName] || '').replace(/"/g, '').trim();
    const commandLine = (cols[idxCmd]  || '').replace(/^"|"$/g, '').trim();
    const rawCd       = idxCd !== -1 ? (cols[idxCd] || '').replace(/"/g, '').trim() : '';

    let creationDateMs = null;
    let creationDateStr = null;
    if (rawCd) {
      const d = new Date(rawCd);
      if (!isNaN(d.getTime())) {
        creationDateMs = d.getTime();
        const pad = (n) => String(n).padStart(2, '0');
        creationDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } else {
        creationDateStr = rawCd;
      }
    }

    if (!pid || !/^\d+$/.test(pid)) continue;
    entries.push({
      pid: parseInt(pid, 10),
      ppid: ppid && /^\d+$/.test(ppid) ? parseInt(ppid, 10) : 0,
      name,
      commandLine,
      creationDateMs,
      creationDateStr: creationDateStr || 'Unknown',
    });
  }

  _procCache = entries;
  _procCacheTime = now;
  return entries;
}

async function getAntigravityProcesses(matchUserDataDir = null) {
  const allProcs = await listProcesses();
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

  const workspaceDir = options.workspaceDir || (typeof profile === 'object' ? profile?.workspaceDir : null) || null;
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

  const workspaceDir = options.workspaceDir || (typeof profile === 'object' ? profile?.workspaceDir : null) || null;
  const exePath = options.exePath || DEFAULT_ANTIGRAVITY_EXE;

  const args = [
    `--user-data-dir=${userDataDir}`,
    workspaceDir
  ].filter(Boolean);

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
/**
 * Resolves the exact user-data directory for a process by walking up its ancestor process tree for --user-data-dir.
 * Defaults to DEFAULT_USER_DATA_DIR if no ancestor process has an explicit --user-data-dir flag.
 *
 * @param {object} proc - Process object
 * @param {Map<number, object>} pidMap - Map of PID to process
 * @returns {string} Normalized lower-cased user-data-dir path
 */
function resolveProcessUserDataDir(proc, pidMap) {
  let curr = proc;
  const visited = new Set();
  while (curr && !visited.has(curr.pid)) {
    visited.add(curr.pid);
    const dir = extractUserDataDir(curr.commandLine);
    if (dir) {
      return path.normalize(dir).toLowerCase();
    }
    curr = pidMap.get(curr.ppid);
  }
  return path.normalize(DEFAULT_USER_DATA_DIR).toLowerCase();
}

/**
 * Poll for the Antigravity Language Server background process.
 *
 * @param {number} [pid] - Main process PID (used for PID tree matching)
 * @param {number} [timeoutMs=90000] - Max polling duration in ms
 * @param {number} [intervalMs=300] - Polling interval in ms
 * @param {string} [matchUserDataDir] - Profile directory path for exact scoping
 * @returns {Promise<{ pid: number, name: string, commandLine: string, elapsedMs: number }|null>}
 */
async function waitForLanguageServer(pid = null, timeoutMs = 90000, intervalMs = 300, matchUserDataDir = null) {
  const pollStart = Date.now();
  const targetDirNorm = matchUserDataDir ? path.normalize(matchUserDataDir).toLowerCase() : null;

  while (Date.now() - pollStart < timeoutMs) {
    const allProcs = await listProcesses();
    const pidMap = new Map(allProcs.map(p => [p.pid, p]));

    const lspProc = allProcs.find(p => {
      const isLsp = p.name.toLowerCase().includes('language_server');
      if (!isLsp) return false;

      // 1. Check PID tree hierarchy if pid is given
      let isChildOfPid = false;
      if (pid) {
        let curr = p;
        const visited = new Set();
        while (curr && !visited.has(curr.pid)) {
          if (curr.pid === pid || curr.ppid === pid) {
            isChildOfPid = true;
            break;
          }
          visited.add(curr.pid);
          curr = pidMap.get(curr.ppid);
        }
      }

      // 2. Check profile directory match via resolveProcessUserDataDir
      let matchesDir = false;
      if (targetDirNorm) {
        const resolvedDir = resolveProcessUserDataDir(p, pidMap);
        if (resolvedDir === targetDirNorm) {
          matchesDir = true;
        }
      }

      if (pid && targetDirNorm) {
        return matchesDir || isChildOfPid;
      } else if (targetDirNorm) {
        return matchesDir;
      } else if (pid) {
        return isChildOfPid;
      } else {
        return true;
      }
    });

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
 * Finds an already-running Language Server process matching the SPECIFIC profile path.
 *
 * @param {string} profilePath - Profile user-data directory path to match
 * @returns {{ pid: number, name: string, commandLine: string, userDataDir: string }|null}
 */
async function findRunningLanguageServerForProfile(profilePath) {
  if (!profilePath) return null;
  const targetNorm = path.normalize(profilePath).toLowerCase();
  const allProcs = await listProcesses();
  const pidMap = new Map(allProcs.map(p => [p.pid, p]));

  const lspProc = allProcs.find(p => {
    const isLsp = p.name.toLowerCase().includes('language_server');
    if (!isLsp) return false;
    const resolvedDir = resolveProcessUserDataDir(p, pidMap);
    return resolvedDir === targetNorm;
  });

  if (lspProc) {
    return {
      pid: lspProc.pid,
      name: lspProc.name,
      commandLine: lspProc.commandLine,
      userDataDir: profilePath,
    };
  }
  return null;
}

/**
 * Helper to extract --user-data-dir parameter from a process command line.
 *
 * @param {string} commandLine
 * @returns {string|null}
 */
function extractUserDataDir(commandLine) {
  if (!commandLine) return null;
  const match = commandLine.match(/--user-data-dir[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (match) {
    return match[1] || match[2] || match[3] || null;
  }
  return null;
}

/**
 * Helper to extract --workspace_id parameter from a process command line.
 *
 * @param {string} commandLine
 * @returns {string|null}
 */
function extractWorkspaceId(commandLine) {
  if (!commandLine) return null;
  const match = commandLine.match(/--workspace_id[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (match) {
    return match[1] || match[2] || match[3] || null;
  }
  return null;
}

/**
 * Checks whether a command line represents a workspace-specific Language Server.
 * Must contain --enable_lsp AND --workspace_id AND --parent_pipe_path.
 *
 * @param {string} commandLine
 * @returns {boolean}
 */
function isWorkspaceLsp(commandLine) {
  if (!commandLine) return false;
  const hasEnableLsp = /--enable_lsp\b/i.test(commandLine);
  const hasWorkspaceId = /--workspace_id\b/i.test(commandLine);
  const hasParentPipe = /--parent_pipe_path\b/i.test(commandLine);
  return hasEnableLsp && hasWorkspaceId && hasParentPipe;
}

/**
 * Helper to check whether a workspace_id matches a target directory path (e.g. C:\Users\VISHESH\Desktop\lune).
 *
 * @param {string} commandLine
 * @param {string} [targetPath=process.cwd()]
 * @returns {boolean}
 */
function matchesTargetWorkspace(commandLine, targetPath = process.cwd()) {
  const wsId = extractWorkspaceId(commandLine);
  if (!wsId || !targetPath) return false;

  const normTarget = path.normalize(targetPath).toLowerCase().replace(/\\/g, '/');

  let decodedWsId = wsId;
  try { decodedWsId = decodeURIComponent(wsId); } catch (_) {}

  let cleanWsPath = decodedWsId
    .replace(/^file[_\/]+/i, '')
    .replace(/_3a_/i, ':')
    .replace(/%3a/i, ':')
    .replace(/_/g, '/')
    .toLowerCase();

  return cleanWsPath.includes(normTarget) || normTarget.includes(cleanWsPath);
}

/**
 * Checks if a language_server process is orphaned (main Antigravity IDE window closed/terminated).
 * An LSP process is orphaned if:
 * 1. its PPID does not exist in the active process map, OR
 * 2. walking up its ancestor process tree finds NO process whose executable name contains 'antigravity'
 *    (meaning the main IDE window was closed but the child server process remained).
 *
 * @param {object} proc - Process object { pid, ppid, name, commandLine }
 * @param {Map<number, object>} pidMap - Map of active processes by PID
 * @returns {boolean} True if orphaned, false if running under an active Antigravity parent
 */
function isOrphanedLspProcess(proc, pidMap) {
  if (!proc || !proc.ppid) return true;
  const parent = pidMap.get(proc.ppid);
  if (!parent) return true;

  let curr = parent;
  const visited = new Set();
  let foundAntigravityParent = false;

  while (curr && !visited.has(curr.pid)) {
    visited.add(curr.pid);
    const pName = (curr.name || '').toLowerCase();
    if (pName.includes('antigravity')) {
      foundAntigravityParent = true;
      break;
    }
    curr = pidMap.get(curr.ppid);
  }

  return !foundAntigravityParent;
}

/**
 * Checks if a process is the main Antigravity GUI process (not an Electron utility sub-process).
 *
 * Main GUI:
 *   "C:\Users\VISHESH\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe"
 * Utility NodeService:
 *   Antigravity IDE.exe --type=utility --utility-sub-type=node.mojom.NodeService
 *
 * @param {object|null} parentProcess - Parent process object { pid, ppid, name, commandLine }
 * @returns {boolean} True if direct parent is the main GUI process
 */
function isMainGuiParent(parentProcess) {
  if (!parentProcess || !parentProcess.name) return false;
  const pName = parentProcess.name.toLowerCase();
  if (!pName.includes('antigravity')) return false;

  const cmd = (parentProcess.commandLine || '').toLowerCase();
  const isUtility = cmd.includes('--type=utility') || cmd.includes('--utility-sub-type=');
  return !isUtility;
}

/**
 * Safely terminates an orphaned zombie language_server process to free system memory
 * and clean up desktop state.
 *
 * @param {number} pid - Process ID to terminate
 */
function safelyKillOrphanedProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    logger.debug(`[Lune antigravity.js] Safely killed orphaned zombie language_server (PID: ${pid})`);
  } catch (_) {}
}

/**
 * Scans the machine for ALL active running Language Server processes.
 * Returns an array of objects containing PID, userDataDir, csrfToken, listening ports, etc.
 *
 * @returns {Array<{ pid: number, name: string, commandLine: string, userDataDir: string, csrfToken: string|null, ports: number[] }>}
 */
async function findAllActiveRunningLanguageServers() {
  const allProcs = await listProcesses();
  const pidMap = new Map(allProcs.map(p => [p.pid, p]));

  const lspProcs = allProcs.filter(p => {
    const pName = p.name.toLowerCase();
    return pName === 'language_server_windows_x64.exe' || pName === 'language_server_windows_x64';
  });

  const results = [];
  for (const p of lspProcs) {
    if (isOrphanedLspProcess(p, pidMap)) {
      logger.debug(`[Lune watcher] PID ${p.pid} is an orphaned LSP (parent PID ${p.ppid} no longer running) — excluding from Live status.`);
      safelyKillOrphanedProcess(p.pid);
      continue;
    }

    let userDataDir = null;
    let curr = p;
    const visited = new Set();
    while (curr && !visited.has(curr.pid)) {
      visited.add(curr.pid);
      const dir = extractUserDataDir(curr.commandLine);
      if (dir) {
        userDataDir = path.normalize(dir);
        break;
      }
      curr = pidMap.get(curr.ppid);
    }
    if (!userDataDir) {
      userDataDir = DEFAULT_USER_DATA_DIR;
    }

    const csrfToken = getCsrfToken(p.commandLine, userDataDir);
    const ports = await findListeningPorts(p.pid);
    const parent = pidMap.get(p.ppid) || null;
    const isMainGui = isMainGuiParent(parent);

    if (ports && ports.length > 0) {
      results.push({
        pid: p.pid,
        name: p.name,
        commandLine: p.commandLine,
        userDataDir,
        csrfToken,
        ports,
        ppid: p.ppid,
        parentName: parent ? parent.name : 'Unknown',
        isMainGuiParent: isMainGui,
        creationDateMs: p.creationDateMs || null,
        creationDateStr: p.creationDateStr || 'Unknown',
      });
    }
  }

  // ── Selection Priority: Prefer Main-GUI Child LSP ────────────────────────

  if (results.length === 0) {
    logger.debug(`[LSP] No active LSP found`);
    return [];
  }

  if (results.length === 1) {
    const r = results[0];
    const parentType = r.isMainGuiParent ? 'Main GUI' : 'Electron NodeService Utility';
    logger.debug(`[LSP] Found 1 candidate Language Server process: PID ${r.pid} (Parent PID: ${r.ppid}, Parent Type: ${parentType})`);
    return results;
  }

  logger.debug(`[LSP] Found ${results.length} candidate Language Server processes\n`);
  for (const r of results) {
    const parentType = r.isMainGuiParent ? 'Main GUI' : 'Electron NodeService Utility';
    const priority = r.isMainGuiParent ? 'PRIMARY' : 'SECONDARY';
    logger.debug(`[LSP] PID ${r.pid} | Parent: ${r.ppid} (${parentType}) | Priority: ${priority}`);
  }

  const mainGuiCandidates = results.filter(r => r.isMainGuiParent);

  if (mainGuiCandidates.length === 1) {
    const selected = mainGuiCandidates[0];
    logger.debug(`[LSP] Selected Main-GUI LSP: PID ${selected.pid}`);
    return [selected];
  }

  if (mainGuiCandidates.length > 1) {
    logger.debug(`[LSP] Multiple main-GUI LSP candidates found (${mainGuiCandidates.length}) - Attempting identity resolution...`);
    return mainGuiCandidates;
  }

  // Fallback if no main-GUI LSP candidates found
  logger.debug(`[LSP] No Main-GUI LSP candidate found. Falling back to secondary candidates.`);
  return results;
}

/**
 * Given a pre-scanned list of Language Server processes (from findAllActiveRunningLanguageServers)
 * and a list of saved account objects (each with userDataDir/profilePath), returns a Map where
 * each account maps to its matched running LSP process (or null if none).
 *
 * Matching is done by comparing each process's already-resolved userDataDir against
 * each account's stored userDataDir/profilePath using exact normalized lowercase equality.
 * Never picks "first process found" — every account gets its own dedicated lookup.
 *
 * @param {Array} lspProcs - Output of findAllActiveRunningLanguageServers()
 * @param {Array} accounts - Array of account objects with userDataDir/profilePath fields
 * @returns {Map<object, object|null>} Map from account object to matching lspProc or null
 */
function matchAccountToRunningProcess(lspProcs, accounts) {
  const result = new Map();
  for (const acc of accounts) {
    const profilePath = acc.userDataDir || acc.profilePath;
    if (!profilePath) {
      result.set(acc, null);
      continue;
    }
    const targetNorm = path.normalize(profilePath).toLowerCase();
    const match = lspProcs.find(lsp => {
      const lspNorm = path.normalize(lsp.userDataDir || '').toLowerCase();
      if (lspNorm !== targetNorm) return false;
      // Always require a valid email on BOTH sides — never match on profilePath alone.
      // An account without an email cannot be identity-verified so should never show as Live.
      if (!acc.email || !lsp.activeEmail) return false;
      return acc.email.toLowerCase().trim() === lsp.activeEmail.toLowerCase().trim();
    }) || null;
    result.set(acc, match);
  }
  return result;
}

/**
 * Polls for a Language Server process that is BOTH:
 *   1. A child (direct or indirect) of parentPid (confirming it belongs to OUR spawned Antigravity instance)
 *   2. Has a resolved userDataDir that exactly matches ownUserDataDir
 *
 * Unlike waitForLanguageServer (which allows either criterion), this requires BOTH.
 * Used exclusively in the add-account flow to prevent false-positive matches against
 * already-running instances of different accounts.
 *
 * @param {number} parentPid - PID of the Antigravity IDE.exe we spawned
 * @param {string} ownUserDataDir - The new profile directory we created for this account
 * @param {number} [timeoutMs=90000] - Max polling duration in ms
 * @param {number} [intervalMs=300] - Polling interval in ms
 * @returns {Promise<{ pid: number, name: string, commandLine: string, elapsedMs: number }|null>}
 */
async function waitForOwnLanguageServer(parentPid, ownUserDataDir, timeoutMs = 90000, intervalMs = 300) {
  const pollStart = Date.now();
  const targetNorm = path.normalize(ownUserDataDir).toLowerCase();

  while (Date.now() - pollStart < timeoutMs) {
    const allProcs = await listProcesses();
    const pidMap = new Map(allProcs.map(p => [p.pid, p]));

    const lspProc = allProcs.find(p => {
      if (!p.name.toLowerCase().includes('language_server')) return false;

      // Criterion 1: Must be a descendant of parentPid
      let isDescendant = false;
      let curr = p;
      const visited = new Set();
      while (curr && !visited.has(curr.pid)) {
        if (curr.pid === parentPid || curr.ppid === parentPid) {
          isDescendant = true;
          break;
        }
        visited.add(curr.pid);
        curr = pidMap.get(curr.ppid);
      }
      if (!isDescendant) return false;

      // Criterion 2: Must resolve to OUR userDataDir (not any other account's)
      const resolvedDir = resolveProcessUserDataDir(p, pidMap);
      return resolvedDir === targetNorm;
    });

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

let _portsCache = null;
let _portsCacheTime = 0;
const PORTS_CACHE_TTL = 2500;

async function getAllListeningPortsMap(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _portsCache && (now - _portsCacheTime < PORTS_CACHE_TTL)) {
    return _portsCache;
  }

  let netstatOut = '';
  try {
    const { stdout } = await execAsync('netstat -ano', {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    netstatOut = stdout || '';
  } catch (err) {
    netstatOut = err.stdout || '';
  }

  const map = new Map();
  for (const line of netstatOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const state   = parts[parts.length - 2]?.toUpperCase();
    const linePid = parseInt(parts[parts.length - 1], 10);
    if (state !== 'LISTENING' || isNaN(linePid) || linePid <= 0) continue;

    const localAddr = parts[1] || '';
    const colonIdx  = localAddr.lastIndexOf(':');
    if (colonIdx === -1) continue;
    const portNum = parseInt(localAddr.slice(colonIdx + 1), 10);
    if (portNum) {
      if (!map.has(linePid)) map.set(linePid, []);
      const list = map.get(linePid);
      if (!list.includes(portNum)) list.push(portNum);
    }
  }

  _portsCache = map;
  _portsCacheTime = now;
  return map;
}

/**
 * Find LISTENING TCP ports for a given PID using netstat.
 *
 * @param {number} pid - Process ID
 * @returns {Promise<number[]>} Array of listening port numbers
 */
async function findListeningPorts(pid) {
  const map = await getAllListeningPortsMap();
  return map.get(parseInt(pid, 10)) || [];
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
      res.on('end', () => {
        if (data && process.env.LUNE_DEBUG === 'true') {
          try {
            const outPath = path.join(process.cwd(), 'debug-full-response.json');
            let formatted = data;
            try {
              formatted = JSON.stringify(JSON.parse(data), null, 2);
            } catch (_) {}
            fs.writeFileSync(outPath, formatted, 'utf8');
            logger.debug(`[Lune Debug] Saved untruncated GetUserStatus JSON (${data.length} bytes) to ${outPath}`);
          } catch (e) {
            console.warn('[Lune Debug] Could not write debug-full-response.json:', e.message);
          }
        }
        resolve({ ok: true, status: res.statusCode, body: data, durationMs: Date.now() - t0 });
      });
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
async function killProcessTree(topPid = null, userDataDir = null) {
  if (!topPid) {
    return { ok: true, remainingCount: 0, remaining: [] };
  }

  // 1. Snapshot process tree under topPid BEFORE killing, so fallback cleanup
  // CANNOT touch active user IDE processes or unrelated instances.
  const allProcs = await listProcesses();
  const spawnedTreePids = new Set([topPid]);
  let added = true;
  while (added) {
    added = false;
    for (const p of allProcs) {
      if (!spawnedTreePids.has(p.pid) && spawnedTreePids.has(p.ppid)) {
        spawnedTreePids.add(p.pid);
        added = true;
      }
    }
  }

  // 2. Primary tree kill on topPid
  try {
    execSync(`taskkill /PID ${topPid} /T /F`, { encoding: 'utf8', windowsHide: true });
  } catch (_) {}

  // 3. Fallback cleanup STRICTLY restricted to PIDs in spawnedTreePids
  let currentProcs = await listProcesses();
  let remaining = currentProcs.filter(p => spawnedTreePids.has(p.pid));
  let attempts = 0;

  while (remaining.length > 0 && attempts < 3) {
    attempts++;
    for (const proc of remaining) {
      console.warn(`[Lune Audit Log] Fallback killing scoped orphan process (PID: ${proc.pid}, Name: ${proc.name}) belonging to spawned tree ${topPid}:\n  CommandLine: ${proc.commandLine}`);
      try {
        execSync(`taskkill /PID ${proc.pid} /F`, { encoding: 'utf8', windowsHide: true });
      } catch (_) {}
    }
    try {
      execSync('ping 127.0.0.1 -n 1 > nul', { windowsHide: true });
    } catch (_) {}
    currentProcs = await listProcesses();
    remaining = currentProcs.filter(p => spawnedTreePids.has(p.pid));
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

/**
 * Find and cleanly close active browser OAuth windows/tabs (e.g. Chrome, Edge, Firefox)
 * that opened the Google OAuth callback page.
 *
 * @returns {number} Number of matching windows closed
 */
function closeOAuthBrowserWindows() {
  let closedCount = 0;

  const callback = koffi.register((hWnd, lParam) => {
    if (!hWnd) return true;
    try {
      if (IsWindowVisible(hWnd)) {
        const buf = Buffer.alloc(512);
        const len = GetWindowTextW(hWnd, buf, 256);
        if (len > 0) {
          const title = buf.toString('utf16le', 0, len * 2);
          const tLower = title.toLowerCase();
          if (
            tLower.includes('google accounts') ||
            tLower.includes('sign in') ||
            tLower.includes('authentication successful') ||
            tLower.includes('redirecting to jetski') ||
            tLower.includes('codeium') ||
            tLower.includes('antigravity') ||
            tLower.includes('127.0.0.1') ||
            tLower.includes('localhost')
          ) {
            logger.debug(`[Lune lib/antigravity] Closing OAuth browser window (hWnd: ${hWnd}, Title: "${title}")`);
            PostMessageW(hWnd, WM_CLOSE, 0, 0);
            closedCount++;
          }
        }
      }
    } catch (_) {}
    return true;
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(callback, 0);
  } catch (err) {
    console.warn('[Lune lib/antigravity] EnumWindows failed:', err.message);
  } finally {
    try { koffi.unregister(callback); } catch (_) {}
  }

  // Secondary fallback via PowerShell CloseMainWindow
  try {
    const psCmd = `Get-Process | Where-Object { $_.MainWindowTitle -match 'Google Accounts|Sign in|Authentication Successful|Codeium|127.0.0.1|localhost' } | ForEach-Object { $_.CloseMainWindow() }`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { encoding: 'utf8', windowsHide: true });
  } catch (_) {}

  return closedCount;
}

/**
 * Automatically dismisses migration nudge modals by finding Antigravity windows
 * and sending VK_ESCAPE to cancel any modal dialogs.
 */
function dismissMigrationModal() {
  try {
    const callback = koffi.register((hWnd, lParam) => {
      if (!hWnd) return true;
      try {
        if (IsWindowVisible(hWnd)) {
          const buf = Buffer.alloc(512);
          const len = GetWindowTextW(hWnd, buf, 256);
          if (len > 0) {
            const title = buf.toString('utf16le', 0, len * 2);
            if (title.includes('Antigravity') || title.includes('Migrate') || title.includes('Import')) {
              logger.debug(`[Lune lib/antigravity] Dismissing modal on window (hWnd: ${hWnd}, Title: "${title}")`);
              PostMessageW(hWnd, 0x0100, 0x1B, 0); // WM_KEYDOWN VK_ESCAPE
              PostMessageW(hWnd, 0x0101, 0x1B, 0); // WM_KEYUP VK_ESCAPE
            }
          }
        }
      } catch (_) {}
      return true;
    }, koffi.pointer(EnumWindowsProc));

    EnumWindows(callback, 0);
    try { koffi.unregister(callback); } catch (_) {}
  } catch (_) {}
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  detectAuthState,
  spawnHidden,
  spawnVisible,
  getAntigravityProcesses,
  waitForLanguageServer,
  getCsrfToken,
  findListeningPorts,
  queryUserStatus,
  killProcessTree,
  closeHiddenDesktop,
  closeOAuthBrowserWindows,
  dismissMigrationModal,
  findAllActiveRunningLanguageServers,
  findRunningLanguageServerForProfile,
  matchAccountToRunningProcess,
  waitForOwnLanguageServer,
  isOrphanedLspProcess,
  DEFAULT_USER_DATA_DIR,
};
