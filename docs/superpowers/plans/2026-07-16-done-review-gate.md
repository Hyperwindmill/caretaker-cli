# Final Review Gate at DONE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At DONE, run one independent code-review pass over the task branch; if it requests changes, reopen the task (worktree kept) and leave the review in history so the agent fixes it next cycle. Cap at 3 rounds.

**Architecture:** A new `task_review.ts` module holds the review prompt, a pure verdict parser, and a `runDoneReview` wrapper around `harness.run` (task tools stripped). The heartbeat's DONE branch in `task_strategy.ts` calls it, stores the review as a replayed `review` message, and either reopens the task or finalizes.

**Tech Stack:** TypeScript ESM, `harness.run` (returns `RunResult.text`), Node `node:test` via `tsx`.

## Global Constraints

- ESM only; relative imports end in `.js`.
- `pnpm test` runs via `tsx` and does NOT type-check — ALWAYS also run `pnpm -F caretaker-cli typecheck`.
- Tests co-located `*.test.ts`; set `process.env.CARETAKER_HOME` at file scope if a test needs it.
- Changeset required (minor — new feature).
- Builds on the worktree isolation feature already on `main`.

---

### Task 1: Review module (prompt + verdict parser + run wrapper)

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/task_review.ts`
- Test: `packages/cli/src/cli/web/scheduler/task_review.test.ts`

**Interfaces:**
- Consumes: `harness.run` from `../../../harness/index.js`; `AgentConfig`/`ProviderConfig` from `../../../types.js`; `Tool` from `../../../harness/tools/types.js`.
- Produces:
  - `MAX_REVIEW_ROUNDS: number` (= 3)
  - `reviewPrompt(objective: string, branch: string, round: number): string`
  - `parseReviewVerdict(text: string): 'pass' | 'changes'`
  - `runDoneReview(opts: { agent: AgentConfig; provider: ProviderConfig; tools: Tool[]; objective: string; branch: string; workingDir: string; round: number }): Promise<{ verdict: 'pass' | 'changes'; text: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/cli/web/scheduler/task_review.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict } from './task_review.js';

test('PASS sentinel -> pass', () => {
  assert.equal(parseReviewVerdict('Looks good.\nREVIEW_RESULT: PASS'), 'pass');
});

test('CHANGES_REQUESTED sentinel -> changes', () => {
  assert.equal(parseReviewVerdict('Bug on line 4.\nREVIEW_RESULT: CHANGES_REQUESTED'), 'changes');
});

test('missing sentinel fails safe to changes', () => {
  assert.equal(parseReviewVerdict('I think it is probably fine.'), 'changes');
});

test('last sentinel wins when the model repeats itself', () => {
  const t = 'REVIEW_RESULT: CHANGES_REQUESTED\n...actually re-reading it...\nREVIEW_RESULT: PASS';
  assert.equal(parseReviewVerdict(t), 'pass');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm exec tsx --test src/cli/web/scheduler/task_review.test.ts`
Expected: FAIL — `Cannot find module './task_review.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/cli/web/scheduler/task_review.ts`:

```ts
import * as harness from '../../../harness/index.js';
import type { AgentConfig, ProviderConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';

export const MAX_REVIEW_ROUNDS = 3;

export function reviewPrompt(objective: string, branch: string, round: number): string {
  return `You are an INDEPENDENT code reviewer. You did not write this code, and your job is to find real problems — not to be agreeable. Do not rubber-stamp.

The autonomous task you are reviewing had this objective:
"""
${objective}
"""

All of the task's work is committed to the git branch \`${branch}\`, checked out in your current working directory. Inspect it:
- \`git log --oneline\` to see the commits made for this task.
- Review the full change with \`git show\` / \`git diff\` across those commits.
- Read the changed files where it matters.

Review for:
- Correctness: real bugs, broken logic, unhandled cases.
- Completeness: does it ACTUALLY achieve the objective, or only part of it?
- Regressions: does it break existing behavior?
- Tests: is the new behavior covered, if the repo expects tests?
Verify claims against the code — do not trust comments or commit messages.

Be concrete: cite files and lines. If the work is genuinely complete and correct, say so plainly.

This is review round ${round} of at most ${MAX_REVIEW_ROUNDS}.

End your response with EXACTLY ONE of these two lines, and nothing after it:
REVIEW_RESULT: PASS
REVIEW_RESULT: CHANGES_REQUESTED`;
}

export function parseReviewVerdict(text: string): 'pass' | 'changes' {
  // Fail-safe: anything that is not an explicit trailing PASS counts as changes-requested.
  const matches = text.match(/REVIEW_RESULT:\s*(PASS|CHANGES_REQUESTED)/gi);
  if (!matches || matches.length === 0) return 'changes';
  const last = matches[matches.length - 1]!.toUpperCase();
  return /:\s*PASS/.test(last) ? 'pass' : 'changes';
}

export async function runDoneReview(opts: {
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: Tool[];
  objective: string;
  branch: string;
  workingDir: string;
  round: number;
}): Promise<{ verdict: 'pass' | 'changes'; text: string }> {
  // Strip task-state tools: the reviewer must not mutate the task; the harness decides.
  const reviewTools = opts.tools.filter((t) => !t.name.startsWith('mcp__task__'));
  const result = await harness.run(
    {
      agent: opts.agent,
      provider: opts.provider,
      tools: reviewTools,
      prompt: reviewPrompt(opts.objective, opts.branch, opts.round),
      history: [],
      workingDir: opts.workingDir,
    },
    {
      confirmTool: async () => 'once', // unattended
    },
  );
  return { verdict: parseReviewVerdict(result.text), text: result.text };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/cli && pnpm exec tsx --test src/cli/web/scheduler/task_review.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm -F caretaker-cli typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_review.ts packages/cli/src/cli/web/scheduler/task_review.test.ts
git commit -m "feat(tasks): review module (prompt, verdict parser, run wrapper)"
```

---

### Task 2: Add the `review` message type and replay it

**Files:**
- Modify: `packages/cli/src/store/db.ts` (`TaskMessage.messageType` union)
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (history-replay filter)
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (local `TaskMessage` union, for rendering)

**Interfaces:**
- Produces: `'review'` as a valid `messageType` everywhere it is consumed.

- [ ] **Step 1: Extend the DB union**

In `packages/cli/src/store/db.ts`, the `TaskMessage.messageType` field (line ~42) currently reads:

```ts
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield';
```

Add `'review'`:

```ts
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review';
```

- [ ] **Step 2: Replay review messages into agent history**

In `packages/cli/src/cli/web/scheduler/task_strategy.ts`, the replay filter (line ~166) currently reads:

```ts
      .filter((m) => m.messageType === 'chat' || m.messageType === 'heartbeat' || m.messageType === 'tool_call')
```

Add `'review'` so the working agent sees the review next cycle:

```ts
      .filter((m) => m.messageType === 'chat' || m.messageType === 'heartbeat' || m.messageType === 'tool_call' || m.messageType === 'review')
```

- [ ] **Step 3: Extend the webview union**

In `packages/webview-ui/src/ProjectsTab.tsx`, the `TaskMessage` interface's `messageType` (line ~40) currently reads:

```ts
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield';
```

Add `'review'`:

```ts
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review';
```

- [ ] **Step 4: Typecheck / build**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F webview-ui build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/store/db.ts packages/cli/src/cli/web/scheduler/task_strategy.ts packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(tasks): add 'review' message type and replay it into agent history"
```

---

### Task 3: Wire the review gate into the DONE branch

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`

**Interfaces:**
- Consumes: `runDoneReview`, `MAX_REVIEW_ROUNDS` from `./task_review.js`; existing `commitWip`, `finalizeDone` from `../../../lib/task_git.js`; `historyMessages` already loaded earlier in the function; `tools`, `effectiveAgent`, `provider`, `workingDir` already in scope.

- [ ] **Step 1: Import the review module**

At the top of `task_strategy.ts`, after the `task_git` import, add:

```ts
import { runDoneReview, MAX_REVIEW_ROUNDS } from './task_review.js';
```

- [ ] **Step 2: Replace the DONE branch of the git-lifecycle block**

Find this block (line ~244-259):

```ts
    // Git lifecycle: commit progress every cycle; on DONE remove the worktree, keep the branch.
    const gitTask = await getTaskById(task.id);
    if (gitTask && gitTask.worktreePath) {
      try {
        if (gitTask.status === 'done') {
          await discardWorktree(gitTask.worktreePath, gitTask.title);
          gitTask.worktreePath = null;
          gitTask.updatedAt = new Date().toISOString();
          await saveTask(gitTask);
          console.log(`[task_heartbeat] Task #${task.id} done: worktree removed, branch ${gitTask.branch} kept`);
        } else if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }
```

Replace the whole `if (gitTask && gitTask.worktreePath) { ... }` body with:

```ts
    if (gitTask && gitTask.worktreePath) {
      try {
        if (gitTask.status === 'done') {
          // Commit the agent's final work so the branch is complete before review.
          await commitWip(gitTask.worktreePath, gitTask.title);

          // Count prior review rounds from the message stream (no stored counter).
          const priorReviews = (
            (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[]
          ).filter((m) => m.messageType === 'review').length;
          const round = priorReviews + 1;

          let verdict: 'pass' | 'changes' = 'pass';
          try {
            const review = await runDoneReview({
              agent: effectiveAgent,
              provider,
              tools,
              objective: gitTask.objective,
              branch: gitTask.branch || '(unknown)',
              workingDir,
              round,
            });
            verdict = review.verdict;
            await addTaskMessage({
              taskId: task.id,
              role: 'user',
              messageType: 'review',
              content: `[CODE REVIEW round ${round}/${MAX_REVIEW_ROUNDS}] verdict=${verdict}\n\n${review.text}`,
            });
            console.log(`[task_heartbeat] Task #${task.id} review round ${round}: ${verdict}`);
          } catch (reviewErr) {
            // A broken review must not trap the task in DONE — finalize as PASS.
            console.error(`[task_heartbeat] Task #${task.id} review failed, finalizing:`, reviewErr);
            verdict = 'pass';
          }

          if (verdict === 'changes' && round < MAX_REVIEW_ROUNDS) {
            // Reopen: keep the worktree, let the agent read the review and fix next cycle.
            gitTask.status = 'active';
            gitTask.noProgressCount = 0;
            gitTask.updatedAt = new Date().toISOString();
            await saveTask(gitTask);
            console.log(`[task_heartbeat] Task #${task.id} reopened by review (round ${round}).`);
          } else {
            if (verdict === 'changes') {
              await addTaskMessage({
                taskId: task.id,
                role: 'assistant',
                messageType: 'system',
                content: `Finished as done despite outstanding review findings after ${MAX_REVIEW_ROUNDS} rounds.`,
              });
            }
            await finalizeDone(gitTask.worktreePath);
            gitTask.worktreePath = null;
            gitTask.updatedAt = new Date().toISOString();
            await saveTask(gitTask);
            console.log(`[task_heartbeat] Task #${task.id} done: worktree removed, branch ${gitTask.branch} kept`);
          }
        } else if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }
```

Note: `discardWorktree` is no longer used in this file's DONE branch (replaced by explicit `commitWip` + `finalizeDone`). Remove `discardWorktree` from the `task_git` import if it is now unused, to keep the lint clean.

- [ ] **Step 3: Typecheck**

Run: `pnpm -F caretaker-cli typecheck`
Expected: no errors. (If `discardWorktree` is reported unused, drop it from the import in `task_strategy.ts`.)

- [ ] **Step 4: Run the scheduler + review tests**

Run: `cd packages/cli && pnpm exec tsx --test src/cli/web/scheduler.test.ts src/cli/web/scheduler/task_review.test.ts src/lib/task_git.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(tasks): gate DONE behind a review pass that can reopen the task"
```

---

### Task 4: Changeset + full verification

**Files:**
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Full build + test + typecheck**

Run: `pnpm build && pnpm test && pnpm -F caretaker-cli typecheck`
Expected: all green.

- [ ] **Step 2: Manual E2E (web GUI)**

```bash
CARETAKER_HOME=/tmp/ct-review pnpm -F caretaker-cli dev web
```

1. Create a git-repo project and a task whose objective is easy to under-deliver.
2. Let the agent complete it (call `task_complete`).
3. Confirm a `[CODE REVIEW round 1/3]` message appears in the task thread, and if it is
   `verdict=changes` the task flips back to `active` (worktree still listed in `git worktree list`).
4. Confirm the next cycle the agent addresses the review and, on PASS, the worktree is removed and
   the branch kept.
5. Confirm the round cap: a task that keeps failing review finalizes `done` after round 3 with the
   "despite outstanding review findings" system message.

Record observed output.

- [ ] **Step 3: Draft the changeset**

Run: `pnpm run changeset` — **minor** for `caretaker-cli` (and `webview-ui` for the message-type union). Summary:

```
Autonomous tasks now run an independent code-review pass when they reach DONE. If the review requests changes, the task reopens (worktree kept) and the review is left in the task history for the agent to address next cycle; a PASS removes the worktree and keeps the branch. Capped at 3 review rounds.
```

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for DONE review gate"
```

---

## Self-Review

- **Spec coverage:** gating reopen → Task 3; review in replayed history → Task 2 + Task 3 (`review` message, role `user`); loop guard (3 rounds, derived count) → Task 3; task tools stripped → Task 1 (`runDoneReview` filter); sentinel verdict + fail-safe → Task 1 (`parseReviewVerdict`); review-run failure falls through to finalize → Task 3 try/catch. ✔
- **Placeholder scan:** none.
- **Type consistency:** `parseReviewVerdict`/`runDoneReview`/`MAX_REVIEW_ROUNDS` names identical between Task 1 and Task 3; `'review'` added to `messageType` in db.ts (Task 2 Step 1), replay filter (Step 2), and webview (Step 3). `runDoneReview` opts match the call site in Task 3.
- **Note:** Task 3 replaces `discardWorktree` usage with `commitWip` + `finalizeDone`; drop the now-unused import if lint/tsc flags it.
