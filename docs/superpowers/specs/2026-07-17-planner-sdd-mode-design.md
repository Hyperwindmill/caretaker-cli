# Planner SDD Mode — Opt-in Markdown Writes During Planning

**Date**: 2026-07-17
**Status**: Approved design, pre-implementation
**Builds on**: `2026-07-16-task-agent-roles-planning-phase-design.md`

## Goal

An opt-in **SDD mode** (spec-driven development) that lets the planner agent create and edit **markdown files only** during the planning phase — enough to produce specs/plans/ADRs as real files on the task branch, while still mechanically preventing it from implementing.

## Principle: mechanism, not convention

Caretaker enforces only the mechanical boundary (planner writes = `.md` files, no bash). *How* and *where* specs are written — superpowers specs, ADRs, any house style — is deliberately left to the project's own conventions (AGENTS.md / the planner agent's `systemPrompt`). The UI copy ("legend") states this explicitly. No path/glob configuration in caretaker: that would be convention smuggled into mechanism.

## Non-goals

- No allowed-directory configuration (see above).
- No bash for the planner in any mode — that is the actual implementation brake.
- Not a security boundary: same convenience-sandbox pact as the existing tool sandbox (an SDD planner *can* touch README.md/CLAUDE.md; the mode is opt-in).
- No change to the `task_submit_plan` handoff: it stays mandatory; in SDD mode the submitted plan message can be short and reference the spec files.

## Data model

- **Task**: `sddEnabled?: boolean | null` — tri-state, `undefined` = inherit from project.
- **Project** (db mirror) and **ProjectConfig** (`packages/types`): `sddEnabled?: boolean | null`.
- Resolution: `resolveSddEnabled(task, project)` = `task.sddEnabled ?? project?.sddEnabled ?? false` — **default OFF** (unlike `planningEnabled`/`reviewEnabled`, this is a true opt-in).

## Mechanism

Today `filterPlannerTools(tools)` strips `write`/`edit`/`multiedit`/`bash` outright. With SDD resolved ON for the planning cycle:

- `bash` is stripped, always.
- `write`, `edit`, `multiedit` are **wrapped** instead of stripped: a proxy tool validates that the target path argument ends in `.md` (case-insensitive) before delegating to the real tool; any other extension returns a tool error — `Planning phase (SDD mode): only markdown (.md) files may be written.` The existing workingDir sandbox still applies underneath.
- Signature change in `task_roles.ts`: `filterPlannerTools(tools, sdd: boolean)` (or an equivalent second function) — the strategy passes the resolved flag.

### Worktree synergy (free)

The planner writes specs inside the task's worktree; the per-cycle `commitWip` already commits them to the task branch. Specs travel with the branch and are visible to the reviewer at DONE. No new code.

### Prompt

`buildPlanningPrompt` gains an `sdd` parameter. With SDD on, the read-only paragraph is replaced by: the planner MAY create/edit markdown documents (specs, plans, ADRs), MUST follow the project's own documentation conventions (project context / AGENTS.md), and everything else (non-md files, bash) remains unavailable. The submit step tells it to reference the spec files in the submitted plan.

## Surfaces

- **Tools**: `task_create` accepts `sdd_enabled?: boolean`; `task_get_state` returns `sddEnabled`.
- **API**: `PATCH /api/tasks/:id/flags` accepts `sddEnabled` (same tri-state semantics); task/project creation accepts the field.
- **UI**:
  - Task edit view: third select in the "Phases" block — "SDD mode (planner writes .md)" with Inherit/On/Off.
  - Project settings: checkbox default **unchecked** with the legend: *"Allow the planner to write markdown documents (specs, plans) during the planning phase. How and where is up to this project's own conventions (AGENTS.md, agent prompt — e.g. superpowers specs). Everything else stays read-only."*

## Error handling

- Non-`.md` path through a wrapped tool → tool error (message above), planner keeps its turn.
- Flag read at cycle start (like the other gates): toggling mid-cycle applies from the next cycle.

## Testing

- `filterPlannerTools(tools, false)` unchanged behavior (regression).
- `filterPlannerTools(tools, true)`: `bash` absent; `write`/`edit`/`multiedit` present but wrapped — `.md` path (incl. nested, mixed case) delegates; `.ts`/extensionless path errors without invoking the wrapped tool.
- `resolveSddEnabled` chain and its OFF default.
- Flags API round-trip for `sddEnabled`.

## Docs

CLAUDE.md (layer 5 planning bullet + State on disk) and README (planning paragraph) in the same unit of work. Changeset: minor.
