---
"caretaker-cli": patch
---

ci: add a GitHub Actions release workflow (`.github/workflows/release.yml`), triggered on `v*` tag push or manual dispatch, that builds the Electron desktop app for Linux (`deb-package` artifact, `electron-builder --linux deb`) and Windows (`windows-installer` artifact, `electron-builder --win nsis`) and the VSCode extension (`vsix-package` artifact, `pnpm -F caretaker-vscode package`). A final `publish-release` job, gated on all three succeeding, downloads the artifacts and uses `softprops/action-gh-release` to create a **draft** GitHub Release for the pushed tag with the deb, exe, and vsix attached, with release notes assembled from the per-package Changesets CHANGELOG sections for that version (dependency-bump-only sections skipped). electron-builder runs with `--publish never` (its implicit publish-on-tag would otherwise fail without a GH_TOKEN), and the release job is skipped on non-tag manual dispatches. No runtime behavior changes.
