# Lune 🌙

A fast, unified Antigravity profile, quota, and process manager built with Electron.

---

## 📥 Download

Download the latest Windows installer:
👉 **[Download Latest Lune (Lune.Setup.exe)](https://github.com/vishesh-ienc/lune/releases/latest/download/Lune.Setup.exe)**

---

## ✨ Features

- **Multi-Account Quota Tracking**: Live quota percentages, model breakdown (Gemini / Claude), and reset timers.
- **Language Server Disambiguation**: Process ranking and single-selection mechanism for active IDE workspaces.
- **Fully Automatic In-App Updates**: Background update detection, automatic download, SHA-512 verification, and seamless relaunch via GitHub Releases.

---

## 🛠️ Development & Release Procedure

### Local Development
```bash
# Install dependencies
npm install

# Start local development app
npm start

# Run test suite
node scripts/test-lsp-matching.js
```

### Publishing a New Release
All production releases are automated via GitHub Actions (`.github/workflows/release.yml`):

1. **Update Version**: Bump `version` in `package.json` and `package-lock.json` (e.g. `npm version 1.3.0 --no-git-tag-version`).
2. **Commit Changes**: Commit the release preparation changes to `main`:
   ```bash
   git add package.json package-lock.json
   git commit -m "Prepare release v1.3.0"
   git push origin main
   ```
3. **Tag Release**: Create and push the corresponding version tag matching `vX.Y.Z`:
   ```bash
   git tag v1.3.0
   git push origin v1.3.0
   ```
4. **Automated CI/CD**: GitHub Actions automatically:
   - Verifies that the Git tag matches `package.json`.
   - Compiles and builds the production NSIS installer via `electron-builder`.
   - Validates that `latest.yml`, the `.blockmap`, and the installer binary match checksums.
   - Generates the permanent `Lune.Setup.exe` asset.
   - Publishes the GitHub Release and attaches all updater assets.
5. **Verify Release**: Inspect the published release on GitHub Releases.
