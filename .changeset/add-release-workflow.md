---
"caretaker-cli": patch
---

ci: add a GitHub Actions release workflow (`.github/workflows/release.yml`), triggered on `v*` tag push or manual dispatch, that builds the Electron desktop app for Linux (`deb-package` artifact, `electron-builder --linux deb`) and Windows (`windows-installer` artifact, `electron-builder --win nsis`) and the VSCode extension (vsix) on tag push, attaching all three to the GitHub Release. No runtime behavior changes.
