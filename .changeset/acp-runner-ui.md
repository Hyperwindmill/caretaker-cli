---
"@hyperwindmill/caretaker-cli": patch
"caretaker-types": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

ACP agent UI parity: the agent settings forms hide the native tool/plugin pickers, maxTurns, and model listing for ACP providers (model becomes an optional label), and interactive chats now surface a confirmation card for every permission request an ACP agent raises (previously auto-approved because `confirmTools` is empty for external runners), with "always" remembered per tool name in-session.
