---
"caretaker-cli": patch
"caretaker-vscode": patch
---

fix: refresh agent config live when edited from another surface

- Web GUI (`caretaker-cli web`): `loadAgentsAndSend()` now updates `currentAgent` in-place when the file watcher detects changes to `agents.json`, instead of only refreshing the agent list. This means workingDir, allowedTools, plugins, and mcpServers changes are picked up immediately without restarting the server.

- VSCode sidebar: same fix applied to `loadAgentsAndSend()` in `sidebar.ts`.

- TUI: added a file watcher in `tui/agents.tsx` that refreshes the agent list and selected agent when `agents.json` changes, so edits from the web GUI or VSCode are visible immediately.

fix: bash tool probes interactive shell environment on Linux

On Linux, `.bashrc` typically exits early for non-interactive shells due to guards like `[ -z "$PS1" ] && return`. This means NVM, volta, fnm, and other version managers are NOT available even when spawning with `bash -l -c`.

New module `harness/tools/builtin/shell-env.ts` (ported from caretaker-agents-platform):

- At startup, probes the environment once using `bash -i -c 'env'` which DOES source `.bashrc`
- Extracts relevant variables: `PATH`, `NVM_DIR`, `NVM_BIN`, `VOLTA_HOME`, `FNM_DIR`, `GOPATH`, `CARGO_HOME`, `PYENV_ROOT`, etc.
- Caches the result and merges it into every bash subprocess environment
- On Windows and macOS, returns early (those platforms handle login shells correctly)

This ensures `pnpm`, `node`, and other version-managed tools are available in bash commands without requiring interactive shell spawning for every command.
