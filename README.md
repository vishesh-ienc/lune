# Lune 🌙

A fast, unified Antigravity profile, quota, and process manager built with Electron.

---

## 📥 Download

Always download the latest Windows installer via the permanent direct link:
👉 **[Download Latest Lune (Lune.Setup.exe)](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe)**

> *Users do not need to search for version tags. The permanent link automatically points to the latest production release on GitHub.*

---

## ✨ Key Capabilities

- **Multi-Account Quota Tracking**: Live quota percentages, model breakdown (Gemini / Claude), and reset timers.
- **Language Server Disambiguation**: Process ranking and single-selection mechanism for active IDE workspaces.
- **Fully Automatic In-App Updates**: Background update detection, automatic download, SHA-512 verification, and seamless relaunch via GitHub Releases.
- **Data Persistence**: Isolated `%APPDATA%\lune\accounts.json` storage preserved across builds and upgrades.

---

## 🔄 Auto-Updater Architecture

Lune uses an automated, zero-prompt update pipeline powered by `electron-updater` and GitHub Releases:

```text
GitHub Release (vX.Y.Z)
      ↓
latest.yml (Release Manifest)
      ↓
electron-updater (Main Process)
      ↓
Automatic Background Download (100 MB NSIS Binary)
      ↓
SHA-512 Checksum & Blockmap Verification
      ↓
NSIS Installer Engine (Silent Update)
      ↓
Automatic Client Restart
      ↓
Updated Lune Client (vX.Y.Z)
```

---

## 🛠️ Development & Production Release Workflow

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Launch in development mode (Update network checks bypassed)
npm start

# 3. Run regression test suite
node scripts/test-lsp-matching.js
```

### Production Release Procedure
All production releases are automated via GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. **Update Version**: Bump `version` in `package.json` and `package-lock.json`:
   ```bash
   npm version 1.4.0 --no-git-tag-version
   ```
2. **Commit Release Preparation**:
   ```bash
   git add package.json package-lock.json
   git commit -m "Prepare release v1.4.0"
   git push origin main
   ```
3. **Tag Release**: Create and push the corresponding version tag:
   ```bash
   git tag v1.4.0
   git push origin v1.4.0
   ```
4. **Automated CI/CD**: GitHub Actions automatically:
   - Verifies that the Git tag matches `package.json.version`.
   - Runs clean `npm ci` and builds the production NSIS package on `windows-latest`.
   - Validates that `latest.yml`, `.blockmap`, and the installer binary match checksums.
   - Generates the permanent `Lune.Setup.exe` asset.
   - Publishes the GitHub Release with all 6 required updater assets.
5. **Verify Release**: Inspect the published release on GitHub Releases.
6. **Automatic Client Upgrade**: Existing installed Lune clients detect the release on startup and automatically upgrade.

---

## 📜 Release History & Verification Milestones

### **v1.3.0** — Automated CI/CD & Production Auto-Updater Verification
- **Automated GitHub Actions Publishing**: Integrated `.github/workflows/release.yml` with automated checksum verification and asset generation.
- **End-to-End Upgrade Verified**: Packaged Lune v1.2.0 successfully discovered v1.3.0, downloaded the 100.69 MB update, verified SHA-512, installed silently, and restarted cleanly into v1.3.0.
- **Data Integrity Verified**: 100% preservation of all registered accounts in `%APPDATA%\lune\accounts.json`.
- **Loop Prevention Verified**: Startup check on v1.3.0 recognizes current version and emits `update-not-available` with zero restart loops.

### **v1.2.0** — Automatic In-App Updates Infrastructure
- Implemented `lib/updater.js` with background auto-download (`autoDownload = true`) and auto-install on quit.
- Added unobtrusive `#update-status-pill` indicator in the header for live download progress and speed reporting.
- Established permanent download asset (`Lune.Setup.exe`).

### **v1.1.0** — Account Online Detection & LSP Disambiguation
- Canonicalized default profile paths (`Antigravity` vs `Antigravity IDE`).
- Implemented active workspace LSP ranking and single active account enforcement.
