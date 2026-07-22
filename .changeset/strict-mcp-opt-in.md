---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

claude-code agents: `--strict-mcp-config` is now **opt-in per agent** via a new `strictMcp` boolean (default off). Previously the per-run MCP config was always strict, which silently ignored the user's own `~/.claude` MCP servers. Now the default **merges** them with caretaker's, so anything set up for Claude Code (e.g. a `caretaker-cli mcp` stdio server for the `task_*` tools) is available in an in-caretaker chat too. The flag applies uniformly, autonomous task runs included. Turn **Strict MCP config** on in the agent form to restore the isolated (caretaker-only) toolset.

Behavior change: existing claude-code agents with configured `mcpServers` go from strict to merge on upgrade — set `strictMcp: true` to keep the old behavior.
