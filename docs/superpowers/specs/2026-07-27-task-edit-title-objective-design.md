# Task Edit: editable title and objective — design

**Date:** 2026-07-27
**Task:** #25 "Edit issue" — *"Check tasks edit mode, the description seems to be never editable."*

## Problem

The task edit view (`TaskEditView` in `packages/webview-ui/src/ProjectsTab.tsx`) is
named "edit" but is read-only for the two fields that describe the work:

- `packages/webview-ui/src/ProjectsTab.tsx:1417` renders the **title** as an `<h3>`.
- `packages/webview-ui/src/ProjectsTab.tsx:1487-1494` renders the **objective** in a
  read-only `<div>` with `whiteSpace: 'pre-wrap'`.

Everything else on that view *is* editable (agents, phase flags, `maxRunSeconds`,
checklist checkboxes), which is exactly why the two static fields read as a bug.

The gap is not only in the UI. Neither surface below can change them either:

- **HTTP:** the task routes in `packages/cli/src/cli/web/server.ts` are
  `messages`, `status`, `discard-worktree`, `archive`, `unarchive`, `DELETE`,
  `checklist-item`, `PATCH …/agent`, `PATCH …/flags`. There is no route that writes
  `title` / `objective`. They are set once, at `POST /api/projects/:id/tasks`.
- **Tools:** `packages/cli/src/harness/tools/builtin/task_tools.ts` has
  `task_create` (writes both at creation) and `task_update_checklist` /
  `task_update_checklist_item`, but nothing that rewrites the title or objective of
  an existing task.

So this is a missing feature across the whole stack, not a disabled input.

## Decisions

### 1. One tool, one route, both fields, both optional

New builtin `mcp__task__task_update_details` with `{ task_id, title?, objective? }`;
new `PATCH /api/tasks/:id` with the same body shape. Absent key = leave alone
(the `'x' in body` pattern already used by `PATCH …/flags`), so a caller can change
the objective without resending the title.

Naming follows the existing `task_update_checklist` / `task_set_agent` family.
"details" rather than "task_update" so the tool never becomes a dumping ground for
every column — status, flags, agents and checklist each already have their own tool.

Mirroring the user affordance with a tool is a project rule (every user-invocable
feature has a builtin counterpart), and the `mcp__task__` prefix means both MCP
producers — the per-task HTTP bridge and the `caretaker-cli mcp` stdio server —
pick it up for free through `taskTools()` in `packages/cli/src/mcp/task_server.ts`.

### 2. Validation: a title is required, an objective is not

- `title`, when present: trimmed, and rejected when empty. A task with a blank title
  is unidentifiable in the list view.
- `objective`, when present: trimmed only. Empty is allowed — a task can legitimately
  be all-title (that is already possible via `task_create`).
- Anything not a string is rejected rather than coerced.

### 3. No running-task guard

`PATCH …/agent` returns 409 while the task is running because swapping identity
mid-cycle means the wrong agent finishes the run. Text has no such hazard: the
objective is read at the start of each cycle, so an edit lands on the next one.
Blocking the edit would only force the user to pause a task to fix a typo.

### 4. UI: explicit Save/Cancel, not save-on-blur

The `maxRunSeconds` field on the same view saves on blur with an uncontrolled
`defaultValue` + `key` remount. That pattern is wrong for a multi-line objective:
`ProjectsTab` refetches tasks on a 3 s interval while a task thread is open
(`packages/webview-ui/src/ProjectsTab.tsx:303-308`), and a remount driven by remote
state would discard whatever the user was typing.

So: local draft state seeded from the task, keyed on `task.id`; Save / Cancel appear
only when the draft differs from the stored values. Save is disabled on an empty
title, matching the server rule.

### 5. No new HTTP route test

`server.ts` registers its routes inline inside the function that also calls
`serve()`, so there is no `server.test.ts` in the repo and no task route is covered
today. Refactoring that for one route is out of scope. The tool carries the logic
tests (`task_tools.test.ts` exists and covers the sibling tools); the route is a thin
adapter over the same store calls and is verified by typecheck plus the manual check.

## Out of scope

- Editing checklist item **text** (add/remove/reword). Checkboxes stay toggle-only.
  Agents rewrite the checklist wholesale via `task_update_checklist`; a user-facing
  checklist editor is a separate feature.
- Editing the project's fields.
- An edit-history / audit trail for the objective.
