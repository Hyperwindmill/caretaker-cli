# Task REVIEWING State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an intermediate `reviewing` task status so the DONE review pass no longer masquerades as an inactive `done` task; the UI shows it as active (purple) while the review runs, and the review is relocated from an inline sub-run to the next heartbeat tick.

**Architecture:** Today a git task's DONE review runs as a nested `harness.run` inline, in the same tick the agent calls `task_complete`, while the store already reads `done` — so the UI shows the task inactive during the review. We introduce a `reviewing` status: `task_complete` on a git task sets `reviewing` (non-git → `done` directly, unchanged — the review is git-diff based and non-git has no branch to review). The heartbeat now also selects `reviewing` tasks and, for them, runs the review as its own cycle, then transitions to `active` (changes requested, worktree kept) or `done` (pass / max rounds, worktree removed). Crash recovery is free: a task left `reviewing` is re-picked next tick.

**Tech Stack:** TypeScript (ESM, strict), Node built-in test runner via `tsx`, `@morphql/store` folder DB, Hono web server, React (webview-ui via esbuild).

## Global Constraints

- ESM only (`"type": "module"`); imports use `.js` extensions.
- Tests are co-located `*.test.ts`, run with `tsx --test`. No Jest/vitest.
- `pnpm test` does NOT type-check — run `pnpm -F caretaker-cli typecheck` separately.
- The review stays **independent**: `runDoneReview` is reused unchanged (no task-history replay, `mcp__task__*` stripped). We only change *when/where* it is invoked.
- `MAX_REVIEW_ROUNDS = 3` (from `task_review.ts`); the round number is derived from the count of `review` messages, never a stored counter.
- Reviewing color in the UI is purple `#a855f7` (matches the existing Tailwind-500 palette used for other statuses).
- Every code change ships with a Changeset (Task 5). Match surrounding style; keep diffs surgical.

---

### Task 1: Add `reviewing` to the Task status union

**Files:**
- Modify: `packages/cli/src/store/db.ts:29`
- Modify: `packages/webview-ui/src/ProjectsTab.tsx:30`

**Interfaces:**
- Produces: `Task.status` type now includes `'reviewing'` in both the CLI store and the webview mirror. All later tasks depend on this.

- [ ] **Step 1: Widen the union in the store**

In `packages/cli/src/store/db.ts:29`, change:

```ts
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'done';
```

to:

```ts
  status: 'draft' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
```

- [ ] **Step 2: Widen the union in the webview mirror**

In `packages/webview-ui/src/ProjectsTab.tsx:30` (the local `Task` interface), change:

```ts
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'done';
```

to:

```ts
  status: 'draft' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
```

- [ ] **Step 3: Verify both packages still type-check**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F webview-ui exec tsc --noEmit`
Expected: both exit 0 (no errors — the value isn't produced anywhere yet, this is a pure type widening).

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/store/db.ts packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(tasks): add 'reviewing' to the Task status union"
```

---

### Task 2: `task_complete` routes git tasks to `reviewing`

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts:195`
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (create)

**Interfaces:**
- Consumes: `Task.status` union from Task 1; `getTaskById`, `createTask`, `saveTask` from `store/db.js`; `completeTaskTool` from `task_tools.js`.
- Produces: after `completeTaskTool.execute({task_id})`, a task with a non-null `worktreePath` has `status === 'reviewing'`; a task without a worktree has `status === 'done'`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/harness/tools/builtin/task_tools.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-tasktools-home-'));
process.env.CARETAKER_HOME = CT_HOME;

const { createTask, getTaskById, saveTask } = await import('../../../store/db.js');
const { completeTaskTool } = await import('./task_tools.js');

const base = {
  projectId: 1,
  title: 'T',
  objective: 'o',
  checklist: [],
  status: 'active' as const,
  blockedReason: null,
  noProgressCount: 0,
  maxNoProgress: 5,
  lockedAt: null,
};

test('task_complete on a git task (worktree set) -> reviewing', async () => {
  const t = await createTask({ ...base });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'x');
  gt!.branch = 'caretaker/task-x';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id });

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'reviewing');
});

test('task_complete on a non-git task (no worktree) -> done', async () => {
  const t = await createTask({ ...base });
  await completeTaskTool.execute({ task_id: t.id });
  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'done');
});

test.after(async () => {
  await rm(CT_HOME, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: the first test FAILS (`after.status` is `'done'`, expected `'reviewing'`); the second passes.

- [ ] **Step 3: Implement the routing**

In `packages/cli/src/harness/tools/builtin/task_tools.ts`, inside `completeTaskTool.execute`, change:

```ts
    task.status = 'done';
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();
```

to:

```ts
    // Git-isolated tasks enter review before finalizing; non-git tasks finalize
    // directly (the review is git-diff based, so it needs a branch to inspect).
    task.status = task.worktreePath ? 'reviewing' : 'done';
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts
git commit -m "feat(tasks): task_complete sends git tasks to reviewing, non-git to done"
```

---

### Task 3: Heartbeat runs the review as a `reviewing` cycle

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (selection line 60; branch + helper; strip inline review from the active cycle, lines ~244-305)
- Test: `packages/cli/src/lib/task_git_e2e.test.ts` (add two tests)

**Interfaces:**
- Consumes: `runDoneReview`, `MAX_REVIEW_ROUNDS` (already imported from `./task_review.js`); `commitWip`, `finalizeDone` (already imported from `../../../lib/task_git.js`); `getTaskById`, `saveTask`, `addTaskMessage`, `runQuery` (already imported); `Task`, `TaskMessage` types (already imported).
- Produces: a new module-private `runReviewCycle(opts)` in `task_strategy.ts`. `runTaskHeartbeatTick` now selects `active` + `reviewing` and, for a `reviewing` task, runs `runReviewCycle` and returns before the agent-run path.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/lib/task_git_e2e.test.ts` (it already imports `runTaskHeartbeatTick`, `getTaskById`, `saveTask`, `createTask`, `__setFetch`, `__resetFetch`, `makeRepo`, `mockFetchResponse`, `saveConfig`, `saveAgents`, and defines `CT_HOME`, `g`). Add a helper to seed a git task already advanced to `reviewing` (run one active tick to create the worktree/branch, then flip the status), then assert each verdict path:

```ts
async function seedReviewingTask(): Promise<{ repo: string; taskId: number }> {
  const repo = await makeRepo();
  await saveConfig({
    port: 3000,
    providers: [{ name: 'mock-provider', endpoint: 'http://localhost:8000', apiKey: 'test-key' }],
    projects: [{ id: 202, name: 'Review Project', description: '', workingDir: repo, agentId: 'mock-agent', active: true }],
  });
  await saveAgents([{ id: 'mock-agent', name: 'Mock', systemPrompt: 'mock', provider: 'mock-provider', model: 'mock-model', allowedTools: [], maxTurns: 30 }]);

  const task = await createTask({
    projectId: 202, title: 'Review Task', objective: 'Do the thing',
    checklist: [{ id: '1', text: 'Step 1', status: 'pending', order: 0 }],
    status: 'active', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
  });

  // One active tick creates the worktree + branch (agent just writes a file).
  __setFetch(async () => mockFetchResponse('working'));
  await runTaskHeartbeatTick(new Date());

  // Advance to reviewing (as task_complete would for a git task).
  const t = await getTaskById(task.id);
  t!.status = 'reviewing';
  t!.lockedAt = null;
  await saveTask(t!);
  return { repo, taskId: task.id };
}

test('reviewing tick: PASS verdict finalizes to done and removes the worktree', async () => {
  const { repo, taskId } = await seedReviewingTask();
  __setFetch(async () => mockFetchResponse('All good.\nREVIEW_RESULT: PASS'));
  try {
    await runTaskHeartbeatTick(new Date());
    const after = await getTaskById(taskId);
    assert.equal(after!.status, 'done');
    assert.equal(after!.worktreePath, null);
    assert.ok(after!.branch, 'branch is kept');
  } finally {
    __resetFetch();
    await rm(repo, { recursive: true, force: true });
  }
});

test('reviewing tick: CHANGES_REQUESTED reopens to active and keeps the worktree', async () => {
  const { repo, taskId } = await seedReviewingTask();
  __setFetch(async () => mockFetchResponse('Bug on line 4.\nREVIEW_RESULT: CHANGES_REQUESTED'));
  try {
    await runTaskHeartbeatTick(new Date());
    const after = await getTaskById(taskId);
    assert.equal(after!.status, 'active');
    assert.ok(after!.worktreePath, 'worktree is kept for the fix cycle');
  } finally {
    __resetFetch();
    await rm(repo, { recursive: true, force: true });
  }
});
```

> Note: `seedReviewingTask` reuses `makeRepo`/`mockFetchResponse` defined at the top of the file. If they are declared *after* the existing test, move `seedReviewingTask` and the new tests below their declarations, or hoist the helpers — do not duplicate them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/lib/task_git_e2e.test.ts`
Expected: both new tests FAIL — the heartbeat's selection is still `WHERE status = 'active'`, so a `reviewing` task is never picked and its status never changes.

- [ ] **Step 3: Widen the heartbeat selection**

In `packages/cli/src/cli/web/scheduler/task_strategy.ts:60`, change:

```ts
  const taskRows = (await runQuery(`SELECT * FROM tasks WHERE status = 'active' AND lockedAt IS NULL`)) as Task[];
```

to:

```ts
  const taskRows = (await runQuery(`SELECT * FROM tasks WHERE status IN ('active', 'reviewing') AND lockedAt IS NULL`)) as Task[];
```

- [ ] **Step 4: Add the `reviewing` branch after tool resolution**

Still in `task_strategy.ts`, immediately after the tools are resolved and before the `// 5. Construct prompt` line (~line 133), insert the branch. At this point `effectiveAgent`, `provider`, `tools`, `workingDir`, and `task` are all in scope, and `workingDir` already points at the worktree for a task that has one:

```ts
    // Reviewing tasks run one independent review pass on their branch as their
    // own heartbeat cycle (not the agent's task loop), then transition.
    if (task.status === 'reviewing') {
      await runReviewCycle({ task, agent: effectiveAgent, provider, tools, workingDir });
      return; // the finally{} block still runs and releases the lock
    }
```

- [ ] **Step 5: Add the `runReviewCycle` helper**

Add this module-private function to `task_strategy.ts` (below `runTaskHeartbeatTick`, same file). It lifts the existing done→review logic (currently inline at lines ~250-303) into a standalone cycle, adds the derive-round and pause-race guard, and sets `status` explicitly (since `task_complete` now leaves the task at `reviewing`, not `done`):

```ts
async function runReviewCycle(opts: {
  task: Task;
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: Tool[];
  workingDir: string;
}): Promise<void> {
  const { task, agent, provider, tools, workingDir } = opts;
  if (!task.worktreePath) return; // reviewing implies a worktree; nothing to review otherwise

  // Finalize the agent's last work so the branch is complete before review.
  await commitWip(task.worktreePath, task.title);

  // Round is derived from the review-message stream, never a stored counter.
  const priorReviews = (
    (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[]
  ).filter((m) => m.messageType === 'review').length;
  const round = priorReviews + 1;

  let verdict: 'pass' | 'changes' = 'pass';
  let reviewText = '';
  try {
    const review = await runDoneReview({
      agent,
      provider,
      tools,
      objective: task.objective,
      branch: task.branch || '(unknown)',
      workingDir,
      round,
    });
    verdict = review.verdict;
    reviewText = review.text;
  } catch (reviewErr) {
    // A broken review must not trap the task in reviewing — finalize as pass.
    console.error(`[task_heartbeat] Task #${task.id} review failed, finalizing:`, reviewErr);
    verdict = 'pass';
  }

  // Respect a Pause that arrived mid-review: only transition if still reviewing.
  const current = await getTaskById(task.id);
  if (!current || current.status !== 'reviewing') {
    console.log(`[task_heartbeat] Task #${task.id} left reviewing mid-review (now ${current?.status}); skipping transition.`);
    return;
  }

  if (reviewText) {
    await addTaskMessage({
      taskId: task.id,
      role: 'user',
      messageType: 'review',
      content: `[CODE REVIEW round ${round}/${MAX_REVIEW_ROUNDS}] verdict=${verdict}\n\n${reviewText}`,
    });
  }
  console.log(`[task_heartbeat] Task #${task.id} review round ${round}: ${verdict}`);

  if (verdict === 'changes' && round < MAX_REVIEW_ROUNDS) {
    // Reopen: keep the worktree; the review message is replayed to the agent next cycle.
    current.status = 'active';
    current.noProgressCount = 0;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
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
    await finalizeDone(current.worktreePath!);
    current.status = 'done';
    current.worktreePath = null;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
    console.log(`[task_heartbeat] Task #${task.id} done: worktree removed, branch ${current.branch} kept`);
  }
}
```

> If `AgentConfig` / `ProviderConfig` / `Tool` are not already imported in `task_strategy.ts`, add:
> `import type { AgentConfig, ProviderConfig } from '../../../types.js';`
> `import type { Tool } from '../../../harness/tools/types.js';`
> (Check the existing imports first; the file already references these types via the agent/provider/tools values, so at least the value imports exist.)

- [ ] **Step 6: Strip the inline review from the active cycle**

Still in `task_strategy.ts`, the active-cycle git-lifecycle block (currently around lines 244-306) runs the done→review inline. Replace the whole `if (gitTask && gitTask.worktreePath) { ... }` block — from `const gitTask = await getTaskById(task.id);` through its closing brace — with a commit-only version (review now happens next tick via `runReviewCycle`):

```ts
    // Git lifecycle: commit progress every cycle. When the agent has just
    // completed the task it is now 'reviewing'; the review runs on the next
    // tick as its own cycle (see runReviewCycle), not inline here.
    const gitTask = await getTaskById(task.id);
    if (gitTask && gitTask.worktreePath) {
      try {
        if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }
```

Remove any now-unused imports this deletion orphans **only if** they are no longer referenced anywhere in the file — `runDoneReview`, `MAX_REVIEW_ROUNDS`, and `finalizeDone` are all still used by `runReviewCycle`, so keep them. Grep before deleting: `grep -n "runDoneReview\|MAX_REVIEW_ROUNDS\|finalizeDone" packages/cli/src/cli/web/scheduler/task_strategy.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/lib/task_git_e2e.test.ts`
Expected: the original lifecycle test AND both new reviewing tests PASS.

- [ ] **Step 8: Type-check the package**

Run: `pnpm -F caretaker-cli typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_strategy.ts packages/cli/src/lib/task_git_e2e.test.ts
git commit -m "feat(tasks): run the DONE review as a reviewing-state heartbeat cycle"
```

---

### Task 4: UI treats `reviewing` as active (purple, Pause not Activate)

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (status color ~475-479; toggle ~280; action button ~573; header dot + label ~663-665)

**Interfaces:**
- Consumes: `Task.status` union from Task 1; `taskMessages` state (already fetched in `ProjectsTab`) to derive the review round.
- Produces: no new exports. Visual behavior only.

- [ ] **Step 1: Purple status color in the task list**

In `packages/webview-ui/src/ProjectsTab.tsx`, in the block at ~475-479, add a `reviewing` case:

```tsx
                      let statusColor = '#64748b'; // draft
                      if (task.status === 'active') statusColor = '#22c55e';
                      if (task.status === 'reviewing') statusColor = '#a855f7';
                      if (task.status === 'paused') statusColor = '#eab308';
                      if (task.status === 'blocked') statusColor = '#f97316';
                      if (task.status === 'done') statusColor = '#3b82f6';
```

- [ ] **Step 2: Pause toggles reviewing too**

In `handleToggleTaskStatus` (~280), change:

```tsx
    const newStatus = task.status === 'active' ? 'paused' : 'active';
```

to:

```tsx
    // Reviewing behaves like active for the toggle: the button pauses it.
    const newStatus = task.status === 'active' || task.status === 'reviewing' ? 'paused' : 'active';
```

- [ ] **Step 3: Show Pause (not Activate) while reviewing**

In the action button (~573), change:

```tsx
                        {selectedTask.status === 'active' ? (
                          <>
                            <PauseIcon size={12} /> Pause
                          </>
                        ) : (
                          <>
                            <ActivateIcon size={12} /> Activate
                          </>
                        )}
```

to:

```tsx
                        {selectedTask.status === 'active' || selectedTask.status === 'reviewing' ? (
                          <>
                            <PauseIcon size={12} /> Pause
                          </>
                        ) : (
                          <>
                            <ActivateIcon size={12} /> Activate
                          </>
                        )}
```

- [ ] **Step 4: Header dot + label reflect reviewing**

In the Execution Thread header (~663-665), replace the status dot + label with a reviewing-aware version. First compute the round just above the `return`/JSX for the selected task (anywhere `taskMessages` and `selectedTask` are in scope — e.g. right before the `{/* TASK INTERACTIVE CHAT */}` block):

```tsx
                const reviewRound = taskMessages.filter((m) => m.messageType === 'review').length + 1;
                const isActiveLike = selectedTask.status === 'active' || selectedTask.status === 'reviewing';
```

Then change the dot + label:

```tsx
                        <span className={`agent-status-dot agent-status-dot--active ${selectedTask.status === 'active' ? 'agent-status-dot--pulsing' : ''}`} />
                        {selectedTask.status === 'active' ? 'Heartbeat loop active' : `Task status: ${selectedTask.status}`}
```

to:

```tsx
                        <span
                          className={`agent-status-dot agent-status-dot--active ${isActiveLike ? 'agent-status-dot--pulsing' : ''}`}
                          style={selectedTask.status === 'reviewing' ? { background: '#a855f7' } : undefined}
                        />
                        {selectedTask.status === 'active'
                          ? 'Heartbeat loop active'
                          : selectedTask.status === 'reviewing'
                          ? `In review (round ${reviewRound}/${3})`
                          : `Task status: ${selectedTask.status}`}
```

> If `selectedTask` is a narrowed const inside a block, place the `reviewRound`/`isActiveLike` consts inside that same block so the narrowing holds. Adjust indentation to match the surrounding JSX.

- [ ] **Step 5: Build + type-check the webview**

Run: `pnpm -F webview-ui build && pnpm -F webview-ui exec tsc --noEmit`
Expected: build succeeds, tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(tasks): show reviewing tasks as active (purple, Pause) in the UI"
```

---

### Task 5: Changeset + full verification

**Files:**
- Create: `.changeset/task-reviewing-state.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/task-reviewing-state.md` (verify the exact package names against each `package.json` `name` field):

```markdown
---
"caretaker-cli": minor
"webview-ui": minor
---

Autonomous git tasks now enter a `reviewing` state between `active` and `done`.
`task_complete` sends a git-isolated task to `reviewing`; the DONE review runs
as its own heartbeat cycle (no longer inline), transitioning to `active` on
changes-requested or `done` on pass/max-rounds. The UI shows reviewing tasks as
active (purple, with a Pause control and an "In review" label) instead of
misleadingly inactive. Non-git tasks finalize directly to `done` as before.
```

- [ ] **Step 2: Run the full test + typecheck + build gate**

Run:
```bash
pnpm -F caretaker-cli test
pnpm -F caretaker-cli typecheck
pnpm -F caretaker-cli build
pnpm -F webview-ui build && pnpm -F webview-ui exec tsc --noEmit
```
Expected: all green. In particular `task_tools.test.ts` (2) and the three tests in `task_git_e2e.test.ts` pass.

- [ ] **Step 3: Commit**

```bash
git add .changeset/task-reviewing-state.md
git commit -m "chore: changeset for task reviewing state"
```

---

## Self-Review

- **Spec coverage:** `reviewing` state added (T1); `task_complete` routing git→reviewing / non-git→done (T2); heartbeat selects + dispatches reviewing, review relocated to its own cycle, pause-race guard, crash recovery via re-pick (T3); UI purple + Pause + label + toggle (T4); changeset + verification (T5). Independent review preserved (`runDoneReview` reused unchanged). Round derived from message stream. All design points covered.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `runReviewCycle` signature matches the values passed at the call site (`effectiveAgent: AgentConfig`, `provider: ProviderConfig`, `tools: Tool[]`, `workingDir: string`, `task: Task`). `Task.status` union is widened in both mirrors before any code produces `'reviewing'`. `MAX_REVIEW_ROUNDS` and the `[CODE REVIEW round n/N]` message format match the existing strings in `task_strategy.ts`/`task_review.ts`.
- **Edge cases:** pause mid-review (reload guard), review throw (fail-safe finalize as pass), non-git (`worktreePath` null → `done`, `runReviewCycle` early-returns), crash mid-review (task stays `reviewing`, re-picked next tick once its lock clears).
