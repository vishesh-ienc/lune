'use strict';

const path = require('path');
const {
  detectAuthState,
  spawnHidden,
  waitForLanguageServer,
  getCsrfToken,
  findListeningPorts,
  queryUserStatus,
  killProcessTree,
  closeHiddenDesktop,
} = require('../lib/antigravity');

const USER_DATA_DIR = process.env.ANTIGRAVITY_USER_DATA ||
  path.join(process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming', 'Antigravity IDE');

const WORKSPACE_DIR = process.cwd();

async function main() {
  console.log('=== VERIFYING LIB/ANTIGRAVITY.JS END-TO-END ===\n');

  // 0. Pre-check clean state
  console.log('[Step 0] Pre-check process tree clean...');
  const preKill = killProcessTree(null, USER_DATA_DIR);
  console.log(`  Initial cleanup complete. Surviving processes: ${preKill.remainingCount}`);

  // 1. Detect auth state
  console.log('\n[Step 1] Running detectAuthState()...');
  const auth = detectAuthState(USER_DATA_DIR);
  console.log(`  isAuthenticated: ${auth.isAuthenticated}`);
  console.log(`  Evidence (${auth.evidence.length} items):`);
  auth.evidence.forEach(ev => console.log(`    - ${ev}`));

  // 2. Spawn hidden
  console.log('\n[Step 2] Running spawnHidden()...');
  const spawnRes = spawnHidden(USER_DATA_DIR, { workspaceDir: WORKSPACE_DIR });
  console.log(`  Main PID: ${spawnRes.pid}`);
  console.log(`  Hidden Desktop: ${spawnRes.desktopFullName}`);
  console.log(`  Handles: hProcess=${spawnRes.hProcess}, hDesktop=${spawnRes.hDesktop}`);

  // 3. Wait for Language Server
  console.log('\n[Step 3] Running waitForLanguageServer()...');
  const lspProc = await waitForLanguageServer(spawnRes.pid, 60000, 300, USER_DATA_DIR);
  if (!lspProc) {
    console.error('  ERROR: Language Server process not detected within timeout.');
    killProcessTree(spawnRes.pid, USER_DATA_DIR);
    closeHiddenDesktop(spawnRes.hDesktop, spawnRes.hProcess);
    process.exit(1);
  }
  console.log(`  Language Server detected! PID: ${lspProc.pid} (${lspProc.elapsedMs} ms post-spawn)`);

  // 4. Get CSRF Token & Listening Ports
  console.log('\n[Step 4] Extracting CSRF Token & Listening Ports...');
  const csrfToken = getCsrfToken(lspProc.commandLine, USER_DATA_DIR);
  console.log(`  CSRF Token: ${csrfToken ? csrfToken.slice(0, 12) + '...' : 'NULL'}`);

  const ports = findListeningPorts(lspProc.pid);
  console.log(`  Listening ports for PID ${lspProc.pid}: [${ports.join(', ')}]`);

  // 5. Query GetUserStatus
  console.log('\n[Step 5] Querying GetUserStatus HTTPS endpoint...');
  let querySuccess = false;
  let statusResult = null;

  for (const port of ports) {
    console.log(`  Querying 127.0.0.1:${port}...`);
    const res = await queryUserStatus(port, csrfToken);
    if (res.ok) {
      querySuccess = true;
      statusResult = res;
      console.log(`  ✓ GetUserStatus HTTP ${res.status} (${res.durationMs} ms)`);
      console.log(`  Response body snippet: ${res.body ? res.body.slice(0, 120) : '(empty)'}`);
      break;
    } else {
      console.log(`  ✖ Port ${port} failed: ${res.error}`);
    }
  }

  if (!querySuccess) {
    console.error('  ERROR: GetUserStatus failed on all candidate ports.');
  }

  // 6. Kill process tree
  console.log('\n[Step 6] Running killProcessTree()...');
  const killRes = killProcessTree(spawnRes.pid, USER_DATA_DIR);
  console.log(`  Process tree killed. Remaining orphans: ${killRes.remainingCount} (clean: ${killRes.ok})`);

  // 7. Close hidden desktop & handles
  console.log('\n[Step 7] Running closeHiddenDesktop()...');
  const closeRes = closeHiddenDesktop(spawnRes.hDesktop, spawnRes.hProcess);
  console.log(`  Desktop closed: ${closeRes.desktopClosed}, Process handle closed: ${closeRes.processHandleClosed}`);

  console.log('\n=== VERIFICATION SUMMARY ===');
  console.log(`Auth state detected : ${auth.isAuthenticated ? 'YES' : 'NO'}`);
  console.log(`Process spawned     : PID ${spawnRes.pid} on ${spawnRes.desktopName}`);
  console.log(`Language Server     : PID ${lspProc.pid} (${lspProc.elapsedMs} ms)`);
  console.log(`GetUserStatus       : ${querySuccess ? `SUCCESS (HTTP ${statusResult.status})` : 'FAILED'}`);
  console.log(`Cleanup             : ${killRes.ok && closeRes.desktopClosed ? 'CLEAN (0 orphans, desktop destroyed)' : 'PARTIAL'}`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error in verify-lib.js:', err);
  process.exit(1);
});
