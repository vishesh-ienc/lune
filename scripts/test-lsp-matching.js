'use strict';

const assert = require('assert');
const path = require('path');
const ag = require('../lib/antigravity');

console.log('====================================================');
console.log('  LUNE LSP MATCHING & DISAMBIGUATION TEST SUITE');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test A: Antigravity vs Antigravity IDE default-path matching
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test A: Default profile canonicalization (Antigravity vs Antigravity IDE)', () => {
  const appData = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
  const path1 = path.join(appData, 'Antigravity');
  const path2 = path.join(appData, 'Antigravity IDE');
  const path3 = path.join(appData, 'antigravity ide\\');

  assert.strictEqual(ag.isDefaultUserDataDir(path1), true, 'path1 should be default');
  assert.strictEqual(ag.isDefaultUserDataDir(path2), true, 'path2 should be default');
  assert.strictEqual(ag.isDefaultUserDataDir(path3), true, 'path3 should be default');

  const canon1 = ag.canonicalUserDataDir(path1);
  const canon2 = ag.canonicalUserDataDir(path2);
  const canon3 = ag.canonicalUserDataDir(path3);

  assert.strictEqual(canon1, canon2, 'canon1 and canon2 must match');
  assert.strictEqual(canon2, canon3, 'canon2 and canon3 must match');

  // Test matching an account saved with 'Antigravity' to an LSP running with 'Antigravity IDE'
  const accounts = [
    { id: 1, email: 'user@example.com', userDataDir: path1 }
  ];
  const lspProcs = [
    { pid: 1234, activeEmail: 'user@example.com', userDataDir: path2 }
  ];

  const matchMap = ag.matchAccountToRunningProcess(lspProcs, accounts);
  assert.strictEqual(matchMap.get(accounts[0]), lspProcs[0], 'Account should match LSP despite default path alias');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B: Old LSP + newer LSP under the same profile
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test B: Old LSP + newer LSP ranking and single selection', () => {
  const appData = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
  const defaultDir = path.join(appData, 'Antigravity IDE');

  const oldLsp = {
    pid: 1000,
    creationDateMs: 100000,
    isWorkspaceLsp: true,
    userDataDir: defaultDir,
    canonicalDir: ag.canonicalUserDataDir(defaultDir),
    activeEmail: 'user@example.com',
  };

  const newLsp = {
    pid: 2000,
    creationDateMs: 200000,
    isWorkspaceLsp: true,
    userDataDir: defaultDir,
    canonicalDir: ag.canonicalUserDataDir(defaultDir),
    activeEmail: 'user@example.com',
  };

  const procs = [oldLsp, newLsp];
  procs.sort((a, b) => {
    if (a.isWorkspaceLsp !== b.isWorkspaceLsp) return a.isWorkspaceLsp ? -1 : 1;
    if (a.creationDateMs !== b.creationDateMs) return b.creationDateMs - a.creationDateMs;
    return b.pid - a.pid;
  });

  assert.strictEqual(procs[0].pid, 2000, 'Newer LSP (pid 2000) must rank first');
  assert.strictEqual(procs[1].pid, 1000, 'Older LSP (pid 1000) must rank second');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test C: Account switch from old identity to new identity in the same profile
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test C: Account switch identity transition (only new account active)', () => {
  const appData = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
  const defaultDir = path.join(appData, 'Antigravity IDE');

  const acc1 = { id: 101, email: 'old-account@example.com', userDataDir: defaultDir };
  const acc2 = { id: 102, email: 'new-account@example.com', userDataDir: defaultDir };
  const accounts = [acc1, acc2];

  // Old LSP lingering (16:00:00) vs New LSP active (16:05:00)
  const oldLsp = {
    pid: 1000,
    creationDateMs: 100000,
    isWorkspaceLsp: true,
    userDataDir: defaultDir,
    activeEmail: 'old-account@example.com',
  };
  const newLsp = {
    pid: 2000,
    creationDateMs: 200000,
    isWorkspaceLsp: true,
    userDataDir: defaultDir,
    activeEmail: 'new-account@example.com',
  };

  // Only the newest responding server is kept per profile in resolveAndDeduplicateServers
  const activeServers = [newLsp]; // after resolution
  const matchMap = ag.matchAccountToRunningProcess(activeServers, accounts);

  assert.strictEqual(matchMap.get(acc1), null, 'Old account must map to null (offline)');
  assert.strictEqual(matchMap.get(acc2), newLsp, 'New account must map to newLsp (online)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test D: Different custom profiles remaining independent
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test D: Independent custom profiles remain distinct and can both be active', () => {
  const profileA = 'C:\\CustomProfiles\\ProfileA';
  const profileB = 'C:\\CustomProfiles\\ProfileB';

  assert.strictEqual(ag.isDefaultUserDataDir(profileA), false, 'ProfileA is not default');
  assert.strictEqual(ag.isDefaultUserDataDir(profileB), false, 'ProfileB is not default');
  assert.notStrictEqual(ag.canonicalUserDataDir(profileA), ag.canonicalUserDataDir(profileB), 'Profiles must have distinct canonical paths');

  const accA = { id: 1, email: 'userA@example.com', userDataDir: profileA };
  const accB = { id: 2, email: 'userB@example.com', userDataDir: profileB };
  const accounts = [accA, accB];

  const lspA = { pid: 3001, activeEmail: 'userA@example.com', userDataDir: profileA };
  const lspB = { pid: 3002, activeEmail: 'userB@example.com', userDataDir: profileB };
  const activeServers = [lspA, lspB];

  const matchMap = ag.matchAccountToRunningProcess(activeServers, accounts);
  assert.strictEqual(matchMap.get(accA), lspA, 'accA matches lspA');
  assert.strictEqual(matchMap.get(accB), lspB, 'accB matches lspB');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test E: Wrong activeEmail not being matched
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test E: Wrong activeEmail rejection', () => {
  const appData = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
  const defaultDir = path.join(appData, 'Antigravity IDE');

  const acc = { id: 1, email: 'expected@example.com', userDataDir: defaultDir };
  const lsp = { pid: 5000, activeEmail: 'different@example.com', userDataDir: defaultDir };

  const matchMap = ag.matchAccountToRunningProcess([lsp], [acc]);
  assert.strictEqual(matchMap.get(acc), null, 'Account must not match when emails differ');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test F: Workspace LSP prioritized over global background LSP
// ─────────────────────────────────────────────────────────────────────────────
runTest('Test F: Workspace LSP prioritized over non-workspace LSP', () => {
  const appData = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
  const defaultDir = path.join(appData, 'Antigravity IDE');

  const globalLsp = {
    pid: 32812,
    creationDateMs: 1787136131000,
    isWorkspaceLsp: false,
    userDataDir: defaultDir,
    canonicalDir: ag.canonicalUserDataDir(defaultDir),
  };

  const workspaceLsp = {
    pid: 11728,
    creationDateMs: 1787136139000,
    isWorkspaceLsp: true,
    userDataDir: defaultDir,
    canonicalDir: ag.canonicalUserDataDir(defaultDir),
  };

  const procs = [globalLsp, workspaceLsp];
  procs.sort((a, b) => {
    if (a.isWorkspaceLsp !== b.isWorkspaceLsp) return a.isWorkspaceLsp ? -1 : 1;
    if (a.creationDateMs !== b.creationDateMs) return b.creationDateMs - a.creationDateMs;
    return b.pid - a.pid;
  });

  assert.strictEqual(procs[0].pid, 11728, 'Workspace LSP must be ranked first');
  assert.strictEqual(procs[1].pid, 32812, 'Global LSP must be ranked second');
});

console.log(`\n====================================================`);
console.log(`  RESULTS: ${passedTests} / ${totalTests} tests passed`);
console.log('====================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
