---
'@hyperwindmill/caretaker-cli': patch
'caretaker-vscode': patch
'webview-ui': patch
---

Voice settings now work fully in the VSCode sidebar: the extension host answers
the **Fetch models** catalogue request itself (via the CLI's new `./voice` package
export), where it previously left the button stuck on "Fetching…" forever. Voice
playback remains unavailable there by design — the tab edits the shared config the
web GUI and desktop app run with, and the managed-backend Start/Stop block stays
web/desktop-only (it needs the web server). The "Use local defaults" note now says
so instead of promising a Start button on every surface.
