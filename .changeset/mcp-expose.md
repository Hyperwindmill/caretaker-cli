---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

New `caretaker-cli mcp` subcommand: a general-purpose MCP server over stdio that exposes caretaker's `mcp__task__*` task/project tools to external MCP clients (e.g. Claude Code), so they can inspect and steer autonomous tasks/projects symmetrically with in-harness agents — no running web server and no token. The server reuses the exact task-tool definitions and server-wrapping the per-task HTTP bridge uses (extracted into a shared `mcp/task_server.ts`), and its trust boundary is local process access to `CARETAKER_HOME`. The existing token-guarded, per-task `/api/mcp/task` bridge is unchanged.
