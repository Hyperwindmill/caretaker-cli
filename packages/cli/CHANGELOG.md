# caretaker-cli

## 0.3.1

### Patch Changes

- Harden the Windows git-plugin reclone fallback and the extension packaging. The reclone's cache removal now uses Node's built-in retry (maxRetries/retryDelay) to ride out transient Windows file locks (Defender/indexer/host handles), matching the store's atomic-write retry policy. The VSCode extension gains a `vscode:prepublish` script so `vsce package` always rebuilds first and can never ship a stale `dist/` bundle.
  - webview-ui@0.3.1
  - caretaker-types@0.3.1

## 0.3.0

### Minor Changes

- a48123e: Implement user prompt attachments (images and documents) with drag-and-drop, paste, and upload support in webview-ui, extension preservation on disk, and the new native `read_attachment` tool.
- f0273f4: Add native `read_document` tool to parse PDF, Word, and Excel files with pandoc fallback for unsupported formats. Add native `read_image` tool along with support for pointer-based tool attachments mapped directly to base64 user messages in LLM turns.

### Patch Changes

- 805e0ac: Fix git plugin refresh failing on Windows with a spurious "local changes" error. isomorphic-git's in-place fetch+checkout reports the working tree as dirty on Windows (filemode/stat mismatch or locked files) and throws even with `force: true`, where Linux succeeds. The updater now falls back to a fresh shallow reclone when the in-place update throws, self-healing the cache on any platform.
  - webview-ui@0.3.0
  - caretaker-types@0.3.0

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
  - webview-ui@0.2.5
  - caretaker-types@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [287021a]
  - webview-ui@0.2.4
  - caretaker-types@0.2.4

## 0.2.3

### Patch Changes

- 7f7b33e: Fix Hono web server to respect and apply the agent-specific working directory in chat sessions instead of falling back blindly to the server's launch folder.
- 1a3ecbd: Integrate visual filesystem directory picking (FolderPicker component on frontend, /api/fs/ls Hono route on backend) for intuitive project and local plugin path selection.
- Updated dependencies [1a3ecbd]
  - webview-ui@0.2.3
  - caretaker-types@0.2.3

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
- Updated dependencies [77d3d8a]
  - caretaker-types@0.2.2
  - webview-ui@0.2.2

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
- 2da7533: Established automated cross-package versioning and changelog tracking across the monorepo using Changesets.
- Updated dependencies [254fba9]
  - caretaker-types@0.2.1
  - webview-ui@0.2.1
