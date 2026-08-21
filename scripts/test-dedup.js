'use strict';

/**
 * Focused regression test for resolveAndDeduplicateServers() deduplication logic.
 * Tests Root Cause B fix: same-profile + different-email MUST both survive.
 *
 * Cases:
 *   A) Same profile + same email     → 1 survivor (true duplicate)
 *   B) Same profile + different email → 2 survivors (two distinct accounts)
 *   C) Different profile + same email → 1 survivor (email-level dedup)
 *   D) Different profile + different email → 2 survivors (fully independent)
 *
 * Run with:  node scripts/test-dedup.js
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

// ── Stubs injected into the sandboxed function ────────────────────────────────

const agStub = {
  canonicalUserDataDir(dir) {
    if (!dir) return 'default';
    // Normalize slashes and strip trailing separator — mirrors the real impl.
    return dir.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  },
};

// queryUserStatus: port encodes identity for test simplicity.
//   port 10001 → alice@example.com
//   port 10002 → bob@example.com
//   port 10099 → (no email — simulates unresolved server)
function makeQueryUserStatus() {
  const emailMap = { 10001: 'alice@example.com', 10002: 'bob@example.com' };
  return async function queryUserStatus(port) {
    const email = emailMap[port];
    if (!email) return { ok: false, error: 'no-email' };
    return {
      ok: true,
      body: JSON.stringify({ user: { email }, planStatus: {}, userTier: {} }),
    };
  };
}

function parseUserStatusBodyStub(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    const userObj = (parsed.userStatus || parsed).user || {};
    return { email: userObj.email || null };
  } catch (_) {
    return {};
  }
}

const loggerStub = { debug: () => {}, info: () => {}, warn: () => {} };

// ── Extract resolveAndDeduplicateServers from main.js via vm ──────────────────

function loadResolveAndDeduplicateServers() {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // Extract function text (from async function resolveAndDeduplicateServers up to
  // the next top-level comment block or async function declaration).
  const fnStart = mainSrc.indexOf('async function resolveAndDeduplicateServers(');
  if (fnStart === -1) throw new Error('Could not locate resolveAndDeduplicateServers in main.js');

  // Walk forward to find the closing brace at depth 0.
  let depth = 0;
  let fnEnd = -1;
  let inStr = false;
  let strChar = '';
  for (let i = fnStart; i < mainSrc.length; i++) {
    const ch = mainSrc[i];
    if (inStr) {
      if (ch === strChar && mainSrc[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
  }
  if (fnEnd === -1) throw new Error('Could not find closing brace of resolveAndDeduplicateServers');

  const fnSrc = mainSrc.slice(fnStart, fnEnd);

  // Check that the Root Cause B fix (composite key) is present.
  if (!fnSrc.includes('seenProfileEmail')) {
    console.warn('[test-dedup] WARNING: composite seenProfileEmail key not found in extracted function.');
    console.warn('  Root Cause B fix may not have been applied yet.');
  }

  const agInSandbox = { canonicalUserDataDir: agStub.canonicalUserDataDir };
  const queryFn = makeQueryUserStatus();

  // We need ag.queryUserStatus accessible inside the function, so we override
  // the ag reference in the sandbox.
  const sandboxAg = Object.assign({}, agInSandbox, { queryUserStatus: queryFn });

  const wrappedSrc = `
    (function(ag, parseUserStatusBody, logger) {
      ${fnSrc}
      return resolveAndDeduplicateServers;
    })
  `;

  const factory = vm.runInNewContext(wrappedSrc, { require, console, Promise, JSON, Array, Set, parseInt, isNaN });
  return factory(sandboxAg, parseUserStatusBodyStub, loggerStub);
}

// ── Test server factory ───────────────────────────────────────────────────────

function makeServer(profile, port, pid) {
  return {
    pid,
    ports: [port],
    csrfToken: 'test-csrf',
    userDataDir: profile,
    canonicalDir: agStub.canonicalUserDataDir(profile),
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  test-dedup.js — resolveAndDeduplicateServers()');
  console.log('══════════════════════════════════════════════════\n');

  let fn;
  try {
    fn = loadResolveAndDeduplicateServers();
    console.log('  [OK] Function extracted from main.js\n');
  } catch (err) {
    console.error('  [FATAL]', err.message);
    process.exit(1);
  }

  const DEFAULT_PROFILE = 'C:/Users/VISHESH/AppData/Roaming/Antigravity IDE';
  const ALT_PROFILE     = 'C:/Users/VISHESH/AppData/Roaming/Antigravity-Profile2';

  const cases = [
    {
      label: 'A) Same profile + same email (true duplicate)',
      servers: [
        makeServer(DEFAULT_PROFILE, 10001, 101),  // alice
        makeServer(DEFAULT_PROFILE, 10001, 102),  // alice again — duplicate
      ],
      expected: 1,
    },
    {
      label: 'B) Same profile + different email (two distinct accounts)',
      servers: [
        makeServer(DEFAULT_PROFILE, 10001, 201),  // alice
        makeServer(DEFAULT_PROFILE, 10002, 202),  // bob — same profile, different account
      ],
      expected: 2,
    },
    {
      label: 'C) Different profile + same email (cross-profile dedup)',
      servers: [
        makeServer(DEFAULT_PROFILE, 10001, 301),  // alice on default install
        makeServer(ALT_PROFILE,     10001, 302),  // alice on alt install
      ],
      expected: 1,
    },
    {
      label: 'D) Different profile + different email (fully independent)',
      servers: [
        makeServer(DEFAULT_PROFILE, 10001, 401),  // alice on default
        makeServer(ALT_PROFILE,     10002, 402),  // bob on alt
      ],
      expected: 2,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const { label, servers, expected } of cases) {
    let result;
    try {
      result = await fn(servers);
    } catch (err) {
      console.error(`  ✗ ${label}`);
      console.error(`    Exception: ${err.message}`);
      failed++;
      continue;
    }

    const ok = result.length === expected;
    if (ok) {
      console.log(`  ✓ ${label}`);
      console.log(`    └─ ${result.length} survivor(s): ${result.map(s => `PID ${s.pid} <${s.activeEmail}>`).join(', ')}`);
      passed++;
    } else {
      console.error(`  ✗ ${label}`);
      console.error(`    Expected ${expected} survivor(s), got ${result.length}.`);
      if (result.length > 0) {
        result.forEach(s => console.error(`    └─ PID ${s.pid}  email=${s.activeEmail}`));
      }
      failed++;
    }
  }

  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`  Passed: ${passed} / ${passed + failed}`);
  if (failed > 0) console.error(`  FAILED: ${failed}`);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[test-dedup.js] Uncaught fatal error:', err);
  process.exit(1);
});
