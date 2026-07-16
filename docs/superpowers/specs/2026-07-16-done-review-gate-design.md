# Final review gate at DONE — design

Date: 2026-07-16
Builds on: `2026-07-16-autonomous-task-worktree-isolation-design.md`

## Problem

When an autonomous task reaches DONE, its work is committed to the branch and the worktree is
removed with no independent check. A task can declare itself complete while the work is buggy,
incomplete, or off-objective, and nobody notices until the user reviews the branch by hand.

## Goal

At DONE, run one independent **code review** pass over the task's branch before finalizing. If the
review requests changes, **reopen the task** (status back to `active`, worktree kept) and leave the
review in the task history so the agent sees it and fixes it on the next heartbeat. A loop guard
caps the number of review rounds.

## Decisions (from brainstorming)

- **Gating**, not advisory: a CHANGES_REQUESTED review reopens the task.
- The review output is stored as a task message that is **replayed into history**, so the working
  agent reads it next cycle and corrects — the harness does not parse findings into actions.
- **Loop guard**: max 3 review rounds total. On the 3rd CHANGES_REQUESTED the task is finalized
  `done` anyway with a note (never loops forever).
- The reviewer is the **same agent identity** but runs with **`mcp__task__*` tools stripped** — it
  cannot mutate task state; the harness owns the reopen/finalize decision.
- Verdict is signalled by a mandatory final sentinel line: `REVIEW_RESULT: PASS` or
  `REVIEW_RESULT: CHANGES_REQUESTED`.
- Review prompt is paraphrased from superpowers `requesting-code-review` (independent, skeptical,
  verify against the objective, cite specifics, no performative agreement).

## Where it hooks

In `packages/cli/src/cli/web/scheduler/task_strategy.ts`, the existing git-lifecycle block runs
after `harness.run`. Today the `gitTask.status === 'done'` branch calls `discardWorktree`. New flow
for that branch (only when the task has a worktree — non-git tasks are unchanged, no review):

1. `commitWip(worktreePath, title)` — commit the agent's final work so the branch is complete.
2. Count prior review rounds = task messages with `messageType === 'review'`.
3. Run the review (`harness.run`, review prompt, tools without `mcp__task__*`, same worktree
   workingDir), capturing the output text.
4. Save the output as a task message: `role: 'user'`, `messageType: 'review'`.
5. Parse the verdict:
   - `CHANGES_REQUESTED` **and** `priorRounds + 1 < 3` → `status = 'active'`, `noProgressCount = 0`,
     keep the worktree, save. (Next heartbeat replays the review; the agent fixes.)
   - otherwise (`PASS`, or round cap reached) → `finalizeDone(worktreePath)`, `worktreePath = null`,
     stay `done`, save. If the cap was reached with CHANGES_REQUESTED, also add a `system` message
     noting the task finished despite outstanding review findings.
6. If the review run itself throws, log and fall through to normal finalize (a broken review must
   not trap a task in DONE forever).

## Schema / plumbing

- `TaskMessage.messageType` gains `'review'` (in `packages/cli/src/store/db.ts` and the webview's
  local `TaskMessage` interface in `ProjectsTab.tsx`).
- The history-replay filter in `task_strategy.ts` (currently `chat | heartbeat | tool_call`) gains
  `'review'` so the review is visible to the working agent next cycle.
- No other schema change: round count is derived from the message stream, not a stored counter.

## Modules

- `packages/cli/src/cli/web/scheduler/task_review.ts` (new): the review prompt constant
  (`REVIEW_PROMPT(objective, branch)`), a pure `parseReviewVerdict(text): 'pass' | 'changes'`
  (defaults to `'changes'` when the sentinel is missing/ambiguous — fail safe toward more review),
  and `runDoneReview(...)` that wraps the `harness.run` review pass and returns the verdict + text.
  Keeping it out of `task_strategy.ts` keeps that file focused and makes the verdict parser unit-
  testable.

## Testing

- Unit test `task_review.test.ts`: `parseReviewVerdict` — PASS sentinel → `'pass'`,
  CHANGES_REQUESTED → `'changes'`, missing/garbled → `'changes'` (fail-safe).
- Manual E2E (web GUI): a task that completes with a deliberate flaw → observe the review message in
  history, the task reopening to `active`, the fix next cycle, then PASS → worktree removed.

## Out of scope

- Structured findings / per-file annotations — the review is free text the agent reads.
- A user-facing "re-review" button — not requested.
