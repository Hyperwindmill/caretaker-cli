---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

New `caretaker-cli config claude` subcommand: one-shot setup that registers caretaker's stdio MCP server (`caretaker-cli mcp`) in your Claude Code user-scope config, so an external Claude Code session can drive caretaker's task/project tools. It checks the `claude` CLI is installed, warns if `caretaker-cli` isn't on PATH, is idempotent (no-op if already configured), and delegates config-writing to `claude mcp add` to stay forward-compatible with Claude Code's config format.
