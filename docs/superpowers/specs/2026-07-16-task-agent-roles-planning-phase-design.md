# Task Agent Roles (Planner / Developer / Reviewer) + Mandatory Planning Phase

**Date**: 2026-07-16
**Status**: Approved design, pre-implementation

## Goal

Extend the autonomous task system with role-based agent assignment — PLANNER, DEVELOPER, REVIEWER — configurable at both project and task level, and introduce a PLANNING phase (default on, opt-out per project/task) in which the planner agent runs without write tools, must record a plan as a task message, and explicitly hands off to execution. The review gate becomes toggleable with the same project/task semantics.

## Non-goals

- No planning phase for the review itself.
- No roles beyond the three.
- No automatic re-planning on `CHANGES_REQUESTED` — the developer reads the review plus the plan from history and decides.
- The review stays git-diff based: `reviewEnabled` can disable it for git tasks but cannot enable it for non-git tasks.

## Data model

### Task (`packages/cli/src/store/db.ts`)

- `status` enum gains `'planning'`: `'draft' | 'planning' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done'`.
- New fields:
  - `plannerAgentId?: string | null` — per-task planner override (null/undefined = inherit).
  - `reviewerAgentId?: string | null` — per-task reviewer override.
  - `planningEnabled?: boolean` — tri-state: `undefined` = inherit from project.
  - `reviewEnabled?: boolean` — tri-state: `undefined` = inherit from project.

### Project

- New fields: `plannerAgentId?`, `reviewerAgentId?`, `planningEnabled?`, `reviewEnabled?`.
- `planningEnabled` and `reviewEnabled` default (`undefined`) = **ON**.
- Existing `agentId` on task and project **is** the DEVELOPER role. No migration.

### TaskMessage

- `messageType` gains `'plan'`. Plan messages are included in the history replay set (`chat`, `heartbeat`, `tool_call`, `review`, `plan`) so the developer sees the plan in later cycles — same mechanism as `review` messages.

### Backward compatibility

- Tasks already `active`/`reviewing`/`paused`/`blocked` are untouched — `planning` only enters via activation.
- With zero new config, behavior differs from today only in one way: newly activated tasks go through planning (project default ON). Everything else (agent resolution, review) is byte-identical.

## Agent resolution per role

Each role degrades onto the existing developer chain (`task_strategy.ts:97-104`):

- **Developer** (unchanged): `task.agentId → project.agentId → agents[0]`.
- **Planner**: `task.plannerAgentId → project.plannerAgentId → developer chain`.
- **Reviewer**: `task.reviewerAgentId → project.reviewerAgentId → developer chain`.

A role id pointing to a deleted agent falls through the chain (same behavior as `task.agentId` today).

## Lifecycle

```
draft → [planning] → active → [reviewing] → done
```

### Activation

`task_activate` (tool + API): if resolved `planningEnabled` is ON → `status = 'planning'`; else `'active'` as today. Same for `task_create` flows that activate directly.

### Planning cycle

Heartbeat selection (`task_strategy.ts:63-71`) adds `'planning'` to the selected statuses. A task in `planning` runs a dedicated cycle branch (same pattern as the `reviewing` branch at `task_strategy.ts:140-143`):

- **Agent**: planner resolution chain.
- **Tools**: resolved via `resolveAgentTools` for the planner agent (with `mcp__task__*` forced in, as today), then post-filtered to strip `write`, `edit`, `multiedit`, `bash` — same mechanism as the review's `mcp__task__*` strip (`task_review.ts:54`). The planner keeps `read_file`, `glob`, `grep`, and the task tools (it needs checklist and messages).
- **Prompt**: dedicated planning prompt — explore the codebase read-only, produce a plan, populate/refine the checklist, call `task_submit_plan` when done; `task_yield` to continue next cycle.
- **Worktree**: unchanged — lazily created on the first cycle, so planning already runs inside it. Harmless: the planner is read-only.
- **Multi-cycle**: the planner may yield across cycles to iterate. The no-progress guard stays as a safety net (checklist updates count as progress, as today).
- **History replay**: same as execution cycles (plan messages included).

### Transition: `task_submit_plan`

New builtin tool `task_submit_plan({ task_id, plan })`:

- Valid only while `status === 'planning'` (error otherwise).
- Persists the plan as a TaskMessage with `messageType: 'plan'`.
- Transitions `planning → active`, clears the lock, bumps `updatedAt`.

Guards:

- `task_complete` called while in `planning` → error: "submit a plan first (task_submit_plan)".
- Fail-safe: without an explicit submit the task stays in `planning` (no implicit transition).

### Execution cycle

Unchanged. The developer agent finds the plan in replayed history.

### Review cycle

`runReviewCycle` / `runDoneReview` resolve the **reviewer** chain instead of reusing the task's agent: reviewer identity, `systemPrompt`, and `allowedTools` drive the review run. Everything else (prompt, verdict parsing, `MAX_REVIEW_ROUNDS`, round derivation from `review` messages, worktree finalize) is unchanged.

### Review gate toggle

In `task_complete`: review triggers only if resolved `reviewEnabled` is ON **and** `task.worktreePath` is set. With the flag OFF (or non-git): `task_complete` → `done` directly, worktree removed, branch kept — the existing finalize path.

If `reviewEnabled` is turned OFF while a task is already `reviewing`, the next tick finalizes it directly without running the review — the flag is read at decision time, consistent with how Pause is respected mid-review.

## UI + API

### `packages/cli/src/cli/web/server.ts`

- Task role assignment: extend `PATCH /api/tasks/:id/agent` with an optional `role` field (`developer` default, `planner`, `reviewer`), or twin routes — implementation detail, one endpoint preferred.
- Task flags: `planningEnabled` / `reviewEnabled` settable on task create and via PATCH.
- Project create/update: accept the four new fields.

### `packages/webview-ui/src/ProjectsTab.tsx`

- Mirror the status enum (+ `'planning'`) and `statusColor` (planning rendered as an active-family state; Pause affordance applies, like `reviewing`).
- Task detail + new-task form: planner/reviewer selectors (default "inherit") next to the existing agent selector; planning/review toggles (default "inherit").
- Project settings: planner/reviewer selectors + planning/review default toggles.

### Model-facing tools (user affordance = also a tool)

- `task_set_agent` gains an optional `role` parameter (`developer` default, `planner`, `reviewer`), same guards as today.
- `task_create` accepts `planner_agent_id`, `reviewer_agent_id`, `planning_enabled`, `review_enabled`.
- New `task_submit_plan` (above).

## Error handling

- `task_submit_plan` outside `planning` → tool error.
- `task_complete` inside `planning` → tool error with pointer to `task_submit_plan`.
- Planner/reviewer id not found in `agents.json` → silent fall-through down the resolution chain (matches current `task.agentId` behavior).
- Crash mid-planning-cycle: task stays `planning`, lock released by the existing `finally`, next tick retries — same recovery model as `reviewing`.

## Testing

Co-located `*.test.ts`, Node test runner via tsx (per repo convention):

- Resolution chain unit tests: planner/reviewer fall-through (task → project → developer chain), deleted-agent fall-through.
- `task_submit_plan`: transition, message persisted as `plan`, error outside `planning`.
- `task_complete`: error in `planning`; `reviewEnabled` OFF → direct `done`; ON + worktree → `reviewing` (existing behavior preserved).
- Planning tool filter: resolved toolset for a planning cycle contains no `write`/`edit`/`multiedit`/`bash`.
- Heartbeat selection includes `planning`; planning cycle uses the planner agent.
- Replay: `plan` messages included in history.
- Env isolation: `CARETAKER_HOME` mutated at file scope only.

## Docs

`CLAUDE.md` (architecture layer 5 + State on disk) and `README.md` updated in the same unit of work. Changeset: `minor`.
