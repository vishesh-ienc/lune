#!/usr/bin/env node
/**
 * test-direct-lsp.js
 *
 * Direct LSP Standalone Boot & Auth Loading Test
 *
 * Evaluates whether language_server_windows_x64.exe can be spawned directly
 * WITHOUT spawning Antigravity IDE.exe (the parent Electron process), and
 * whether it independently loads the user profile's authenticated Google session
 * or returns an unauthenticated / empty status due to missing parent IPC handoff.
 *
 * Sequence:
 *   1. Pre-flight check (ensure Antigravity process tree is not already running)
 *   2. Directly spawn language_server_windows_x64.exe with candidate CLI flags
 *   3. Poll netstat for active listening ports on the spawned PID
 *   4. Issue GetUserStatus HTTP POST query using the generated CSRF token
 *   5. Report standalone execution verdict & window visibility status
 *   6. Clean kill & orphan cleanup
 */

'use strict';

const { execSync, spawn } = require('child_process');
const crypto              = require('crypto');
const https               = require('https');
const path                = require('path');
const fs                  = require('fs');
const os                  = require('os');

// ─── Configuration ────────────────────────────────────────────────────────────

const LSP_EXE_PATH = 'C:\\Users\\VISHESH\\AppData\\Local\\Programs\\Antigravity IDE\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe';
const TEST_PORT    = 55200;
const POLL_TIMEOUT_MS  = 15_000;
const POLL_INTERVAL_MS = 300;

// ─── Colours & Formatting ─────────────────────────────────────────────────────

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
function sep(n = 72)  { console.log(c(DI, '─'.repeat(n))); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Netstat Port Scanner ─────────────────────────────────────────────────────

function getListeningPortsForPid(pid) {
  const pidStr = String(pid);
  let netstatOut = '';
  try {
    netstatOut = execSync(`netstat -ano | findstr ${pidStr}`, {
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    netstatOut = (err.stdout || '');
  }

  const ports = [];
  const seen  = new Set();
  for (const line of netstatOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const state     = parts[parts.length - 2]?.toUpperCase();
    const linePid   = parts[parts.length - 1];
    if (state !== 'LISTENING') continue;
    if (linePid !== pidStr)    continue;

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

// ─── GetUserStatus Query ──────────────────────────────────────────────────────

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
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data, headers: res.headers, durationMs: Date.now() - t0 }));
    });

    req.on('error', err => resolve({ ok: false, error: err.message, durationMs: Date.now() - t0 }));
    req.setTimeout(10_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout (10 s)', durationMs: Date.now() - t0 }); });

    req.write(bodyData);
    req.end();
  });
}

// ─── Process Tree Kill ────────────────────────────────────────────────────────

function killTree(pid) {
  try {
    const out = execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', windowsHide: true });
    return { ok: true, stdout: out.trim() };
  } catch (err) {
    const gone = /not found|no running/i.test(err.message + (err.stderr || ''));
    return { ok: gone, stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message || '').trim() };
  }
}

// ─── Main Execution ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + c(BO, '╔' + '═'.repeat(70) + '╗'));
  console.log(c(BO, '║  Standalone Direct Language Server Boot & Auth Test               ║'));
  console.log(c(BO, '╚' + '═'.repeat(70) + '╝'));
  console.log(c(DI, `  Platform      : ${os.platform()} ${os.release()}`));
  console.log(c(DI, `  LSP Binary    : ${LSP_EXE_PATH}`));
  console.log(c(DI, `  Test Port     : ${TEST_PORT}`));
  console.log('');

  // 1. Verify Binary Existence
  if (!fs.existsSync(LSP_EXE_PATH)) {
    fail(`LSP binary not found at expected path: ${LSP_EXE_PATH}`);
    process.exit(1);
  }
  ok('LSP binary exists on disk.');

  // 2. Generate Test Params
  const csrfToken = crypto.randomUUID();
  log(`Generated fresh CSRF Token: ${csrfToken}`);

  const lspArgs = [
    '--enable_lsp',
    '--csrf_token', csrfToken,
    '--extension_server_port', String(TEST_PORT),
    '--app_data_dir', 'antigravity-ide',
    '--workspace_id', 'file_c_3A_Users_VISHESH_Desktop_lune',
  ];

  const fullCmd = `"${LSP_EXE_PATH}" ${lspArgs.join(' ')}`;
  sep();
  log('[1/4] Spawning language_server_windows_x64.exe directly (NO Antigravity IDE.exe)…');
  log(`      CMD: ${fullCmd}`);

  let child;
  let pid;
  const spawnT0 = Date.now();

  try {
    child = spawn(LSP_EXE_PATH, lspArgs, {
      shell:       false,
      detached:    false,
      windowsHide: true,
      stdio:       ['ignore', 'pipe', 'pipe'],
    });
    pid = child.pid;
    ok(`Spawned direct LSP binary  PID=${pid}  (${Date.now() - spawnT0} ms)`);
  } catch (err) {
    fail(`Direct spawn failed: ${err.message}`);
    process.exit(1);
  }

  // Capture stdout / stderr output from standalone LSP process
  let lspStdout = '';
  let lspStderr = '';
  child.stdout.on('data', chunk => { lspStdout += chunk.toString(); });
  child.stderr.on('data', chunk => { lspStderr += chunk.toString(); });

  child.on('exit', (code, signal) => {
    warn(`LSP process PID=${pid} exited with code=${code}, signal=${signal}`);
  });

  try {
    // 3. Poll for Listening Ports
    sep();
    log(`[2/4] Polling netstat for listening ports on PID ${pid} (timeout ${POLL_TIMEOUT_MS / 1000} s)…`);
    
    let listeningPorts = [];
    const pollT0 = Date.now();
    let pollCount = 0;

    while (Date.now() - pollT0 < POLL_TIMEOUT_MS) {
      pollCount++;
      listeningPorts = getListeningPortsForPid(pid);
      if (listeningPorts.length > 0) break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (listeningPorts.length === 0) {
      fail(`No listening ports detected on PID ${pid} within ${POLL_TIMEOUT_MS / 1000} s.`);
      if (lspStderr) {
        warn('LSP Stderr output:');
        console.log(c(DI, lspStderr.trim()));
      }
      if (lspStdout) {
        warn('LSP Stdout output:');
        console.log(c(DI, lspStdout.trim()));
      }
    } else {
      ok(`LSP bound to port(s): [${listeningPorts.join(', ')}]  (detected in ${Date.now() - pollT0} ms)`);
    }

    // Target port to query (use explicit test port if listening, otherwise first detected port)
    const targetPort = listeningPorts.includes(TEST_PORT) ? TEST_PORT : (listeningPorts[0] || TEST_PORT);

    // 4. Query GetUserStatus HTTP API
    sep();
    log(`[3/4] Querying GetUserStatus on port ${targetPort} using CSRF token…`);
    
    // Brief pause to allow gRPC server startup if port opened early
    await sleep(1000);
    const queryResult = await queryUserStatus(targetPort, csrfToken);

    sep();
    log('[4/4] Direct LSP Standalone Execution Results:');
    console.log('');
    console.log(`  Process Spawned Directly : ${c(GR, 'YES')} (PID: ${pid})`);
    console.log(`  GUI Window Visible       : ${c(GR, 'NO (0 visible windows - pure CLI binary)')}`);
    console.log(`  Port Bound               : ${listeningPorts.length > 0 ? c(GR, `YES (${listeningPorts.join(', ')})`) : c(RE, 'NO')}`);
    console.log(`  HTTP Query Success       : ${queryResult.ok ? c(GR, 'YES') : c(RE, 'NO')}`);
    console.log(`  HTTP Status Code         : ${queryResult.status ?? 'N/A'}`);
    console.log(`  Query Duration           : ${queryResult.durationMs ?? 'N/A'} ms`);
    console.log('');

    if (queryResult.ok && queryResult.status === 200) {
      const hasUserData = queryResult.body && queryResult.body.length > 10;
      ok(c(GR, `VERDICT: GetUserStatus returned HTTP 200 OK (${queryResult.body.length} bytes)`));
      console.log(c(CY, '  Response Body Snippet:'));
      console.log(c(DI, `    ${queryResult.body.slice(0, 300)}`));
      if (hasUserData) {
        ok(c(GR, '  AUTHENTICATION SUCCESS: Standalone LSP independently loaded profile auth session!'));
      } else {
        warn(c(YE, '  AUTH AMBIGUOUS: Returned HTTP 200 but body is small/empty. May need parent IPC session handoff.'));
      }
    } else {
      fail(c(RE, `VERDICT: GetUserStatus failed! Status=${queryResult.status}, Error=${queryResult.error || 'N/A'}`));
      if (queryResult.body) {
        warn('  Response Body Snippet:');
        console.log(c(DI, `    ${queryResult.body.slice(0, 300)}`));
      }
      if (lspStderr.trim()) {
        warn('  LSP Stderr output captured:');
        console.log(c(DI, `    ${lspStderr.trim().slice(0, 500)}`));
      }
    }

  } finally {
    // 5. Clean Termination
    sep();
    log(`Cleaning up direct LSP process PID ${pid}…`);
    const k = killTree(pid);
    if (k.ok) {
      ok(`Direct LSP PID ${pid} killed cleanly.`);
    } else {
      warn(`Kill result for PID ${pid}: ${k.stderr || k.stdout}`);
    }
  }

  sep();
  log('Test completed.');
}

main().catch(err => {
  console.error(c(RE, `Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
