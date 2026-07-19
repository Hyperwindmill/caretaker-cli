# caretaker-vscode

## 0.13.0

### Patch Changes

- Updated dependencies [29c61bf]
  - @hyperwindmill/caretaker-cli@0.13.0
  - webview-ui@0.13.0

## 0.12.2

### Patch Changes

- 9517ff3: feat(tasks): show the reviewer agent identity on review output in the task log

  Review output was rendered as a plain user bubble, so it wasn't clear which
  agent ran the review. The `review` message now stores the reviewer's
  `name · model` (captured at run time, like the per-cycle developer/planner
  label) and renders as a labeled "🔎 Code review" bubble, confirming the review
  was done by the expected agent.

- aac46b1: fix(tasks): persist the running agent identity on each cycle message so the log distinguishes planner from developer

  The previous label resolved the agent live in the UI by message type, which
  couldn't tell a planning cycle's heartbeat output from a developer cycle's — so
  planning bubbles showed the developer name. The per-cycle message now stores
  `agentLabel` (`name · model`) captured at run time from the role-resolved agent,
  and the thread renders that. It's text of the moment, so it stays correct even
  if the agent is later renamed or re-modelled. The live UI heuristic remains only
  as a fallback for older messages.

- Updated dependencies [d078b90]
- Updated dependencies [9517ff3]
- Updated dependencies [aac46b1]
  - @hyperwindmill/caretaker-cli@0.12.2
  - webview-ui@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [ebe9181]
  - @hyperwindmill/caretaker-cli@0.12.1
  - webview-ui@0.12.1

## 0.12.0

### Minor Changes

- 6011525: feat(tasks): configurable per-cycle run budget (maxRunSeconds) at project and task level

  The per-invocation wall-clock budget is now configurable instead of a hardcoded
  value, and it's a real enforced abort for every provider — not just prompt text
  for native runs. `maxRunSeconds` resolves task → project → provider default
  (120s native, 900s claude-code) via `resolveMaxRunSeconds`, and the run (plus
  the review pass) aborts when it exceeds the budget, reusing the same
  AbortController that Pause fires. Set it on the project settings form or per task
  in the task settings; leave empty to inherit. Native runs stay additionally
  turn-bounded by `agent.maxTurns`.

- 5372744: feat(tasks): project-level bootstrap commands run once on worktree setup

  Projects gain an optional `bootstrapCommands` list. When a task worktree is
  first created (git projects only), the commands run once in order — before the
  agent's first cycle — so the agent doesn't spend tokens on setup like
  `pnpm install`. The run stops at the first command that fails and blocks the
  task with the failed command and its output as the reason. Configured via a new
  "Bootstrap Commands" field in the project settings form.

### Patch Changes

- 69d442d: fix(tasks): restore the Pause/Activate button in the task log view and make it available during planning and reviewing

  The refactor dropped the pause control from the task log header, so an autonomous
  task viewed in its log could no longer be paused. The button is back in the log
  header and, together with the task detail view, now treats `planning` and
  `reviewing` as pausable (not just `active`) — pausing an off-track agent aborts
  the current cycle (the heartbeat skips post-processing on a paused task) and
  prevents the next one, whatever phase the task is in.

- 8a27f64: feat(tasks): show the agent name and model on assistant bubbles in the task log

  Assistant messages in the task execution thread said only "assistant". They now
  carry the responsible agent's `name · model` — the developer agent for cycle
  output, the planner agent for the submitted plan — resolved with the same
  task → project → default fallback chain the runtime uses. Regular chat is
  unchanged (still "assistant").

- Updated dependencies [6011525]
- Updated dependencies [5372744]
- Updated dependencies [69d442d]
- Updated dependencies [4cbc578]
- Updated dependencies [8a27f64]
  - @hyperwindmill/caretaker-cli@0.12.0
  - webview-ui@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [8e81883]
- Updated dependencies [14efee3]
  - @hyperwindmill/caretaker-cli@0.11.2
  - webview-ui@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies
  - @hyperwindmill/caretaker-cli@0.11.1
  - webview-ui@0.11.1

## 0.11.0

### Patch Changes

- 8e0ce22: Security: remediate GitHub Dependabot alerts.
  - Add `pnpm.overrides` pinning patched versions of transitive deps (undici, form-data, tmp, lodash-es, markdown-it, linkify-it, qs, js-yaml, esbuild) and bump direct `hono` to `^4.12.25`; bump direct `esbuild` to `^0.28.1` in webview-ui and vscode-extension — clears the transitive/direct alerts, no code changes.
  - Replace `xlsx` (SheetJS) with `exceljs` for `.xlsx` reading in `read_document`/`read_attachment`. SheetJS had two unpatched HIGH advisories (ReDoS, prototype pollution) with no npm fix available. **Behavior change:** legacy binary `.xls` is no longer supported (exceljs reads `.xlsx`/`.csv` only); `.xls` now returns an "unsupported format" message suggesting conversion.
  - Wrap a `Buffer` in `Uint8Array` at the desktop tray-icon fallback write to satisfy the refreshed `@types/node` typing.

- Updated dependencies [aa6fc4e]
- Updated dependencies [8e0ce22]
  - @hyperwindmill/caretaker-cli@0.11.0
  - webview-ui@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [3cef808]
- Updated dependencies [50c9a6b]
- Updated dependencies [50c9a6b]
  - caretaker-cli@0.10.1
  - webview-ui@0.10.1

## 0.10.0

### Minor Changes

- 8f3112d: Claude Code as an optional runner: new provider type `claude-code` runs agents
  through `claude -p` (stream-json) on every surface — chat, headless, scheduler,
  and autonomous tasks (task tools exposed via a token-guarded HTTP MCP bridge).
  Agents on such providers use Claude Code's own tools and permission modes
  (new per-agent permission-mode setting; unattended runs force bypassPermissions).

### Patch Changes

- Updated dependencies [7466cd2]
- Updated dependencies [8f3112d]
  - caretaker-cli@0.10.0
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
  - caretaker-cli@0.9.0
  - webview-ui@0.9.0

## 0.8.0

### Minor Changes

- 308a369: Task agent roles and planning phase: assign a distinct PLANNER, DEVELOPER, and REVIEWER agent per project or per task (planner/reviewer degrade onto the developer chain). New default-on PLANNING phase: activated tasks start in `planning`, where the planner agent runs read-only (write/edit/multiedit/bash stripped), iterates across heartbeat cycles, and starts execution explicitly via the new `task_submit_plan` tool — the plan is persisted to the task thread and replayed to the executing agent. The DONE review gate is now toggleable per project/task (`reviewEnabled`, default on) and runs under the reviewer-role agent. New/extended APIs: `PATCH /api/tasks/:id/agent` (role param), `PATCH /api/tasks/:id/flags`, role/flag fields on task and project creation; task tools gain `task_submit_plan`, a `role` param on `task_set_agent`, and role/flag params on `task_create`.

### Patch Changes

- 28bce1c: Hide Projects settings tab from the VSCode extension

  Completes the gating introduced in 59d3703: the VSCode sidebar no longer shows the "Projects" tab in Settings either. Projects (autonomous tasks) is scheduler-driven, and the VSCode surface never boots the scheduler, so the tab was misleading there. The "Projects" settings tab and the Projects screen are now both gated to the `sidebar` layout (web/desktop) only — matching the Scheduler settings tab. Web and desktop surfaces keep full Projects functionality unchanged.

- Updated dependencies [308a369]
- Updated dependencies [defe86c]
- Updated dependencies [28bce1c]
  - caretaker-cli@0.8.0
  - webview-ui@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [f9a2f4e]
- Updated dependencies [5e6498d]
  - caretaker-cli@0.7.0
  - webview-ui@0.7.0

## 0.6.2

### Patch Changes

- Updated dependencies [40aca7b]
  - caretaker-cli@0.6.2
  - webview-ui@0.6.2

## 0.6.1

### Patch Changes

- 5d0c60d: Fix attachments silently dropped in the VSCode sidebar: the webview sent them with the `start` message, but the extension host ignored the field, so the agent never saw attached files (reported as "PDF reading doesn't work"). The host now persists each attachment via `saveAttachment` and passes the records to the harness (`promptAttachments` + `sessionId`), matching the web server behaviour — `read_attachment` now resolves correctly in the sidebar too.
- Updated dependencies [2714e9c]
  - caretaker-cli@0.6.1
  - webview-ui@0.6.1

## 0.6.0

### Minor Changes

- 61a0d81: Add task archive and delete: archived tasks are hidden by default with a "Show archived" toggle and are excluded from the scheduler heartbeat; delete permanently removes a task and its messages from the store. Both are available as MCP tools (task_archive, task_unarchive, task_delete), REST endpoints, and confirm-gated UI actions. A locked/running task cannot be deleted (409) to avoid zombie resurrection by the heartbeat.

### Patch Changes

- Updated dependencies [95dd100]
- Updated dependencies [61a0d81]
- Updated dependencies [ada15d2]
- Updated dependencies [04c6f3e]
  - webview-ui@0.6.0
  - caretaker-cli@0.6.0

## 0.5.0

### Minor Changes

- 699a67d: Add conversation delete to the web app and VSCode sidebar

  The TUI already supported deleting chat sessions; the web GUI and the
  VSCode sidebar did not. Wire a `deleteSession` message through the
  host↔view bridge and handle it in both hosts (the local web server and
  the VSCode sidebar), then expose a delete button (with a confirmation
  prompt) on each conversation row in the sidebar sessions list and the
  conversations dropdown. Deleting the active conversation clears the
  chat view and refreshes the sessions list.

### Patch Changes

- Updated dependencies [97d36f8]
- Updated dependencies [699a67d]
- Updated dependencies [fb5020f]
- Updated dependencies [0704fc5]
- Updated dependencies [06cc49e]
  - caretaker-cli@0.5.0
  - webview-ui@0.5.0

## 0.4.2

### Patch Changes

- Updated dependencies [2656cfc]
  - caretaker-cli@0.4.2
  - webview-ui@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [0d70758]
  - caretaker-cli@0.4.1
  - webview-ui@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [0eac4c4]
  - caretaker-cli@0.4.0
  - webview-ui@0.4.0

## 0.3.6

### Patch Changes

- 59d3703: VSCode sidebar no longer exposes the Projects (autonomous tasks) entry point. Projects is scheduler-driven, and the VSCode surface never boots the scheduler, so the button was misleading there. It's now gated to the sidebar layout (web/desktop) only — the same gating already applied to the Scheduler settings tab.
- 08126cf: Fix: model "thinking"/reasoning blocks now appear live during streaming, not only after reloading a past conversation. The harness loop already emitted `onThinking` and persisted the parts, but the surfaces (web server, VSCode sidebar) never forwarded the event and the bridge contract had no `thinking` message, so live turns silently dropped it. Added a `thinking` event to the `HostToView` contract and wired it through both surfaces and the webview reducer.
- cf07a9d: Replace emoji icons with lucide-react across the whole webview UI (chat surface + all settings/scheduler/projects tabs). Icons are SVG that inherit `currentColor`, so they follow the theme (light/dark) and render consistently across platforms — unlike the previous OS-dependent emoji. Icon choices are centralized in a single `icons.ts` module. Also removed the now-unused `@vscode/codicons` dependency from the VSCode extension (it was a dead CSS import; the extension renders the shared webview UI), so the whole product uses one icon system. Icon-button colors were adjusted so the new SVG glyphs stay legible on dark cards.
- Updated dependencies [219ade5]
- Updated dependencies [59d3703]
- Updated dependencies [08126cf]
- Updated dependencies [cf07a9d]
  - webview-ui@0.3.6
  - caretaker-cli@0.3.6

## 0.3.5

### Patch Changes

- Updated dependencies [f9d9e93]
  - caretaker-cli@0.3.5
  - webview-ui@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [0cd08e4]
  - caretaker-cli@0.3.4
  - webview-ui@0.3.4

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
