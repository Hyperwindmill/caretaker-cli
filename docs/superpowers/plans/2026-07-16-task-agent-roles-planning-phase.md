# Task Agent Roles + Planning Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-based agent assignment (PLANNER / DEVELOPER / REVIEWER) at project and task level, plus a PLANNING phase (default on, opt-out per project/task) where the planner runs read-only and hands off to execution via a new `task_submit_plan` tool; the review gate becomes toggleable with the same inheritance semantics.

**Architecture:** The existing `task.agentId → project.agentId → agents[0]` chain IS the developer role; planner/reviewer get optional override fields that degrade onto it. A new `'planning'` task status runs as its own heartbeat cycle branch (like `'reviewing'` does) with a post-filtered toolset (no `write`/`edit`/`multiedit`/`bash`) — same mechanism the review already uses to strip `mcp__task__*`. All resolution logic lives in one new pure module, `task_roles.ts`.

**Tech Stack:** TypeScript ESM (strict, `.js` import suffixes), Node built-in test runner via tsx, Hono (server), React (webview-ui), `@morphql/store` folder DB.

**Spec:** `docs/superpowers/specs/2026-07-16-task-agent-roles-planning-phase-design.md`

## Global Constraints

- Package manager: **pnpm** ≥10, run from repo root. Never `npm`.
- Tests co-located as `*.test.ts`, run: `pnpm -F caretaker-cli exec tsx --test <file>`. `pnpm test` does NOT typecheck — always also run `pnpm -F caretaker-cli typecheck`.
- In tests, `process.env.CARETAKER_HOME` is mutated at FILE scope only (before dynamic `import()` of store modules), never inside a test/describe.
- ESM only: relative imports end in `.js` even from `.ts` files.
- No new dependencies.
- Flag defaults: `planningEnabled` and `reviewEnabled` resolve to **true** when unset at both task and project level, and when the project record is missing.
- Every commit message in English; feature commits use `feat(tasks): …`, test-only additions ride with their feature commit.
- A changeset (minor) is mandatory at the end (Task 10).

---

### Task 1: Data model — types for roles, flags, planning status

**Files:**
- Modify: `packages/types/src/index.ts:20-27` (ProjectConfig)
- Modify: `packages/cli/src/store/db.ts:14-51` (Project, Task, TaskMessage)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Task.status` union includes `'planning'`; `Task.plannerAgentId?: string | null`, `Task.reviewerAgentId?: string | null`, `Task.planningEnabled?: boolean | null`, `Task.reviewEnabled?: boolean | null`; same four optional fields on `ProjectConfig` and on db `Project`; `TaskMessage.messageType` union includes `'plan'`. Every later task relies on these exact names.

- [ ] **Step 1: Extend ProjectConfig in packages/types/src/index.ts**

Replace lines 20-27 with:

```ts
export type ProjectConfig = {
  id: number;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
  /** Optional planner-role agent; falls back to the developer chain when unset. */
  plannerAgentId?: string | null;
  /** Optional reviewer-role agent; falls back to the developer chain when unset. */
  reviewerAgentId?: string | null;
  /** Planning phase default for tasks in this project. Unset = enabled. */
  planningEnabled?: boolean | null;
  /** DONE-review gate default for tasks in this project. Unset = enabled. */
  reviewEnabled?: boolean | null;
};
```

- [ ] **Step 2: Extend db.ts model interfaces**

In `packages/cli/src/store/db.ts`:

`Project` (lines 14-21) — add the same four optional fields after `active: boolean;`:

```ts
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
```

`Task.status` (line 29) becomes:

```ts
  status: 'draft' | 'planning' | 'active' | 'reviewing' | 'paused' | 'blocked' | 'done';
```

`Task` — after `agentId?: string | null;` (line 37) add:

```ts
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
```

`TaskMessage.messageType` (line 46) becomes:

```ts
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review' | 'plan';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -F caretaker-types build && pnpm -F caretaker-cli typecheck`
Expected: both succeed (fields are all optional; no consumer breaks).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/index.ts packages/cli/src/store/db.ts
git commit -m "feat(tasks): data model for agent roles, planning status, and gate flags"
```

---

### Task 2: `task_roles.ts` — role resolution, flag resolution, activation rule, planner tool filter

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/task_roles.ts`
- Test: `packages/cli/src/cli/web/scheduler/task_roles.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskMessage`, `runQuery` from `../../../store/db.js`; `ProjectConfig`, `AgentConfig` from `../../../types.js`; `Tool` from `../../../harness/tools/types.js`.
- Produces (used by Tasks 3-7):
  - `type TaskRole = 'planner' | 'developer' | 'reviewer'`
  - `resolveRoleAgent(role: TaskRole, task: Task, project: ProjectConfig | undefined, agents: AgentConfig[]): AgentConfig | undefined`
  - `resolvePlanningEnabled(task: Pick<Task, 'planningEnabled'>, project?: Pick<ProjectConfig, 'planningEnabled'> | null): boolean`
  - `resolveReviewEnabled(task: Pick<Task, 'reviewEnabled'>, project?: Pick<ProjectConfig, 'reviewEnabled'> | null): boolean`
  - `activationStatus(task: Task, project: ProjectConfig | undefined): Promise<'planning' | 'active'>`
  - `PLANNER_TOOL_DENYLIST: Set<string>` and `filterPlannerTools(tools: Tool[]): Tool[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/cli/web/scheduler/task_roles.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME isolation (mutate at file scope, never inside describe).
process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-taskroles-home-'));

const { createTask, addTaskMessage } = await import('../../../store/db.js');
const {
  resolveRoleAgent,
  resolvePlanningEnabled,
  resolveReviewEnabled,
  activationStatus,
  filterPlannerTools,
} = await import('./task_roles.js');
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import type { Task } from '../../../store/db.js';
import type { Tool } from '../../../harness/tools/types.js';

function agent(id: string): AgentConfig {
  return {
    id,
    name: id,
    systemPrompt: 'x',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 10,
  } as AgentConfig;
}

const AGENTS = [agent('a-default'), agent('a-dev'), agent('a-plan'), agent('a-rev'), agent('a-proj')];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    title: 't',
    objective: 'o',
    checklist: [],
    status: 'draft',
    blockedReason: null,
    noProgressCount: 0,
    maxNoProgress: 5,
    lockedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: 1, name: 'p', description: '', workingDir: '/w', agentId: 'a-proj', active: true, ...overrides };
}

test('developer chain: task.agentId -> project.agentId -> agents[0]', () => {
  assert.equal(resolveRoleAgent('developer', makeTask({ agentId: 'a-dev' }), makeProject(), AGENTS)!.id, 'a-dev');
  assert.equal(resolveRoleAgent('developer', makeTask(), makeProject(), AGENTS)!.id, 'a-proj');
  assert.equal(resolveRoleAgent('developer', makeTask(), undefined, AGENTS)!.id, 'a-default');
});

test('planner chain: task.plannerAgentId -> project.plannerAgentId -> developer chain', () => {
  assert.equal(
    resolveRoleAgent('planner', makeTask({ plannerAgentId: 'a-plan', agentId: 'a-dev' }), makeProject(), AGENTS)!.id,
    'a-plan',
  );
  assert.equal(
    resolveRoleAgent('planner', makeTask({ agentId: 'a-dev' }), makeProject({ plannerAgentId: 'a-plan' }), AGENTS)!.id,
    'a-plan',
  );
  // No planner anywhere -> developer.
  assert.equal(resolveRoleAgent('planner', makeTask({ agentId: 'a-dev' }), makeProject(), AGENTS)!.id, 'a-dev');
});

test('reviewer chain falls through a deleted agent id to the developer chain', () => {
  assert.equal(
    resolveRoleAgent('reviewer', makeTask({ reviewerAgentId: 'gone', agentId: 'a-dev' }), makeProject(), AGENTS)!.id,
    'a-dev',
  );
  assert.equal(
    resolveRoleAgent('reviewer', makeTask({ reviewerAgentId: 'a-rev' }), makeProject(), AGENTS)!.id,
    'a-rev',
  );
});

test('flags: task overrides project; both unset -> true; missing project -> true', () => {
  assert.equal(resolvePlanningEnabled(makeTask(), makeProject()), true);
  assert.equal(resolvePlanningEnabled(makeTask(), undefined), true);
  assert.equal(resolvePlanningEnabled(makeTask({ planningEnabled: false }), makeProject()), false);
  assert.equal(resolvePlanningEnabled(makeTask(), makeProject({ planningEnabled: false })), false);
  assert.equal(resolvePlanningEnabled(makeTask({ planningEnabled: true }), makeProject({ planningEnabled: false })), true);
  assert.equal(resolveReviewEnabled(makeTask({ reviewEnabled: false }), makeProject()), false);
  assert.equal(resolveReviewEnabled(makeTask(), makeProject({ reviewEnabled: false })), false);
  assert.equal(resolveReviewEnabled(makeTask(), makeProject()), true);
});

test('activationStatus: planning when enabled and no plan message; active once a plan exists or when disabled', async () => {
  const t1 = await createTask({
    projectId: 1, title: 'no plan yet', objective: 'o', checklist: [], status: 'draft',
    blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null,
  });
  assert.equal(await activationStatus(t1, makeProject()), 'planning');

  await addTaskMessage({ taskId: t1.id, role: 'assistant', messageType: 'plan', content: 'the plan' });
  assert.equal(await activationStatus(t1, makeProject()), 'active');

  const t2 = await createTask({
    projectId: 1, title: 'planning off', objective: 'o', checklist: [], status: 'draft',
    blockedReason: null, noProgressCount: 0, maxNoProgress: 5, lockedAt: null, planningEnabled: false,
  });
  assert.equal(await activationStatus(t2, makeProject()), 'active');
});

test('filterPlannerTools strips write/edit/multiedit/bash and keeps the rest', () => {
  const mk = (name: string): Tool => ({ name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) });
  const tools = ['read_file', 'glob', 'grep', 'write', 'edit', 'multiedit', 'bash', 'mcp__task__task_get_state'].map(mk);
  const filtered = filterPlannerTools(tools).map((t) => t.name);
  assert.deepEqual(filtered, ['read_file', 'glob', 'grep', 'mcp__task__task_get_state']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/task_roles.test.ts`
Expected: FAIL — `Cannot find module './task_roles.js'`.

- [ ] **Step 3: Implement `task_roles.ts`**

Create `packages/cli/src/cli/web/scheduler/task_roles.ts`:

```ts
// Role and phase resolution for the autonomous task system.
// The existing task.agentId -> project.agentId -> agents[0] chain IS the
// developer role; planner/reviewer optionally override and degrade onto it.
import { runQuery, Task, TaskMessage } from '../../../store/db.js';
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';

export type TaskRole = 'planner' | 'developer' | 'reviewer';

export function resolveRoleAgent(
  role: TaskRole,
  task: Task,
  project: ProjectConfig | undefined,
  agents: AgentConfig[],
): AgentConfig | undefined {
  const pick = (id?: string | null) => (id ? agents.find((a) => a.id === id) : undefined);
  const developer = pick(task.agentId) || pick(project?.agentId) || agents[0];
  if (role === 'developer') return developer;
  const taskRoleId = role === 'planner' ? task.plannerAgentId : task.reviewerAgentId;
  const projectRoleId = role === 'planner' ? project?.plannerAgentId : project?.reviewerAgentId;
  return pick(taskRoleId) || pick(projectRoleId) || developer;
}

export function resolvePlanningEnabled(
  task: Pick<Task, 'planningEnabled'>,
  project?: Pick<ProjectConfig, 'planningEnabled'> | null,
): boolean {
  return task.planningEnabled ?? project?.planningEnabled ?? true;
}

export function resolveReviewEnabled(
  task: Pick<Task, 'reviewEnabled'>,
  project?: Pick<ProjectConfig, 'reviewEnabled'> | null,
): boolean {
  return task.reviewEnabled ?? project?.reviewEnabled ?? true;
}

/**
 * Where does an (re)activated task go? Planning, unless planning is disabled
 * or a plan message is already on record. Deterministic and derived from the
 * message stream, like review rounds — no stored phase counter.
 */
export async function activationStatus(
  task: Task,
  project: ProjectConfig | undefined,
): Promise<'planning' | 'active'> {
  if (!resolvePlanningEnabled(task, project)) return 'active';
  const messages = (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[];
  return messages.some((m) => m.messageType === 'plan') ? 'active' : 'planning';
}

/** Builtins the planner must not have: everything that mutates the workspace.
 *  bash is stripped too — it cannot be made read-only, and the planner keeps
 *  read_file/glob/grep for exploration. Same post-filter mechanism as the
 *  reviewer's mcp__task__* strip in task_review.ts. */
export const PLANNER_TOOL_DENYLIST = new Set(['write', 'edit', 'multiedit', 'bash']);

export function filterPlannerTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => !PLANNER_TOOL_DENYLIST.has(t.name));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/task_roles.test.ts`
Expected: PASS (6 tests). Also run `pnpm -F caretaker-cli typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_roles.ts packages/cli/src/cli/web/scheduler/task_roles.test.ts
git commit -m "feat(tasks): role/flag resolution module (planner/developer/reviewer, planning+review gates)"
```

---

### Task 3: `task_submit_plan` builtin tool

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts` (append tool)
- Modify: `packages/cli/src/harness/tools/builtin/index.ts` (import/register/export)
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (append tests)

**Interfaces:**
- Consumes: `getTaskById`, `saveTask`, `addTaskMessage` from db (already imported in task_tools.ts).
- Produces: tool `mcp__task__task_submit_plan` with params `{ task_id: number, plan: string }`; on success persists a `messageType: 'plan'` message and sets status `planning → active`, `noProgressCount = 0`, `lockedAt = null`. Exported as `submitPlanTool`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (add `submitPlanTool` to the existing dynamic import on line 14):

```ts
test('task_submit_plan on a planning task -> plan message persisted, status active', async () => {
  const t = await createTask({ ...base, title: 'Plan Me', status: 'planning' });
  const res = await submitPlanTool.execute({ task_id: t.id, plan: '1. do X\n2. do Y' }, ctx());
  assert.equal(JSON.parse(res.content).ok, true);

  const after = await getTaskById(t.id);
  assert.equal(after!.status, 'active');
  assert.equal(after!.noProgressCount, 0);

  const msgs = (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${t.id}`)) as any[];
  const plan = msgs.find((m) => m.messageType === 'plan');
  assert.ok(plan);
  assert.equal(plan.content, '1. do X\n2. do Y');
});

test('task_submit_plan outside planning -> error', async () => {
  const t = await createTask({ ...base, title: 'Not Planning' }); // status: active
  const res = await submitPlanTool.execute({ task_id: t.id, plan: 'p' }, ctx());
  assert.ok(JSON.parse(res.content).error.includes('not in planning'));
});

test('task_submit_plan with empty plan -> error', async () => {
  const t = await createTask({ ...base, title: 'Empty Plan', status: 'planning' });
  const res = await submitPlanTool.execute({ task_id: t.id, plan: '   ' }, ctx());
  assert.ok(JSON.parse(res.content).error);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: FAIL — `submitPlanTool` is not exported.

- [ ] **Step 3: Implement the tool**

Append to `packages/cli/src/harness/tools/builtin/task_tools.ts`:

```ts
export const submitPlanTool: Tool = {
  name: 'mcp__task__task_submit_plan',
  description:
    'Submit the implementation plan for a task in the planning phase and start execution. Persists the plan to the task thread and transitions the task from planning to active. Only valid while the task status is "planning".',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      plan: { type: 'string', description: 'The full implementation plan, markdown.' },
    },
    required: ['task_id', 'plan'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('Plan must not be empty.');

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);
    if (task.status !== 'planning') {
      return err(`Task ${taskId} is not in planning (status: ${task.status}).`);
    }

    await addTaskMessage({
      taskId,
      role: 'assistant',
      messageType: 'plan',
      content: plan,
      agentId: null,
    });

    task.status = 'active';
    task.noProgressCount = 0;
    task.lockedAt = null;
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ status: 'active' });
  },
};
```

In `packages/cli/src/harness/tools/builtin/index.ts`: add `submitPlanTool,` to the import block from `./task_tools.js` (after `taskSetAgentTool,`), add `registry.register(submitPlanTool);` after `registry.register(taskSetAgentTool);`, and add `submitPlanTool,` to the export block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/index.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts
git commit -m "feat(tasks): task_submit_plan tool — planning -> active transition"
```

---

### Task 4: `task_complete` gates — planning guard + review flag

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts:190-217` (completeTaskTool.execute)
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (append)

**Interfaces:**
- Consumes: `resolveReviewEnabled` from `../../../cli/web/scheduler/task_roles.js` (task_tools.ts already imports from `../../../cli/web/scheduler/locks.js`, so the path pattern is established); `loadConfig` (already imported).
- Produces: `task_complete` errors while status is `'planning'`; goes to `'reviewing'` only when `worktreePath` is set AND `resolveReviewEnabled(task, project)` is true; otherwise `'done'` (worktree, if any, is finalized by the heartbeat post-run step — Task 6).

- [ ] **Step 1: Write the failing tests**

Append to `task_tools.test.ts`:

```ts
test('task_complete in planning -> error pointing to task_submit_plan', async () => {
  const t = await createTask({ ...base, title: 'Planning Complete Guard', status: 'planning' });
  const res = await completeTaskTool.execute({ task_id: t.id }, ctx());
  const parsed = JSON.parse(res.content);
  assert.ok(parsed.error);
  assert.ok(parsed.error.includes('task_submit_plan'));
  assert.equal((await getTaskById(t.id))!.status, 'planning');
});

test('task_complete on a git task with reviewEnabled=false on the task -> done directly', async () => {
  const t = await createTask({ ...base, title: 'Review Off', reviewEnabled: false });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'ro');
  gt!.branch = 'caretaker/task-ro';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'done');
});

test('task_complete on a git task with reviewEnabled=false on the project -> done directly', async () => {
  await saveConfig({
    port: 3000,
    providers: [],
    projects: [{ id: 77, name: 'NoReview', description: '', workingDir: '/w', agentId: 'a', active: true, reviewEnabled: false }],
  } as any);
  const t = await createTask({ ...base, projectId: 77, title: 'Project Review Off' });
  const gt = await getTaskById(t.id);
  gt!.worktreePath = join(CT_HOME, 'worktrees', 'pro');
  gt!.branch = 'caretaker/task-pro';
  await saveTask(gt!);

  await completeTaskTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'done');
  // Restore a config without projects so earlier-file tests never see project 1.
  await saveConfig({ port: 3000, providers: [] } as any);
});
```

Note: the two existing `task_complete` tests (lines 38-56) use `projectId: 1` with no project configured — `resolveReviewEnabled(task, undefined)` must stay `true`, so they keep passing untouched. That is the regression check.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: the 3 new tests FAIL (no guard, no flag), all pre-existing PASS.

- [ ] **Step 3: Implement the gates**

In `task_tools.ts`, add the import at the top (next to the `locks.js` import):

```ts
import { resolveReviewEnabled } from '../../../cli/web/scheduler/task_roles.js';
```

In `completeTaskTool.execute`, replace the block from `// Git-isolated tasks enter review…` through `task.status = task.worktreePath ? 'reviewing' : 'done';` (lines 198-200) with:

```ts
    if (task.status === 'planning') {
      return err(
        `Task ${taskId} is in the planning phase. Submit a plan with task_submit_plan before completing.`,
      );
    }

    // Git-isolated tasks enter review before finalizing — unless the review
    // gate is disabled for this task/project. Non-git tasks always finalize
    // directly (the review is git-diff based, it needs a branch to inspect).
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    const reviewOn = resolveReviewEnabled(task, project);
    task.status = task.worktreePath && reviewOn ? 'reviewing' : 'done';
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts && pnpm -F caretaker-cli typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts
git commit -m "feat(tasks): task_complete gates — planning guard and toggleable review"
```

---

### Task 5: Activation rule + role params on the remaining task tools

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts` (taskActivateTool, taskUnpauseTool, taskUnblockTool, taskCreateTool, taskSetAgentTool, getTaskStateTool)
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (append)

**Interfaces:**
- Consumes: `activationStatus` from `../../../cli/web/scheduler/task_roles.js` (extend the Task 4 import).
- Produces:
  - `task_activate` / `task_unpause` / `task_unblock` set status via `activationStatus(task, project)` instead of hard-coded `'active'`.
  - `task_create` accepts `planner_agent_id`, `reviewer_agent_id`, `planning_enabled`, `review_enabled`; `start_active` routes through the planning gate.
  - `task_set_agent` accepts `role: 'developer' | 'planner' | 'reviewer'` (default `'developer'`).
  - `task_get_state` returns `plannerAgentId`, `reviewerAgentId`, `planningEnabled`, `reviewEnabled`.

- [ ] **Step 1: Write the failing tests**

Append to `task_tools.test.ts` (add `taskActivateTool`, `taskUnpauseTool`, `submitPlanTool` — if not already — to the dynamic import):

```ts
test('task_activate: draft -> planning by default; -> active when task disables planning', async () => {
  const t1 = await createTask({ ...base, title: 'Activate Plans', status: 'draft' });
  await taskActivateTool.execute({ task_id: t1.id }, ctx());
  assert.equal((await getTaskById(t1.id))!.status, 'planning');

  const t2 = await createTask({ ...base, title: 'Activate No Plan', status: 'draft', planningEnabled: false });
  await taskActivateTool.execute({ task_id: t2.id }, ctx());
  assert.equal((await getTaskById(t2.id))!.status, 'active');
});

test('task_unpause: returns to planning when no plan exists; to active once planned', async () => {
  const t = await createTask({ ...base, title: 'Unpause Phase', status: 'paused' });
  await taskUnpauseTool.execute({ task_id: t.id }, ctx());
  assert.equal((await getTaskById(t.id))!.status, 'planning');

  const t2 = await createTask({ ...base, title: 'Unpause Planned', status: 'paused' });
  await addTaskMessage({ taskId: t2.id, role: 'assistant', messageType: 'plan', content: 'plan' });
  await taskUnpauseTool.execute({ task_id: t2.id }, ctx());
  assert.equal((await getTaskById(t2.id))!.status, 'active');
});

test('task_create with start_active and default planning -> status planning; role fields persisted', async () => {
  await saveAgents([
    { id: 'a-dev', name: 'a-dev', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
    { id: 'a-plan', name: 'a-plan', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
  ] as any);
  await saveConfig({
    port: 3000, providers: [],
    projects: [{ id: 9, name: 'RoleProj', description: '', workingDir: '/w', agentId: 'a-dev', active: true }],
  } as any);

  const res = await taskCreateTool.execute(
    {
      project_id: 9, title: 'Roles', objective: 'o', checklist: [{ text: 's1' }],
      start_active: true, agent_id: 'a-dev', planner_agent_id: 'a-plan', review_enabled: false,
    },
    ctx(),
  );
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.ok, true);

  const created = await getTaskById(parsed.task_id);
  assert.equal(created!.status, 'planning');
  assert.equal(created!.plannerAgentId, 'a-plan');
  assert.equal(created!.reviewEnabled, false);
  await saveConfig({ port: 3000, providers: [] } as any);
});

test('task_set_agent with role planner/reviewer sets the role fields', async () => {
  await saveAgents([
    { id: 'a-x', name: 'a-x', systemPrompt: 'x', provider: 'p', model: 'm', allowedTools: [], maxTurns: 5 },
  ] as any);
  const t = await createTask({ ...base, title: 'Set Roles', status: 'paused' });

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x', role: 'planner' }, ctx());
  assert.equal((await getTaskById(t.id))!.plannerAgentId, 'a-x');

  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x', role: 'reviewer' }, ctx());
  assert.equal((await getTaskById(t.id))!.reviewerAgentId, 'a-x');

  // Clear the planner override.
  await taskSetAgentTool.execute({ task_id: t.id, role: 'planner' }, ctx());
  assert.equal((await getTaskById(t.id))!.plannerAgentId, null);
  // Default role still targets the developer field.
  await taskSetAgentTool.execute({ task_id: t.id, agent_id: 'a-x' }, ctx());
  assert.equal((await getTaskById(t.id))!.agentId, 'a-x');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

In `task_tools.ts`, extend the Task 4 import:

```ts
import { resolveReviewEnabled, resolvePlanningEnabled, activationStatus } from '../../../cli/web/scheduler/task_roles.js';
```

**`taskActivateTool.execute`** — replace `task.status = 'active';` (line 478) with:

```ts
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    task.status = await activationStatus(task, project);
```

and make the confirmation message phase-aware, replacing the `content: 'Task activated.'` line with:

```ts
      content: task.status === 'planning' ? 'Task activated (planning phase).' : 'Task activated.',
```

**`taskUnpauseTool.execute`** — replace `task.status = 'active';` (line 516) with the same three lines (config, project, `activationStatus`).

**`taskUnblockTool.execute`** — replace `task.status = 'active';` (line 440) the same way.

**`taskCreateTool`** — add to `parameters.properties` after `agent_id`:

```ts
      planner_agent_id: { type: 'string', description: 'Optional planner-role agent for this task.' },
      reviewer_agent_id: { type: 'string', description: 'Optional reviewer-role agent for this task.' },
      planning_enabled: { type: 'boolean', description: 'Override the project planning-phase default for this task.' },
      review_enabled: { type: 'boolean', description: 'Override the project review-gate default for this task.' },
```

In its `execute`, after `const agentId = …` add:

```ts
    const plannerAgentId = args.planner_agent_id ? String(args.planner_agent_id) : null;
    const reviewerAgentId = args.reviewer_agent_id ? String(args.reviewer_agent_id) : null;
    const planningEnabled = typeof args.planning_enabled === 'boolean' ? args.planning_enabled : null;
    const reviewEnabled = typeof args.review_enabled === 'boolean' ? args.review_enabled : null;
```

Extend the agent-validation block to cover all three ids:

```ts
    const idsToValidate = [agentId, plannerAgentId, reviewerAgentId].filter(Boolean) as string[];
    if (idsToValidate.length > 0) {
      const agents = await loadAgents();
      for (const id of idsToValidate) {
        if (!agents.some((a) => a.id === id)) {
          return err(`Agent "${id}" not found. Available agents: ${agents.map((a) => a.id).join(', ') || '(none)'}`);
        }
      }
    }
```

And change the `createTask` call:

```ts
    const startStatus = startActive
      ? (resolvePlanningEnabled({ planningEnabled }, project) ? 'planning' : 'active')
      : 'draft';

    const createdTask = await createTask({
      projectId,
      title,
      objective,
      checklist,
      status: startStatus,
      blockedReason: null,
      noProgressCount: 0,
      maxNoProgress: 5,
      lockedAt: null,
      agentId,
      plannerAgentId,
      reviewerAgentId,
      planningEnabled,
      reviewEnabled,
    });
```

(the `if (startActive)` system message stays; change its content to `` startStatus === 'planning' ? 'Task created and activated (planning phase).' : 'Task created and activated.' ``)

**`taskSetAgentTool`** — add to `parameters.properties`:

```ts
      role: {
        type: 'string',
        enum: ['developer', 'planner', 'reviewer'],
        description: 'Which role to assign. Defaults to developer (the main task agent).',
      },
```

and in `execute`, replace `task.agentId = agentId;` (line 701) with:

```ts
    const role = args.role === 'planner' || args.role === 'reviewer' ? args.role : 'developer';
    if (role === 'planner') task.plannerAgentId = agentId;
    else if (role === 'reviewer') task.reviewerAgentId = agentId;
    else task.agentId = agentId;
```

and the return with `return ok({ role, agentId });`. Update the tool `description` to mention roles:

```ts
  description:
    'Assign a specific agent to a task role, overriding the project default. role: developer (default, the main task agent), planner, or reviewer. Pass null or omit agent_id to clear the override and fall back to the project default.',
```

**`getTaskStateTool`** — in the returned JSON after `agentId: task.agentId || null,` add:

```ts
        plannerAgentId: task.plannerAgentId || null,
        reviewerAgentId: task.reviewerAgentId || null,
        planningEnabled: task.planningEnabled ?? null,
        reviewEnabled: task.reviewEnabled ?? null,
```

- [ ] **Step 4: Run all cli tests + typecheck**

Run: `pnpm -F caretaker-cli test && pnpm -F caretaker-cli typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts
git commit -m "feat(tasks): planning-aware activation and role params across task tools"
```

---

### Task 6: Scheduler — planning cycle, reviewer identity, review flag, done-worktree finalize

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`

**Interfaces:**
- Consumes: `resolveRoleAgent`, `resolveReviewEnabled`, `filterPlannerTools`, `TaskRole` from `./task_roles.js`.
- Produces: heartbeat selects `'planning'` tasks; planning cycles run the planner agent with filtered tools and a planning prompt; review cycles run the reviewer agent; `reviewEnabled=false` finalizes a `reviewing` task without running the review; a `done` task that still has a worktree after the run is finalized in the post-run git step; `'plan'` messages are replayed into history.

No unit tests for this file (it is `harness.run` I/O wiring and has none today); the pure logic it consumes is covered by Task 2's tests. Verification is `pnpm -F caretaker-cli typecheck` + Task 10's live check.

- [ ] **Step 1: Add imports and the planning prompt**

In `task_strategy.ts` add to the imports:

```ts
import { resolveRoleAgent, resolveReviewEnabled, filterPlannerTools, TaskRole } from './task_roles.js';
```

After `buildPrompt` (line 58) add:

```ts
function buildPlanningPrompt(
  systemPrompt: string,
  taskId: number,
  taskTitle: string,
  maxRunSeconds: number,
  maxTurns: number,
  workingDir?: string,
): string {
  const workspaceLine = workingDir
    ? `\n**Your workspace is: \`${workingDir}\`** — operate exclusively inside this directory.\n`
    : '';

  return `${systemPrompt}
${workspaceLine}
---

You are running in **autonomous task mode**, in the **PLANNING phase**. Your only job
is to produce an implementation plan for this task — you must NOT modify anything.

You have read-only access to the workspace: explore it with \`read_file\`, \`glob\`, and
\`grep\`. Write tools and \`bash\` are not available in this phase.

You have no memory of previous invocations. Your only memory is in the task messages.
You have **${maxRunSeconds} seconds** and at most **${maxTurns} turns** for this invocation.

On each invocation:
1. Read the current state with \`task_get_state\` (objective, checklist, recent messages)
2. Explore the workspace as needed to understand how to achieve the objective
3. When the plan is ready:
   - Replace the checklist with concrete execution steps via \`task_update_checklist\`
   - Call \`task_submit_plan\` with the full plan (markdown). This ends the planning
     phase and starts execution — the executing agent will read your plan from the
     task thread, so make it self-contained.
4. If you cannot finish the plan in this invocation, call \`task_add_message\` with your
   findings so far, then stop — you will continue planning in the next cycle.

Do NOT call \`task_complete\` in this phase.

TASK ID: ${taskId}
TITLE: ${taskTitle}`;
}
```

- [ ] **Step 2: Select planning tasks and resolve the agent by role**

Replace the selection query (line 63):

```ts
  const taskRows = (await runQuery(`SELECT * FROM tasks WHERE (status = 'active' OR status = 'reviewing' OR status = 'planning') AND lockedAt IS NULL`)) as Task[];
```

Replace step 3 agent resolution (lines 96-104) with:

```ts
    // 3. Load Agent — resolved per role: the task's phase decides who runs.
    //    planner/reviewer overrides degrade onto the developer chain
    //    (task.agentId -> project.agentId -> agents[0]).
    const agents = await loadAgents();
    const role: TaskRole =
      task.status === 'reviewing' ? 'reviewer' : task.status === 'planning' ? 'planner' : 'developer';
    const agent = resolveRoleAgent(role, task, project, agents);
```

(the `if (!agent) throw` stays as is.)

- [ ] **Step 3: Review flag + planning branch**

Replace the reviewing branch (lines 138-143) with:

```ts
    // Reviewing tasks run one independent review pass on their branch as their
    // own heartbeat cycle (not the agent's task loop), then transition. The
    // review gate flag is read at decision time: disabling it while a task sits
    // in reviewing finalizes the task directly on the next tick.
    if (task.status === 'reviewing') {
      await runReviewCycle({ task, project, agent: effectiveAgent, provider, tools, workingDir });
      return; // the finally{} block still runs and releases the lock
    }

    const planning = task.status === 'planning';
    if (planning) {
      // Read-only phase: strip workspace-mutating tools (same post-filter
      // mechanism the review uses to strip mcp__task__*).
      tools = filterPlannerTools(tools);
    }
```

Change the `tools` binding (line 136) from `const` to `let`:

```ts
    let tools = await harness.resolveAgentTools(effectiveAgent, harness.tools);
```

- [ ] **Step 4: Planning prompt + progress guard + replay**

Replace the prompt construction (line 150):

```ts
    const prompt = planning
      ? buildPlanningPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir)
      : buildPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir);
```

In the history replay filter (line 181) add `'plan'`:

```ts
      .filter((m) => m.messageType === 'chat' || m.messageType === 'heartbeat' || m.messageType === 'tool_call' || m.messageType === 'review' || m.messageType === 'plan')
```

In the progress guard (line 229), also cover a task still in planning:

```ts
    if (refreshedTask && (refreshedTask.status === 'active' || refreshedTask.status === 'planning')) {
```

- [ ] **Step 5: Finalize done-with-worktree in the post-run git step**

Replace the git lifecycle block (lines 259-270) with:

```ts
    // Git lifecycle: commit progress every cycle. When the agent has just
    // completed the task it is now 'reviewing' (review runs next tick as its
    // own cycle) — or already 'done' when the review gate is disabled, in
    // which case the worktree is finalized here, after the run has ended.
    const gitTask = await getTaskById(task.id);
    if (gitTask && gitTask.worktreePath) {
      try {
        if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
        if (gitTask.status === 'done') {
          await finalizeDone(gitTask.worktreePath);
          gitTask.worktreePath = null;
          gitTask.updatedAt = new Date().toISOString();
          await saveTask(gitTask);
          console.log(`[task_heartbeat] Task #${task.id} done (review gate off): worktree removed, branch ${gitTask.branch} kept`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }
```

- [ ] **Step 6: Reviewer flag check in runReviewCycle**

Add `project: Project;` to the `runReviewCycle` opts type (import `Project` is already there via db import on line 4 — it is), destructure it, and insert at the top of the function body, right after the `if (!task.worktreePath) return;` guard:

```ts
  // Review gate disabled (task or project level): finalize directly, no review.
  if (!resolveReviewEnabled(task, project)) {
    await commitWip(task.worktreePath, task.title);
    const current = await getTaskById(task.id);
    if (!current || current.status !== 'reviewing') return;
    await finalizeDone(current.worktreePath!);
    current.status = 'done';
    current.worktreePath = null;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
    console.log(`[task_heartbeat] Task #${task.id} review gate disabled: finalized as done, branch ${current.branch} kept`);
    return;
  }
```

Note: `project` here is a `ProjectConfig` from `config.projects` — type the opt as `ProjectConfig` (imported from `../../../types.js`, already imported for `AgentConfig, ProviderConfig`), not the db `Project`.

- [ ] **Step 7: Typecheck + full test suite**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F caretaker-cli test`
Expected: clean, all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(tasks): planning heartbeat cycle, per-role agents, toggleable review in scheduler"
```

---

### Task 7: Web API — role/flag routes and planning-aware transitions

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts:266-289` (POST /api/projects), `:321-354` (POST /api/projects/:id/tasks), `:367-390` (POST /api/tasks/:id/messages), `:392-409` (POST /api/tasks/:id/status), `:509-536` (PATCH /api/tasks/:id/agent), + one new route

**Interfaces:**
- Consumes: `activationStatus`, `resolvePlanningEnabled` from `./scheduler/task_roles.js` (server.ts lives in `cli/web/`).
- Produces:
  - `PATCH /api/tasks/:id/agent` accepts `{ agentId, role? }` (role: `'developer' | 'planner' | 'reviewer'`, default developer).
  - New `PATCH /api/tasks/:id/flags` accepts `{ planningEnabled?, reviewEnabled? }` where each value is `true | false | null` (null = inherit); only keys present in the body are applied.
  - `POST /api/projects/:id/tasks` accepts `plannerAgentId`, `reviewerAgentId`, `planningEnabled`, `reviewEnabled`; `startActive` routes through the planning gate.
  - `POST /api/tasks/:id/status` with `status: 'active'` and `POST /api/tasks/:id/messages` wake-up route through `activationStatus`.
  - `POST /api/projects` accepts the four new project fields.

- [ ] **Step 1: Import the resolution helpers**

In `server.ts`, next to the existing scheduler imports:

```ts
import { activationStatus, resolvePlanningEnabled } from './scheduler/task_roles.js';
```

- [ ] **Step 2: POST /api/projects — accept role/flag fields**

In the handler (line 269) destructure and persist them:

```ts
      const { name, description, workingDir, agentId, plannerAgentId, reviewerAgentId, planningEnabled, reviewEnabled } = body;
```

and in the `project` literal after `active: true,`:

```ts
        plannerAgentId: plannerAgentId || null,
        reviewerAgentId: reviewerAgentId || null,
        planningEnabled: typeof planningEnabled === 'boolean' ? planningEnabled : null,
        reviewEnabled: typeof reviewEnabled === 'boolean' ? reviewEnabled : null,
```

- [ ] **Step 3: POST /api/projects/:id/tasks — role fields + planning gate**

Replace the destructure (line 324):

```ts
    const { title, objective, checklist, startActive, agentId, plannerAgentId, reviewerAgentId, planningEnabled, reviewEnabled } = body;
```

Extend the validation to all provided agent ids:

```ts
    const idsToValidate = [agentId, plannerAgentId, reviewerAgentId].filter(Boolean) as string[];
    if (idsToValidate.length > 0) {
      const agents = await loadAgents();
      for (const id of idsToValidate) {
        if (!agents.some((a) => a.id === id)) {
          return c.json({ ok: false, error: `Agent "${id}" not found.` }, 400);
        }
      }
    }
```

Before `createTask`, compute the start status:

```ts
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === projectId);
    const taskPlanning = typeof planningEnabled === 'boolean' ? planningEnabled : null;
    const startStatus = startActive
      ? (resolvePlanningEnabled({ planningEnabled: taskPlanning }, project) ? 'planning' : 'active')
      : 'draft';
```

and change the `createTask` call to use `status: startStatus,` plus the new fields:

```ts
      agentId: agentId || null,
      plannerAgentId: plannerAgentId || null,
      reviewerAgentId: reviewerAgentId || null,
      planningEnabled: taskPlanning,
      reviewEnabled: typeof reviewEnabled === 'boolean' ? reviewEnabled : null,
```

(`loadConfig` is already imported in server.ts — verify; if not, add it to the existing `store/json.js` import.)

- [ ] **Step 4: Planning-aware wake-up and status routes**

`POST /api/tasks/:id/messages` (line 380-387) — replace `task.status = 'active';` with:

```ts
      const config = await loadConfig();
      const project = (config.projects || []).find((p) => p.id === task.projectId);
      task.status = await activationStatus(task, project);
```

`POST /api/tasks/:id/status` (lines 397-406) — replace the body of `if (task)` with:

```ts
    if (task) {
      if (status === 'active') {
        const config = await loadConfig();
        const project = (config.projects || []).find((p) => p.id === task.projectId);
        task.status = await activationStatus(task, project);
        task.noProgressCount = 0;
        task.blockedReason = null;
      } else {
        task.status = status;
      }
      task.updatedAt = new Date().toISOString();
      await saveTask(task);
    }
```

- [ ] **Step 5: PATCH /api/tasks/:id/agent — role param; new /flags route**

In the agent PATCH handler, destructure `const { agentId, role } = body;` and replace `task.agentId = agentId || null;` with:

```ts
    const targetRole = role === 'planner' || role === 'reviewer' ? role : 'developer';
    if (targetRole === 'planner') task.plannerAgentId = agentId || null;
    else if (targetRole === 'reviewer') task.reviewerAgentId = agentId || null;
    else task.agentId = agentId || null;
```

and the response with `return c.json({ ok: true, role: targetRole, agentId: agentId || null });`.

Add the flags route right after it:

```ts
  app.patch('/api/tasks/:id/flags', async (c) => {
    const taskId = Number(c.req.param('id'));
    const body = await c.req.json();

    const task = await getTaskById(taskId);
    if (!task) return c.json({ ok: false, error: 'not found' }, 404);

    if ('planningEnabled' in body) {
      task.planningEnabled = typeof body.planningEnabled === 'boolean' ? body.planningEnabled : null;
    }
    if ('reviewEnabled' in body) {
      task.reviewEnabled = typeof body.reviewEnabled === 'boolean' ? body.reviewEnabled : null;
    }
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return c.json({ ok: true, planningEnabled: task.planningEnabled ?? null, reviewEnabled: task.reviewEnabled ?? null });
  });
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -F caretaker-cli typecheck`
Expected: clean.

```bash
git add packages/cli/src/cli/web/server.ts
git commit -m "feat(tasks): web API for role assignment, gate flags, planning-aware activation"
```

---

### Task 8: Webview UI — ProjectsTab (task views)

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx`

**Interfaces:**
- Consumes: the Task 7 API (`PATCH /api/tasks/:id/agent` with `role`, `PATCH /api/tasks/:id/flags`, task create fields).
- Produces: `planning` rendered as an active-family status; planner/reviewer selectors and gate selects in the edit view and the new-task modal.

- [ ] **Step 1: Local types**

Mirror the model (lines 23-50): add `'planning'` to `Task['status']`, add to `Task`:

```ts
  plannerAgentId?: string | null;
  reviewerAgentId?: string | null;
  planningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
```

and `'plan'` to `TaskMessage['messageType']`. In `newTask` state (line 162-168) add `plannerAgentId: ''`, `reviewerAgentId: ''` (and reset them in the two `setNewTask({...})` reset calls).

- [ ] **Step 2: Status handling**

`statusColor` (line 536): add before `case 'paused'`:

```ts
      case 'planning':
        return '#06b6d4';
```

`isActiveLike` (line 531): include planning:

```ts
    ? selectedTask.status === 'active' || selectedTask.status === 'reviewing' || selectedTask.status === 'planning'
```

`handleToggleTaskStatus` (line 323): treat planning as pausable:

```ts
    const newStatus =
      task.status === 'active' || task.status === 'reviewing' || task.status === 'planning' ? 'paused' : 'active';
```

TaskLogView header status text (lines 1091-1095): add a planning case:

```ts
              {task.status === 'active'
                ? 'Heartbeat loop active'
                : task.status === 'planning'
                ? 'Planning phase — read-only'
                : task.status === 'reviewing'
                ? `In review (round ${reviewRound}/3)`
                : `Task status: ${task.status}`}
```

In `taskMessagesToChatItems`, render plan messages as a highlighted notice before the assistant fallback (insert after the `tool_call` branch):

```ts
    if (msg.messageType === 'plan') {
      items.push({ kind: 'assistant', text: `**📋 Plan submitted**\n\n${msg.content}`, streaming: false });
      continue;
    }
```

- [ ] **Step 3: Handlers with role + flags**

Change `handleSetTaskAgent` to accept a role:

```ts
  const handleSetTaskAgent = async (task: Task, role: 'developer' | 'planner' | 'reviewer', agentId: string) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId || null, role }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to reassign agent');
      }
    } catch (err) {
      console.error('Failed to set task agent:', err);
      setTaskError('Failed to reassign agent');
    }
  };
```

Add next to it:

```ts
  const handleSetTaskFlag = async (task: Task, flag: 'planningEnabled' | 'reviewEnabled', value: boolean | null) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [flag]: value }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to update task setting');
      }
    } catch (err) {
      console.error('Failed to set task flag:', err);
      setTaskError('Failed to update task setting');
    }
  };
```

Pass `onSetFlag={handleSetTaskFlag}` to `TaskEditView` and update its props interface (`onSetAgent: (t: Task, role: 'developer' | 'planner' | 'reviewer', agentId: string) => void; onSetFlag: (t: Task, flag: 'planningEnabled' | 'reviewEnabled', value: boolean | null) => void;`).

- [ ] **Step 4: TaskEditView — role selectors + gate selects**

The existing "Assigned Agent" select's `onChange` becomes `onSetAgent(task, 'developer', e.target.value)`. Extract the shared disabled logic once at the top of `TaskEditView`:

```ts
  const isRunning = task.status === 'active' || task.status === 'reviewing' || task.status === 'planning';
```

and use `isRunning` in the existing select's `disabled`/`cursor`/`opacity`/`title` in place of the inline `task.status === 'active' || task.status === 'reviewing'` expressions.

After the "Assigned Agent" block (line 1360), add two more selects with the same markup, changing only label/value/role:

```tsx
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Planner Agent
          </h4>
          <select
            value={task.plannerAgentId || ''}
            onChange={(e) => onSetAgent(task, 'planner', e.target.value)}
            disabled={isRunning}
            style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none', width: '100%', cursor: isRunning ? 'not-allowed' : 'pointer', opacity: isRunning ? 0.6 : 1 }}
            title={isRunning ? 'Pause the task before changing its planner' : 'Agent that runs the planning phase (read-only). Falls back to the developer agent.'}
          >
            <option value="">Same as developer</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.provider})</option>
            ))}
          </select>
        </div>
```

and an identical "Reviewer Agent" block with `task.reviewerAgentId`, role `'reviewer'`, title "Agent that reviews the branch at DONE. Falls back to the developer agent.".

Then a "Phases" block with two tri-state selects:

```tsx
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Phases
          </h4>
          <div style={{ display: 'flex', gap: '12px' }}>
            {(
              [
                { flag: 'planningEnabled' as const, label: 'Planning phase', value: task.planningEnabled },
                { flag: 'reviewEnabled' as const, label: 'Review at DONE', value: task.reviewEnabled },
              ]
            ).map(({ flag, label, value }) => (
              <label key={flag} style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                {label}
                <select
                  value={value === true ? 'on' : value === false ? 'off' : 'inherit'}
                  onChange={(e) => onSetFlag(task, flag, e.target.value === 'inherit' ? null : e.target.value === 'on')}
                  style={{ background: 'var(--vscode-input-background, #252526)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, #3c3c3c)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none' }}
                >
                  <option value="inherit">Project default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            ))}
          </div>
        </div>
```

- [ ] **Step 5: New Task modal — planner/reviewer selects**

In the modal, after the existing "Assigned Agent" select (line 742), add two selects with the same markup bound to `newTask.plannerAgentId` / `newTask.reviewerAgentId`, labels "Planner Agent (optional — read-only planning phase)" and "Reviewer Agent (optional — reviews at DONE)", first option `<option value="">Same as developer</option>`. In `handleCreateTask`'s body JSON add:

```ts
          plannerAgentId: newTask.plannerAgentId || undefined,
          reviewerAgentId: newTask.reviewerAgentId || undefined,
```

(No per-task gate selects in the create modal — flags default to inherit; they are editable post-creation in the edit view.)

- [ ] **Step 6: Build + typecheck + commit**

Run: `pnpm -F webview-ui build && pnpm -F caretaker-cli typecheck`
Expected: esbuild bundle succeeds, typecheck clean.

```bash
git add packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(webview): planning status, role selectors, phase gate controls in task views"
```

---

### Task 9: Webview UI — ProjectsTabSettings (project form)

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTabSettings.tsx`

**Interfaces:**
- Consumes: `ProjectConfig` with the Task 1 fields (via `caretaker-types`); persists through the existing `postMessage({ type: 'saveConfig', … })` path — no new plumbing.
- Produces: project-level planner/reviewer selection and planning/review default toggles.

- [ ] **Step 1: Form state**

Add after the `agentId` state (line 21):

```ts
  const [plannerAgentId, setPlannerAgentId] = useState('');
  const [reviewerAgentId, setReviewerAgentId] = useState('');
  const [planningEnabled, setPlanningEnabled] = useState(true);
  const [reviewEnabled, setReviewEnabled] = useState(true);
```

In `startEdit` add:

```ts
    setPlannerAgentId(proj.plannerAgentId || '');
    setReviewerAgentId(proj.reviewerAgentId || '');
    setPlanningEnabled(proj.planningEnabled ?? true);
    setReviewEnabled(proj.reviewEnabled ?? true);
```

In `startCreate` add:

```ts
    setPlannerAgentId('');
    setReviewerAgentId('');
    setPlanningEnabled(true);
    setReviewEnabled(true);
```

- [ ] **Step 2: Persist on save**

In `validateAndSave`, extend both the `newProj` literal and the edit spread with:

```ts
        plannerAgentId: plannerAgentId || null,
        reviewerAgentId: reviewerAgentId || null,
        planningEnabled,
        reviewEnabled,
```

- [ ] **Step 3: Form fields**

After the "Assigned Agent" form-group (line 192), add:

```tsx
          <div className="form-group">
            <label htmlFor="project-planner">Planner Agent (optional)</label>
            <select id="project-planner" value={plannerAgentId} onChange={(e) => setPlannerAgentId(e.target.value)}>
              <option value="">Same as assigned agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="project-reviewer">Reviewer Agent (optional)</label>
            <select id="project-reviewer" value={reviewerAgentId} onChange={(e) => setReviewerAgentId(e.target.value)}>
              <option value="">Same as assigned agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={planningEnabled} onChange={(e) => setPlanningEnabled(e.target.checked)} />
              Planning phase for new tasks (planner explores read-only and submits a plan before execution)
            </label>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
              Independent review at DONE (git tasks only)
            </label>
          </div>
```

In the project card list (around line 216), extend the badge row to show the roles when set:

```tsx
                    <div className="settings-card__badge" style={{ marginTop: '6px' }}>
                      Agent: {assignedAgent}
                      {proj.plannerAgentId && ` · Planner: ${agents.find((a) => a.id === proj.plannerAgentId)?.name || proj.plannerAgentId}`}
                      {proj.reviewerAgentId && ` · Reviewer: ${agents.find((a) => a.id === proj.reviewerAgentId)?.name || proj.reviewerAgentId}`}
                    </div>
```

- [ ] **Step 4: Build + commit**

Run: `pnpm -F webview-ui build && pnpm -F caretaker-vscode build`
Expected: both build clean.

```bash
git add packages/webview-ui/src/ProjectsTabSettings.tsx
git commit -m "feat(webview): project-level planner/reviewer agents and phase defaults"
```

---

### Task 10: Docs, changeset, full verification

**Files:**
- Modify: `CLAUDE.md` (Scheduler layer 5 + State on disk sections)
- Modify: `README.md` (autonomous tasks feature section)
- Create: `.changeset/task-agent-roles-planning-phase.md`

- [ ] **Step 1: Update CLAUDE.md**

In layer 5 (autonomous task heartbeat) and the State-on-disk section, document current behavior (not history):

- Task statuses now: `draft/planning/active/reviewing/paused/blocked/done`.
- Role-based agent resolution: planner/reviewer overrides at task and project level degrade onto the developer chain (`task.agentId → project.agentId → agents[0]`); resolution lives in `scheduler/task_roles.ts`.
- Planning phase (default on; `planningEnabled` tri-state on task inheriting from project): activation sends a task to `planning`; the planner runs read-only (`write`/`edit`/`multiedit`/`bash` stripped, same post-filter mechanism as the review's `mcp__task__*` strip), iterates across cycles, and hands off via `mcp__task__task_submit_plan`, which persists a `plan` message (replayed into history) and transitions to `active`. `task_complete` errors during planning. Re-activation rule: a task with planning enabled and no `plan` message on record goes to `planning`; otherwise `active`.
- Review gate is now toggleable (`reviewEnabled`, same inheritance, default on); flag is read at decision time — `task_complete` with the gate off finalizes directly (worktree cleaned up by the heartbeat post-run step), and a task already `reviewing` when the gate is turned off is finalized on the next tick without running the review. The review runs under the reviewer-role agent.
- Add `task_submit_plan` to the `mcp__task__*` tool list; note `task_set_agent`'s `role` param and `task_create`'s role/flag params.

- [ ] **Step 2: Update README.md**

In the autonomous tasks section, add a short paragraph: per-role agents (planner/developer/reviewer) configurable per project and per task; mandatory-by-default planning phase with a read-only planner that must submit a plan before execution starts; review gate toggleable per project/task.

- [ ] **Step 3: Changeset**

Create `.changeset/task-agent-roles-planning-phase.md`:

```md
---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Task agent roles and planning phase: assign a distinct PLANNER, DEVELOPER, and REVIEWER agent per project or per task (planner/reviewer degrade onto the developer chain). New default-on PLANNING phase: activated tasks start in `planning`, where the planner agent runs read-only (no write/edit/multiedit/bash), iterates across heartbeat cycles, and starts execution explicitly via the new `task_submit_plan` tool — the plan is persisted to the task thread and replayed to the executing agent. The DONE review gate is now toggleable per project/task (`reviewEnabled`, default on) and runs under the reviewer-role agent. New/extended APIs: `PATCH /api/tasks/:id/agent` (role param), `PATCH /api/tasks/:id/flags`, role/flag fields on task and project creation; task tools gain `task_submit_plan`, `task_set_agent role`, and role/flag params on `task_create`.
```

- [ ] **Step 4: Full verification**

Run: `pnpm build && pnpm test`
Expected: all five packages build, all tests pass.

Live check (manual, `CARETAKER_HOME=/tmp/ct-roles pnpm -F caretaker-cli dev web`): create a project on a scratch git repo, create a task with startActive → status must show `planning` (cyan badge); watch the first heartbeat cycle run the planner (no write tools in the tool_call stream), see the plan message appear, status flip to `active`, then normal execution.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/task-agent-roles-planning-phase.md
git commit -m "docs: task agent roles + planning phase; changeset"
```
