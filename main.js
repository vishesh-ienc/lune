'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const ag   = require('./lib/antigravity');

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
      console.log(`[Lune main.js] Loaded ${parsed.length} persisted account(s) from ${filePath}`);
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
    console.log(`[Lune backup] Created accounts backup: ${backupFileName}`);

    const MAX_BACKUPS = 20;
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('accounts-') && f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const oldFile of toDelete) {
        try {
          fs.unlinkSync(path.join(backupDir, oldFile));
          console.log(`[Lune backup] Pruned old backup: ${oldFile}`);
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
    fs.writeFileSync(filePath, data, 'utf8');
    console.log(`[Lune main.js] Persisted ${clean.length} account(s) to ${filePath}`);
    return { ok: true };
  } catch (err) {
    console.error('[Lune main.js] Failed to save accounts.json:', err.message);
    return { ok: false, error: err.message };
  }
}

// â”€â”€ Shared Utility: Parse identity from raw GetUserStatus response body â”€â”€â”€â”€â”€â”€â”€

/**
 * Extracts { email, name } from a raw JSON string returned by GetUserStatus.
 * Returns { email: null, name: null } if parsing fails or no identity is found.
 */
function parseUserStatusBody(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const userStatus = parsed.userStatus || parsed;
    const userObj = userStatus.user || userStatus.userInfo || userStatus;
    const email = userObj.email || userObj.emailAddress || userStatus.email || null;
    const name  = userObj.name || userObj.displayName || userObj.fullName || userStatus.name || null;
    return { email, name };
  } catch (_) {
    return { email: null, name: null };
  }
}

/**
 * Resolves activeEmail for each running server in the list over HTTP.
 * Keeps all server processes that successfully respond with a valid activeEmail.
 * Deduplicates by activeEmail so each unique authenticated identity is tracked.
 *
 * NOTE (diagnostic): We intentionally do NOT skip the HTTP query based on a
 * previously-set server.activeEmail here. The only caching that happens is
 * within a single call (seenEmails dedup). Each tick gets a fresh query.
 */
async function resolveAndDeduplicateServers(servers) {
  if (!servers || !Array.isArray(servers) || servers.length === 0) return [];

  const resolvedServers = [];
  const seenEmails = new Set();

  for (const server of servers) {
    if (!server.ports || server.ports.length === 0 || !server.csrfToken) continue;

    // DIAGNOSTIC: always note whether this server already had a cached identity
    // from a previous tick (set by a prior resolveAndDeduplicateServers call).
    const hadCachedEmail = !!(server.activeEmail);

    let email = null;  // Always resolve fresh â€” never short-circuit on server.activeEmail
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
            console.log(`[Lune resolve-servers] PID ${server.pid} port ${port}: fresh query returned email=${email}` +
              (hadCachedEmail ? ` (was cached as ${server.activeEmail}${server.activeEmail !== email ? ' â€” IDENTITY CHANGED!' : ''})` : ' (no prior cache)'));
            break;
          }
        }
      } catch (err) {
        console.log(`[Lune resolve-servers] PID ${server.pid} port ${port}: query failed â€” ${err.message}`);
      }
    }

    if (!email) {
      console.log(`[Lune resolve-servers] PID ${server.pid}: no email resolved from any port [${server.ports.join(', ')}]` +
        (hadCachedEmail ? ` (had cached email=${server.activeEmail})` : ''));
    }

    if (email) {
      // Update cached identity on the object (used by watcher's live-update loop,
      // Update cached identity on the object (used by watcher's live-update loop).
      server.activeEmail = email;
      server.lastParsedUserStatus = parsed;
      server.lastRawResponseBody = body;

      const emailLower = email.toLowerCase().trim();
      if (!seenEmails.has(emailLower)) {
        seenEmails.add(emailLower);
        resolvedServers.push(server);
      } else {
        console.log(`[Lune resolve-servers] PID ${server.pid}: email ${emailLower} already seen this tick â€” deduped out.`);
      }
    }
  }

  return resolvedServers;
}

// â”€â”€ IPC Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Load accounts â€” returns the live in-memory array (no disk read needed after init)
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

  const maxFrac = newAccount.pools.length > 0 ? Math.max(...newAccount.pools.map(p => p.remainingFraction)) : 1.0;
  newAccount.quotaPercent = Math.round(maxFrac * 100);

  return newAccount;
}

/**
 * 'detect-running-accounts' â€” Scan for all active Language Server processes, query GetUserStatus for each independently,
 * and return candidate accounts along with duplicate registration status.
 */
ipcMain.handle('detect-running-accounts', async () => {
  const rawServers = ag.findAllActiveRunningLanguageServers() || [];
  const servers = await resolveAndDeduplicateServers(rawServers);
  console.log(`[Lune detect-running-accounts] Found ${servers.length} running Language Server process(es)`);

  if (servers.length === 0) {
    return { ok: false, error: 'no-running-lsp', message: 'No running Antigravity IDE process found on your PC.' };
  }

  const existingAccounts = getAccounts();
  const candidates = [];
  const seenEmails = new Set();

  for (const srv of servers) {
    if (!srv.ports || srv.ports.length === 0 || !srv.csrfToken) {
      console.warn(`[Lune detect-running-accounts] PID ${srv.pid} missing ports or csrfToken`);
      continue;
    }

    for (const port of srv.ports) {
      const res = await ag.queryUserStatus(port, srv.csrfToken);
      if (res.ok && res.body) {
        try {
          const parsedBody = JSON.parse(res.body);
          const userStatus = parsedBody.userStatus || parsedBody;
          const userObj = userStatus.user || userStatus.userInfo || userStatus;
          const name = userObj.name || userObj.displayName || userObj.fullName || userStatus.name || null;
          const email = userObj.email || userObj.emailAddress || userStatus.email || null;

          if (email || name) {
            const emailLower = (email || '').toLowerCase().trim();
            if (emailLower && seenEmails.has(emailLower)) {
              // Avoid duplicate entries in candidate list if multiple ports belong to same account
              break;
            }
            if (emailLower) seenEmails.add(emailLower);

            const isAlreadyRegistered = emailLower ? existingAccounts.some(a => (a.email || '').toLowerCase().trim() === emailLower) : false;

            // Build full account candidate object
            const accountObj = buildAccountFromUserStatusHelper(userStatus, srv.userDataDir, existingAccounts.length + candidates.length);

            candidates.push({
              pid: srv.pid,
              userDataDir: srv.userDataDir,
              email: email || '',
              name: name || email || 'Antigravity User',
              accountObj,
              isAlreadyRegistered,
            });
            break; // Stop testing other ports for this process
          }
        } catch (e) {
          console.warn(`[Lune detect-running-accounts] Exception parsing GetUserStatus from PID ${srv.pid} port ${port}:`, e.message);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, error: 'not-logged-in', message: 'Running Antigravity IDE instance is not logged in to any account.' };
  }

  return { ok: true, candidates };
});

/**
 * 'save-imported-account' â€” Persists a candidate account object selected by the user to accounts.json.
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
    // Roll back in-memory push on failure
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
 * 'launch-account' â€” launch visible, interactive Antigravity IDE window for a profile.
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
 * 'refresh-account' â€” full hidden-desktop refresh cycle for one authenticated profile.
 *
 * Renderer calls: ipcRenderer.invoke('refresh-account', { profilePath, accountId })
 * Progress events: ipcRenderer.on('refresh-status', (_, { accountId, stage }) => â€¦)
 *
 * Stage sequence (happy path):
 *   auth-check â†’ launching â†’ waiting-lsp â†’ querying â†’ cleanup â†’ done
 *
 * On auth-check failure: returns { authenticated: false }  (no spawn).
 * On any later failure:  returns { authenticated: true, error: '<what failed>' }
 *   Cleanup (killProcessTree / closeHiddenDesktop) still runs even on error
 *   so no orphan processes are left behind.
 */
ipcMain.handle('refresh-account', async (event, { profilePath, accountId }) => {
  if (!profilePath) {
    return { authenticated: false, error: 'No profilePath provided' };
  }
  const send = (stage) => event.sender.send('refresh-status', { accountId, stage });

  // â”€â”€ 1. Auth check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Diagnostic Logging Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      console.log(`    â€¢ ${m.label.padEnd(25)} | Fraction: ${String(m.fraction).padEnd(8)} | ResetTime: ${m.resetTime || 'N/A'}`);
      if (m.fiveHourResetTime || m.fiveHourFraction !== null) {
        console.log(`      â””â”€ 5h Window             | 5hFraction: ${String(m.fiveHourFraction).padEnd(6)} | 5hResetTime: ${m.fiveHourResetTime || 'N/A'}`);
      }
    });
  }

  if (body2) {
    console.log('\n  [QUERY 2 MODEL QUOTAS & RESET TIMES (t = +5s)]');
    if (models2.length === 0) {
      console.log('    (No models found in body 2)');
    } else {
      models2.forEach(m => {
        console.log(`    â€¢ ${m.label.padEnd(25)} | Fraction: ${String(m.fraction).padEnd(8)} | ResetTime: ${m.resetTime || 'N/A'}`);
        if (m.fiveHourResetTime || m.fiveHourFraction !== null) {
          console.log(`      â””â”€ 5h Window             | 5hFraction: ${String(m.fiveHourFraction).padEnd(6)} | 5hResetTime: ${m.fiveHourResetTime || 'N/A'}`);
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
      const statusTag = match ? 'âœ“ IDENTICAL (SETTLED)' : 'âœ– DIFFERENT (SYNCING IN PROGRESS!)';

      console.log(`    ${lbl.padEnd(25)} | Q1 (t=0s): ${f1Str.padEnd(7)} | Q2 (t=+5s): ${f2Str.padEnd(7)} | ${statusTag}`);
    });

    console.log('\n  [EVIDENCE CONCLUSION]');
    if (anyDifference) {
      console.log('    âš  STALENESS DETECTED: Quota data updated between Query 1 and Query 2! The LSP was killed too early during backend sync.');
    } else {
      console.log('    âœ“ NO EARLY-KILL STALENESS: Data remained identical across the 5s window. Initial response was already settled.');
    }
  }

  console.log('\n  [FULL RAW JSON RESPONSE â€” QUERY 1]');
  console.log(body1 || '(empty)');
  if (body2) {
    console.log('\n  [FULL RAW JSON RESPONSE â€” QUERY 2 (+5s)]');
    console.log(body2 || '(empty)');
  }
  console.log('='.repeat(80) + '\n');
}

  // â”€â”€ 1b. Direct query on already-running instance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let queryResponse = null;
  try {
    console.log(`[Lune refresh-account] Checking for already-running instance matching userDataDir=${profilePath}...`);
    const existingLsp = ag.findRunningLanguageServerForProfile(profilePath);
    if (existingLsp) {
      console.log(`[Lune refresh-account] Found matching running instance for userDataDir=${profilePath} at PID ${existingLsp.pid}`);
      const ports = ag.findListeningPorts(existingLsp.pid);
      const csrfToken = ag.getCsrfToken(existingLsp.commandLine, profilePath);
      console.log(`[Lune refresh-account] Existing instance candidate listening ports: [${ports.join(', ')}]`);
      if (ports.length > 0 && csrfToken) {
        send('querying');
        for (const port of ports) {
          console.log(`[Lune refresh-account] Trying candidate port ${port} (candidate ports: [${ports.join(', ')}])...`);
          const res = await ag.queryUserStatus(port, csrfToken);
          if (res.ok) {
            queryResponse = res;
            console.log(`[Lune refresh-account] Direct Query SUCCEEDED on TCP port ${port}! (${res.durationMs} ms)`);
            break;
          }
        }
      }
    } else {
      console.log(`[Lune refresh-account] No matching running instance found for userDataDir=${profilePath}, spawning fresh.`);
    }
  } catch (e) {
    console.info('[Lune refresh-account] Direct query on existing process skipped:', e.message);
  }

  if (!queryResponse) {
    // â”€â”€ 2. Spawn on hidden desktop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    send('launching');
    let spawnResult;
    try {
      spawnResult = ag.spawnHidden(profilePath);
    } catch (err) {
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'spawn failed: ' + err.message };
    }

    const { pid, hProcess, hDesktop } = spawnResult;

    // â”€â”€ 3. Wait for Language Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let lspProc;
    try {
      send('waiting-lsp');
      lspProc = await ag.waitForLanguageServer(pid, 90_000, 300, profilePath);
      if (!lspProc) {
        throw new Error('LSP did not appear within 90 s timeout');
      }
    } catch (err) {
      // Cleanup before returning
      try { ag.killProcessTree(pid, profilePath); } catch (_) {}
      try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
      send('cleanup');
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'lsp-timeout: ' + err.message };
    }

    // â”€â”€ 4. Find ports & CSRF token, then query GetUserStatus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    send('querying');
    try {
      const ports = ag.findListeningPorts(lspProc.pid);
      const csrfToken = ag.getCsrfToken(lspProc.commandLine, profilePath);

      console.log(`[Lune main.js] Hidden desktop LSP PID ${lspProc.pid} detected. Candidate listening ports: [${ports.join(', ')}]`);

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
        console.log(`[Lune main.js] Trying candidate listening port ${port} (candidate ports: [${ports.join(', ')}])...`);
        const res = await ag.queryUserStatus(port, csrfToken);
        if (res.ok) {
          queryResponse = res;
          usedPort = port;
          console.log(`[Lune main.js] Hidden Desktop Query SUCCEEDED on TCP port ${port}! (${res.durationMs} ms)`);
          break;
        }
        lastErr = res.error;
      }
      if (!queryResponse) {
        throw new Error('queryUserStatus failed on all candidate ports [' + ports.join(', ') + ']: ' + lastErr);
      }
    } catch (err) {
      // Cleanup before returning
      try { ag.killProcessTree(pid, profilePath); } catch (_) {}
      try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
      send('cleanup');
      return { authenticated: true, ok: false, status: 'unreachable', unreachable: true, error: 'query failed: ' + err.message };
    }

    // â”€â”€ 5. Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    send('cleanup');
    try { ag.killProcessTree(pid, profilePath); } catch (_) {}
    try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
  }

  // â”€â”€ 6. Done â€” return real API payload to renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  send('done');

  console.log('[Lune main.js] GetUserStatus RAW JSON body:\n' + queryResponse.body);

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

    const maxFrac = acc.pools.length > 0 ? Math.max(...acc.pools.map(p => p.remainingFraction)) : 1.0;
    acc.quotaPercent = Math.round(maxFrac * 100);
  }
}

/**
 * Bulk Refresh Helper â€” Tries running LSP direct queries first (Part 2), then falls back to hidden desktop spawn.
 * Emits refresh-all-card-status start/done events per card for visual glow animation (Part 7).
 * Updates lastSync ONLY on confirmed success for that specific account (Part 8).
 */
async function refreshAllAccountsHelper() {
  console.log('[Lune main.js] Starting bulk refresh for all registered accounts...');
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
      console.log(`[Lune refresh-all] Account ${acc.name} matched running process (PID ${lspMatch.pid}). Trying direct query...`);
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
            console.log(`[Lune refresh-all] Direct refresh SUCCEEDED for ${acc.name}`);
          } catch (e) {
            console.warn(`[Lune refresh-all] Error parsing direct status for ${acc.name}:`, e.message);
          }
          break;
        }
      }
    }

    // Fall back to hidden desktop spawn if direct query was not applicable or failed
    if (!refreshedOk) {
      console.log(`[Lune refresh-all] No running match for ${acc.name}, spawning hidden desktop...`);
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
          try { ag.killProcessTree(pid, profilePath); } catch (_) {}
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
      console.log(`[Lune refresh-all] No successful refresh for ${acc.name} â€” leaving last known data untouched.`);
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

async function runLiveWatcher() {
  // Skip this tick if a previous tick is still running (prevents concurrent mutation of
  // watcherOnlineAccountIds which is the root cause of "wrong account Live" flashes).
  if (watcherRunning) {
    console.log('[Lune watcher] Previous tick still in-flight â€” skipping this tick.');
    return;
  }
  watcherRunning = true;
  let servers = [];
  try {
    const accounts = getAccounts(); // authoritative shared array â€” never a stale local copy
    const rawServers = ag.findAllActiveRunningLanguageServers() || [];
    servers = await resolveAndDeduplicateServers(rawServers);

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

    // Concise per-tick summary log (not per-PID verbose)
    console.log(`[Lune watcher] tick â€” ${servers.length} server(s), ${accounts.length} saved account(s)`);

    // Determine which accounts are online THIS tick and emit status changes.
    // FIRST PASS: Calculate exact online set for this tick with strict email deduplication.
    const currentOnlineAccountIds = new Set();
    const seenActiveEmails = new Set();

    for (const acc of accounts) {
      const lsp = matchMap ? matchMap.get(acc) : null;
      const isOnline = !!(lsp && lsp.ports && lsp.ports.length > 0 && lsp.csrfToken &&
                        acc.email && lsp.activeEmail && acc.email.toLowerCase().trim() === lsp.activeEmail.toLowerCase().trim());
      if (isOnline) {
        const normEmail = acc.email.toLowerCase().trim();
        // Strict guard: ensure each active email maps to EXACTLY ONE primary saved account card
        if (!seenActiveEmails.has(normEmail)) {
          seenActiveEmails.add(normEmail);
          currentOnlineAccountIds.add(acc.id);
        }
      }
    }

    // Step A: Send OFFLINE events FIRST so old Live badges are removed immediately before new ones are added.
    for (const id of Array.from(watcherOnlineAccountIds)) {
      if (!currentOnlineAccountIds.has(id)) {
        watcherOnlineAccountIds.delete(id);
        // Reset the live-update rate limiter for this account: it's going offline, so when it
        // next comes online (e.g. user switches back to it), we want to sync immediately rather
        // than waiting out the full WATCHER_QUERY_INTERVAL_MS from its last successful query.
        lastWatcherQueryMs.delete(id);
        const offlineAcc = accounts.find(a => a.id === id);
        console.log(`[Lune watcher] OFFLINE: ${offlineAcc?.email || id} (id=${id}) â€” no longer matched on any running process this tick.`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: false });
        }
      }
    }

    // Step B: Send ONLINE events SECOND for newly online accounts.
    for (const id of currentOnlineAccountIds) {
      if (!watcherOnlineAccountIds.has(id)) {
        watcherOnlineAccountIds.add(id);
        const onlineAcc = accounts.find(a => a.id === id);
        console.log(`[Lune watcher] ONLINE: ${onlineAcc?.email || id} (id=${id}) â€” matched on a running process this tick.`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-online-status', { accountId: id, isOnline: true });
        }
      }
    }

    for (const acc of accounts) {
      const lsp = matchMap.get(acc);

      // No running process matched this account this tick â€” skip entirely.
      // Do NOT emit any IPC event or modify this account's data in any way.
      // Last known real values must remain intact until a genuine successful query occurs.
      if (!lsp || !lsp.ports || lsp.ports.length === 0 || !lsp.csrfToken) continue;

      if (watcherInFlightAccounts.has(acc.id)) continue;

      const lastQuery = lastWatcherQueryMs.get(acc.id) || 0;
      if (Date.now() - lastQuery < WATCHER_QUERY_INTERVAL_MS) continue;

      lastWatcherQueryMs.set(acc.id, Date.now());

      let parsed = lsp.lastParsedUserStatus;
      let body = lsp.lastRawResponseBody;

      if (!parsed) {
        for (const port of lsp.ports) {
          watcherInFlightAccounts.add(acc.id);
          try {
            const res = await ag.queryUserStatus(port, lsp.csrfToken);
            if (res.ok && res.body) {
              try {
                parsed = parseUserStatusBody(res.body);
                body = res.body;
              } catch (_) {}
              break;
            }
          } finally {
            watcherInFlightAccounts.delete(acc.id);
          }
        }
      }

      if (parsed && parsed.email) {
        // Strict email match: only update this account if the email matches the saved record.
        if (acc.email && parsed.email.toLowerCase().trim() !== acc.email.toLowerCase().trim()) {
          continue;
        }

        updateAccountFromUserStatus(acc, parsed);
        acc.lastSync = Date.now();
        acc.lastSyncSource = 'auto';
        acc.authenticated = true;
        acc.status = 'active';
        // Only persist when data actually changed â€” dirty flag prevents overwriting deletions.
        markAccountsDirty();
        persistIfDirty();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('live-account-update', {
            accountId: acc.id,
            authenticated: true,
            ok: true,
            lastSyncSource: 'auto',
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
      mainWindow.webContents.send('account-online-status-sync', { activeAccountIds: activeIds, activeEmails });
    }
  } catch (err) {
    console.warn('[Lune watcher] Tick error:', err.message);
  } finally {
    watcherRunning = false;
  }
}

// runNewAccountDetector() removed â€” new account detection is now explicit-only
// via the "Import Active Account" button in the Add Account modal.


ipcMain.handle('refresh-all-accounts', async () => {
  return refreshAllAccountsHelper();
});

ipcMain.handle('remove-account', async (event, { accountId }) => {
  const accounts = getAccounts();
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx === -1) {
    console.warn(`[Lune remove-account] Account id=${accountId} not found in live array â€” may already be deleted.`);
    return { ok: true }; // idempotent
  }
  const removed = accounts.splice(idx, 1)[0];
  console.log(`[Lune remove-account] Removed ${removed.email || accountId} from in-memory array. Persisting immediately.`);
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

// â”€â”€ Window factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#11131A',        // matches the dashboard body background
    show: false,                        // reveal only after content is ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,           // renderer has no access to Node APIs
      nodeIntegration: false,           // security: keep Node out of renderer
      sandbox: false,                   // preload needs require(); keep false
    },
  });

  mainWindow = win;
  win.loadFile('index.html');

  // Instant scan on window focus (reuses watcherRunning guard inside runLiveWatcher)
  win.on('focus', () => {
    console.log('[Lune main.js] Window focused — triggering instant watcher scan');
    runLiveWatcher().catch(err => {
      console.warn('[Lune main.js] Focus watcher scan error:', err.message);
    });
  });

  // Show the window as soon as the page has finished painting to avoid flash.
  win.once('ready-to-show', () => win.show());
}

// â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.whenReady().then(() => {
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
