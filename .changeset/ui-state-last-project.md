---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
---

The Projects screen reopens on the last selected project, also in the desktop app: the choice is stored server-side in `ui-state.json` instead of the browser's localStorage, which the desktop app loses on every launch (new port, new origin).
