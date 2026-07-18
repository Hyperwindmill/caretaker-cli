---
"@hyperwindmill/caretaker-cli": patch
---

fix(tasks): bootstrap commands now resolve version-manager binaries (pnpm, npx, …)

`runBootstrap` (the per-project `bootstrapCommands` that run once on a fresh task
worktree) spawned each command with the raw `process.env`, which on Linux does not
source `~/.bashrc`. That left `pnpm`/`node`/`nvm`/`fnm`/`volta` off `PATH` when
installed via a version manager, so `pnpm install` failed with
`/bin/sh: pnpm: not found` and blocked the task. Bootstrap (and the internal
`git()` helper) now reuse the same probed interactive-shell environment the
`bash` tool already uses (`commandEnv()`), so user-installed tooling is found.
Secret env vars (`*_TOKEN`/`*_KEY`/`*_SECRET`/`OPENCODE_*`/`CLAUDE_*`) are
scrubbed the same way as for the `bash` tool.