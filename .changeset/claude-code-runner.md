---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Claude Code as an optional runner: new provider type `claude-code` runs agents
through `claude -p` (stream-json) on every surface — chat, headless, scheduler,
and autonomous tasks (task tools exposed via a token-guarded HTTP MCP bridge).
Agents on such providers use Claude Code's own tools and permission modes
(new per-agent permission-mode setting; unattended runs force bypassPermissions).
