#!/usr/bin/env node
/**
 * test-option2-offscreen-reposition.js
 *
 * OPTION 2: Post-detect off-screen HWND repositioning (SetWindowPos) + ShowWindow(SW_HIDE).
 *
 * Used if Option 1 launch argument fails to prevent initial window painting.
 * When the HWND is detected post-spawn:
 *   1. Immediately calls Win32 SetWindowPos(hwnd, 0, -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
 *      to move the window 32,000 pixels off-screen out of monitor viewport space.
 *   2. ALSO calls ShowWindow(hwnd, SW_HIDE) as a belt-and-suspenders measure.
 *
 * Followed by full LSP verification:
 *   1. Spawn process normally
 *   2. HWND hook executes SetWindowPos + ShowWindow(SW_HIDE)
 *   3. Poll for language_server_windows_x64.exe
 *   4. Extract CSRF token & listening ports
 *   5. Execute GetUserStatus query
 *   6. Cleanly terminate process tree
 */

'use strict';

const { spawn, execSync } = require('child_process');
const https               = require('https');
const path                = require('path');
const { performance }     = require('perf_hooks');

// ─── Configuration ────────────────────────────────────────────────────────────

const ANTIGRAVITY_EXE  = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
const USER_DATA_DIR    = 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';
const WORKSPACE_DIR    = 'C:\\Users\\VISHESH\\Desktop\\lune';

const LSP_POLL_TIMEOUT_MS  = 60_000;
const LSP_POLL_INTERVAL_MS = 300;
const LSP_WARMUP_MS        = 1500;

// Win32 SetWindowPos Flags
const SWP_NOSIZE     = 0x0001;
const SWP_NOZORDER   = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_OFFSCREEN_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE; // 0x0015 (21)

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

// ─── Native In-Process Off-Screen Repositioning + Hide Hook ────────────────────

let win32Ffi = null;
let win32FfiError = null;
let win32FfiStage = 'not_started';

function initWin32Ffi() {
  if (win32Ffi !== null) return win32Ffi;
  try {
    win32FfiStage = 'require_koffi';
    const koffi = require('koffi');

    win32FfiStage = 'load_user32_dll';
    const user32 = koffi.load('user32.dll');

    win32FfiStage = 'declare_functions';
    const EnumWindowsProc          = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
    const EnumWindows              = user32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumWindowsProc), 'intptr_t']);
    const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr_t', koffi.out(koffi.pointer('uint32'))]);
    const ShowWindow               = user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr_t', 'int']);
    const SetWindowPos             = user32.func('__stdcall', 'SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint']);
    const IsWindowVisible          = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']);
    const GetWindowTextW           = user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr_t', koffi.out(koffi.pointer(koffi.array('uint16', 512))), 'int']);
    const GetClassNameW            = user32.func('__stdcall', 'GetClassNameW', 'int', ['intptr_t', koffi.out(koffi.pointer(koffi.array('uint16', 256))), 'int']);

    win32FfiStage = 'ready';
    win32Ffi = { koffi, EnumWindowsProc, EnumWindows, GetWindowThreadProcessId, ShowWindow, SetWindowPos, IsWindowVisible, GetWindowTextW, GetClassNameW };
    return win32Ffi;
  } catch (err) {
    win32FfiError = err;
    win32Ffi = false;
    return false;
  }
}

let nwmManager = null;
let nwmError = null;
function initNodeWindowManager() {
  if (nwmManager !== null) return nwmManager;
  try {
    const nwm = require('node-window-manager');
    if (nwm && nwm.windowManager) {
      nwmManager = nwm.windowManager;
      return nwmManager;
    } else {
      nwmError = new Error('node-window-manager package loaded, but windowManager export is missing/undefined');
    }
  } catch (err) {
    nwmError = err;
  }
  nwmManager = false;
  return false;
}

async function pollForOffscreenRepositionNative(mainPid, timeoutMs = 15000, pollIntervalMs = 15) {
  const startTimePerf = performance.now();
  const manager = initNodeWindowManager();
  const ffi = initWin32Ffi();

  let detectionMethod = '';
  if (manager) {
    detectionMethod = 'node-window-manager (native binding)';
    ok(`Native window detection method selected: ${detectionMethod}`);
  } else if (ffi) {
    detectionMethod = 'koffi Win32 FFI (in-process direct binding)';
    ok(`Native window detection method selected: ${detectionMethod}`);
  } else {
    fail(`Native window detection availability check failed for ALL attempted methods.`);
    throw new Error('Neither node-window-manager nor koffi could be loaded.');
  }

  log(`Polling Win32 HWNDs (${c(BO, detectionMethod)}) for main PID ${mainPid} to move off-screen (-32000,-32000)...`);

  let lastRuntimeErrLog = 0;
  let pollCount = 0;
  let pidSet = new Set([mainPid]);
  let lastProcScanTime = 0;

  while (performance.now() - startTimePerf < timeoutMs) {
    pollCount++;
    const currentElapsedMs = Math.round(performance.now() - startTimePerf);

    if (Date.now() - lastProcScanTime >= 1000) {
      lastProcScanTime = Date.now();
      const procs = getAntigravityProcesses();
      pidSet = new Set([mainPid, ...procs.map(p => p.pid)]);
    }

    let hit = null;

    if (manager) {
      try {
        const windows = manager.getWindows();
        for (const win of windows) {
          if (pidSet.has(win.processId)) {
            const detectPerf = performance.now();
            const detectIso  = new Date().toISOString();
            const detectMs   = Math.round(detectPerf - startTimePerf);

            // 1. Move off-screen via node-window-manager
            if (win.setBounds) {
              try { win.setBounds({ x: -32000, y: -32000 }); } catch (_) {}
            } else if (win.move) {
              try { win.move(-32000, -32000); } catch (_) {}
            }
            // 2. Hide window
            if (win.hide) win.hide();

            const actionPerf = performance.now();
            const actionIso  = new Date().toISOString();
            const actionMs   = Math.round(actionPerf - startTimePerf);

            const hwndHex     = '0x' + (win.handle || win.id || 0).toString(16).toUpperCase();
            const windowTitle = win.getTitle ? win.getTitle() : 'Antigravity IDE';
            const windowClass = 'Chrome_WidgetWin_1';

            hit = {
              hwndHex,
              targetPid: win.processId,
              detectIso,
              detectMs,
              actionIso,
              actionMs,
              windowClass,
              windowTitle,
              totalGapMs: actionMs,
              gapSpawnToDetectMs: detectMs,
              gapDetectToActionMs: actionMs - detectMs,
              methodUsed: detectionMethod,
              pollCount,
            };
            break;
          }
        }
      } catch (err) {
        if (Date.now() - lastRuntimeErrLog > 3000) {
          warn(`node-window-manager polling exception: ${err.message || err}`);
          lastRuntimeErrLog = Date.now();
        }
      }
    } else if (ffi) {
      try {
        const { koffi, EnumWindowsProc, EnumWindows, GetWindowThreadProcessId, ShowWindow, SetWindowPos, IsWindowVisible, GetWindowTextW, GetClassNameW } = ffi;

        let found = null;
        const cb = koffi.register((hwnd, lParam) => {
          try {
            if (!IsWindowVisible(hwnd)) return true;

            const pidBuf = [0];
            GetWindowThreadProcessId(hwnd, pidBuf);
            const winPid = pidBuf[0];

            if (pidSet.has(winPid)) {
              const detectPerf = performance.now();
              const detectIso  = new Date().toISOString();
              const detectMs   = Math.round(detectPerf - startTimePerf);

              const titleBuf = new Uint16Array(512);
              const classBuf = new Uint16Array(256);
              GetWindowTextW(hwnd, titleBuf, 512);
              GetClassNameW(hwnd, classBuf, 256);

              const title = String.fromCharCode(...titleBuf).split('\0')[0].trim();
              const cls   = String.fromCharCode(...classBuf).split('\0')[0].trim();

              // 1. Reposition HWND off-screen to X=-32000, Y=-32000 (SetWindowPos)
              const moveOk = SetWindowPos(hwnd, 0, -32000, -32000, 0, 0, SWP_OFFSCREEN_FLAGS);

              // 2. ALSO hide window via ShowWindow(SW_HIDE)
              const hideOk = ShowWindow(hwnd, 0); // SW_HIDE = 0

              const actionPerf = performance.now();
              const actionIso  = new Date().toISOString();
              const actionMs   = Math.round(actionPerf - startTimePerf);

              found = {
                hwndHex: '0x' + hwnd.toString(16).toUpperCase(),
                targetPid: winPid,
                detectIso,
                detectMs,
                actionIso,
                actionMs,
                windowClass: cls,
                windowTitle: title,
                totalGapMs: actionMs,
                gapSpawnToDetectMs: detectMs,
                gapDetectToActionMs: actionMs - detectMs,
                methodUsed: detectionMethod,
                pollCount,
                moveOk,
                hideOk,
              };
              return false;
            }
          } catch (cbErr) {
            // Keep enumerating if error occurs on single window
          }
          return true;
        }, koffi.pointer(EnumWindowsProc));

        try {
          EnumWindows(cb, 0);
        } finally {
          koffi.unregister(cb);
        }

        if (found) hit = found;
      } catch (err) {
        if (Date.now() - lastRuntimeErrLog > 3000) {
          warn(`koffi Win32 FFI polling exception: ${err.message || err}`);
          lastRuntimeErrLog = Date.now();
        }
      }
    }

    if (hit) {
      ok(`HWND Detected, Repositioned Off-Screen (-32000,-32000), & Hidden on poll #${pollCount} at ${hit.detectMs} ms!`);
      console.log(`\n  ${c(BO, 'Win32 HWND Off-Screen Repositioning Metrics:')}`);
      console.log(`    ${c(CY, 'Detection Method')}       : ${c(BO, hit.methodUsed)}`);
      console.log(`    ${c(CY, 'HWND')}                   : ${c(BO, hit.hwndHex)} (Class: "${hit.windowClass}", Title: "${hit.windowTitle}")`);
      console.log(`    ${c(CY, 'SetWindowPos(-32000,-32000)')}: ${hit.moveOk !== false ? c(GR, 'SUCCESS ✓') : c(RE, 'FAILED ✖')}`);
      console.log(`    ${c(CY, 'ShowWindow(SW_HIDE)')}    : ${hit.hideOk !== false ? c(GR, 'SUCCESS ✓') : c(RE, 'FAILED ✖')}`);
      console.log(`    ${c(CY, 'Owner PID')}              : ${hit.targetPid} (Spawned Top PID: ${mainPid})`);
      console.log(`    ${c(CY, 'Total Poll Attempts')}      : ${hit.pollCount}`);
      console.log(`    ${c(CY, 'HWND Detect Time')}        : ${hit.detectIso} (${hit.detectMs} ms post-spawn)`);
      console.log(`    ${c(CY, 'Action Applied Time')}     : ${hit.actionIso} (${hit.actionMs} ms post-spawn)`);
      console.log(`    ${c(CY, 'Gap Spawn→Detect')}        : ${c(BO, hit.gapSpawnToDetectMs + ' ms')}`);
      console.log(`    ${c(CY, 'Gap Detect→Action')}       : ${c(BO, hit.gapDetectToActionMs + ' ms')}`);
      console.log(`    ${c(CY, 'Total Flash Window')}       : ${c(BO, hit.totalGapMs + ' ms')}\n`);

      return { success: true, ...hit };
    }

    log(`  poll #${pollCount} at ${currentElapsedMs}ms, no HWND yet`);

    await sleep(pollIntervalMs);
  }

  fail(`In-process HWND repositioning hook timed out after ${timeoutMs} ms without detecting window.`);
  return { success: false, methodUsed: detectionMethod };
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
  console.log(c(BO, '  OPTION 2: OFF-SCREEN REPOSITION HOOK TEST  (test-option2-offscreen-reposition.js)'));
  console.log(c(BO, '===============================================================\n'));
  log(`Strategy : SetWindowPos(hwnd, -32000, -32000) + ShowWindow(SW_HIDE)`);
  log(`Exe      : ${ANTIGRAVITY_EXE}`);
  log(`Profile  : ${USER_DATA_DIR}`);
  log(`Folder   : ${WORKSPACE_DIR}\n`);

  // Pre-check for existing processes
  const existing = getAntigravityProcesses();
  if (existing.length > 0) {
    warn(`Found ${existing.length} pre-existing Antigravity processes running. Cleaning up...`);
    cleanKillProcessTree(null);
    await sleep(1000);
  }

  console.log(c(CY, '\n[OPTION 2] Spawning Antigravity IDE and attaching HWND off-screen reposition hook...'));

  const spawnTimeMs = Date.now();
  const spawnIso    = new Date().toISOString();

  const child = spawn(ANTIGRAVITY_EXE, [`--user-data-dir=${USER_DATA_DIR}`, WORKSPACE_DIR], {
    detached: false,
    windowsHide: false,
    stdio: 'ignore',
  });

  const pid = child.pid;
  ok(`Spawned PID ${c(BO, pid)} at ${c(CY, spawnIso)}`);

  // Poll Win32 HWNDs and reposition off-screen
  const repositionResult = await pollForOffscreenRepositionNative(pid, 15000, 15);

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
  console.log(c(BO, '               OPTION 2 TEST RESULTS SUMMARY'));
  sep();
  console.log(`  ${c(CY, 'Strategy')}              : SetWindowPos(-32000,-32000) + ShowWindow(SW_HIDE)`);
  console.log(`  ${c(CY, 'HWND Hook Result')}       : ${repositionResult.success ? c(GR, 'SUCCESS ✓') : c(RE, 'FAILED ✖')}`);
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
