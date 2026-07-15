# caretaker-vscode

## 0.3.3

### Patch Changes

- Updated dependencies [254936d]
  - caretaker-cli@0.3.3
  - webview-ui@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [e30955c]
  - caretaker-cli@0.3.2
  - webview-ui@0.3.2

## 0.3.1

### Patch Changes

- Harden the Windows git-plugin reclone fallback and the extension packaging. The reclone's cache removal now uses Node's built-in retry (maxRetries/retryDelay) to ride out transient Windows file locks (Defender/indexer/host handles), matching the store's atomic-write retry policy. The VSCode extension gains a `vscode:prepublish` script so `vsce package` always rebuilds first and can never ship a stale `dist/` bundle.
- Updated dependencies
  - caretaker-cli@0.3.1
  - webview-ui@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [a48123e]
- Updated dependencies [f0273f4]
- Updated dependencies [805e0ac]
  - caretaker-cli@0.3.0
  - webview-ui@0.3.0

## 0.2.5

### Patch Changes

- 7c65a7f: fix: refresh agent config live when edited from another surface

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

- Updated dependencies [7c65a7f]
  - caretaker-cli@0.2.5
  - webview-ui@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [287021a]
  - webview-ui@0.2.4
  - caretaker-cli@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [7f7b33e]
- Updated dependencies [1a3ecbd]
  - caretaker-cli@0.2.3
  - webview-ui@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [77d3d8a]
  - webview-ui@0.2.2
  - caretaker-cli@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [254fba9]
- Updated dependencies [2da7533]
  - webview-ui@0.2.1
  - caretaker-cli@0.2.1
