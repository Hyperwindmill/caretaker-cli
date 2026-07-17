# caretaker-cli

## 0.10.1

### Patch Changes

- 3cef808: fix(claude-code): drop empty thinking blocks. Opus (extended thinking off) emits an empty `thinking` block in the final assistant message; it was persisted and rendered as an empty "Thinking Process" box when a chat was reloaded (never live). Guard at parse time (`claude_code_stream`) plus render-side guards in the web and TUI reload paths so already-persisted empty blocks are hidden too.
- 50c9a6b: fix(tui): stop the shell-env probe from suspending the TUI on Linux. The boot-time interactive-shell probe (`bash -i -c env`, used to pick up NVM/volta PATH) ran in the same session as the process, so its job-control setup sent SIGTTIN/SIGTTOU to our process group and stopped the TUI right after the menu rendered (`[1]+ Stopped`). Spawning it `detached: true` (own session, no controlling terminal) disables bash's job control while still sourcing `.bashrc`.
- 50c9a6b: fix(tui): exit the process cleanly on ESC/Quit. `runCli` rendered the Ink app and returned without awaiting `waitUntilExit()`, so `useApp().exit()` (ESC or the Quit menu item) unmounted the UI but left the event loop alive on background boot handles (MCP pool, model-limits fetch, refresh-on-start) — the TUI looked frozen until Ctrl+C. Now `runCli` awaits `waitUntilExit()` and `process.exit(0)`s.
- Updated dependencies [3cef808]
  - webview-ui@0.10.1
  - caretaker-types@0.10.1

## 0.10.0

### Minor Changes

- 8f3112d: Claude Code as an optional runner: new provider type `claude-code` runs agents
  through `claude -p` (stream-json) on every surface — chat, headless, scheduler,
  and autonomous tasks (task tools exposed via a token-guarded HTTP MCP bridge).
  Agents on such providers use Claude Code's own tools and permission modes
  (new per-agent permission-mode setting; unattended runs force bypassPermissions).

### Patch Changes

- 7466cd2: Final-review fixes for the Claude Code runner: the task bridge URL now honors `--host` instead of hardcoding `127.0.0.1`; claude-code task heartbeat and review cycles are now bounded by a 15-minute wall-clock timeout (the Claude Code CLI has no `--max-turns`); a stale/GC'd `--resume` session id is retried once without `--resume` instead of wedging the session forever; and Windows spawn-error messages now hint at pointing the provider `command` at `claude.exe` instead of an npm `.cmd` shim.
- Updated dependencies [8f3112d]
  - caretaker-types@0.10.0
  - webview-ui@0.10.0

## 0.9.0

### Minor Changes

- d96430e: Planner SDD mode (opt-in): a new `sddEnabled` tri-state gate (task inherits from project, default off) lets the planner create and edit markdown files during the planning phase — write/edit/multiedit are wrapped with a `.md`-only path guard instead of stripped, while bash stays unavailable. Spec conventions (where/how) are left to the project's own AGENTS.md / agent prompt; the documents land on the task branch via the per-cycle WIP commit. Surfaced everywhere the other gates are: `task_create` (`sdd_enabled`), `task_get_state`, `PATCH /api/tasks/:id/flags`, task/project creation APIs, and the task/project settings UI.

### Patch Changes

- a032ea2: Task worktree auto-commits now use `chore(auto): <title>` instead of `wip: <title>` — `wip` is not a conventional-commits type, so commitlint-style hooks and wip-detecting tools warned on the machine-made commits.
- 537a413: Fix misleading planner/reviewer fallback labels: at task level an unset role falls back to the project-level role first (then the developer chain), so the empty option now reads "Project default" instead of "Same as developer"; tooltips spell out the actual chain. Project-level selects read "Same as assigned agent" (accurate there — a project role has no higher default). Also fixes the project "Planning Phase" select claiming the default is Off — the unset default is On.
- Updated dependencies [a032ea2]
- Updated dependencies [d96430e]
- Updated dependencies [537a413]
  - caretaker-types@0.9.0
  - webview-ui@0.9.0

## 0.8.0

### Minor Changes

- 308a369: Task agent roles and planning phase: assign a distinct PLANNER, DEVELOPER, and REVIEWER agent per project or per task (planner/reviewer degrade onto the developer chain). New default-on PLANNING phase: activated tasks start in `planning`, where the planner agent runs read-only (write/edit/multiedit/bash stripped), iterates across heartbeat cycles, and starts execution explicitly via the new `task_submit_plan` tool — the plan is persisted to the task thread and replayed to the executing agent. The DONE review gate is now toggleable per project/task (`reviewEnabled`, default on) and runs under the reviewer-role agent. New/extended APIs: `PATCH /api/tasks/:id/agent` (role param), `PATCH /api/tasks/:id/flags`, role/flag fields on task and project creation; task tools gain `task_submit_plan`, a `role` param on `task_set_agent`, and role/flag params on `task_create`.

### Patch Changes

- defe86c: Fix tasks page UX: restore one-click archive, fix "not found" after archiving, and bring the checklist back into the task log view.
  - Fix archive navigation: after archiving/unarchiving from the edit view, navigate back to the list (previously left the user on a "Task not found" screen when "Show archived" was off).
  - Add an inline Archive button on each task row in the list view (with a confirm dialog), restoring the one-click archive flow.
  - Restore the checklist sidebar on the left side of the task log view, with live progress count and toggleable items.

- 28bce1c: Hide Projects settings tab from the VSCode extension

  Completes the gating introduced in 59d3703: the VSCode sidebar no longer shows the "Projects" tab in Settings either. Projects (autonomous tasks) is scheduler-driven, and the VSCode surface never boots the scheduler, so the tab was misleading there. The "Projects" settings tab and the Projects screen are now both gated to the `sidebar` layout (web/desktop) only — matching the Scheduler settings tab. Web and desktop surfaces keep full Projects functionality unchanged.

- Updated dependencies [308a369]
- Updated dependencies [defe86c]
- Updated dependencies [28bce1c]
  - caretaker-types@0.8.0
  - webview-ui@0.8.0

## 0.7.0

### Minor Changes

- f9a2f4e: Add per-task agent assignment, allowing a specific agent to be assigned to
  a task to override the project's default agent.
  - **Task schema**: the `Task` record gains an optional `agentId` field
    (`string | null`). When `null` or unset, the project's default agent is
    used (existing behaviour).
  - **MCP tools**: `task_create` accepts a new optional `agent_id` parameter.
    A new `task_set_agent` tool allows reassigning a task's agent at any time
    (refused while the task is running).
  - **REST API**: `POST /api/projects/:id/tasks` accepts `agentId` in the
    request body. A new `PATCH /api/tasks/:id/agent` endpoint reassigns the
    agent (409 if the task is currently running).
  - **Scheduler heartbeat**: `runTaskHeartbeatTick` resolves the agent as
    `task.agentId` → `project.agentId` → first agent in `agents.json`.
  - **Web UI**: the New Task form has an agent selector dropdown ("Project
    default" + all configured agents). The task list table has a new "Agent"
    column. The task edit view has an agent selector that is disabled while
    the task is active/reviewing (pause first to reassign).
  - **`task_get_state`** now includes `agentId` in its response.

- 5e6498d: Restructure the autonomous task page into a multi-view section with a paginated
  tasks table, a dedicated task log route, and a dedicated task edit route.
  - The task page is no longer an all-in-one 3-column layout. It now uses a
    lightweight view-router with three routes: **list**, **log**, and **edit**.
    The tasks table gets the full width of the pane.
  - **Project filter**: the projects sidebar is replaced by a project filter
    dropdown at the top of the list view. The selected project is persisted to
    localStorage and remembered across sessions, defaulting to the first project
    on first load. The "Show archived" toggle is also persisted.
  - Project management (add / delete) is removed from this view — projects are
    created and managed from the Settings panel instead.
  - **List view**: a proper paginated tasks table (20 rows/page) with columns
    for ID, title, status badge, checklist progress bar, branch, last-updated
    timestamp, and an edit action. Row click opens the log view; the edit
    button opens the edit view.
  - **Log view**: the execution thread (messages + composer) is now its own
    route with a back button and a status-aware header, keeping the live 3s
    polling.
  - **Edit view**: the objective, checklist, and status actions (pause /
    activate / archive / delete / discard worktree) live in their own route
    with a back button and a "View Log" shortcut.
  - Back buttons reuse the existing `.settings-panel__back-btn` style. New
    CSS classes (`.task-table`, `.task-table__pagination`, `.task-view__header`,
    `.task-view__project-filter`) were added to `styles.css`.

### Patch Changes

- Updated dependencies [f9a2f4e]
- Updated dependencies [5e6498d]
  - webview-ui@0.7.0
  - caretaker-types@0.7.0

## 0.6.2

### Patch Changes

- 40aca7b: Fix PDF parsing crash in the VSCode extension host: unpdf's bundled pdfjs assigns `globalThis.navigator` at import time, which throws ("Cannot set property navigator ... only a getter") on hosts exposing navigator as a getter-only nullish property. `read_document`/`read_attachment` now redefine it as a writable data property before loading unpdf. Also replace the PDF fallback: pandoc cannot read PDFs (write-only), so the fallback now uses pdftotext (poppler) when installed.
  - webview-ui@0.6.2
  - caretaker-types@0.6.2

## 0.6.1

### Patch Changes

- 2714e9c: Add pandoc fallback for PDF parsing: `read_document` and `read_attachment` try the native unpdf parser first, and if it throws, fall back to pandoc when installed on the system. If pandoc also fails, a combined error (unpdf + pandoc) is surfaced; if pandoc is not installed, the original unpdf error propagates. Defensive hardening — extraction failures now always have a recovery path or a clear error.
  - webview-ui@0.6.1
  - caretaker-types@0.6.1

## 0.6.0

### Minor Changes

- 61a0d81: Add task archive and delete: archived tasks are hidden by default with a "Show archived" toggle and are excluded from the scheduler heartbeat; delete permanently removes a task and its messages from the store. Both are available as MCP tools (task_archive, task_unarchive, task_delete), REST endpoints, and confirm-gated UI actions. A locked/running task cannot be deleted (409) to avoid zombie resurrection by the heartbeat.
- 04c6f3e: Autonomous git tasks now enter a `reviewing` state between `active` and `done`.
  `task_complete` sends a git-isolated task to `reviewing`; the DONE review runs
  as its own heartbeat cycle (no longer inline), transitioning to `active` on
  changes-requested or `done` on pass/max-rounds. The UI shows reviewing tasks as
  active (purple, with a Pause control and an "In review" label) instead of
  misleadingly inactive. Non-git tasks finalize directly to `done` as before.

### Patch Changes

- ada15d2: Task chat now reuses the normal chat renderer (MessageList): markdown, thinking, and tool blocks render consistently with the interactive chat instead of raw plain text.
- Updated dependencies [95dd100]
- Updated dependencies [61a0d81]
- Updated dependencies [ada15d2]
- Updated dependencies [04c6f3e]
  - webview-ui@0.6.0
  - caretaker-types@0.6.0

## 0.5.0

### Minor Changes

- 97d36f8: Autonomous tasks now run in a dedicated git worktree on a per-task branch (caretaker/task-<id>-<slug>). Progress is committed every heartbeat cycle; on completion the worktree is removed and the branch is left for review. Non-git projects run in place as before. Adds a "Discard worktree" action (web button + mcp**task**task_discard_worktree tool).
- 699a67d: Add conversation delete to the web app and VSCode sidebar

  The TUI already supported deleting chat sessions; the web GUI and the
  VSCode sidebar did not. Wire a `deleteSession` message through the
  host↔view bridge and handle it in both hosts (the local web server and
  the VSCode sidebar), then expose a delete button (with a confirmation
  prompt) on each conversation row in the sidebar sessions list and the
  conversations dropdown. Deleting the active conversation clears the
  chat view and refreshes the sessions list.

- fb5020f: Autonomous tasks now run an independent code-review pass when they reach DONE. If the review requests changes, the task reopens (worktree kept) and the review is left in the task history for the agent to address next cycle; a PASS removes the worktree and keeps the branch. Capped at 3 review rounds.

### Patch Changes

- 06cc49e: Autonomous task WIP commits now use `--no-verify` and supply a fallback git identity only when the target repo has none configured. Previously a repo with a failing pre-commit hook (husky/lint-staged) or no configured `user.name`/`user.email` would make every WIP commit throw — silently stalling progress each heartbeat and, worse, leaving the worktree undeletable at DONE (and via the manual discard button), since worktree removal runs only after a successful commit.
- Updated dependencies [97d36f8]
- Updated dependencies [699a67d]
- Updated dependencies [fb5020f]
- Updated dependencies [0704fc5]
  - webview-ui@0.5.0
  - caretaker-types@0.5.0

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
