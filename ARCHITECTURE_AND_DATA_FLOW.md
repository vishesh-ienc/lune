# 🛰️ Lune Architecture & Data Flow Guide

This document provides a complete, easy-to-understand reference for how Lune operates, how data flows through the application, where user files are stored on disk, and how real-time account tracking and backup safety work.

---

## 🧠 1. Overview & Core Concept

Lune acts as a **lightweight, non-invasive status monitor** for your Antigravity IDE accounts. It does **not** launch or modify your IDE windows. Instead, it reads the status of the local Language Server process (`language_server.exe`) already running on your computer and displays real-time prompt credits, model quotas, reset timers, and live online status on a unified dashboard.

```
┌────────────────────────────────┐
│   Antigravity IDE (Running)    │
│  └─ language_server.exe (LSP)  │
└──────────────┬─────────────────┘
               │ Local HTTP Request (/GetUserStatus)
               ▼
┌────────────────────────────────┐       IPC Channel       ┌────────────────────────────────┐
│       Lune Main Process        │ ──────────────────────> │    Lune UI (index.html)        │
│          (main.js)             │                         │   (Cards, Quota Progress Bars) │
└──────────────┬─────────────────┘                         └────────────────────────────────┘
               │ Writes only when data changes (Dirty Flag)
               ▼
┌────────────────────────────────┐
│   Disk Storage (accounts.json) │
│  └─ accounts-backups/ (Max 20) │
└────────────────────────────────┘
```

---

## 📁 2. Storage Location & File Structure

### 📍 Local Storage Directory
On Windows, Lune stores all user accounts and configuration in the application data directory:

```text
C:\Users\<WindowsUsername>\AppData\Roaming\lune\
   ├── accounts.json            <-- Master JSON database file
   └── accounts-backups/        <-- Folder holding up to 20 rolling backups
       ├── accounts-2026-08-09T19-24-52.319Z.json
       ├── accounts-2026-08-09T19-26-17.308Z.json
       └── ...
```

### 🆕 First-Launch Behavior (New User)
1. **Empty File Start**: When a new user launches Lune, `accounts.json` does not exist yet.
2. **Clean In-Memory Initialization**: Lune starts up with an empty in-memory accounts array (`ACCOUNTS = []`).
3. **No Mock Data**: Lune never creates or displays hardcoded or mock accounts.
4. **Auto-Directory & Backup Creation**: As soon as the user imports their first account, Lune automatically creates the `lune` folder, saves `accounts.json`, and initializes the rolling snapshot system in `accounts-backups/`.

---

## 🔄 3. Account Import Flow

When a user opens Antigravity IDE and clicks **"Import Active Account"** in Lune:

1. **Process Discovery**:  
   Lune queries active Windows processes using `Get-CimInstance Win32_Process` to locate running `language_server.exe` processes.
2. **Port & Security Token Resolution**:  
   Lune parses command-line arguments to extract the process's local port (e.g. `52859`) and CSRF security token.
3. **Local HTTP Query**:  
   Lune sends a fast local request to the Language Server's `/GetUserStatus` endpoint over HTTP.
4. **Identity & Quota Extraction**:  
   The Language Server responds with JSON containing:
   - **Identity**: Name, email, plan tier (e.g. `Google AI Pro` or `Antigravity Starter Quota`).
   - **Prompt Credits**: Remaining vs total prompt credits (e.g. `500 / 50,000`).
   - **Model Quotas**: Per-model percentage usage and reset countdowns (e.g. `Gemini 2.5 Flash`, `Claude 3.7 Sonnet`).
5. **Disk Persistence**:  
   Lune pushes the account to the master in-memory array (`ACCOUNTS`), marks the store dirty (`accountsDirty = true`), and persists the updated array to `accounts.json`.

---

## ⚡ 4. Live Background Watcher & Sub-Second Focus Sync

Lune keeps your account status synced in real-time with zero performance overhead:

### A. 5-Second Background Watcher Cycle
Every 5 seconds, Lune's background watcher (`runLiveWatcher()`) scans for active Language Server processes:
- If a running Language Server matches a saved account's email, that account card is marked **`🟢 Live`**.
- If no active process matches the account (or if the IDE was closed), the account is marked **Offline**.

### B. Account Switch Disambiguation (PID Ranking)
When you switch accounts inside Antigravity IDE, two `language_server.exe` processes may exist under the same parent process tree.  
Lune automatically groups processes by profile directory and ranks them by Process ID (PID), selecting **only the newest active process** (highest PID). Older lingering processes are ignored, ensuring **only your currently active account shows `🟢 Live`**.

### C. Instant Focus Sync
Whenever you **Alt+Tab** back to Lune or click on its window, `win.on('focus')` triggers an immediate background scan, delivering instant updates without waiting for the 5-second timer.

---

## 🛡️ 5. Data Integrity & Safety Features

- **Dirty-Flag Guard (`persistIfDirty()`)**:  
  Disk writes only occur when data actually changes (e.g. credit consumption, account addition, or account deletion). This avoids unnecessary disk I/O.
- **Transient Flag Cleanup**:  
  Runtime error flags (`wrongAccountActive`, `unreachable`, `isLive`) are **never saved to disk**. They are re-evaluated fresh on each session so stale error messages never persist across app restarts.
- **Rolling Backup Engine**:  
  Before every write to `accounts.json`, Lune creates a timestamped backup copy inside `accounts-backups/`. It automatically prunes older files to maintain a rolling limit of **20 backups**.
