---
"@hyperwindmill/caretaker-cli": patch
"caretaker-types": patch
"webview-ui": patch
"caretaker-vscode": patch
"caretaker-desktop": patch
---

ACP presets follow-ups found with a real Antigravity install:

- Binary presets keep the registry's `args`/`env` in both provider forms (Antigravity on Linux needs `--uid=`, without it the server aborts at boot); only the command waits for Install or a pasted path.
- A child that fails the ACP handshake now surfaces its stderr tail in the runner error instead of a bare "connection closed".
- `auth_required` at session start: interactive chats run the agent's first advertised login method (browser OAuth for Antigravity) and retry; scheduled/autonomous runs fail with a readable hint to log in via one interactive chat first.
