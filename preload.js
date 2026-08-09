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

  /**
   * Load persisted accounts array from disk (userData/accounts.json).
   * @returns {Promise<Array>}
   */
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),

  /**
   * Save accounts array to disk (userData/accounts.json).
   * @param {Array} accounts
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  saveAccounts: (accounts) => ipcRenderer.invoke('save-accounts', accounts),

  /**
   * Scan system for running Antigravity IDE Language Server processes and return candidate accounts.
   */
  detectRunningAccounts: () => ipcRenderer.invoke('detect-running-accounts'),

  /**
   * Save an imported candidate account to accounts.json.
   */
  saveImportedAccount: (accountObj) => ipcRenderer.invoke('save-imported-account', accountObj),

  /**
   * Bulk refresh all accounts.
   */
  refreshAllAccounts: () => ipcRenderer.invoke('refresh-all-accounts'),

  /**
   * Remove an account by ID.
   */
  removeAccount: (accountId) => ipcRenderer.invoke('remove-account', { accountId }),

  /**
   * Subscribe to live background watcher status updates for running accounts.
   */
  onLiveAccountUpdate: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('live-account-update', handler);
    return () => ipcRenderer.removeListener('live-account-update', handler);
  },

  /**
   * Subscribe to per-card refresh status during Refresh All.
   * Callback receives { accountId, status: 'start'|'done' }
   */
  onRefreshAllCardStatus: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('refresh-all-card-status', handler);
    return () => ipcRenderer.removeListener('refresh-all-card-status', handler);
  },

  /**
   * Subscribe to live online/offline status changes for accounts.
   * Emitted by the live watcher when a matched running process appears or disappears.
   * Callback receives { accountId: number, isOnline: boolean }
   * Only emitted on state CHANGE (flip), not every tick.
   */
  onAccountOnlineStatus: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('account-online-status', handler);
    return () => ipcRenderer.removeListener('account-online-status', handler);
  },

  /**
   * Subscribe to full batch account-online-status-sync events.
   * Emitted every scan cycle with the array of active account IDs and active emails.
   * Callback receives { activeAccountIds: number[], activeEmails: string[] }
   */
  onAccountOnlineStatusSync: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('account-online-status-sync', handler);
    return () => ipcRenderer.removeListener('account-online-status-sync', handler);
  },

});
