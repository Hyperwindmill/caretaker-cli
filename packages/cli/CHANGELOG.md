# caretaker-cli

## 0.4.2

### Patch Changes

- 2656cfc: Heal Windows installs whose encryption key predates the owner-only ACL: the
  ACL is now re-applied once per process when an existing key is loaded, so
  keys created before the previous release get locked down on next launch
  without regenerating the key (which would orphan all existing ciphertext).
  - webview-ui@0.4.2
  - caretaker-types@0.4.2

## 0.4.1

### Patch Changes

- 0d70758: Protect the on-disk encryption key on Windows with an explicit owner-only ACL
  (`icacls`). `chmod 0600` only toggles the read-only bit on Windows and leaves
  the key readable via inherited ACLs, so the key is now locked to the current
  user at creation time — the Windows equivalent of the POSIX 0600 already
  applied elsewhere.
  - webview-ui@0.4.1
  - caretaker-types@0.4.1

## 0.4.0

### Minor Changes

- 0eac4c4: Add OAuth authentication for http MCP servers. An explicit per-server
  "Authenticate" action runs the SDK OAuth flow (Dynamic Client Registration +
  PKCE) via an ephemeral loopback callback, and tokens are stored AES-256-GCM
  encrypted in `mcp.json`. Passive connects use the saved tokens and refresh them
  automatically; unattended runs never open a browser.

  Re-authenticating on a fresh loopback port discards the stale DCR registration
  together with its orphaned tokens, so the browser flow runs cleanly instead of
  failing a refresh against a re-registered client.

### Patch Changes

- Updated dependencies [0eac4c4]
  - caretaker-types@0.4.0
  - webview-ui@0.4.0

## 0.3.6

### Patch Changes

- 08126cf: Fix: model "thinking"/reasoning blocks now appear live during streaming, not only after reloading a past conversation. The harness loop already emitted `onThinking` and persisted the parts, but the surfaces (web server, VSCode sidebar) never forwarded the event and the bridge contract had no `thinking` message, so live turns silently dropped it. Added a `thinking` event to the `HostToView` contract and wired it through both surfaces and the webview reducer.
- Updated dependencies [219ade5]
- Updated dependencies [59d3703]
- Updated dependencies [08126cf]
- Updated dependencies [cf07a9d]
  - webview-ui@0.3.6
  - caretaker-types@0.3.6

## 0.3.5

### Patch Changes

- f9d9e93: ci: stop adding `[skip ci]` to changesets version commits (`skipCI: "add"` in `.changeset/config.json`). The marker on RELEASING commits prevented tag-push-triggered workflows (the release pipeline) from ever running when the tag pointed at the version commit; it now remains only on `changeset add` commits.
  - webview-ui@0.3.5
  - caretaker-types@0.3.5

## 0.3.4

### Patch Changes

- 0cd08e4: ci: add a GitHub Actions release workflow (`.github/workflows/release.yml`), triggered on `v*` tag push or manual dispatch, that builds the Electron desktop app for Linux (`deb-package` artifact, `electron-builder --linux deb`) and Windows (`windows-installer` artifact, `electron-builder --win nsis`) and the VSCode extension (`vsix-package` artifact, `pnpm -F caretaker-vscode package`). A final `publish-release` job, gated on all three succeeding, downloads the artifacts and uses `softprops/action-gh-release` to create a **draft** GitHub Release for the pushed tag with the deb, exe, and vsix attached, with release notes assembled from the per-package Changesets CHANGELOG sections for that version (dependency-bump-only sections skipped). electron-builder runs with `--publish never` (its implicit publish-on-tag would otherwise fail without a GH_TOKEN), and the release job is skipped on non-tag manual dispatches. No runtime behavior changes.
  - webview-ui@0.3.4
  - caretaker-types@0.3.4

## 0.3.3

### Patch Changes

- 254936d: chore: prepare the repository for public release

  Add package metadata for a public repo: `license` (FSL-1.1-MIT via `SEE LICENSE IN LICENSE`), `author`, `repository`, `homepage`, `bugs`, and `keywords` across the workspace packages, and broaden the root description to cover all surfaces. No runtime behavior changes.
  - webview-ui@0.3.3
  - caretaker-types@0.3.3

## 0.3.2

### Patch Changes

- e30955c: fix(plugins): materialize tracked symlinks as plain files during git checkout on Windows

  Plugin "sync now" failed on Windows for any source repo that tracks a symlink
  (e.g. `CLAUDE.md -> AGENTS.md`): isomorphic-git's checkout calls `fs.symlink`,
  which throws `EPERM` without the `SeCreateSymbolicLinkPrivilege` (admin /
  Developer Mode). The git fetcher now wraps the `fs` handed to isomorphic-git so
  `symlink` falls back to writing a plain file containing the link target on
  `EPERM`/`EACCES` — mirroring git's own `core.symlinks=false` behavior (the
  Windows default). Real symlinks are still used everywhere the OS permits them.
  - webview-ui@0.3.2
  - caretaker-types@0.3.2

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
