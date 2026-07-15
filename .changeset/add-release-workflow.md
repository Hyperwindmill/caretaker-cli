---
"caretaker-cli": patch
---

ci: add a GitHub Actions release workflow that builds the Electron desktop app (Linux deb, Windows nsis) and the VSCode extension (vsix) on tag push, attaching all three to the GitHub Release. No runtime behavior changes.
