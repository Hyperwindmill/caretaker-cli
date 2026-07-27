---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Fix the chat UI freezing on long conversations (around 200k tokens) in the web GUI, the
desktop app and the VSCode sidebar. Markdown is now parsed once per message and cached,
the message list and its items are memoized so typing in the composer no longer re-renders
the whole thread, and collapsed tool blocks no longer mount their (often very large)
results until expanded.