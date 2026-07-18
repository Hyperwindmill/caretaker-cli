# webview-ui

## 0.12.1

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

## 0.11.2

## 0.11.1

## 0.11.0

### Patch Changes

- 8e0ce22: Security: remediate GitHub Dependabot alerts.
  - Add `pnpm.overrides` pinning patched versions of transitive deps (undici, form-data, tmp, lodash-es, markdown-it, linkify-it, qs, js-yaml, esbuild) and bump direct `hono` to `^4.12.25`; bump direct `esbuild` to `^0.28.1` in webview-ui and vscode-extension — clears the transitive/direct alerts, no code changes.
  - Replace `xlsx` (SheetJS) with `exceljs` for `.xlsx` reading in `read_document`/`read_attachment`. SheetJS had two unpatched HIGH advisories (ReDoS, prototype pollution) with no npm fix available. **Behavior change:** legacy binary `.xls` is no longer supported (exceljs reads `.xlsx`/`.csv` only); `.xls` now returns an "unsupported format" message suggesting conversion.
  - Wrap a `Buffer` in `Uint8Array` at the desktop tray-icon fallback write to satisfy the refreshed `@types/node` typing.

## 0.10.1

### Patch Changes

- 3cef808: fix(claude-code): drop empty thinking blocks. Opus (extended thinking off) emits an empty `thinking` block in the final assistant message; it was persisted and rendered as an empty "Thinking Process" box when a chat was reloaded (never live). Guard at parse time (`claude_code_stream`) plus render-side guards in the web and TUI reload paths so already-persisted empty blocks are hidden too.

## 0.10.0

### Minor Changes

- 8f3112d: Claude Code as an optional runner: new provider type `claude-code` runs agents
  through `claude -p` (stream-json) on every surface — chat, headless, scheduler,
  and autonomous tasks (task tools exposed via a token-guarded HTTP MCP bridge).
  Agents on such providers use Claude Code's own tools and permission modes
  (new per-agent permission-mode setting; unattended runs force bypassPermissions).

## 0.9.0

### Minor Changes

- d96430e: Planner SDD mode (opt-in): a new `sddEnabled` tri-state gate (task inherits from project, default off) lets the planner create and edit markdown files during the planning phase — write/edit/multiedit are wrapped with a `.md`-only path guard instead of stripped, while bash stays unavailable. Spec conventions (where/how) are left to the project's own AGENTS.md / agent prompt; the documents land on the task branch via the per-cycle WIP commit. Surfaced everywhere the other gates are: `task_create` (`sdd_enabled`), `task_get_state`, `PATCH /api/tasks/:id/flags`, task/project creation APIs, and the task/project settings UI.

### Patch Changes

- a032ea2: Task worktree auto-commits now use `chore(auto): <title>` instead of `wip: <title>` — `wip` is not a conventional-commits type, so commitlint-style hooks and wip-detecting tools warned on the machine-made commits.
- 537a413: Fix misleading planner/reviewer fallback labels: at task level an unset role falls back to the project-level role first (then the developer chain), so the empty option now reads "Project default" instead of "Same as developer"; tooltips spell out the actual chain. Project-level selects read "Same as assigned agent" (accurate there — a project role has no higher default). Also fixes the project "Planning Phase" select claiming the default is Off — the unset default is On.

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

## 0.6.2

## 0.6.1

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

- 95dd100: Fix conversation delete in VSCode sidebar mode by replacing the disabled
  `window.confirm()` call with an inline React confirmation dialog. The
  overlay supports Escape-key and backdrop-click dismissal and renders
  correctly inside both the sidebar and chat layouts (fixes a JSX syntax
  error that broke the build).
- ada15d2: Task chat now reuses the normal chat renderer (MessageList): markdown, thinking, and tool blocks render consistently with the interactive chat instead of raw plain text.

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

- 0704fc5: Add folder picker to project creation modal

  The "Register New Project" modal in the Projects tab used a plain text input
  for the working directory path. It now uses the existing `FolderPicker`
  component (already used in project settings, agents, and plugins tabs), giving
  users a "Browse..." button to navigate the filesystem visually instead of
  typing the absolute path by hand.

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.6

### Patch Changes

- 219ade5: Web UI: tool use blocks are now collapsed by default. The compact header shows the tool name, a smart one-line arg preview (basename for path-like args such as read/write, the command for shell tools, else truncated JSON), a neutral outcome hint (spinner while running, then line count or byte size of the result), and a chevron. Clicking expands the full pretty-printed args and result. Reuses the existing `<details>` accordion pattern; no bridge/harness changes.
- 59d3703: VSCode sidebar no longer exposes the Projects (autonomous tasks) entry point. Projects is scheduler-driven, and the VSCode surface never boots the scheduler, so the button was misleading there. It's now gated to the sidebar layout (web/desktop) only — the same gating already applied to the Scheduler settings tab.
- 08126cf: Fix: model "thinking"/reasoning blocks now appear live during streaming, not only after reloading a past conversation. The harness loop already emitted `onThinking` and persisted the parts, but the surfaces (web server, VSCode sidebar) never forwarded the event and the bridge contract had no `thinking` message, so live turns silently dropped it. Added a `thinking` event to the `HostToView` contract and wired it through both surfaces and the webview reducer.
- cf07a9d: Replace emoji icons with lucide-react across the whole webview UI (chat surface + all settings/scheduler/projects tabs). Icons are SVG that inherit `currentColor`, so they follow the theme (light/dark) and render consistently across platforms — unlike the previous OS-dependent emoji. Icon choices are centralized in a single `icons.ts` module. Also removed the now-unused `@vscode/codicons` dependency from the VSCode extension (it was a dead CSS import; the extension renders the shared webview UI), so the whole product uses one icon system. Icon-button colors were adjusted so the new SVG glyphs stay legible on dark cards.

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.5

## 0.2.4

### Patch Changes

- 287021a: Improve FolderPicker UX: center and constrain max height to 50vh, increase z-index to 999999 for proper panel layering, and integrate FolderPicker on the Agent settings working directory input.

## 0.2.3

### Patch Changes

- 1a3ecbd: Integrate visual filesystem directory picking (FolderPicker component on frontend, /api/fs/ls Hono route on backend) for intuitive project and local plugin path selection.

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
