# caretaker-desktop

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

- Updated dependencies [219ade5]
- Updated dependencies [59d3703]
- Updated dependencies [08126cf]
- Updated dependencies [cf07a9d]
  - webview-ui@0.3.6
  - caretaker-cli@0.3.6

## 0.3.5

### Patch Changes

- de68558: fix(desktop): packaged app opened on a white page because the backend crashed on startup with `Cannot find module 'es-object-atoms'`. electron-builder 26.8.1's pnpm node-modules collector dropped 13 transitive leaf dependencies (`es-object-atoms`, `mime-db`, `setprototypeof`, `unpipe`, and others in the Hono HTTP chain) from the asar, so the forked `caretaker-cli web` process died before binding its port and the BrowserWindow loaded a connection-refused page. Upgrading electron-builder to 26.15.6 fixes the collector; verified by unpacking the asar (13 missing → 0 runtime-relevant) and booting the packaged exe end-to-end (HTTP 200 from the embedded server).
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

- Fix Electron packaging for desktop: bundle CLI assets to prevent ENOENT crashes and load application icons compatibly from ASAR.
- Updated dependencies [77d3d8a]
  - webview-ui@0.2.2
  - caretaker-cli@0.2.2

## 0.2.1

### Patch Changes

- 2da7533: Established automated cross-package versioning and changelog tracking across the monorepo using Changesets.
- Updated dependencies [254fba9]
- Updated dependencies [2da7533]
  - webview-ui@0.2.1
  - caretaker-cli@0.2.1
