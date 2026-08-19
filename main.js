'use strict';

const { app, BrowserWindow, ipcMain, Menu, nativeImage } = require('electron');
const logger = require('./lib/logger');
const fs   = require('fs');
const path = require('path');
const ag   = require('./lib/antigravity');

// Suppress Chromium GPU disk-cache errors on Windows (harmless, caused by
// file-lock contention when a previous process just exited).
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-features', 'DiskCacheBackend');

let mainWindow = null;

// â”€â”€ Authoritative In-Memory Accounts Store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ALL code in main.js must read from and write to this single array.
// Never hold a separate local copy that outlives a single synchronous operation.
// Handlers that need a snapshot for async work should capture acc references from
// this array (not clone it) so mutations are immediately visible everywhere.
let ACCOUNTS = [];
// When true, the array has been modified since the last disk write.
// persistIfDirty() checks this flag and writes only when set.
let accountsDirty = false;

/** Returns the live authoritative accounts array. Do NOT hold the reference
 *  past a single synchronous operation â€” always re-call for up-to-date data. */
function getAccounts() { return ACCOUNTS; }

/** Mark ACCOUNTS as modified â€” next persistIfDirty() call will write to disk. */
function markAccountsDirty() { accountsDirty = true; }

/**
 * Write ACCOUNTS to disk only if something has changed since the last write.
 * This replaces the old pattern of calling saveAccountsToDisk(accounts) on
 * EVERY tick regardless of whether anything actually changed.
 * @returns {{ ok: boolean }} same shape as saveAccountsToDisk
 */
function persistIfDirty() {
  if (!accountsDirty) return { ok: true };
  const result = saveAccountsToDisk(ACCOUNTS);
  if (result.ok) accountsDirty = false;
  return result;
}

/**
 * Fully replace the in-memory store with a fresh disk read.
 * Called once at startup; rarely needed after that.
 */
function reloadAccountsFromDisk() {
  ACCOUNTS = loadAccountsFromDisk();
  accountsDirty = false;
}


// ── Persistence Helpers ───────────────────────────────────────────────────

function getAccountsFilePath() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function loadAccountsFromDisk() {
  try {
    const filePath = getAccountsFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      logger.debug(`[Lune main.js] Loaded ${parsed.length} persisted account(s) from ${filePath}`);
      // Strip transient runtime-only error flags so they never bleed across sessions.
      // These are set during a live query and must be re-evaluated fresh each run.
      for (const acc of parsed) {
        delete acc.wrongAccountActive;
        delete acc.unreachable;
        delete acc.refreshError;
        delete acc.refreshStatusLabel;
        delete acc.isLive;
      }
      return parsed;
    }
    return [];
  } catch (err) {
    console.warn('[Lune main.js] Failed to load accounts.json:', err.message);
    return [];
  }
}

function backupAccountsFileBeforeWrite(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;

    const userDataDir = path.dirname(filePath);
    const backupDir = path.join(userDataDir, 'accounts-backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/:/g, '-');
    const backupFileName = `accounts-${ts}.json`;
    const backupPath = path.join(backupDir, backupFileName);

    fs.copyFileSync(filePath, backupPath);
    logger.debug(`[Lune backup] Created accounts backup: ${backupFileName}`);

    const MAX_BACKUPS = 20;
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('accounts-') && f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const oldFile of toDelete) {
        try {
          fs.unlinkSync(path.join(backupDir, oldFile));
          logger.debug(`[Lune backup] Pruned old backup: ${oldFile}`);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[Lune backup] Failed to create backup before write:', err.message);
  }
}

function saveAccountsToDisk(accounts) {
  try {
    if (!Array.isArray(accounts)) {
      return { ok: false, error: 'Accounts payload must be an array' };
    }
    // Strip transient runtime-only error flags before persisting.
    // These are re-evaluated fresh each session; saving them causes stale
    // error overlays (e.g. wrongAccountActive, unreachable) to hide real
    // pool data when the app restarts.
    const TRANSIENT_FLAGS = ['wrongAccountActive', 'unreachable', 'refreshError', 'refreshStatusLabel'];
    const clean = accounts.map(acc => {
      const out = { ...acc };
      for (const key of TRANSIENT_FLAGS) delete out[key];
      return out;
    });
    const filePath = getAccountsFilePath();
    backupAccountsFileBeforeWrite(filePath);
    const data = JSON.stringify(clean, null, 2);
    const tempPath = filePath + '.tmp';
    let saved = false;
    for (let i = 0; i < 3; i++) {
      try {
        fs.writeFileSync(tempPath, data, 'utf8');
        fs.renameSync(tempPath, filePath);
        saved = true;
        break;
      } catch (writeErr) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        if (i === 2) {
          // Direct write fallback
          fs.writeFileSync(filePath, data, 'utf8');
          saved = true;
        } else {
          const start = Date.now();
          while (Date.now() - start < 50) {}
        }
      }
    }
    logger.debug(`[Lune main.js] Persisted ${clean.length} account(s) to ${filePath}`);
    return { ok: true };
  } catch (err) {
    console.error('[Lune main.js] Failed to save accounts.json:', err.message);
    return { ok: false, error: err.message };
  }
}

// parseUserStatusBody is defined below near updateAccountFromUserStatus (full version with quotas).

/**
 * Resolves activeEmail for each running server in the list over HTTP.
 * Respects priority ordering from findAllActiveRunningLanguageServers:
 * For each canonical profile directory, selects the top successfully responding server.
 * Different independent canonical profiles are resolved independently.
 */
async function resolveAndDeduplicateServers(servers) {
  if (!servers || !Array.isArray(servers) || servers.length === 0) return [];

  const resolvedServers = [];
  const seenProfiles = new Set();
  const seenEmails = new Set();

  for (const server of servers) {
    if (!server.ports || server.ports.length === 0 || !server.csrfToken) continue;

    const canonicalProfile = ag.canonicalUserDataDir(server.userDataDir || server.canonicalDir);
    // If we have already resolved an active server for this canonical profile, skip secondary/stale candidates
    if (seenProfiles.has(canonicalProfile)) {
      logger.debug(`[Lune resolve-servers] PID ${server.pid}: skipping secondary candidate for already-resolved profile ${canonicalProfile}`);
      continue;
    }

    let email = null;
    let parsed = null;
    let body = null;

    for (const port of server.ports) {
      try {
        const res = await ag.queryUserStatus(port, server.csrfToken);
        if (res.ok && res.body) {
          const p = parseUserStatusBody(res.body);
          if (p.email) {
            email = p.email;
            parsed = p;
            body = res.body;
            break;
          }
        }
      } catch (err) {
        logger.debug(`[Lune resolve-servers] PID ${server.pid} port ${port}: query failed — ${err.message}`);
      }
    }

    if (!email) {
      logger.debug(`[Lune resolve-servers] PID ${server.pid}: no email resolved — skipping.`);
      continue;
    }

    // Cache resolved identity on the server object for downstream consumers.
    server.activeEmail = email;
    server.lastParsedUserStatus = parsed;
    server.lastRawResponseBody = body;
    server.canonicalDir = canonicalProfile;

    const emailLower = email.toLowerCase().trim();
    if (!seenEmails.has(emailLower)) {
      seenEmails.add(emailLower);
      seenProfiles.add(canonicalProfile);
      resolvedServers.push(server);
      logger.debug(`[Lune resolve-servers] PID ${server.pid}: resolved email=${email} for profile=${canonicalProfile}.`);
    }
  }

  return resolvedServers;
}

// ── Diagnostic Logging Helpers ────────────────────────────────────────────

function extractModelSummaries(body) {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    const userStatus = parsed.userStatus || parsed;
    const configs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    return configs.map(cfg => {
      const q = cfg.quotaInfo || {};
      return {
        label: cfg.label || cfg.modelName || cfg.name || 'Unknown',
        fraction: q.remainingFraction !== undefined ? q.remainingFraction : null,
        resetTime: q.resetTime || null,
        fiveHourFraction: q.fiveHourRemainingFraction ?? q.shortTermRemainingFraction ?? null,
        fiveHourResetTime: q.fiveHourResetTime || q.shortTermResetTime || null
      };
    });
  } catch (e) {
    return [];
  }
}

function logDiagnosticComparison(usedPort, candidatePorts, body1, durationMs1, body2, durationMs2) {
  if (!logger.isDebug()) return;
  console.log('\n' + '='.repeat(80));
  console.log('  [LUNE DIAGNOSTIC INSTRUMENTATION LOG]');
  console.log('='.repeat(80));
  console.log(`  Target Port Used   : ${usedPort}`);
  console.log(`  Candidate Ports    : [${candidatePorts.join(', ')}] (Total: ${candidatePorts.length})`);
  console.log(`  Query 1 Timing     : ${durationMs1} ms post-LSP detection (Immediate)`);
  console.log(`  Query 2 Timing     : ${durationMs2} ms post-LSP detection (+5s delay)`);
  console.log('-'.repeat(80));

  const models1 = extractModelSummaries(body1);
  const models2 = extractModelSummaries(body2);

  console.log('\n  [QUERY 1 MODEL QUOTAS & RESET TIMES (t = 0s)]');
  if (models1.length === 0) {
    console.log('    (No models found in body 1)');
  } else {
    models1.forEach(m => {
      console.log(`    • ${m.label.padEnd(25)} | Fraction: ${String(m.fraction).padEnd(8)} | ResetTime: ${m.resetTime || 'N/A'}`);
      if (m.fiveHourResetTime || m.fiveHourFraction !== null) {
        console.log(`      └─ 5h Window             | 5hFraction: ${String(m.fiveHourFraction).padEnd(6)} | 5hResetTime: ${m.fiveHourResetTime || 'N/A'}`);
      }
    });
  }

  if (body2) {
    console.log('\n  [QUERY 2 MODEL QUOTAS & RESET TIMES (t = +5s)]');
    if (models2.length === 0) {
      console.log('    (No models found in body 2)');
    } else {
      models2.forEach(m => {
        console.log(`    • ${m.label.padEnd(25)} | Fraction: ${String(m.fraction).padEnd(8)} | ResetTime: ${m.resetTime || 'N/A'}`);
        if (m.fiveHourResetTime || m.fiveHourFraction !== null) {
          console.log(`      └─ 5h Window             | 5hFraction: ${String(m.fiveHourFraction).padEnd(6)} | 5hResetTime: ${m.fiveHourResetTime || 'N/A'}`);
        }
      });
    }

    console.log('\n  [SIDE-BY-SIDE STALENESS COMPARISON]');
    const allLabels = Array.from(new Set([...models1.map(m => m.label), ...models2.map(m => m.label)]));
    let anyDifference = false;
    allLabels.forEach(lbl => {
      const m1 = models1.find(m => m.label === lbl) || {};
      const m2 = models2.find(m => m.label === lbl) || {};

      const f1Str = m1.fraction !== undefined && m1.fraction !== null ? m1.fraction.toString() : 'N/A';
      const f2Str = m2.fraction !== undefined && m2.fraction !== null ? m2.fraction.toString() : 'N/A';
      const match = f1Str === f2Str && m1.resetTime === m2.resetTime;

      if (!match) anyDifference = true;
      const statusTag = match ? '✓ IDENTICAL (SETTLED)' : '✖ DIFFERENT (SYNCING IN PROGRESS!)';

      console.log(`    ${lbl.padEnd(25)} | Q1 (t=0s): ${f1Str.padEnd(7)} | Q2 (t=+5s): ${f2Str.padEnd(7)} | ${statusTag}`);
    });

    console.log('\n  [EVIDENCE CONCLUSION]');
    if (anyDifference) {
      console.log('    ⚠ STALENESS DETECTED: Quota data updated between Query 1 and Query 2! The LSP was killed too early during backend sync.');
    } else {
      console.log('    ✓ NO EARLY-KILL STALENESS: Data remained identical across the 5s window. Initial response was already settled.');
    }
  }

  console.log('\n  [FULL RAW JSON RESPONSE — QUERY 1]');
  console.log(body1 || '(empty)');
  if (body2) {
    console.log('\n  [FULL RAW JSON RESPONSE — QUERY 2 (+5s)]');
    console.log(body2 || '(empty)');
  }
  console.log('='.repeat(80) + '\n');
}

// ── IPC Handlers ──────────────────────────────────────────────────────────

// Load accounts — returns the live in-memory array (no disk read needed after init)
ipcMain.handle('load-accounts', async () => {
  return getAccounts();
});

// Save accounts array to disk & sync authoritative in-memory store
ipcMain.handle('save-accounts', async (event, accounts) => {
  if (Array.isArray(accounts)) {
    const mainAccounts = getAccounts();
    mainAccounts.length = 0;
    accounts.forEach(a => mainAccounts.push(a));
    markAccountsDirty();
  }
  return saveAccountsToDisk(accounts);
});

let detectScanInFlightPromise = null;

/**
 * 'detect-running-accounts' — Scan for all active Language Server processes and return
 * candidate accounts along with duplicate registration status.
 */
ipcMain.handle('detect-running-accounts', async () => {
  if (detectScanInFlightPromise) {
    logger.debug('[Lune detect-running-accounts] Reusing in-flight scan');
    return detectScanInFlightPromise;
  }

  detectScanInFlightPromise = (async () => {
    const t0 = Date.now();
    const rawServers = (await ag.findAllActiveRunningLanguageServers()) || [];
    const tScan = Date.now() - t0;

    const tResolveStart = Date.now();
    const servers = await resolveAndDeduplicateServers(rawServers);
    const tResolve = Date.now() - tResolveStart;
    const tTotal = Date.now() - t0;

    logger.debug(`[SCAN TIMING] total: ${tTotal}ms | scan: ${tScan}ms | resolve: ${tResolve}ms | main-thread blocking: 0ms`);
    logger.debug(`[Lune detect-running-accounts] Found ${servers.length} running Language Server process(es)`);

    if (servers.length === 0) {
      return { ok: false, error: 'no-running-lsp', message: 'No running Antigravity IDE process found on your PC.' };
    }

    const existingAccounts = getAccounts();
    const candidates = [];
    const seenEmails = new Set();

    for (const srv of servers) {
      const email = srv.activeEmail || null;
      const name  = srv.lastParsedUserStatus?.name || null;
      const body  = srv.lastRawResponseBody || null;

      if (!email) continue;

      const emailLower = email.toLowerCase().trim();
      if (seenEmails.has(emailLower)) continue;
      seenEmails.add(emailLower);

      const isAlreadyRegistered = existingAccounts.some(a => (a.email || '').toLowerCase().trim() === emailLower);

      let accountObj = null;
      if (body) {
        try {
          const parsedBody = JSON.parse(body);
          const userStatus = parsedBody.userStatus || parsedBody;
          accountObj = buildAccountFromUserStatusHelper(userStatus, srv.userDataDir, existingAccounts.length + candidates.length);
        } catch (e) {
          console.warn(`[Lune detect-running-accounts] Exception building accountObj for PID ${srv.pid}:`, e.message);
        }
      }

      if (!accountObj) continue;

      candidates.push({
        pid: srv.pid,
        userDataDir: srv.userDataDir,
        email,
        name: name || accountObj.name || email,
        isAlreadyRegistered,
        accountObj,
      });
    }

    if (candidates.length === 0) {
      return { ok: false, error: 'not-logged-in', message: 'Running Antigravity IDE instance is not logged in to any account.' };
    }

    return { ok: true, candidates };
  })();

  try {
    return await detectScanInFlightPromise;
  } finally {
    detectScanInFlightPromise = null;
  }
});

// Helper for avatar colors
const AVATAR_PALETTE = ['#1A4038', '#142040', '#3D2010', '#3D1212', '#2A1B40', '#1B3D38', '#382E1B', '#143840'];

function deriveInitialsHelper(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

function findPrimaryModelHelper(poolName, models) {
  if (!models || models.length === 0) return null;
  if (/gemini/i.test(poolName)) {
    return models.find(m => /2\.0 flash/i.test(m.name)) ||
           models.find(m => /1\.5 pro/i.test(m.name)) ||
           models.find(m => /2\.0 pro/i.test(m.name)) ||
           models[0];
  } else {
    return models.find(m => /3\.5 sonnet/i.test(m.name)) ||
           models.find(m => /sonnet/i.test(m.name)) ||
           models.find(m => /gpt-4o/i.test(m.name)) ||
           models[0];
  }
}

function formatResetTimeHelper(rt) {
  if (!rt) return 'N/A';
  try {
    const d = new Date(rt);
    if (isNaN(d.getTime())) return String(rt);
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return 'Resetting...';
    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHrs / 24);
    const remHrs = diffHrs % 24;
    if (diffDays > 0) return `${diffDays}d ${remHrs}h`;
    return `${diffHrs}h`;
  } catch (e) {
    return String(rt);
  }
}

function buildPoolFromGroupHelper(poolName, models) {
  if (!models || models.length === 0) {
    return {
      name: poolName,
      remainingFraction: 0,
      resetTime: null,
      resetIn: 'N/A',
      models: [],
      hasDiscrepancy: false,
      discrepancyDetails: null
    };
  }
  const rep = findPrimaryModelHelper(poolName, models) || models[0];
  return {
    name: poolName,
    remainingFraction: rep.fraction ?? 1.0,
    resetTime: rep.resetTime || null,
    resetIn: formatResetTimeHelper(rep.resetTime),
    primaryModelName: rep.name,
    fiveHourRemainingFraction: rep.fiveHourRemainingFraction ?? null,
    fiveHourResetTime: rep.fiveHourResetTime || null,
    fiveHourResetIn: formatResetTimeHelper(rep.fiveHourResetTime),
    models: models,
    hasDiscrepancy: false,
    discrepancyDetails: null
  };
}

/**
 * Single source of truth for overall account quota percentage in main process.
 * Blended / average availability across all valid model pools (OPTION A).
 * Formula: round((sum of valid pool remainingFraction / number of valid pools) * 100)
 */
function calculateOverallQuota(account) {
  if (!account || !Array.isArray(account.pools) || account.pools.length === 0) {
    return (account && typeof account.quotaPercent === 'number') ? account.quotaPercent : null;
  }

  const validPools = account.pools.filter(
    pool => pool && typeof pool.remainingFraction === 'number' && !isNaN(pool.remainingFraction)
  );

  if (validPools.length === 0) {
    return (account && typeof account.quotaPercent === 'number') ? account.quotaPercent : null;
  }

  const sum = validPools.reduce((accSum, pool) => accSum + pool.remainingFraction, 0);
  return Math.round((sum / validPools.length) * 100);
}

function buildAccountFromUserStatusHelper(userStatus, profilePath, existingAccountsCount = 0) {
  let userObj = userStatus.user || userStatus.userInfo || userStatus;
  let name = userObj.name || userObj.displayName || userObj.fullName || userStatus.name || null;
  let email = userObj.email || userObj.emailAddress || userStatus.email || null;

  const planStatus = userStatus.planStatus || {};
  const planInfo = planStatus.planInfo || {};
  const userTier = userStatus.userTier || {};

  const planName = planInfo.planName || null;
  const teamsTier = planInfo.teamsTier || null;
  const userTierName = userTier.name || null;

  const availPrompt = planStatus.availablePromptCredits;
  const monthlyPrompt = planInfo.monthlyPromptCredits;
  const promptCredits = (availPrompt !== undefined || monthlyPrompt !== undefined) ? {
    available: availPrompt !== undefined ? availPrompt : null,
    monthly: monthlyPrompt !== undefined ? monthlyPrompt : null,
  } : null;

  const availFlow = planStatus.availableFlowCredits;
  const monthlyFlow = planInfo.monthlyFlowCredits;
  const flowCredits = (availFlow !== undefined || monthlyFlow !== undefined) ? {
    available: availFlow !== undefined ? availFlow : null,
    monthly: monthlyFlow !== undefined ? monthlyFlow : null,
  } : null;

  let maxTokens = 16384;
  const rawTokens = planInfo.maxNumChatInputTokens;
  if (rawTokens) maxTokens = parseInt(rawTokens, 10) || 16384;

  const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs;
  let modelQuotas = [];
  if (Array.isArray(clientConfigs)) {
    modelQuotas = clientConfigs.map(cfg => {
      const q = cfg.quotaInfo || {};
      return {
        label: cfg.label || cfg.modelName || cfg.name || 'Unknown Model',
        remainingFraction: q.remainingFraction !== undefined ? q.remainingFraction : null,
        resetTime: q.resetTime || null,
        fiveHourRemainingFraction: q.fiveHourRemainingFraction ?? q.shortTermRemainingFraction ?? null,
        fiveHourResetTime: q.fiveHourResetTime || q.shortTermResetTime || null,
        rawQuotaInfo: q,
      };
    });
  }

  const initials = deriveInitialsHelper(name || email || 'Account');
  const avatarBg = AVATAR_PALETTE[existingAccountsCount % AVATAR_PALETTE.length];

  const newAccount = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    rank: existingAccountsCount + 1,
    name: name || email || 'New Account',
    email: email || '',
    initials,
    avatarBg,
    profilePath: profilePath,
    userDataDir: profilePath,
    isReal: true,
    plan: userTierName || planName || teamsTier || 'Google AI Pro',
    userTierName,
    planName,
    teamsTier,
    lastSync: Date.now(),
    lastSyncedAt: Date.now(),
    previousSnapshot: null,
    promptCredits,
    flowCredits,
    modelQuotas,
    stats: {
      promptCredits: { rem: promptCredits?.available ?? 0, tot: promptCredits?.monthly ?? 0 },
      flowCredits: { rem: flowCredits?.available ?? 0, tot: flowCredits?.monthly ?? 0 },
      maxInputTokens: maxTokens,
    },
    pools: [],
    authenticated: true,
    status: 'active',
    refreshError: null
  };

  const geminiModels = [];
  const claudeGptModels = [];
  modelQuotas.forEach(m => {
    const label = m.label || m.name || 'Unknown Model';
    const item = {
      name: label,
      tag: m.tagTitle || (m.remainingFraction !== null && m.remainingFraction > 0.8 ? 'FAST' : null),
      fraction: m.remainingFraction ?? 0,
      resetTime: m.resetTime,
      fiveHourRemainingFraction: m.fiveHourRemainingFraction ?? null,
      fiveHourResetTime: m.fiveHourResetTime || null,
    };
    if (/gemini/i.test(label)) {
      geminiModels.push(item);
    } else {
      claudeGptModels.push(item);
    }
  });

  newAccount.pools = [
    buildPoolFromGroupHelper('Gemini Models', geminiModels),
    buildPoolFromGroupHelper('Claude and GPT models', claudeGptModels)
  ];

  newAccount.quotaPercent = calculateOverallQuota(newAccount);

  return newAccount;
}

/**
 * 'save-imported-account' — Persists a candidate account object selected by the user to accounts.json.
 */
ipcMain.handle('save-imported-account', async (event, accountObj) => {
  if (!accountObj || !accountObj.email) {
    return { ok: false, error: 'invalid-account', message: 'Invalid account object provided.' };
  }
  const accounts = getAccounts();
  const emailLower = (accountObj.email || '').toLowerCase().trim();
  if (emailLower && accounts.some(a => (a.email || '').toLowerCase().trim() === emailLower)) {
    return { ok: false, error: 'duplicate-account', message: `Account '${accountObj.email}' is already registered in Lune.` };
  }
  accounts.push(accountObj);
  markAccountsDirty();
  const saveRes = persistIfDirty();
  if (!saveRes.ok) {
    accounts.splice(accounts.indexOf(accountObj), 1);
    return { ok: false, error: saveRes.error || 'save-failed', message: 'Failed to save account to disk.' };
  }
  return { ok: true, account: accountObj };
});

// Proof-of-concept ping handler; kept for debug comparison.
ipcMain.handle('ping', async () => {
  return 'pong from main process';
});

/**
 * 'launch-account' — launch visible, interactive Antigravity IDE window for a profile.
 */
ipcMain.handle('launch-account', async (event, { profilePath }) => {
  try {
    const pPath = profilePath;
    if (!pPath) return { ok: false, error: 'No profilePath provided' };
    const res = ag.spawnVisible(pPath);
    return { ok: true, pid: res.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 'refresh-account' — full hidden-desktop refresh cycle for one authenticated profile.
 */
ipcMain.handle('refresh-account', async (event, { profilePath, accountId }) => {
  if (!profilePath) {
    return { authenticated: false, error: 'No profilePath provided' };
  }
  const send = (stage) => event.sender.send('refresh-status', { accountId, stage });

  send('auth-check');
  let authResult;
  try {
    authResult = ag.detectAuthState(profilePath);
  } catch (err) {
    return { authenticated: false, error: 'detectAuthState threw: ' + err.message };
  }
  if (!authResult.isAuthenticated) {
    return { authenticated: false };
  }

  let queryResponse = null;
  try {
    logger.debug(`[Lune refresh-account] Checking for already-running instance matching userDataDir=${profilePath}...`);
    const existingLsp = await ag.findRunningLanguageServerForProfile(profilePath);
    if (existingLsp) {
      logger.debug(`[Lune refresh-account] Found matching running instance for userDataDir=${profilePath} at PID ${existingLsp.pid}`);
      const ports = await ag.findListeningPorts(existingLsp.pid);
      const csrfToken = ag.getCsrfToken(existingLsp.commandLine, profilePath);
      logger.debug(`[Lune refresh-account] Existing instance candidate listening ports: [${ports.join(', ')}]`);
      if (ports.length > 0 && csrfToken) {
        send('querying');
        for (const port of ports) {
          logger.debug(`[Lune refresh-account] Trying candidate port ${port} (candidate ports: [${ports.join(', ')}])...`);
          const res = await ag.queryUserStatus(port, csrfToken);
          if (res.ok) {
            queryResponse = res;
            logger.debug(`[Lune refresh-account] Direct Query SUCCEEDED on TCP port ${port}! (${res.durationMs} ms)`);
            break;
          }
        }
      }
    } else {
      logger.debug(`[Lune refresh-account] No matching running instance found for userDataDir=${profilePath}, spawning fresh.`);
    }
  } catch (e) {
    logger.info('[Lune refresh-account] Direct query on existing process skipped:', e.message);
  }

  if (!queryResponse) {
    // ── 2. Spawn on hidden desktop ──────────────────────────────────────────
    send('launching');
    let spawnResult;
    try {
      spawnResult = ag.spawnHidden(profilePath);
    } catch (err) {
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'spawn failed: ' + err.message };
    }

    const { pid, hProcess, hDesktop } = spawnResult;

    // ── 3. Wait for Language Server ────────────────────────────────────────
    let lspProc;
    try {
      send('waiting-lsp');
      lspProc = await ag.waitForLanguageServer(pid, 90_000, 300, profilePath);
      if (!lspProc) {
        throw new Error('LSP did not appear within 90 s timeout');
      }
    } catch (err) {
      // Cleanup before returning
      try { await ag.killProcessTree(pid, profilePath); } catch (_) {}
      try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
      send('cleanup');
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'lsp-timeout: ' + err.message };
    }

    // ── 4. Find ports & CSRF token, then query GetUserStatus ────────────────
    send('querying');
    try {
      const ports = await ag.findListeningPorts(lspProc.pid);
      const csrfToken = ag.getCsrfToken(lspProc.commandLine, profilePath);

      logger.debug(`[Lune main.js] Hidden desktop LSP PID ${lspProc.pid} detected. Candidate listening ports: [${ports.join(', ')}]`);

      if (!ports.length) {
        throw new Error('no LISTENING ports found for LSP pid ' + lspProc.pid);
      }
      if (!csrfToken) {
        throw new Error('CSRF token not found in commandline or logs');
      }

      // Try each port; use first successful response
      let usedPort = null;
      let lastErr = null;
      for (const port of ports) {
        logger.debug(`[Lune main.js] Trying candidate listening port ${port} (candidate ports: [${ports.join(', ')}])...`);
        const res = await ag.queryUserStatus(port, csrfToken);
        if (res.ok) {
          queryResponse = res;
          usedPort = port;
          logger.debug(`[Lune main.js] Hidden Desktop Query SUCCEEDED on TCP port ${port}! (${res.durationMs} ms)`);
          break;
        }
        lastErr = res.error;
      }
      if (!queryResponse) {
        throw new Error('queryUserStatus failed on all candidate ports [' + ports.join(', ') + ']: ' + lastErr);
      }
    } catch (err) {
      // Cleanup before returning
      try { await ag.killProcessTree(pid, profilePath); } catch (_) {}
      try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
      send('cleanup');
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'query failed: ' + err.message };
    }

    // ── 5. Cleanup ──────────────────────────────────────────────────────────
    send('cleanup');
    try { await ag.killProcessTree(pid, profilePath); } catch (_) {}
    try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
  }

  // ── 6. Done — return real API payload to renderer ──────────────────────
  send('done');

  logger.debug('[Lune main.js] GetUserStatus RAW JSON body:\n' + queryResponse?.body);

  let name = null;
  let email = null;
  let planName = null;
  let teamsTier = null;
  let userTierName = null;
  let promptCredits = null;
  let flowCredits = null;
  let modelQuotas = [];

  if (queryResponse.body) {
    try {
      const parsedBody = JSON.parse(queryResponse.body);
      const userStatus = parsedBody.userStatus || parsedBody;
      const userObj = userStatus.user || userStatus.userInfo || userStatus;

      name = userObj.name || userObj.displayName || userObj.fullName || userStatus.name || null;
      email = userObj.email || userObj.emailAddress || userStatus.email || null;

      const planStatus = userStatus.planStatus || {};
      const planInfo = planStatus.planInfo || {};
      const userTier = userStatus.userTier || {};

      planName = planInfo.planName || null;
      teamsTier = planInfo.teamsTier || null;
      userTierName = userTier.name || null;

      const availPrompt = planStatus.availablePromptCredits;
      const monthlyPrompt = planInfo.monthlyPromptCredits;
      if (availPrompt !== undefined || monthlyPrompt !== undefined) {
        promptCredits = {
          available: availPrompt !== undefined ? availPrompt : null,
          monthly: monthlyPrompt !== undefined ? monthlyPrompt : null,
        };
      }
      const availFlow = planStatus.availableFlowCredits;
      const monthlyFlow = planInfo.monthlyFlowCredits;
      if (availFlow !== undefined || monthlyFlow !== undefined) {
        flowCredits = {
          available: availFlow !== undefined ? availFlow : null,
          monthly: monthlyFlow !== undefined ? monthlyFlow : null,
        };
      }

      const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs;
      if (Array.isArray(clientConfigs)) {
        modelQuotas = clientConfigs.map(cfg => {
          const q = cfg.quotaInfo || {};
          return {
            label: cfg.label || cfg.modelName || cfg.name || 'Unknown Model',
            remainingFraction: q.remainingFraction !== undefined ? q.remainingFraction : null,
            resetTime: q.resetTime || null,
            fiveHourRemainingFraction: q.fiveHourRemainingFraction !== undefined ? q.fiveHourRemainingFraction : (q.shortTermRemainingFraction !== undefined ? q.shortTermRemainingFraction : null),
            fiveHourResetTime: q.fiveHourResetTime || q.shortTermResetTime || null,
            rawQuotaInfo: q,
          };
        });
      }
    } catch (e) {
      console.warn('[Lune main.js] Failed to parse queryResponse.body:', e.message);
    }
  }

  // â”€â”€ Part 6: Check for wrong account active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Look up ONLY by accountId â€” NOT by profilePath â€” to avoid cross-account contamination
  // when multiple accounts share the same profilePath (single-install setups).
  const existingAccounts = getAccounts();
  const targetAcc = existingAccounts.find(a => a.id === accountId);
  if (targetAcc && targetAcc.email && email) {
    const targetEmailLower = targetAcc.email.toLowerCase().trim();
    const respEmailLower = email.toLowerCase().trim();
    if (targetEmailLower !== respEmailLower) {
      console.warn(`[Lune refresh-account] Wrong account active for profile ${profilePath}: expected '${targetAcc.email}', got '${email}'`);
      return {
        authenticated: true,
        ok: false,
        status: 'wrong-account-active',
        error: 'wrong-account-active',
        activeEmail: email,
        expectedEmail: targetAcc.email,
        message: 'Currently signed in with a different account â€” switch or launch this account\'s own window to refresh.'
      };
    }
  }

  return {
    authenticated: true,
    ok: queryResponse.ok,
    status: queryResponse.status,
    lastSyncSource: 'manual',
    name,
    email,
    planName,
    teamsTier,
    userTierName,
    promptCredits,
    flowCredits,
    modelQuotas,
    raw: queryResponse.body,
    body: queryResponse.body,
    durationMs: queryResponse.durationMs,
  };
});

// â”€â”€ Shared User Status Parsers & Updaters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseUserStatusBody(body) {
  if (!body) return {};
  try {
    const parsedBody = JSON.parse(body);
    const userStatus = parsedBody.userStatus || parsedBody;
    const userObj = userStatus.user || userStatus.userInfo || userStatus;

    const name = userObj.name || userObj.displayName || userObj.fullName || userStatus.name || null;
    const email = userObj.email || userObj.emailAddress || userStatus.email || null;

    const planStatus = userStatus.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const userTier = userStatus.userTier || {};

    const planName = planInfo.planName || null;
    const teamsTier = planInfo.teamsTier || null;
    const userTierName = userTier.name || null;

    const availPrompt = planStatus.availablePromptCredits;
    const monthlyPrompt = planInfo.monthlyPromptCredits;
    const promptCredits = (availPrompt !== undefined || monthlyPrompt !== undefined) ? {
      available: availPrompt !== undefined ? availPrompt : null,
      monthly: monthlyPrompt !== undefined ? monthlyPrompt : null,
    } : null;

    const availFlow = planStatus.availableFlowCredits;
    const monthlyFlow = planInfo.monthlyFlowCredits;
    const flowCredits = (availFlow !== undefined || monthlyFlow !== undefined) ? {
      available: availFlow !== undefined ? availFlow : null,
      monthly: monthlyFlow !== undefined ? monthlyFlow : null,
    } : null;

    const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs;
    let modelQuotas = [];
    if (Array.isArray(clientConfigs)) {
      modelQuotas = clientConfigs.map(cfg => {
        const q = cfg.quotaInfo || {};
        return {
          label: cfg.label || cfg.modelName || cfg.name || 'Unknown Model',
          remainingFraction: q.remainingFraction !== undefined ? q.remainingFraction : null,
          resetTime: q.resetTime || null,
          fiveHourRemainingFraction: q.fiveHourRemainingFraction ?? q.shortTermRemainingFraction ?? null,
          fiveHourResetTime: q.fiveHourResetTime || q.shortTermResetTime || null,
          rawQuotaInfo: q,
        };
      });
    }

    return {
      name,
      email,
      planName,
      teamsTier,
      userTierName,
      promptCredits,
      flowCredits,
      modelQuotas,
    };
  } catch (e) {
    return {};
  }
}

function updateAccountFromUserStatus(acc, parsed) {
  if (!acc || !parsed) return;
  if (parsed.name) acc.name = parsed.name;
  if (parsed.email && (!acc.email || acc.email.toLowerCase().trim() === parsed.email.toLowerCase().trim())) {
    acc.email = parsed.email;
  }
  acc.planName = parsed.planName || acc.planName || null;
  acc.teamsTier = parsed.teamsTier || acc.teamsTier || null;
  acc.userTierName = parsed.userTierName || acc.userTierName || null;
  acc.plan = parsed.userTierName || parsed.planName || parsed.teamsTier || acc.plan || 'Google AI Pro';

  acc.lastSyncedAt = Date.now();
  acc.lastSync = Date.now();
  acc.promptCredits = parsed.promptCredits || acc.promptCredits || null;
  acc.flowCredits = parsed.flowCredits || acc.flowCredits || null;
  if (parsed.modelQuotas && parsed.modelQuotas.length > 0) {
    acc.modelQuotas = parsed.modelQuotas;
    const geminiModels = [];
    const claudeGptModels = [];
    parsed.modelQuotas.forEach(m => {
      const label = m.label || 'Unknown Model';
      const item = {
        name: label,
        tag: m.remainingFraction !== null && m.remainingFraction > 0.8 ? 'FAST' : null,
        fraction: m.remainingFraction ?? 0,
        resetTime: m.resetTime,
        fiveHourRemainingFraction: m.fiveHourRemainingFraction ?? null,
        fiveHourResetTime: m.fiveHourResetTime || null,
      };
      if (/gemini/i.test(label)) geminiModels.push(item);
      else claudeGptModels.push(item);
    });

    acc.pools = [
      buildPoolFromGroupHelper('Gemini Models', geminiModels),
      buildPoolFromGroupHelper('Claude and GPT models', claudeGptModels)
    ];

    acc.quotaPercent = calculateOverallQuota(acc);
  }
}

/**
 * Bulk Refresh Helper â€” Tries running LSP direct queries first (Part 2), then falls back to hidden desktop spawn.
 * Emits refresh-all-card-status start/done events per card for visual glow animation (Part 7).
 * Updates lastSync ONLY on confirmed success for that specific account (Part 8).
 */
async function refreshAllAccountsHelper() {
  logger.debug('[Lune main.js] Starting bulk refresh for all registered accounts...');
  const accounts = getAccounts(); // use shared authoritative array
  if (!accounts || accounts.length === 0) return [];

  // Step 1: Scan active running LSPs system-wide and resolve/deduplicate by identity
  const rawServers = ag.findAllActiveRunningLanguageServers() || [];
  const servers = await resolveAndDeduplicateServers(rawServers);

  const matchMap = ag.matchAccountToRunningProcess(servers, accounts);

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const profilePath = acc.profilePath || acc.userDataDir;
    if (!profilePath || !fs.existsSync(profilePath)) continue;

    // Send card start event (Part 7)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('refresh-all-card-status', { accountId: acc.id, status: 'start' });
    }

    let refreshedOk = false;
    const lspMatch = matchMap.get(acc);

    if (lspMatch && lspMatch.ports && lspMatch.ports.length > 0 && lspMatch.csrfToken) {
      logger.debug(`[Lune refresh-all] Account ${acc.name} matched running process (PID ${lspMatch.pid}). Trying direct query...`);
      for (const port of lspMatch.ports) {
        const res = await ag.queryUserStatus(port, lspMatch.csrfToken);
        if (res.ok && res.body) {
          try {
            const parsed = parseUserStatusBody(res.body);
            if (parsed.email && acc.email && parsed.email.toLowerCase().trim() !== acc.email.toLowerCase().trim()) {
              console.warn(`[Lune refresh-all] Email mismatch for running process on ${acc.name}: expected ${acc.email}, got ${parsed.email}`);
              break; // Skip direct match on email mismatch
            }
            updateAccountFromUserStatus(acc, parsed);
            acc.lastSync = Date.now(); // Part 8: lastSync updated ONLY on confirmed success
            acc.lastSyncSource = 'manual';
            acc.authenticated = true;
            acc.status = 'active';
            acc.unreachable = false;
            refreshedOk = true;
            logger.debug(`[Lune refresh-all] Direct refresh SUCCEEDED for ${acc.name}`);
          } catch (e) {
            console.warn(`[Lune refresh-all] Error parsing direct status for ${acc.name}:`, e.message);
          }
          break;
        }
      }
    }

    // Fall back to hidden desktop spawn if direct query was not applicable or failed
    if (!refreshedOk) {
      logger.debug(`[Lune refresh-all] No running match for ${acc.name}, spawning hidden desktop...`);
      try {
        const authResult = ag.detectAuthState(profilePath);
        if (!authResult.isAuthenticated) {
          acc.authenticated = false;
          acc.status = 'auth_required';
        } else {
          const spawnResult = ag.spawnHidden(profilePath, { desktopName: `LuneRefresh_${Date.now()}` });
          const { pid, hProcess, hDesktop } = spawnResult;
          const lspProc = await ag.waitForLanguageServer(pid, 60_000, 300, profilePath);

          if (lspProc) {
            const ports = ag.findListeningPorts(lspProc.pid);
            const csrfToken = ag.getCsrfToken(lspProc.commandLine, profilePath);

            if (ports.length > 0 && csrfToken) {
              for (const port of ports) {
                const res = await ag.queryUserStatus(port, csrfToken);
                if (res.ok && res.body) {
                  try {
                    const parsed = parseUserStatusBody(res.body);
                    if (!parsed.email || !acc.email || parsed.email.toLowerCase().trim() === acc.email.toLowerCase().trim()) {
                      updateAccountFromUserStatus(acc, parsed);
                      acc.lastSync = Date.now(); // Part 8: lastSync updated ONLY on confirmed success
                      acc.lastSyncSource = 'manual';
                      acc.authenticated = true;
                      acc.status = 'active';
                      acc.unreachable = false;
                      refreshedOk = true;
                    }
                  } catch (_) {}
                  break;
                }
              }
            }
          }
          try { await ag.killProcessTree(pid, profilePath); } catch (_) {}
          try { if (hDesktop) ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
        }
      } catch (err) {
        console.warn(`[Lune main.js] Error during bulk refresh spawn for ${acc.name}:`, err.message);
      }
    }

    if (!refreshedOk) {
      // Part 9: No match found and no spawn succeeded â€” leave all existing data EXACTLY as-is.
      // Setting unreachable here would overwrite last-known real values; instead we simply skip.
      // The renderer already knows this account wasn't refreshed because no IPC event is emitted for it.
      logger.debug(`[Lune refresh-all] No successful refresh for ${acc.name} — leaving last known data untouched.`);
    }

    // Send card done event (Part 7)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('refresh-all-card-status', { accountId: acc.id, status: 'done' });
    }
  }

  markAccountsDirty();
  persistIfDirty();
  return accounts;
}

// â”€â”€ Live Background Watcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const lastWatcherQueryMs = new Map();
const watcherInFlightAccounts = new Set();
const WATCHER_QUERY_INTERVAL_MS = 5000;

// Track which account IDs currently have a confirmed running matched process.
// Only emit 'account-online-status' IPC when the state FLIPS to avoid redundant renderer updates.
const watcherOnlineAccountIds = new Set();

// Guard: prevent overlapping watcher ticks.
// setInterval fires every 9s regardless of whether the previous async tick completed.
// Concurrent ticks both mutate watcherOnlineAccountIds, causing brief "wrong account Live" flashes.
let watcherRunning = false;
let lastSyncedActiveIdsKey = null;

async function runLiveWatcher() {
  if (watcherRunning) {
    logger.debug('[Lune watcher] Previous tick still in-flight — skipping this tick.');
    return;
  }
  watcherRunning = true;
  let servers = [];
  try {
    const t0 = Date.now();
    const accounts = getAccounts();
    const rawServers = (await ag.findAllActiveRunningLanguageServers()) || [];
    const tScan = Date.now() - t0;

    const tResolveStart = Date.now();
    servers = await resolveAndDeduplicateServers(rawServers);
    const tResolve = Date.now() - tResolveStart;
    const tTotal = Date.now() - t0;

    logger.debug(`[PERF] watcher: ${tTotal}ms | scan: ${tScan}ms | resolve: ${tResolve}ms`);

    if (!accounts || accounts.length === 0) {
      for (const id of Array.from(watcherOnlineAccountIds)) {
        watcherOnlineAccountIds.delete(id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: false });
        }
      }
      return;
    }

    if (servers.length === 0) {
      for (const id of Array.from(watcherOnlineAccountIds)) {
        watcherOnlineAccountIds.delete(id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: false });
        }
      }
      return;
    }

    const matchMap = ag.matchAccountToRunningProcess(servers, accounts);
    logger.debug(`[Lune watcher] tick — ${servers.length} server(s), ${accounts.length} saved account(s)`);

    const currentOnlineAccountIds = new Set();
    const seenActiveEmails = new Set();

    for (const acc of accounts) {
      const lsp = matchMap ? matchMap.get(acc) : null;
      const isOnline = !!(lsp && lsp.ports && lsp.ports.length > 0 && lsp.csrfToken &&
                        acc.email && lsp.activeEmail && acc.email.toLowerCase().trim() === lsp.activeEmail.toLowerCase().trim());
      if (isOnline) {
        const normEmail = acc.email.toLowerCase().trim();
        if (!seenActiveEmails.has(normEmail)) {
          seenActiveEmails.add(normEmail);
          currentOnlineAccountIds.add(acc.id);
        }
      }
    }

    // Step A: Send OFFLINE events FIRST
    for (const id of Array.from(watcherOnlineAccountIds)) {
      if (!currentOnlineAccountIds.has(id)) {
        watcherOnlineAccountIds.delete(id);
        lastWatcherQueryMs.delete(id);
        const offlineAcc = accounts.find(a => a.id === id);
        logger.debug(`[Lune watcher] OFFLINE: ${offlineAcc?.email || id} (id=${id}) — no longer matched on any running process this tick.`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: false });
        }
      }
    }

    // Step B: Send ONLINE events SECOND
    for (const id of currentOnlineAccountIds) {
      if (!watcherOnlineAccountIds.has(id)) {
        watcherOnlineAccountIds.add(id);
        const onlineAcc = accounts.find(a => a.id === id);
        logger.debug(`[Lune watcher] ONLINE: ${onlineAcc?.email || id} (id=${id}) — matched on a running process this tick.`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: true });
        }
      }
    }

    for (const acc of accounts) {
      const lsp = matchMap.get(acc);
      if (!lsp || !lsp.ports || lsp.ports.length === 0 || !lsp.csrfToken) continue;
      if (watcherInFlightAccounts.has(acc.id)) continue;

      const lastQuery = lastWatcherQueryMs.get(acc.id) || 0;
      if (Date.now() - lastQuery < WATCHER_QUERY_INTERVAL_MS) continue;

      lastWatcherQueryMs.set(acc.id, Date.now());

      let parsed = lsp.lastParsedUserStatus;
      let body = lsp.lastRawResponseBody;

      if (!parsed || !parsed.email) {
        for (const port of lsp.ports) {
          watcherInFlightAccounts.add(acc.id);
          try {
            const res = await ag.queryUserStatus(port, lsp.csrfToken);
            if (res.ok && res.body) {
              try {
                parsed = parseUserStatusBody(res.body);
                body = res.body;
                if (parsed && parsed.email) {
                  lsp.lastParsedUserStatus = parsed;
                  lsp.lastRawResponseBody  = body;
                  lsp.activeEmail          = parsed.email;
                }
              } catch (_) {}
              break;
            }
          } finally {
            watcherInFlightAccounts.delete(acc.id);
          }
        }
      }

      if (parsed && parsed.email) {
        if (acc.email && parsed.email.toLowerCase().trim() !== acc.email.toLowerCase().trim()) {
          continue;
        }

        updateAccountFromUserStatus(acc, parsed);
        acc.lastSync = Date.now();
        acc.lastSyncedAt = Date.now();
        acc.lastSyncSource = 'auto';
        acc.authenticated = true;
        acc.status = 'active';
        markAccountsDirty();
        persistIfDirty();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('live-account-update', {
            accountId: acc.id,
            authenticated: true,
            ok: true,
            lastSyncSource: 'auto',
            lastSyncedAt: acc.lastSyncedAt,
            name: parsed.name,
            email: parsed.email,
            planName: parsed.planName,
            teamsTier: parsed.teamsTier,
            userTierName: parsed.userTierName,
            promptCredits: parsed.promptCredits,
            flowCredits: parsed.flowCredits,
            modelQuotas: parsed.modelQuotas,
            body: body,
          });
        }
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      const activeIds = Array.from(currentOnlineAccountIds);
      const activeEmails = activeIds.map(id => accounts.find(a => a.id === id)?.email).filter(Boolean);
      const key = activeIds.sort().join(',') + '|' + activeEmails.sort().join(',');
      if (key !== lastSyncedActiveIdsKey) {
        lastSyncedActiveIdsKey = key;
        mainWindow.webContents.send('account-online-status-sync', { activeAccountIds: activeIds, activeEmails });
      }
    }
  } catch (err) {
    logger.warn('[Lune watcher] Tick error:', err.message);
  } finally {
    watcherRunning = false;
  }
}

// runNewAccountDetector() removed — new account detection is now explicit-only
// via the "Import Active Account" button in the Add Account modal.


ipcMain.handle('refresh-all-accounts', async () => {
  return refreshAllAccountsHelper();
});

ipcMain.handle('remove-account', async (event, { accountId }) => {
  const accounts = getAccounts();
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx === -1) {
    console.warn(`[Lune remove-account] Account id=${accountId} not found in live array — may already be deleted.`);
    return { ok: true }; // idempotent
  }
  const removed = accounts.splice(idx, 1)[0];
  logger.debug(`[Lune remove-account] Removed ${removed.email || accountId} from in-memory array. Persisting immediately.`);
  // Mark dirty and persist synchronously BEFORE returning to the renderer
  // so the authoritative array and disk are both updated in the same microtask.
  // The watcher's next tick will read getAccounts() which already has the deletion.
  markAccountsDirty();
  persistIfDirty();
  // Clean up watcher state for this account so it doesn't linger as "online"
  lastWatcherQueryMs.delete(accountId);
  watcherOnlineAccountIds.delete(accountId);
  return { ok: true };
});

// ── Window factory ──────────────────────────────────────────────────────────
function createWindow() {
  const iconFileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(__dirname, 'build', iconFileName);
  let appIcon = null;
  try {
    if (fs.existsSync(iconPath)) {
      appIcon = nativeImage.createFromPath(iconPath);
    }
  } catch (_) {}

  const win = new BrowserWindow({
    title: 'Lune - Agent tracking dashboard',
    icon: appIcon && !appIcon.isEmpty() ? appIcon : iconPath,
    width: 1280,
    height: 800,
    minWidth: 900,
    backgroundColor: '#11131A',        // matches the dashboard body background
    show: false,                        // reveal only after content is ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,           // renderer has no access to Node APIs
      nodeIntegration: false,           // security: keep Node out of renderer
      sandbox: false,                   // preload needs require(); keep false
    },
  });

  if (appIcon && !appIcon.isEmpty()) {
    try { win.setIcon(appIcon); } catch (_) {}
  }

  win.removeMenu();
  Menu.setApplicationMenu(null);

  mainWindow = win;
  win.loadFile('index.html');

  // Instant scan on window focus (reuses watcherRunning guard inside runLiveWatcher)
  win.on('focus', () => {
    logger.debug('[Lune main.js] Window focused — triggering instant watcher scan');
    runLiveWatcher().catch(err => {
      console.warn('[Lune main.js] Focus watcher scan error:', err.message);
    });
  });

  // Show the window as soon as the page has finished painting to avoid flash.
  win.once('ready-to-show', () => win.show());
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.lune.app' : process.execPath);
  }

  // Initialise the single authoritative in-memory accounts array from disk.
  // From this point on, all code must use getAccounts() rather than loadAccountsFromDisk().
  reloadAccountsFromDisk();

  createWindow();

  // Live Background Watcher runs every 5 seconds (lightweight process-scan, no spawning)
  setInterval(() => {
    runLiveWatcher().catch(err => {
      console.warn('[Lune main.js] Live watcher error:', err.message);
    });
  }, 5000);

  // Schedule automatic 15-minute background refresh for all accounts
  const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    refreshAllAccountsHelper().catch(err => {
      console.warn('[Lune main.js] Background scheduled refresh error:', err.message);
    });
  }, REFRESH_INTERVAL_MS);

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS where it's conventional
// to keep the app running until the user explicitly quits with Cmd+Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
