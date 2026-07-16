---
'caretaker-cli': minor
'caretaker-vscode': minor
'webview-ui': minor
---

Add conversation delete to the web app and VSCode sidebar

The TUI already supported deleting chat sessions; the web GUI and the
VSCode sidebar did not. Wire a `deleteSession` message through the
host↔view bridge and handle it in both hosts (the local web server and
the VSCode sidebar), then expose a delete button (with a confirmation
prompt) on each conversation row in the sidebar sessions list and the
conversations dropdown. Deleting the active conversation clears the
chat view and refreshes the sessions list.