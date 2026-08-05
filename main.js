'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ag   = require('./lib/antigravity');

// ── IPC Handlers ────────────────────────────────────────────────────────────

// Proof-of-concept ping handler; kept for debug comparison until Phase B is confirmed working.
ipcMain.handle('ping', async () => {
  return 'pong from main process';
});

/**
 * 'launch-account' — launch visible, interactive Antigravity IDE window for a profile
 * (e.g. for initial OAuth login or active coding work).
 */
ipcMain.handle('launch-account', async (event, { profilePath }) => {
  try {
    const pPath = profilePath || 'C:\\Users\\VISHESH\\AppData\\Roaming\\Antigravity IDE';
    const res = ag.spawnVisible(pPath);
    return { ok: true, pid: res.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 'refresh-account' — full hidden-desktop refresh cycle for one authenticated profile.
 *
 * Renderer calls: ipcRenderer.invoke('refresh-account', { profilePath, accountId })
 * Progress events: ipcRenderer.on('refresh-status', (_, { accountId, stage }) => …)
 *
 * Stage sequence (happy path):
 *   auth-check → launching → waiting-lsp → querying → cleanup → done
 *
 * On auth-check failure: returns { authenticated: false }  (no spawn).
 * On any later failure:  returns { authenticated: true, error: '<what failed>' }
 *   Cleanup (killProcessTree / closeHiddenDesktop) still runs even on error
 *   so no orphan processes are left behind.
 */
ipcMain.handle('refresh-account', async (event, { profilePath, accountId }) => {
  const send = (stage) => event.sender.send('refresh-status', { accountId, stage });

  // ── 1. Auth check ────────────────────────────────────────────────────────
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

  // ── 1b. Direct query on already-running instance ──────────────────────────
  let queryResponse = null;
  try {
    const existingLsp = await ag.waitForLanguageServer(null, 1000, 200, profilePath);
    if (existingLsp) {
      const ports = ag.findListeningPorts(existingLsp.pid);
      const csrfToken = ag.getCsrfToken(existingLsp.commandLine, profilePath);
      if (ports.length > 0 && csrfToken) {
        send('querying');
        for (const port of ports) {
          const res = await ag.queryUserStatus(port, csrfToken);
          if (res.ok) {
            queryResponse = res;
            console.log('[Lune main.js] Successfully queried already-running Antigravity instance directly!');
            break;
          }
        }
      }
    }
  } catch (e) {
    console.info('[Lune main.js] Direct query on existing process skipped:', e.message);
  }

  if (!queryResponse) {
    // ── 2. Spawn on hidden desktop ───────────────────────────────────────────
    send('launching');
    let spawnResult;
    try {
      spawnResult = ag.spawnHidden(profilePath);
    } catch (err) {
      return { authenticated: true, error: 'spawn failed: ' + err.message };
    }

    const { pid, hProcess, hDesktop } = spawnResult;

    // ── 3. Wait for Language Server ──────────────────────────────────────────
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
      return { authenticated: true, error: 'lsp-timeout: ' + err.message };
    }

    // ── 4. Find ports & CSRF token, then query GetUserStatus ────────────────
    send('querying');
    try {
      const ports = ag.findListeningPorts(lspProc.pid);
      const csrfToken = ag.getCsrfToken(lspProc.commandLine, profilePath);

      if (!ports.length) {
        throw new Error('no LISTENING ports found for LSP pid ' + lspProc.pid);
      }
      if (!csrfToken) {
        throw new Error('CSRF token not found in commandline or logs');
      }

      // Try each port; use first successful response
      let lastErr = null;
      for (const port of ports) {
        const res = await ag.queryUserStatus(port, csrfToken);
        if (res.ok) {
          queryResponse = res;
          break;
        }
        lastErr = res.error;
      }
      if (!queryResponse) {
        throw new Error('queryUserStatus failed on all ports: ' + lastErr);
      }
    } catch (err) {
      // Cleanup before returning
      try { ag.killProcessTree(pid, profilePath); } catch (_) {}
      try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
      send('cleanup');
      return { authenticated: true, error: 'query failed: ' + err.message };
    }

    // ── 5. Cleanup ───────────────────────────────────────────────────────────
    send('cleanup');
    try { ag.killProcessTree(pid, profilePath); } catch (_) {}
    try { ag.closeHiddenDesktop(hDesktop, hProcess); } catch (_) {}
  }

  // ── 6. Done — return real API payload to renderer ───────────────────────
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

  return {
    authenticated: true,
    ok: queryResponse.ok,
    status: queryResponse.status,
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

// ── Window factory ───────────────────────────────────────────────────────────
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

  win.loadFile('index.html');

  // Show the window as soon as the page has finished painting to avoid flash.
  win.once('ready-to-show', () => win.show());
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

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
