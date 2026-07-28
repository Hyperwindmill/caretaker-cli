---
'@hyperwindmill/caretaker-cli': patch
'webview-ui': patch
'caretaker-vscode': patch
'caretaker-desktop': patch
'caretaker-types': patch
---

Autofocus the chat composer when it becomes usable again (turn finished, tool
confirmation resolved, or an agent selected) and on initial load. Focus is only
restored when the webview already holds focus, so the VSCode sidebar never steals the
caret out of the code editor.