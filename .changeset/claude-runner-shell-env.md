---
"@hyperwindmill/caretaker-cli": patch
---

fix(claude-code): merge the probed interactive-shell PATH into the `claude` spawn env

The Claude Code runner spawned `claude` with the raw `process.env`, so when caretaker itself was launched from a non-interactive shell (no nvm/fnm/volta on PATH), the spawned `claude` — and any stdio MCP server it spawned in turn, e.g. `caretaker-cli mcp` — could not find `node`/`claude` and failed to connect. The runner now uses `mergeShellEnv(process.env)`, prepending the boot-time probed interactive-shell PATH and version-manager vars while leaving secrets untouched (so env-based auth like `ANTHROPIC_API_KEY`/`CLAUDE_CODE_*` survives). Degrades to `process.env` unchanged if the probe has not run.
