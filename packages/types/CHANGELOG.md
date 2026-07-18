# caretaker-types

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

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.1

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

- 28bce1c: Hide Projects settings tab from the VSCode extension

  Completes the gating introduced in 59d3703: the VSCode sidebar no longer shows the "Projects" tab in Settings either. Projects (autonomous tasks) is scheduler-driven, and the VSCode surface never boots the scheduler, so the tab was misleading there. The "Projects" settings tab and the Projects screen are now both gated to the `sidebar` layout (web/desktop) only — matching the Scheduler settings tab. Web and desktop surfaces keep full Projects functionality unchanged.

## 0.7.0

## 0.6.2

## 0.6.1

## 0.6.0

### Minor Changes

- 61a0d81: Add task archive and delete: archived tasks are hidden by default with a "Show archived" toggle and are excluded from the scheduler heartbeat; delete permanently removes a task and its messages from the store. Both are available as MCP tools (task_archive, task_unarchive, task_delete), REST endpoints, and confirm-gated UI actions. A locked/running task cannot be deleted (409) to avoid zombie resurrection by the heartbeat.

## 0.5.0

## 0.4.2

## 0.4.1

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

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

### Patch Changes

- 77d3d8a: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.

## 0.2.1

### Patch Changes

- 254fba9: Extracted shared static types into caretaker-types leaf package to resolve the cyclic workspace dependency between caretaker-cli and webview-ui.
