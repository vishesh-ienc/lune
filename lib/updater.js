'use strict';

const { app, ipcMain } = require('electron');
const logger = require('./logger');

let initialized = false;
let isUpdateDownloaded = false;
let isInstallingUpdate = false;
let isChecking = false;
let isDownloading = false;
let targetWindow = null;
let autoUpdaterInstance = null;

/**
 * Safely gets or instantiates the electron-updater autoUpdater singleton.
 *
 * @returns {object|null}
 */
function getAutoUpdater() {
  if (autoUpdaterInstance) return autoUpdaterInstance;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterInstance = autoUpdater;
    return autoUpdaterInstance;
  } catch (err) {
    logger.warn('[Lune updater] Failed to load electron-updater:', err.message);
    return null;
  }
}

/**
 * Safely forwards an updater event and optional payload to the renderer process.
 *
 * @param {string} channel - IPC channel name
 * @param {object} [payload] - Optional event payload
 */
function sendToRenderer(channel, payload = {}) {
  try {
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send(channel, payload);
    }
  } catch (err) {
    logger.warn(`[Lune updater] Failed to send "${channel}" to renderer:`, err.message);
  }
}

/**
 * Initializes the auto-updater module, registers event listeners and IPC handlers,
 * and performs an initial update check if running in a packaged environment.
 *
 * @param {BrowserWindow} mainWindow - The main application window
 */
function initAutoUpdater(mainWindow) {
  if (initialized) {
    targetWindow = mainWindow;
    return;
  }
  initialized = true;
  targetWindow = mainWindow;

  // 1. Register IPC handlers for compatibility
  ipcMain.handle('check-for-updates', async () => {
    if (!app || !app.isPackaged) {
      logger.debug('[Lune updater] check-for-updates skipped: running in development mode (unpackaged).');
      return { ok: false, reason: 'dev-mode', message: 'Update checks are disabled in development mode.' };
    }
    const updater = getAutoUpdater();
    if (!updater) {
      return { ok: false, error: 'updater-unavailable', message: 'Auto-updater is not available.' };
    }
    if (isChecking) {
      return { ok: true, inProgress: true, message: 'Update check already in progress.' };
    }
    try {
      logger.debug('[Lune updater] Manual update check triggered via IPC.');
      const result = await updater.checkForUpdates();
      return {
        ok: true,
        updateInfo: result?.updateInfo ? {
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          releaseNotes: result.updateInfo.releaseNotes,
        } : null,
      };
    } catch (err) {
      logger.warn('[Lune updater] Manual update check failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('start-download-update', async () => {
    if (!app || !app.isPackaged) {
      return { ok: false, reason: 'dev-mode', message: 'Update downloads are disabled in development mode.' };
    }
    const updater = getAutoUpdater();
    if (!updater) {
      return { ok: false, error: 'updater-unavailable', message: 'Auto-updater is not available.' };
    }
    if (isDownloading) {
      return { ok: true, inProgress: true, message: 'Download already in progress.' };
    }
    if (isUpdateDownloaded) {
      return { ok: true, alreadyDownloaded: true, message: 'Update has already been downloaded.' };
    }
    try {
      isDownloading = true;
      logger.info('[Lune updater] Starting update download...');
      updater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      isDownloading = false;
      logger.warn('[Lune updater] Failed to start update download:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('quit-and-install-update', async () => {
    if (!app || !app.isPackaged) {
      return { ok: false, reason: 'dev-mode', message: 'Update installation is disabled in development mode.' };
    }
    if (!isUpdateDownloaded) {
      logger.warn('[Lune updater] quit-and-install-update called before update was downloaded.');
      return { ok: false, error: 'no-update-downloaded', message: 'No update has been downloaded yet.' };
    }
    if (isInstallingUpdate) {
      return { ok: true, inProgress: true, message: 'Installation already in progress.' };
    }
    try {
      isInstallingUpdate = true;
      const updater = getAutoUpdater();
      if (!updater) return { ok: false, error: 'updater-unavailable' };
      logger.info('[Lune updater] Quitting and installing update...');
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      isInstallingUpdate = false;
      logger.error('[Lune updater] quitAndInstall failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // 2. In development mode (!app.isPackaged), do not contact GitHub or listen to network events
  if (!app || !app.isPackaged) {
    logger.debug('[Lune updater] Development mode detected: updater network listeners and checks skipped.');
    return;
  }

  // 3. Configure autoUpdater behavior (packaged mode only)
  const updater = getAutoUpdater();
  if (!updater) return;

  // Fully automatic updates: automatically download when available
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.logger = {
    info: (...args) => logger.debug('[electron-updater info]', ...args),
    warn: (...args) => logger.warn('[electron-updater warn]', ...args),
    error: (...args) => logger.error('[electron-updater error]', ...args),
    debug: (...args) => logger.debug('[electron-updater debug]', ...args),
  };

  updater.on('checking-for-update', () => {
    isChecking = true;
    logger.debug('[Lune updater] Checking for update...');
    sendToRenderer('update-checking');
  });

  updater.on('update-available', (info) => {
    isChecking = false;
    isDownloading = true;
    logger.info(`[Lune updater] Update available: v${info.version} (released: ${info.releaseDate || 'N/A'}). Automatically downloading...`);
    sendToRenderer('update-available', {
      version: info.version,
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
    });
  });

  updater.on('update-not-available', (info) => {
    isChecking = false;
    isDownloading = false;
    logger.debug(`[Lune updater] Update not available. Current version is up to date (v${info?.version || app.getVersion()}).`);
    sendToRenderer('update-not-available', {
      version: info?.version || app.getVersion(),
    });
  });

  updater.on('error', (err) => {
    isChecking = false;
    isDownloading = false;
    logger.warn('[Lune updater] Updater error:', err == null ? 'unknown' : (err.stack || err).toString());
    sendToRenderer('update-error', {
      message: err?.message || 'Update service error',
    });
  });

  updater.on('download-progress', (progressObj) => {
    sendToRenderer('update-download-progress', {
      percent: Math.round(progressObj.percent || 0),
      bytesPerSecond: progressObj.bytesPerSecond || 0,
      transferred: progressObj.transferred || 0,
      total: progressObj.total || 0,
    });
  });

  updater.on('update-downloaded', (info) => {
    isDownloading = false;
    isUpdateDownloaded = true;
    logger.info(`[Lune updater] Update downloaded: v${info.version}. Triggering automatic quit-and-install...`);
    sendToRenderer('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
    });

    // Guard against duplicate execution
    if (!isInstallingUpdate) {
      isInstallingUpdate = true;
      // Brief 1-second timeout allowing renderer to render "Installing..." status before process exit
      setTimeout(() => {
        try {
          updater.quitAndInstall(false, true);
        } catch (err) {
          isInstallingUpdate = false;
          logger.error('[Lune updater] Automatic quitAndInstall failed:', err.message);
          sendToRenderer('update-error', {
            message: `Automatic installation failed: ${err.message}`,
          });
        }
      }, 1000);
    }
  });

  // 4. Perform startup update check (only in packaged app, delayed by 3s)
  logger.debug('[Lune updater] Scheduling initial startup update check (packaged mode)...');
  setTimeout(() => {
    updater.checkForUpdates().catch((err) => {
      logger.warn('[Lune updater] Startup update check failed:', err.message);
    });
  }, 3000);
}

module.exports = {
  initAutoUpdater,
};
