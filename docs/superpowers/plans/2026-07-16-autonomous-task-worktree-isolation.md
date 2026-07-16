# Autonomous Task Worktree Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every autonomous task its own git worktree on a dedicated branch, commit progress each heartbeat cycle, and on completion remove the worktree while leaving the branch for the user to review/merge.

**Architecture:** A new path-based git helper module (`packages/cli/src/lib/task_git.ts`) wraps `git` via `execFile`. The task heartbeat (`task_strategy.ts`) creates the worktree lazily on the first cycle, runs the agent inside it, and commits/finalizes after each `harness.run`. A mirror builtin tool and a web endpoint + webview button expose a manual "discard worktree" action. Non-git projects keep running in place (current behavior).

**Tech Stack:** TypeScript (ESM, `moduleResolution: bundler`), Node built-in `node:test` via `tsx`, `@morphql/store` folder DB, Hono web server, React (webview-ui), lucide-react icons.

## Global Constraints

- pnpm workspaces monorepo; run all commands from repo root. Package manager pnpm ≥ 10.
- ESM only (`"type": "module"`); relative imports MUST end in `.js`.
- Tests co-located as `*.test.ts`, run with Node's built-in test runner through `tsx`. No Jest/vitest.
- Atomic-write policy for persisted JSON state (tmp + rename + Windows retry) — not touched by this plan; the DB writes go through existing `saveTask`.
- In tests, set `process.env.CARETAKER_HOME` at **file scope**, never inside `describe`, so the developer's real `~/.caretaker/` store is never clobbered.
- **Changeset required**: after implementation, draft a changeset via `pnpm run changeset` (semver: minor — new feature).
- Copy: no emoji in new UI; use lucide icons from `packages/webview-ui/src/icons.ts`.

---

### Task 1: Git worktree helper module + Task schema fields

**Files:**
- Modify: `packages/cli/src/store/db.ts` (add two fields to the `Task` interface, ~line 23-36)
- Create: `packages/cli/src/lib/task_git.ts`
- Test: `packages/cli/src/lib/task_git.test.ts`

**Interfaces:**
- Consumes: `dataDir()` from `packages/cli/src/store/db.ts`.
- Produces (all in `task_git.ts`):
  - `isGitRepo(dir: string): Promise<boolean>`
  - `ensureWorktree(projectWorkingDir: string, projectId: number, taskId: number, title: string): Promise<{ branch: string; worktreePath: string; agentWorkingDir: string }>`
  - `agentDirIn(worktreePath: string, projectWorkingDir: string): Promise<string>`
  - `commitWip(worktreePath: string, title: string): Promise<boolean>`
  - `finalizeDone(worktreePath: string): Promise<void>`
  - `discardWorktree(worktreePath: string, title: string): Promise<void>`
- `Task` gains `branch: string | null` and `worktreePath: string | null`.

- [ ] **Step 1: Add the two nullable fields to the `Task` interface**

In `packages/cli/src/store/db.ts`, inside `export interface Task { ... }`, add after `lockedAt: string | null;`:

```ts
  branch: string | null;
  worktreePath: string | null;
```

(No migration needed: `saveTask` serializes the whole object; pre-existing rows read these as `undefined`, and all consumers coalesce with `?? null`.)

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/lib/task_git.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const g = (cwd: string, args: string[]) => exec('git', args, { cwd });

// File-scope CARETAKER_HOME so worktrees land in a temp dir, never the dev store.
const CT_HOME = await mkdtemp(join(tmpdir(), 'ct-git-home-'));
process.env.CARETAKER_HOME = CT_HOME;

// Import AFTER setting the env var (dataDir() reads it at call time, but keep the order explicit).
const { isGitRepo, ensureWorktree, commitWip, finalizeDone, discardWorktree, agentDirIn } = await import(
  './task_git.js'
);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-repo-'));
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'test@example.com']);
  await g(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# repo\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('isGitRepo true inside a repo, false outside', async () => {
  const repo = await makeRepo();
  const plain = await mkdtemp(join(tmpdir(), 'ct-plain-'));
  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(plain), false);
  await rm(repo, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
});

test('ensureWorktree -> commitWip -> finalizeDone keeps branch, removes worktree', async () => {
  const repo = await makeRepo();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 1, 42, 'Do the Thing!');

  assert.equal(branch, 'caretaker/task-42-do-the-thing');
  assert.equal(agentWorkingDir, worktreePath); // project working dir == repo root

  // Agent produces work in the worktree.
  await writeFile(join(agentWorkingDir, 'out.txt'), 'hello\n');
  const committed = await commitWip(worktreePath, 'Do the Thing!');
  assert.equal(committed, true);

  // A second commit with a clean tree is a no-op.
  assert.equal(await commitWip(worktreePath, 'Do the Thing!'), false);

  // Commit is visible on the branch from the main repo.
  const log = await g(repo, ['log', '--oneline', branch]);
  assert.match(log.stdout, /wip: Do the Thing!/);

  await finalizeDone(worktreePath);

  // Worktree directory is gone...
  await assert.rejects(() => stat(worktreePath));
  // ...but the branch still exists.
  const branches = await g(repo, ['branch', '--list', branch]);
  assert.match(branches.stdout, /caretaker\/task-42-do-the-thing/);

  await rm(repo, { recursive: true, force: true });
});

test('discardWorktree commits pending work then removes the worktree', async () => {
  const repo = await makeRepo();
  const { branch, worktreePath, agentWorkingDir } = await ensureWorktree(repo, 1, 7, 'Abandon me');
  await writeFile(join(agentWorkingDir, 'wip.txt'), 'unsaved\n');

  await discardWorktree(worktreePath, 'Abandon me');

  await assert.rejects(() => stat(worktreePath));
  const log = await g(repo, ['log', '--oneline', branch]);
  assert.match(log.stdout, /wip: Abandon me/); // pending work was committed, not lost
  await rm(repo, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: FAIL — `Cannot find module './task_git.js'` (module not created yet).

- [ ] **Step 4: Write the implementation**

Create `packages/cli/src/lib/task_git.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { dataDir } from '../store/db.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

function worktreePathFor(projectId: number, taskId: number): string {
  return join(dataDir(), 'worktrees', `${projectId}-${taskId}`);
}

export async function agentDirIn(worktreePath: string, projectWorkingDir: string): Promise<string> {
  // Preserve a sub-directory working dir when the project points below the repo root.
  const repoRoot = await git(projectWorkingDir, ['rev-parse', '--show-toplevel']);
  const rel = relative(repoRoot, projectWorkingDir);
  return rel ? join(worktreePath, rel) : worktreePath;
}

export async function ensureWorktree(
  projectWorkingDir: string,
  projectId: number,
  taskId: number,
  title: string,
): Promise<{ branch: string; worktreePath: string; agentWorkingDir: string }> {
  const repoRoot = await git(projectWorkingDir, ['rev-parse', '--show-toplevel']);
  const branch = `caretaker/task-${taskId}-${slug(title)}`;
  const worktreePath = worktreePathFor(projectId, taskId);

  try {
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  } catch {
    // Branch may already exist from a previous run whose path field was lost — reuse it.
    await git(repoRoot, ['worktree', 'add', worktreePath, branch]);
  }

  const rel = relative(repoRoot, projectWorkingDir);
  const agentWorkingDir = rel ? join(worktreePath, rel) : worktreePath;
  return { branch, worktreePath, agentWorkingDir };
}

export async function commitWip(worktreePath: string, title: string): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (!status) return false;
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', `wip: ${title}`]);
  return true;
}

export async function finalizeDone(worktreePath: string): Promise<void> {
  let mainRepo: string;
  try {
    const commonDir = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    mainRepo = dirname(commonDir); // .../<repo>/.git -> .../<repo>
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
    return;
  }
  try {
    await git(mainRepo, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // Metadata inconsistent (e.g. dir already gone): force cleanup + prune.
    await rm(worktreePath, { recursive: true, force: true });
    await git(mainRepo, ['worktree', 'prune']).catch(() => {});
  }
}

export async function discardWorktree(worktreePath: string, title: string): Promise<void> {
  await commitWip(worktreePath, title);
  await finalizeDone(worktreePath);
}
```

Note (`ponytail:` intent): the WIP commit message is just `wip: <title>` — no cycle counter. Deriving a reliable per-cycle number needs a stored base sha (schema creep); the granular commit history + timestamps already order the work. Add a counter later only if a reviewer asks.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/lib/task_git.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -F caretaker-cli typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/store/db.ts packages/cli/src/lib/task_git.ts packages/cli/src/lib/task_git.test.ts
git commit -m "feat(tasks): git worktree helper + Task branch/worktreePath fields"
```

---

### Task 2: Wire the worktree lifecycle into the task heartbeat

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`

**Interfaces:**
- Consumes: `isGitRepo`, `ensureWorktree`, `agentDirIn`, `commitWip`, `discardWorktree` from `../../../lib/task_git.js`; existing `getTaskById`, `saveTask` from the store.
- Produces: no new exported symbols; `runTaskHeartbeatTick` now sets up/tears down worktrees.

- [ ] **Step 1: Add the import**

At the top of `packages/cli/src/cli/web/scheduler/task_strategy.ts`, after the existing store import (line ~4), add:

```ts
import { isGitRepo, ensureWorktree, agentDirIn, commitWip, discardWorktree } from '../../../lib/task_git.js';
```

- [ ] **Step 2: Replace the working-dir resolution with worktree setup**

Find (line ~103):

```ts
    const workingDir = project.workingDir || agent.workingDir || process.cwd();
```

Replace with:

```ts
    const baseWorkingDir = project.workingDir || agent.workingDir || process.cwd();
    let workingDir = baseWorkingDir;

    // Worktree isolation for git projects: lazily create a dedicated branch + worktree.
    if (task.worktreePath) {
      workingDir = await agentDirIn(task.worktreePath, baseWorkingDir);
    } else if (await isGitRepo(baseWorkingDir)) {
      const wt = await ensureWorktree(baseWorkingDir, task.projectId, task.id, task.title);
      task.branch = wt.branch;
      task.worktreePath = wt.worktreePath;
      await saveTask(task);
      workingDir = wt.agentWorkingDir;
      console.log(`[task_heartbeat] Task #${task.id} worktree ${wt.worktreePath} (branch ${wt.branch})`);
    }
    // Non-git projects fall through: workingDir stays baseWorkingDir (run in place).
```

(`workingDir` is already passed to `buildPrompt(...)` and `harness.run({ ..., workingDir })` further down — no other change needed there.)

- [ ] **Step 3: Add the post-run git step**

Find the end of the checklist-progress block inside `try` (after `await saveTask(refreshedTask);`, line ~225, still before the `} catch` at ~228). Insert immediately after that `saveTask`:

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

- [ ] **Step 4: Typecheck**

Run: `pnpm -F caretaker-cli typecheck`
Expected: no errors.

- [ ] **Step 5: Verify the existing scheduler tests still pass**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler.test.ts`
Expected: PASS (no regressions; this task adds no new unit test — its logic lives in the already-tested `task_git.ts`; behavior is verified end-to-end in Task 5's manual check).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(tasks): run autonomous heartbeat in a per-task git worktree"
```

---

### Task 3: Mirror builtin tool `task_discard_worktree`

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts`
- Modify: `packages/cli/src/harness/tools/builtin/index.ts`
- Test: `packages/cli/src/harness/tools/builtin/task_discard_worktree.test.ts`

**Interfaces:**
- Consumes: `discardWorktree` from `../../../lib/task_git.js`; existing `getTaskById`, `saveTask` from the store.
- Produces: `taskDiscardWorktreeTool: Tool` exported from `task_tools.ts`, registered in `index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/harness/tools/builtin/task_discard_worktree.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-discard-home-'));

const { taskDiscardWorktreeTool } = await import('./task_tools.js');

test('task_discard_worktree errors when the task has no worktree', async () => {
  // Task 999 does not exist -> "not found".
  const res = await taskDiscardWorktreeTool.execute({ task_id: 999 });
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.error, 'Task 999 not found');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_discard_worktree.test.ts`
Expected: FAIL — `taskDiscardWorktreeTool` is not exported yet.

- [ ] **Step 3: Add the tool**

In `packages/cli/src/harness/tools/builtin/task_tools.ts`, add the import near the top (after line 3):

```ts
import { discardWorktree } from '../../../lib/task_git.js';
```

Then add this exported tool (place it after `taskUnpauseTool`, near the end of the file):

```ts
export const taskDiscardWorktreeTool: Tool = {
  name: 'mcp__task__task_discard_worktree',
  description:
    'Commit any pending changes on the task branch, then remove its git worktree (the branch is kept). Use to clean up a task worktree manually when a task is done or abandoned.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);
    if (!task.worktreePath) return err(`Task ${taskId} has no active worktree`);

    await discardWorktree(task.worktreePath, task.title);
    task.worktreePath = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ branch: task.branch });
  },
};
```

- [ ] **Step 4: Register the tool**

In `packages/cli/src/harness/tools/builtin/index.ts`:

1. Add `taskDiscardWorktreeTool,` to the import block from `./task_tools.js` (after `taskUnpauseTool,`, line ~37).
2. Add `registry.register(taskDiscardWorktreeTool);` after `registry.register(taskUnpauseTool);` (line ~84).
3. Add `taskDiscardWorktreeTool,` to the re-export block (after `taskUnpauseTool,`, line ~118).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_discard_worktree.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm -F caretaker-cli typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/index.ts packages/cli/src/harness/tools/builtin/task_discard_worktree.test.ts
git commit -m "feat(tasks): task_discard_worktree builtin tool"
```

---

### Task 4: Web endpoint + webview "Discard worktree" button

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts`
- Modify: `packages/webview-ui/src/ProjectsTab.tsx`

**Interfaces:**
- Consumes: `discardWorktree` from `../../lib/task_git.js` (server); the `/api/tasks/:id/discard-worktree` endpoint (webview).
- Produces: `POST /api/tasks/:id/discard-worktree`; a button rendered when `selectedTask.worktreePath` is set.

- [ ] **Step 1: Add the server import**

In `packages/cli/src/cli/web/server.ts`, after the store import (line 11), add:

```ts
import { discardWorktree } from '../../lib/task_git.js';
```

- [ ] **Step 2: Add the endpoint**

In `server.ts`, immediately after the `app.post('/api/tasks/:id/status', ...)` handler (ends line ~394), add:

```ts
  app.post('/api/tasks/:id/discard-worktree', async (c) => {
    const taskId = Number(c.req.param('id'));
    const task = await getTaskById(taskId);
    if (!task) return c.json({ ok: false, error: 'not found' }, 404);
    if (!task.worktreePath) return c.json({ ok: false, error: 'no worktree' }, 400);

    await discardWorktree(task.worktreePath, task.title);
    task.worktreePath = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return c.json({ ok: true, branch: task.branch });
  });
```

- [ ] **Step 3: Extend the webview `Task` interface**

In `packages/webview-ui/src/ProjectsTab.tsx`, inside `interface Task { ... }` (line ~21-34), add after `lockedAt: string | null;`:

```ts
  branch: string | null;
  worktreePath: string | null;
```

- [ ] **Step 4: Import the git icon**

In `ProjectsTab.tsx`, extend the icon import (line 3) to include `GitIcon`:

```ts
import { FolderIcon, DeleteIcon, WarningIcon, ToolIcon, SettingsIcon, PauseIcon, ActivateIcon, GitIcon } from './icons.js';
```

- [ ] **Step 5: Add the discard handler**

In `ProjectsTab.tsx`, after `handleToggleTaskStatus` (ends line ~261), add:

```ts
  const handleDiscardWorktree = async (task: Task) => {
    if (!window.confirm(`Discard the worktree for task #${task.id}? Pending changes are committed to branch ${task.branch}; the branch is kept.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${task.id}/discard-worktree`, { method: 'POST' });
      if (res.ok) {
        fetchTasks(task.projectId);
      }
    } catch (err) {
      console.error('Failed to discard worktree:', err);
    }
  };
```

- [ ] **Step 6: Render the button in the task header**

In `ProjectsTab.tsx`, inside the task-header `<div>` (the flex row holding the `<h3>Task #…</h3>` and the Pause/Activate button, lines ~506-523), the two buttons should sit together. Replace the single Pause/Activate `<button>` with a wrapping flex container that holds both it and the new button:

```tsx
                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                      {selectedTask.worktreePath && (
                        <button
                          className="confirm__btn"
                          onClick={() => handleDiscardWorktree(selectedTask)}
                          title={`Commit pending changes to ${selectedTask.branch} and remove the worktree`}
                          style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        >
                          <GitIcon size={12} /> Discard worktree
                        </button>
                      )}
                      <button
                        className="confirm__btn confirm__btn--primary"
                        onClick={() => handleToggleTaskStatus(selectedTask)}
                        style={{ padding: '3px 10px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        {selectedTask.status === 'active' ? (
                          <>
                            <PauseIcon size={12} /> Pause
                          </>
                        ) : (
                          <>
                            <ActivateIcon size={12} /> Activate
                          </>
                        )}
                      </button>
                    </div>
```

- [ ] **Step 7: Typecheck / build both packages**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F webview-ui build`
Expected: no errors; webview bundle builds.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli/web/server.ts packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(tasks): discard-worktree endpoint + webview button"
```

---

### Task 5: Changeset + full verification

**Files:**
- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Full build, typecheck, and test**

Run: `pnpm build && pnpm test`
Expected: all packages build; all tests pass, including the new `task_git.test.ts` and `task_discard_worktree.test.ts`.

- [ ] **Step 2: Manual end-to-end verification (web GUI)**

```bash
CARETAKER_HOME=/tmp/ct-wt pnpm -F caretaker-cli dev web
```

In the web GUI:
1. Create a Project whose `workingDir` is a git repo (e.g. a fresh `git init` temp dir with one commit).
2. Create a task in that project and activate it.
3. Wait for a heartbeat cycle (the daemon ticks every 15 s). Confirm in the repo:
   - `git worktree list` shows a worktree under `/tmp/ct-wt/worktrees/<projectId>-<taskId>`.
   - `git branch --list 'caretaker/*'` shows the task branch.
   - After a cycle that changed files, `git log caretaker/task-<id>-* --oneline` shows `wip: <title>` commits.
4. Click **Discard worktree** on the task. Confirm the worktree dir is gone (`git worktree list`) but the branch remains (`git branch --list 'caretaker/*'`).
5. (Optional) Create a task in a **non-git** project working dir and confirm the heartbeat still runs it in place (no worktree created, no error).

Record the observed output.

- [ ] **Step 3: Draft the changeset**

Run: `pnpm run changeset`

Choose **minor** for the affected packages (`caretaker-cli`, `webview-ui`). Summary:

```
Autonomous tasks now run in a dedicated git worktree on a per-task branch (caretaker/task-<id>-<slug>). Progress is committed every heartbeat cycle; on completion the worktree is removed and the branch is left for review. Non-git projects run in place as before. Adds a "Discard worktree" action (web button + mcp__task__task_discard_worktree tool).
```

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for autonomous task worktree isolation"
```

---

## Self-Review

- **Spec coverage:**
  - Schema fields → Task 1. ✔
  - Lazy worktree creation on first heartbeat + non-git fallback → Task 2 Step 2. ✔
  - WIP commit each cycle → Task 2 Step 3 (`else if commitWip`). ✔
  - DONE: final commit + remove worktree + keep branch → Task 2 Step 3 (`status === 'done'`) via `discardWorktree`. ✔
  - paused/blocked/yield keep worktree → Task 2 Step 3 only removes on `done`; other statuses hit the `commitWip` branch. ✔
  - Git module (`isGitRepo`/`ensureWorktree`/`commitWip`/`finalizeDone`/`discardWorktree`) → Task 1. ✔
  - Manual discard affordance: web endpoint + UI button + mirror tool → Tasks 3 & 4. ✔
  - Testing → `task_git.test.ts` (Task 1), `task_discard_worktree.test.ts` (Task 3), manual E2E (Task 5). ✔
- **Placeholder scan:** none — all steps contain concrete code/commands.
- **Type consistency:** `discardWorktree(worktreePath, title)` signature identical across module, tool, and server. `Task.branch` / `Task.worktreePath` added in both `db.ts` and the webview interface. `agentDirIn`/`ensureWorktree`/`commitWip` names match between Task 1 definitions and Task 2 usage.
- **Deviation from spec (intentional):** git helpers live in `packages/cli/src/lib/task_git.ts` (not `scheduler/`) so the builtin tool and web server can import them without a harness→scheduler dependency. WIP commit message drops the "(cycle N)" counter (cosmetic; avoids storing a base sha).
