'use strict';

/**
 * Focused regression test for matchAccountsForLiveStatus() — Root Cause A fix.
 *
 * Cases:
 *   A) Profile + matching email        → confirmed Live
 *   B) Profile + different resolved email → NOT Live (rejected)
 *   C) Profile + unresolved email       → tentative Live candidate
 *   D) Different profile + unresolved email → NOT Live
 *   E) Two accounts, same profile, unresolved LSP → at most one tentative
 *   F) Unresolved LSP → resolves to Account B → A offline, B confirmed Live
 *
 * Run with:  node scripts/test-live-match.js
 */

const assert = require('assert');
const ag     = require('../lib/antigravity');

const APPDATA      = process.env.APPDATA || 'C:\\Users\\VISHESH\\AppData\\Roaming';
const DEFAULT_DIR  = require('path').join(APPDATA, 'Antigravity IDE');
const ALT_DIR      = 'C:\\CustomProfiles\\AltProfile';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLsp(pid, userDataDir, activeEmail = null, ports = [50001], csrfToken = 'tok') {
  return { pid, userDataDir, activeEmail, ports, csrfToken };
}

function makeAcc(id, email, userDataDir = DEFAULT_DIR) {
  return { id, email, userDataDir };
}

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════');
console.log('  test-live-match.js — matchAccountsForLiveStatus()');
console.log('══════════════════════════════════════════════════════════\n');

// Case A: profile + matching email → confirmed Live
check('A) Profile + matching email → CONFIRMED Live', () => {
  const acc = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const lsp = makeLsp(100, DEFAULT_DIR, 'alice@example.com');
  const map = ag.matchAccountsForLiveStatus([lsp], [acc]);
  const r   = map.get(acc);
  assert.ok(r, 'result must exist');
  assert.strictEqual(r.matchType, 'confirmed', `expected confirmed, got ${r.matchType}`);
  assert.strictEqual(r.lsp, lsp, 'lsp must be the matched process');
});

// Case B: profile matches but different resolved email → NOT Live (rejected)
check('B) Profile + different resolved email → NOT Live', () => {
  const acc = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const lsp = makeLsp(101, DEFAULT_DIR, 'bob@example.com');
  const map = ag.matchAccountsForLiveStatus([lsp], [acc]);
  const r   = map.get(acc);
  assert.ok(r, 'result must exist');
  assert.strictEqual(r.matchType, 'none', `expected none, got ${r.matchType}`);
  assert.strictEqual(r.lsp, null, 'lsp must be null');
});

// Case C: profile matches, email unresolved → tentative Live
check('C) Profile + unresolved email → TENTATIVE Live', () => {
  const acc = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const lsp = makeLsp(102, DEFAULT_DIR, null);  // no activeEmail
  const map = ag.matchAccountsForLiveStatus([lsp], [acc]);
  const r   = map.get(acc);
  assert.ok(r, 'result must exist');
  assert.strictEqual(r.matchType, 'tentative', `expected tentative, got ${r.matchType}`);
  assert.strictEqual(r.lsp, lsp, 'lsp must be the unresolved process');
});

// Case D: different profile, unresolved email → NOT Live
check('D) Different profile + unresolved email → NOT Live', () => {
  const acc = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const lsp = makeLsp(103, ALT_DIR, null);  // unresolved, wrong profile
  const map = ag.matchAccountsForLiveStatus([lsp], [acc]);
  const r   = map.get(acc);
  assert.ok(r, 'result must exist');
  assert.strictEqual(r.matchType, 'none', `expected none, got ${r.matchType}`);
  assert.strictEqual(r.lsp, null, 'lsp must be null');
});

// Case E: two accounts share same profile, one unresolved LSP → at most ONE tentative
check('E) Two accounts, same profile, unresolved LSP → at most one tentative', () => {
  const acc1 = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const acc2 = makeAcc(2, 'bob@example.com',   DEFAULT_DIR);
  const lsp  = makeLsp(104, DEFAULT_DIR, null);  // unresolved
  const map  = ag.matchAccountsForLiveStatus([lsp], [acc1, acc2]);

  const r1 = map.get(acc1);
  const r2 = map.get(acc2);

  const tentativeCount = [r1, r2].filter(r => r && r.matchType === 'tentative').length;
  assert.strictEqual(tentativeCount, 1, `expected exactly 1 tentative, got ${tentativeCount}`);

  // The other account must be 'none'
  const noneCount = [r1, r2].filter(r => r && r.matchType === 'none').length;
  assert.strictEqual(noneCount, 1, `expected exactly 1 none, got ${noneCount}`);

  // The claimed tentative must be the first account in array order
  assert.strictEqual(r1.matchType, 'tentative', 'first account (acc1) should be the tentative candidate');
  assert.strictEqual(r2.matchType, 'none',      'second account (acc2) must not also be tentative');
});

// Case F: unresolved LSP first resolves to B → A offline, B confirmed Live
check('F) Unresolved → resolves to Account B: A offline, B confirmed', () => {
  const accA = makeAcc(1, 'alice@example.com', DEFAULT_DIR);
  const accB = makeAcc(2, 'bob@example.com',   DEFAULT_DIR);

  // Cycle 1: LSP unresolved — acc1 gets tentative (first in array)
  const unresolvedLsp = makeLsp(105, DEFAULT_DIR, null);
  const map1 = ag.matchAccountsForLiveStatus([unresolvedLsp], [accA, accB]);
  assert.strictEqual(map1.get(accA).matchType, 'tentative', 'cycle 1: accA tentative');
  assert.strictEqual(map1.get(accB).matchType, 'none',      'cycle 1: accB none');

  // Cycle 2: LSP now resolved as Bob's account — Bob confirmed, Alice rejected
  const resolvedLsp = makeLsp(105, DEFAULT_DIR, 'bob@example.com');
  const map2 = ag.matchAccountsForLiveStatus([resolvedLsp], [accA, accB]);
  assert.strictEqual(map2.get(accA).matchType, 'none',      'cycle 2: accA offline (rejected)');
  assert.strictEqual(map2.get(accB).matchType, 'confirmed', 'cycle 2: accB confirmed Live');
  assert.strictEqual(map2.get(accB).lsp, resolvedLsp, 'cycle 2: accB lsp is resolvedLsp');
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n──────────────────────────────────────────────────────────`);
console.log(`  Passed: ${passed} / ${passed + failed}`);
if (failed > 0) console.error(`  FAILED: ${failed}`);
console.log('══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
