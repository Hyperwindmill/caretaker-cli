---
"caretaker-cli": patch
---

ci: add a GitHub Actions release workflow (`.github/workflows/release.yml`), triggered on `v*` tag push or manual dispatch, that builds the Electron desktop app for Linux (`deb-package` artifact, `electron-builder --linux deb`) and Windows (`windows-installer` artifact, `electron-builder --win nsis`) and the VSCode extension (`vsix-package` artifact, `pnpm -F caretaker-vscode package`). A final `publish-release` job, gated on all three succeeding, downloads the artifacts and uses `softprops/action-gh-release` to create/update the GitHub Release for the pushed tag with the deb, exe, and vsix attached. No runtime behavior changes.
