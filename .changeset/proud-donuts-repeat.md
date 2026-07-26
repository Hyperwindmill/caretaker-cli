---
'webview-ui': patch
'caretaker-vscode': patch
---

Hide the Voice settings tab in the VSCode sidebar. Voice mode is out of scope
there (the webview CSP blocks microphone access), and settings for a capability
a surface cannot offer should not be shown on it — the same pattern that already
hides the Projects and Scheduler tabs. Voice is configured from the web GUI or
the desktop app, which share the same on-disk config.
