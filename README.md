<div align="center">

# Lune 🌙

### All your Antigravity accounts. One place.

A fast, lightweight Windows desktop application designed to manage, monitor, and track multiple Google Antigravity accounts from a unified dashboard.

[![Website](https://img.shields.io/badge/Website-lune--web--rho.vercel.app-2dd4bf?style=for-the-badge&logo=vercel)](https://lune-web-rho.vercel.app)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(64--bit)-0078D6?style=for-the-badge&logo=windows)](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe)
[![Download](https://img.shields.io/badge/Download-Lune.Setup.exe-4ade80?style=for-the-badge&logo=windows-terminal)](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe)
[![GitHub Release](https://img.shields.io/github/v/release/vishesh-ienc/lune?style=for-the-badge&color=22c55e)](https://github.com/vishesh-ienc/lune/releases/latest)

---

[**🌐 Visit Official Website**](https://lune-web-rho.vercel.app) • [**📥 Download Installer (.exe)**](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe) • [**📖 Capabilities**](#-key-capabilities)

</div>

---

## ⚡ What is Lune?

Managing multiple Antigravity accounts shouldn't require mental overhead or constantly switching tabs to check quotas.

**Lune** runs alongside your Antigravity IDE on Windows as a single visibility layer. Import your active Antigravity accounts once: Lune remembers them, tracks their Gemini and Claude/GPT quota pools, monitors 5-hour refresh countdowns, and displays everything in real time.

---

## 📥 Download

Always download the latest Windows installer via the permanent direct link:

👉 **[Download Latest Lune (Lune.Setup.exe)](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe)**

> *No need to search for version tags. The permanent link automatically points to the latest production release on GitHub.*

---

## ✨ Key Capabilities

- **Unified Account Pool**: Keep all your Antigravity accounts organized in one place. No more hunting through browser tabs or forgotten sessions.
- **One-Click Session Import**: Automatically detects the active Antigravity profile with a single click. Zero credential re-entry required.
- **Real-Time Quota Tracking**: Inspect Gemini and Claude/GPT quota pools separately, complete with live percentage meters, prompt/flow credits, and exact 5-hour refresh countdown timers.
- **Zero-Overhead Auto-Sync**: Lune runs silently in the background on Windows, keeping your account data and limits current without consuming IDE resources.
- **Automatic In-App Updates**: Background update pipeline powered by `electron-updater` and GitHub Actions with SHA-512 checksum verification.
- **Persistent Local Storage**: Isolated `%APPDATA%\lune\accounts.json` storage preserved cleanly across application updates.

---

## 🛠️ How It Works

```
1. Start with Antigravity  ──▶  Ensure Antigravity IDE is running and signed in.
2. Open Lune               ──▶  Launch Lune on Windows alongside your IDE.
3. Click Import Account    ──▶  Lune automatically scans for active sessions.
4. Confirm Detected User   ──▶  Review the detected profile and confirm with 1 click.
5. Live Dashboard          ──▶  Account is stored in your pool with live quota meters.
```

---

## 🔄 Auto-Updater Architecture

Lune features an automated, zero-prompt update pipeline:

```
GitHub Release (vX.Y.Z)
      │
      ▼
latest.yml (Release Manifest)
      │
      ▼
electron-updater (Main Process)
      │
      ▼
Automatic Background Download (NSIS Installer)
      │
      ▼
SHA-512 Checksum & Blockmap Verification
      │
      ▼
Silent Background Update Engine
      │
      ▼
Automatic Client Restart ──▶ Updated Lune Client
```

---

## 💻 Development & Build Workflow

### Prerequisites
- Node.js 18+ (Node 20+ or 22+ recommended)
- Windows 10 or 11 (64-bit)

### Local Setup
```bash
# 1. Clone the repository
git clone https://github.com/vishesh-ienc/lune.git
cd lune

# 2. Install dependencies
npm install

# 3. Start in development mode
npm start
```

### Production Build
```bash
# Build the NSIS Windows installer
npm run dist:win
```

---

## 🌐 Official Website

The official product landing page for Lune is live at:
**[https://lune-web-rho.vercel.app](https://lune-web-rho.vercel.app)**

Source code for the website: [vishesh-ienc/lune-web](https://github.com/vishesh-ienc/lune-web)

---

## 📄 License

Created and maintained by [Vishesh Jiwnani](https://github.com/vishesh-ienc).
All rights reserved.
