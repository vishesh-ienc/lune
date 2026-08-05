'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Legacy debug bridge (ping button) ───────────────────────────────────────
// Kept in place until Phase B is confirmed working — do not remove yet.
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Proof-of-concept bridge call.
   * Returns a Promise that resolves to "pong from main process".
   * @returns {Promise<string>}
   */
  ping: () => ipcRenderer.invoke('ping'),
});

// ── Phase B real-refresh bridge ─────────────────────────────────────────────
contextBridge.exposeInMainWorld('api', {
  /**
   * Trigger a full hidden-desktop refresh cycle for one authenticated profile.
   *
   * @param {string} profilePath  - Absolute path to the IDE user-data directory
   * @param {number} accountId    - The account's numeric ID (used to match progress events)
   * @returns {Promise<{
   *   authenticated: boolean,
   *   ok?: boolean,
   *   status?: number,
   *   body?: string,
   *   durationMs?: number,
   *   error?: string
   * }>}
   */
  refreshAccount: (profilePath, accountId) =>
    ipcRenderer.invoke('refresh-account', { profilePath, accountId }),

  /**
   * Subscribe to staged progress notifications emitted during a refresh cycle.
   * Callback receives { accountId, stage } where stage is one of:
   *   'auth-check' | 'launching' | 'waiting-lsp' | 'querying' | 'cleanup' | 'done'
   *
   * Returns an unsubscribe function — call it to stop listening.
   *
   * @param {function} callback
   * @returns {function}  unsubscribe
   */
  onRefreshStatus: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('refresh-status', handler);
    return () => ipcRenderer.removeListener('refresh-status', handler);
  },

  /**
   * Launch a visible, interactive Antigravity IDE window for a profile (e.g. for OAuth login).
   *
   * @param {string} profilePath
   * @returns {Promise<{ ok: boolean, pid?: number, error?: string }>}
   */
  launchAccount: (profilePath) =>
    ipcRenderer.invoke('launch-account', { profilePath }),
});
