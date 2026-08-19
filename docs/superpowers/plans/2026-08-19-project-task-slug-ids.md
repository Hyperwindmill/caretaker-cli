# Project and Task Slug Ids — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, **inline and sequentially** — NOT subagent-driven. The work is one dependency web: types flip first, then compile errors are chased with a workspace-global `tsc`. Parallel workers sharing one typecheck will trample each other. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace numeric `Project.id` and `Task.id` with opaque string ids — a user-settable slug for projects, `<projectSlug>-<seq>` for tasks — so ids are never reused after deletion.

**Architecture:** One validator module (`lib/project_slug.ts`) is the authority for slug rules, called by all three config write paths. The type flip propagates `number → string` through the cli package in one commit. A lazy, idempotent migration pass on the store's query queue coerces existing numeric ids to their string forms (`3` → `"3"`, task `17` in project `3` → `"3-17"`), chosen so every derived artifact name (worktree dir, container name, managed clone dir) stays byte-identical and nothing on disk moves.

**Tech Stack:** TypeScript strict ESM, Node built-in test runner via `tsx`, `@morphql/store` FolderAdapter (JSON array per collection under `~/.caretaker/store/`), Hono web server, React webview.

**Spec:** `docs/superpowers/specs/2026-08-19-project-task-slug-ids-design.md` — read it first; this plan implements it and argues from it.

## Global Constraints

- Package manager is **pnpm** (≥10). Never `npm install`.
- `pnpm -F @hyperwindmill/caretaker-cli typecheck` is the gate after every task. **`pnpm test` runs via tsx and does NOT type-check** — a green test run proves nothing about types.
- Commit at the end of every task. **NEVER `--amend`, `rebase`, or `reset`** — fixes go in a new commit on top, even one-word fixes. The user pushes and tags from GitHub Desktop mid-session without announcing it.
- Work directly on the current branch. **No git worktrees.**
- All code, comments, and test names in English.
- Tests are co-located `*.test.ts`. Env isolation at **file scope**: set `process.env.CARETAKER_HOME` to a `mkdtemp` dir in a top-level `before()` and dynamic-`import()` the module under test after (see `packages/cli/src/store/db.test.ts` for the canonical pattern). Never mutate `CARETAKER_HOME` per-describe.
- A changeset file is mandatory (Task 6). Semver: **minor** (`ProjectConfig.id` is a public type in `caretaker-types`, re-exported by the published CLI's `./types` entry).

### DO-NOT-TOUCH (applies to every task)

These files use "task" to mean **`ServiceConfig`** (a scheduled service), whose `id` is **already `string`**. `tsc` will not flag a wrong edit here. Leave them completely unchanged:

- `packages/cli/src/cli/web/scheduler/heartbeat.ts`
- `packages/cli/src/cli/web/scheduler/telegram.ts`
- `packages/cli/src/cli/web/scheduler/logs.ts`
- `packages/webview-ui/src/ServicesTab.tsx`
- `packages/webview-ui/src/bridge.ts` (its `taskId` fields are service ids)
- `packages/webview-ui/src/App.tsx` `taskRuns` handling (service ids)
- In `packages/cli/src/cli/web/scheduler/locks.ts`: **`runningTasks: Set<string>` stays exactly as is** — it holds service ids. Only `runningTaskControllers`, `abortRunningTask`, and `syncingProjects` change (Task 2).

Verification after each task: `git diff --stat` must show no lines changed in the first six files.

---

### Task 1: Slug validator module

**Files:**
- Create: `packages/cli/src/lib/project_slug.ts`
- Create: `packages/cli/src/lib/project_slug.test.ts`
- Modify: `packages/cli/src/store/json.ts` (one re-export line)

**Interfaces:**
- Produces: `PROJECT_SLUG_RE: RegExp`, `validateProjectSlug(id: string): string | null`, `validateProjectIds(incoming: Array<{ id: string; name: string }>): string | null`. `null` = valid, string = user-facing error. Task 4 wires these into the three write paths; Task 5 copies the regex client-side for form feedback.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/cli/src/lib/project_slug.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectSlug, validateProjectIds } from './project_slug.js';

describe('validateProjectSlug', () => {
  it('accepts simple slugs', () => {
    assert.equal(validateProjectSlug('caretaker-cli'), null);
    assert.equal(validateProjectSlug('a'), null);
    assert.equal(validateProjectSlug('3'), null); // migrated numeric id
    assert.equal(validateProjectSlug('a'.repeat(39)), null);
  });
  it('rejects bad charset and shape', () => {
    // trailing hyphen: docker image grammar requires components end alphanumeric
    assert.ok(validateProjectSlug('foo-'));
    assert.ok(validateProjectSlug('-foo'));
    assert.ok(validateProjectSlug('Foo'));
    assert.ok(validateProjectSlug('foo_bar'));
    assert.ok(validateProjectSlug('foo/bar'));
    assert.ok(validateProjectSlug('..'));
    assert.ok(validateProjectSlug(''));
    assert.ok(validateProjectSlug('a'.repeat(40)));
  });
});

describe('validateProjectIds', () => {
  it('accepts a valid unique set', () => {
    assert.equal(validateProjectIds([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), null);
  });
  it('rejects a duplicate id', () => {
    const err = validateProjectIds([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]);
    assert.ok(err && err.includes('a'));
  });
  it('rejects an invalid id and names the project', () => {
    const err = validateProjectIds([{ id: 'Foo-', name: 'Broken' }]);
    assert.ok(err && err.includes('Broken'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/project_slug.test.ts`
Expected: FAIL — cannot find module `./project_slug.js`.

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/lib/project_slug.ts
/**
 * Authoritative validation for project ids (slugs).
 *
 * Same contract as validateRepositoryUrl (lib/repo_url.ts): the webview may
 * keep a copy of the regex for form feedback, but every write path into
 * caretaker.json — POST /api/projects, the web server's saveConfig websocket
 * handler, and the VSCode sidebar's saveConfig handler — must call THIS one,
 * because clients can send any payload.
 *
 * The slug is embedded verbatim in docker container/image names, git ref
 * names, and filesystem paths under ~/.caretaker/ (a trust boundary: the
 * charset is what makes `..` and `/` unrepresentable). It must start AND end
 * alphanumeric — the docker image reference grammar
 * `[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*` rejects a component ending in a hyphen,
 * so `foo-` would make `caretaker-project-foo-:latest` an invalid reference.
 *
 * Slugs are immutable after creation by construction: the two forms never
 * change the id of an existing project and POST /api/projects only creates.
 * A changed id arriving via saveConfig is indistinguishable from a
 * delete+create, so it cannot be rejected here; the web handler additionally
 * refuses to drop a project that still has tasks (Task 4).
 */
export const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export function validateProjectSlug(id: string): string | null {
  if (!PROJECT_SLUG_RE.test(id)) {
    return 'Project id must be 1-39 characters of a-z, 0-9 and hyphens, starting and ending with a letter or digit.';
  }
  return null;
}

export function validateProjectIds(incoming: Array<{ id: string; name: string }>): string | null {
  const seen = new Set<string>();
  for (const p of incoming) {
    const err = validateProjectSlug(String(p.id));
    if (err) return `Project "${p.name}": ${err}`;
    if (seen.has(p.id)) return `Duplicate project id "${p.id}".`;
    seen.add(p.id);
  }
  return null;
}
```

- [ ] **Step 4: Re-export from the store entry** (the VSCode sidebar imports through `./store`, exactly like `validateRepositoryUrl` — see `packages/cli/src/store/json.ts:11`):

```typescript
// packages/cli/src/store/json.ts — add next to the existing repo_url re-export:
export { validateProjectSlug, validateProjectIds, PROJECT_SLUG_RE } from '../lib/project_slug.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/project_slug.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/lib/project_slug.ts packages/cli/src/lib/project_slug.test.ts packages/cli/src/store/json.ts
git commit -m "feat(cli): add authoritative project slug validator"
```

---

### Task 2: The type flip — string ids through the cli package

One commit. The workspace will not typecheck at intermediate steps; that is expected. Follow the file order below, then let `tsc` find what the list missed.

**Files:**
- Modify: `packages/types/src/index.ts` (ProjectConfig)
- Modify: `packages/cli/src/store/db.ts` (Task, TaskMessage, all task functions)
- Modify: `packages/cli/src/lib/task_git.ts`
- Modify: `packages/cli/src/lib/docker.ts`
- Modify: `packages/cli/src/cli/web/scheduler/locks.ts`
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`
- Modify: `packages/cli/src/cli/web/scheduler/task_roles.ts` (and `task_review.ts` if tsc flags it)
- Modify: `packages/cli/src/cli/web/server.ts`
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts`
- Modify/Test: `packages/cli/src/store/db.test.ts` and any other test tsc or the runner flags

**Interfaces:**
- Consumes: nothing from Task 1 (validation wiring is Task 4).
- Produces: `Task { id: string; projectId: string; seq: number; … }`, `ProjectConfig { id: string; nextTaskSeq?: number | null; … }`, `createTask(task: Omit<Task, 'id' | 'seq' | 'createdAt' | 'updatedAt'>): Promise<Task>` (computes seq and id itself), `getTaskById(id: string)`, `deleteTask(taskId: string)`, `containerName(taskId: string)`, `ensureWorktree(projectWorkingDir: string, taskId: string, title: string, existingBranch?: string | null)`, `abortRunningTask(taskId: string)`, `syncingProjects: Set<string>`.

- [ ] **Step 1: `packages/types/src/index.ts`** — in `ProjectConfig`: `id: number` → `id: string`, and add after `active`:

```typescript
  /** High-water mark for task sequence numbers in this project. Tasks get
   *  id `<projectId>-<seq>`; the counter never decreases, so a deleted
   *  task's id is never reused. Self-heals from existing tasks' seq. */
  nextTaskSeq?: number | null;
```

Add a doc comment on `id` itself: `/** Opaque slug (see lib/project_slug.ts). Immutable after creation; embedded in container/image names, git refs, and paths under ~/.caretaker/. */`

- [ ] **Step 2: `packages/cli/src/store/db.ts`** — interfaces:

```typescript
export interface Task {
  /** `<projectId>-<seq>`. OPAQUE — never parse it; projectId and seq below
   *  are the source of truth. Embedded verbatim in the worktree dir name
   *  (~/.caretaker/worktrees/<id>) and container name (caretaker-task-<id>). */
  id: string;
  projectId: string;
  /** Per-project sequence number; stored, never derived from id. */
  seq: number;
  // …rest unchanged
}
```

`TaskMessage.taskId: number` → `string`.

Add an id guard used by every function that interpolates a task id into a query (string ids come straight from route params; the charset guard is what keeps quote characters out of the query):

```typescript
/** Ids are validated slugs/composites; anything else never matches a record.
 *  Also keeps quotes/backslashes out of interpolated queries. */
function safeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}
```

Rewrite the task functions — note every task-id interpolation gains quotes:

```typescript
export async function getTaskById(id: string): Promise<Task | null> {
  if (!safeId(id)) return null;
  try {
    const taskRows = (await runQuery(`SELECT * FROM tasks WHERE id = '${id}'`)) as Task[];
    return taskRows[0] || null;
  } catch (err) {
    return null;
  }
}

export async function saveTask(task: Task): Promise<void> {
  await runQuery(`DELETE FROM tasks WHERE id = '${task.id}'`);
  await runQuery(`INSERT INTO tasks ${JSON.stringify(task)}`);
}

export async function createTask(task: Omit<Task, 'id' | 'seq' | 'createdAt' | 'updatedAt'>): Promise<Task> {
  if (!safeId(task.projectId)) throw new Error(`Invalid project id: ${task.projectId}`);
  const config = await loadConfig();
  const project = (config.projects || []).find((p) => p.id === task.projectId);
  const existing = (await runQuery(`SELECT * FROM tasks WHERE projectId = '${task.projectId}'`)) as Task[];
  const seq = Math.max(project?.nextTaskSeq ?? 0, 0, ...existing.map((t) => t.seq ?? 0)) + 1;
  const record: Task = {
    ...task,
    id: `${task.projectId}-${seq}`,
    seq,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await runQuery(`INSERT INTO tasks ${JSON.stringify(record)}`);
  if (project) {
    // ponytail: unlocked read-modify-write on nextTaskSeq; the max() over
    // existing seqs above heals races and stale-config rollbacks. Move the
    // counter into the folder DB behind runQuery's queue if it ever matters.
    project.nextTaskSeq = seq;
    await saveConfig(config);
  }
  return record;
}
```

(`createTask` returns the record it built — the old re-read-and-`find()` hack, which returned the wrong task on a duplicated title+objective, is deleted, not adapted.) Add the import: `import { loadConfig, saveConfig } from './json.js';` — same package, no cycle (`json.ts` does not import `db.ts`).

`addTaskMessage`, `deleteTask`, `deleteTaskMessages` (db.ts:161, 187-189): parameter types → `string`, guard with `safeId`, quote the `taskId` interpolations. `updateTaskMessageContent` keeps its numeric message `id` unchanged.

- [ ] **Step 3: `packages/cli/src/lib/task_git.ts`**

```typescript
function worktreePathFor(taskId: string): string {
  return join(dataDir(), 'worktrees', taskId); // task id is already <projectId>-<seq>
}

export async function ensureWorktree(
  projectWorkingDir: string,
  taskId: string,
  title: string,
  existingBranch?: string | null,
): Promise<{ branch: string; worktreePath: string; agentWorkingDir: string }> {
  const repoRoot = await git(projectWorkingDir, ['rev-parse', '--show-toplevel']);
  // The persisted branch is authoritative: re-deriving under the new id scheme
  // would produce a different name and orphan a lost-path task's commits.
  const branch = existingBranch || `caretaker/task-${taskId}-${slug(title)}`;
  const worktreePath = worktreePathFor(taskId);
  // …rest of the body unchanged
```

`managedRepoDir` (task_git.ts:130): `String(project.id)` → `project.id`; the inline `{ id: number; … }` param types in `projectWorkingDir`/`managedRepoDir`/`projectRepoStatus`/`syncProjectRepo` → `id: string`.

- [ ] **Step 4: `packages/cli/src/lib/docker.ts`**

```typescript
/** Deterministic container name for a task — the caller's naming policy. */
export function containerName(taskId: string): string {
  return `caretaker-task-${taskId}`; // task id is already <projectId>-<seq>
}
```

- [ ] **Step 5: `packages/cli/src/cli/web/scheduler/locks.ts`** — `runningTaskControllers: Map<string, AbortController>`, `abortRunningTask(taskId: string)`, `syncingProjects: Set<string>`. **`runningTasks: Set<string>` stays untouched** (service ids — see DO-NOT-TOUCH).

- [ ] **Step 6: `packages/cli/src/cli/web/scheduler/task_strategy.ts`** — the two call sites:

```typescript
const wt = await ensureWorktree(baseWorkingDir, task.id, task.title, task.branch);   // line ~219
const name = containerName(task.id);                                                 // line ~237
```

`imageRef = \`caretaker-project-${task.projectId}:latest\`` (line ~251) needs no change beyond types. Quote the two task-message queries (lines ~397, ~660): `WHERE taskId = '${task.id}'`.

- [ ] **Step 7: `packages/cli/src/cli/web/scheduler/task_roles.ts`** — quote the query at line 87: `WHERE taskId = '${task.id}'`. Fix any type errors tsc reports here and in `task_review.ts`.

- [ ] **Step 8: `packages/cli/src/cli/web/server.ts`** — all **16** `Number(c.req.param('id'))` become `c.req.param('id')` (5 project routes: lines ~348, 374, 398, 409, 421; 11 task routes: ~472, 483, 510, 536, 577, 599, 618, 665, 687, 720, 754). Quote the three project-id query interpolations (~362-363, 412):

```typescript
await runQuery(`DELETE FROM task_messages WHERE taskId IN (SELECT id FROM tasks WHERE projectId = '${id}')`);
await runQuery(`DELETE FROM tasks WHERE projectId = '${id}'`);
const rows = (await runQuery(`SELECT * FROM tasks WHERE projectId = '${id}'`)) as Task[];
```

and the task-message one (~474). Note: raw param strings reaching `runQuery` are safe because every db function now guards with `safeId` — but the two project queries above interpolate directly, so guard them at the top of each route: `if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return c.json({ error: 'Invalid id' }, 400);`

In `POST /api/projects` (~314): delete the `nextId` line; take `id` from the body (validation is wired in Task 4; for now `const id = String(body.id || '').trim();` and reject empty with 400). In `DELETE /api/projects/:id` rewrite the comment at ~355: the managed-clone removal is kept because deleting a deleted project's repository is correct regardless of id reuse (ids no longer get reused).

In `POST /api/projects/:id/tasks` (~421): `projectId` is now the param string; the `createTask` call no longer needs changes beyond that.

- [ ] **Step 9: `packages/cli/src/harness/tools/builtin/task_tools.ts`** — the JSON schemas are invisible to tsc in BOTH directions; use grep as the checklist:

```bash
grep -c "type: 'number'" packages/cli/src/harness/tools/builtin/task_tools.ts   # expect 19 before
grep -c "Number(args\." packages/cli/src/harness/tools/builtin/task_tools.ts    # expect 19 before
```

Every one of the 19 `type: 'number'` occurrences is a `task_id` or `project_id` param — flip each to `{ type: 'string' }`. Every `Number(args.task_id)` / `Number(args.project_id)` becomes `String(args.task_id)` / `String(args.project_id)` — `String()` also keeps external MCP clients that still send migrated numeric ids (`17`) working. After the edit both grep counts must be **0**, and `grep -c "type: 'string' }" …` gained 19.

- [ ] **Step 10: Run `pnpm -F @hyperwindmill/caretaker-cli typecheck` and fix every remaining error.** Expect stragglers in files not listed above (e.g. inline types in `task_review.ts`, tool result formatting). While fixing, re-check the DO-NOT-TOUCH list: if tsc drags you into `heartbeat.ts`, `telegram.ts`, or `logs.ts`, the edit that caused it is wrong — those files only deal in service ids.

- [ ] **Step 11: Update existing tests + add seq tests.** `db.test.ts` currently asserts `typeof task.id === 'number'` and passes `projectId: 1` — flip to `projectId: 'p1'` / composite expectations. Then add:

```typescript
it('assigns composite ids from a per-project sequence', async () => {
  const a = await db.createTask({ projectId: 'seqproj', title: 'A', objective: 'o', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  const b = await db.createTask({ projectId: 'seqproj', title: 'B', objective: 'o', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  assert.equal(a.id, `seqproj-${a.seq}`);
  assert.equal(b.seq, a.seq + 1);
});

it('never reuses a deleted task id (monotonic seq)', async () => {
  const a = await db.createTask({ projectId: 'monoproj', title: 'A', objective: 'o', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  await db.deleteTask(a.id);
  const b = await db.createTask({ projectId: 'monoproj', title: 'B', objective: 'o', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  assert.notEqual(b.id, a.id);
  assert.ok(b.seq > a.seq);
});
```

(Monotonicity across deletion works without a config file because `createTask` persists `nextTaskSeq` only when the project exists in config — in this store-only test the self-heal `max(...existing seqs)` can't see the deleted task, so ALSO write a `caretaker.json` with `projects: [{ id: 'monoproj', … }]` into the test home before this test, or assert via the config-backed path. The executor must make the second variant pass, not weaken it.)

```typescript
it('returns the NEW task when title and objective duplicate an existing one', async () => {
  const a = await db.createTask({ projectId: 'dupproj', title: 'Same', objective: 'same', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  const b = await db.createTask({ projectId: 'dupproj', title: 'Same', objective: 'same', checklist: [], status: 'draft', blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null });
  assert.notEqual(b.id, a.id);
  assert.equal(b.seq, a.seq + 1);
});
```

- [ ] **Step 12: Full gate + do-not-touch check + commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
git diff --stat -- packages/cli/src/cli/web/scheduler/heartbeat.ts packages/cli/src/cli/web/scheduler/telegram.ts packages/cli/src/cli/web/scheduler/logs.ts
# expect: empty
git add -A packages/cli/src packages/types/src
git commit -m "feat!: string slug ids for projects and composite ids for tasks"
```

---

### Task 3: Migration pass

**Files:**
- Modify: `packages/cli/src/store/db.ts` (migration + queue gate)
- Modify: `packages/cli/src/store/json.ts` (`loadConfig` coercion)
- Test: `packages/cli/src/store/migration.test.ts` (new file — file-scope env isolation)

**Interfaces:**
- Consumes: `runQuery` queue, `FolderAdapter` layout (`<CARETAKER_HOME>/store/tasks.json`, `task_messages.json` — plain JSON arrays).
- Produces: transparent behaviour — no new exports. Every store access from every surface (including `caretaker-cli mcp`) waits for the migration because it runs as the first operation on the `runQuery` queue.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/store/migration.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('numeric id migration', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-mig-test-'));
    process.env.CARETAKER_HOME = testHome;
    await mkdir(join(testHome, 'store'), { recursive: true });
    await writeFile(join(testHome, 'store', 'tasks.json'), JSON.stringify([
      { id: 17, projectId: 3, title: 'Old task', objective: 'o', checklist: [], status: 'active',
        blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
        branch: 'caretaker/task-17-old-task', worktreePath: '/x/worktrees/3-17',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]));
    await writeFile(join(testHome, 'store', 'task_messages.json'), JSON.stringify([
      { id: 1, taskId: 17, role: 'user', messageType: 'chat', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' },
    ]));
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  it('rewrites numeric ids to composites, seeds seq, and preserves the branch', async () => {
    const task = await db.getTaskById('3-17'); // first store access triggers migration
    assert.ok(task);
    assert.equal(task.id, '3-17');
    assert.equal(task.projectId, '3');
    assert.equal(task.seq, 17);
    assert.equal(task.branch, 'caretaker/task-17-old-task'); // untouched — authoritative
    const msgs = await db.runQuery(`SELECT * FROM task_messages WHERE taskId = '3-17'`);
    assert.equal(msgs.length, 1);
  });

  it('derived artifact names are byte-identical to the pre-migration ones', async () => {
    const { containerName } = await import('../lib/docker.js');
    assert.equal(containerName('3-17'), 'caretaker-task-3-17'); // == old caretaker-task-<3>-<17>
    // worktreePathFor is module-private; the worktree dir equality is covered by
    // the preserved task.worktreePath ('/x/worktrees/3-17') matching join(dataDir(),'worktrees','3-17').
  });

  it('is idempotent', async () => {
    const beforeBytes = await readFile(join(testHome, 'store', 'tasks.json'), 'utf8');
    await db.getTaskById('3-17');
    const afterBytes = await readFile(join(testHome, 'store', 'tasks.json'), 'utf8');
    assert.equal(afterBytes, beforeBytes);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/migration.test.ts`
Expected: FAIL — `getTaskById('3-17')` returns null (the stored id is numeric `17`).

- [ ] **Step 3: Implement in `db.ts`.** `getDb()` is synchronous, so the pass gates the queue instead:

```typescript
let migrationPromise: Promise<void> | null = null;

/** One-time, idempotent rewrite of numeric ids to their string composites:
 *  project 3 → "3", task 17 in project 3 → "3-17". Chosen so every derived
 *  artifact name (worktrees/3-17, caretaker-task-3-17, repos/3) is
 *  byte-identical to what is already on disk — nothing moves. Runs as the
 *  first operation on the query queue, so every surface waits for it. */
async function migrateNumericIds(): Promise<void> {
  const store = getDb();
  const tasks = (await store.query('SELECT * FROM tasks')) as any[];
  const legacy = tasks.filter((t) => typeof t.id === 'number');
  for (const t of legacy) {
    const oldId = t.id as number;
    const projectId = String(t.projectId);
    const newId = `${projectId}-${oldId}`;
    await store.query(`DELETE FROM tasks WHERE id = ${oldId}`);
    await store.query(`INSERT INTO tasks ${JSON.stringify({ ...t, id: newId, projectId, seq: oldId })}`);
    await store.query(`UPDATE task_messages SET taskId = '${newId}' WHERE taskId = ${oldId}`);
  }
}

export async function runQuery(sql: string): Promise<any> {
  if (!migrationPromise) migrationPromise = migrateNumericIds();
  const op = async () => {
    await migrationPromise;
    return getDb().query(sql);
  };
  const resultPromise = queryQueue.then(op);
  queryQueue = resultPromise.catch(() => {});
  return resultPromise;
}
```

(Note `migrateNumericIds` calls `store.query` directly, never `runQuery` — calling `runQuery` from inside the gate would deadlock on `migrationPromise`.)

- [ ] **Step 4: `loadConfig` coercion in `json.ts`** — projects saved by older versions carry numeric ids:

```typescript
export async function loadConfig(): Promise<CaretakerConfig> {
  const cfg = await readJsonOrDefault(configPath(), defaultConfig);
  // Numeric project ids from older versions become their string slugs ("3").
  for (const p of cfg.projects || []) (p as any).id = String(p.id);
  return cfg;
}
```

- [ ] **Step 5: Run the migration tests, then the full suite**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/migration.test.ts` → PASS
Run: `pnpm -F @hyperwindmill/caretaker-cli test && pnpm -F @hyperwindmill/caretaker-cli typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/store/db.ts packages/cli/src/store/json.ts packages/cli/src/store/migration.test.ts
git commit -m "feat(cli): lazy idempotent migration of numeric ids to string composites"
```

---

### Task 4: Wire validation into the three write paths

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts` (`POST /api/projects`, `saveConfig` ws handler)
- Modify: `packages/vscode-extension/src/sidebar.ts` (`saveConfig` handler, ~line 376)

**Interfaces:**
- Consumes: `validateProjectSlug` / `validateProjectIds` from Task 1 (sidebar imports them from the `./store` entry, like `validateRepositoryUrl`); `runQuery` for the has-tasks check.

- [ ] **Step 1: `POST /api/projects`** — after the existing `validateRepositoryUrl` block:

```typescript
const id = String(body.id || '').trim();
const slugError = validateProjectSlug(id);
if (slugError) return c.json({ error: slugError }, 400);
const config = await loadConfig();
if ((config.projects || []).some((p) => p.id === id)) {
  return c.json({ error: `Project id "${id}" already exists.` }, 400);
}
```

(the project object then uses `id`, and the old `nextId` computation is already gone from Task 2).

- [ ] **Step 2: web `saveConfig` handler** — extend the existing per-project loop (which already validates repository URLs) with ids, plus the referential guard:

```typescript
const idError = validateProjectIds(msg.config.projects || []);
if (idError) { post({ type: 'error', message: idError }); return; }
// A project that still has tasks must be deleted through DELETE /api/projects/:id
// (which removes tasks, worktrees and the managed clone) — not silently dropped
// from a config save. Also blocks id "renames", which arrive as drop+add.
const prev = await loadConfig();
const incomingIds = new Set((msg.config.projects || []).map((p) => p.id));
for (const old of prev.projects || []) {
  if (incomingIds.has(old.id)) continue;
  const remaining = (await runQuery(`SELECT * FROM tasks WHERE projectId = '${old.id}'`)) as unknown[];
  if (remaining.length > 0) {
    post({ type: 'error', message: `Project "${old.name}" still has ${remaining.length} task(s) — delete it from the Projects panel instead.` });
    return;
  }
}
```

- [ ] **Step 3: VSCode sidebar `saveConfig`** — same shape as its `validateRepositoryUrl` loop; charset+uniqueness only (the sidebar has no db access through the public `./store` export, and it does not render the Projects tab, so its saves pass the projects array through untouched):

```typescript
const idError = validateProjectIds(msg.config.projects || []);
if (idError) { /* post the error the same way the repoUrl loop does */ return; }
```

Import `validateProjectIds` from the same specifier the file already uses for `validateRepositoryUrl`.

- [ ] **Step 4: Gates + commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
pnpm -F caretaker-vscode build
git add packages/cli/src/cli/web/server.ts packages/vscode-extension/src/sidebar.ts
git commit -m "feat: enforce project slug rules on all three config write paths"
```

---

### Task 5: Webview — types, slug field, no more client-side ids

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (local `Project`/`Task`/`TaskMessage` interfaces)
- Modify: `packages/webview-ui/src/ProjectsTabSettings.tsx` (slug input; delete the `Math.max` id assignment at ~line 121)

**Interfaces:**
- Consumes: `PROJECT_SLUG_RE` semantics from Task 1 — but as a **copy** (UX only; the host-side validators from Task 4 are the enforcement). The webview cannot import from the cli package.

- [ ] **Step 1: `ProjectsTab.tsx`** — local interfaces: `Project.id: string`; `Task.id: string`, `Task.projectId: string`, add `seq: number`; `TaskMessage.taskId: string`. Chase the resulting tsc errors inside this file and any props they flow into (state defaults like `useState<number | null>` become `useState<string | null>`).

- [ ] **Step 2: `ProjectsTabSettings.tsx`** — add slug state + input; replace the id computation:

```typescript
// UX copy only — authoritative validation is host-side (lib/project_slug.ts).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const [slugText, setSlugText] = useState('');
```

In the create branch (was `const nextId = Math.max(...)`):

```typescript
if (isCreating) {
  const slug = slugText.trim();
  if (!SLUG_RE.test(slug) || projects.some((p) => p.id === slug)) {
    setError('Project id must be 1-39 chars of a-z, 0-9 and hyphens (start/end alphanumeric) and unique.');
    return;
  }
  const newProj: ProjectConfig = {
    id: slug,
    // …rest of the literal unchanged
```

(use whatever error affordance the form already has; if none, add a small red text line — match surrounding style). The input renders only when `isCreating`; when editing, show the id as read-only text — **the id is immutable after creation**. `deleteProject(id: number)` → `(id: string)`.

- [ ] **Step 3: Gates + commit**

```bash
pnpm -F webview-ui typecheck
pnpm -F webview-ui test
pnpm -F webview-ui build
git add packages/webview-ui/src
git commit -m "feat(webview): project slug field; string ids; drop client-side id assignment"
```

---

### Task 6: Docs, spec amendment, changeset

**Files:**
- Modify: `CLAUDE.md` (State on disk section)
- Modify: `docs/superpowers/specs/2026-08-19-project-task-slug-ids-design.md` (one amendment)
- Modify: `README.md` (only if it documents project creation fields — check)
- Create: `.changeset/slug-ids.md`

- [ ] **Step 1: `CLAUDE.md`** — in *State on disk*: project ids are now user-chosen slugs (validated by `lib/project_slug.ts`, immutable, embedded in container/image/branch/path names); task ids are `<projectSlug>-<seq>` with a persisted per-project `nextTaskSeq` high-water mark (never reused after deletion; `seq` stored on the task, ids never parsed); numeric ids from older installs are migrated lazily and byte-compatibly on first store access (`3` → `"3"`, `17` → `"3-17"`; derived artifact names unchanged). Update the sentence that currently justifies the managed-clone delete by id reuse ("project ids are `max+1`…") — the removal stays, the justification changes. Also update the layer-5 mention of worktree naming to `~/.caretaker/worktrees/<taskId>`.

- [ ] **Step 2: Spec amendment** — the spec promises immutability *rejection* in the saveConfig handlers; implementation reality: a changed id via saveConfig is indistinguishable from delete+create (the settings form legitimately creates through saveConfig), so enforcement is (a) charset+uniqueness on every save on all three paths, (b) the web handler refuses to drop a project that still has tasks, (c) the forms never change an existing id (read-only field). Add a short "Amendment (implementation)" note to the spec's enforcement section saying exactly this. Commit the spec change together with this task — never rewrite the earlier spec commits.

- [ ] **Step 3: Changeset** — create `.changeset/slug-ids.md`:

```markdown
---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Project ids are now user-chosen slugs and task ids are `<projectSlug>-<seq>` composites; ids are never reused after deletion. Existing numeric ids migrate automatically and byte-compatibly on first use (worktrees, containers, and managed clones keep their names). `ProjectConfig.id` and `Task.id`/`Task.projectId` are now strings; `Task.seq` and `ProjectConfig.nextTaskSeq` are new fields.
```

- [ ] **Step 4: Final gates + commit**

```bash
pnpm -r build && pnpm -r test && pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F webview-ui typecheck
git add CLAUDE.md README.md docs/superpowers/specs/2026-08-19-project-task-slug-ids-design.md .changeset/slug-ids.md
git commit -m "docs: slug ids in CLAUDE.md; spec amendment; changeset"
```

---

## Self-review notes (already applied)

- Spec coverage: validator+regex (T1), type flip incl. tool schemas and route coercions (T2), seq field + monotonicity + duplicate-title fix (T2), migration incl. branch-authority fix (T2 step 3 + T3), three write paths (T4), client-side id assignment removal + slug form (T5), docs+changeset (T6). The spec's "immutability rejection in saveConfig" is narrowed with rationale — T6 amends the spec, see Task 6 Step 2.
- The `runningTasks` / service-id trap is stated in Global Constraints AND inline in T2 steps 5 and 10.
- Type consistency: `createTask` omits `'id' | 'seq' | 'createdAt' | 'updatedAt'` everywhere it appears (T2 interface block, T2 step 11 tests use that shape).
