# Planner SDD Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in SDD mode (`sddEnabled`, default OFF, task inherits from project) that lets the planner create/edit **markdown files only** during the planning phase, while bash stays stripped.

**Architecture:** Instead of stripping `write`/`edit`/`multiedit` in planning cycles, SDD mode wraps them with a `.md`-only path guard (all three tools take a `path` argument); `bash` is stripped in both modes. One new resolver (`resolveSddEnabled`) plus a second parameter on `filterPlannerTools` in the existing pure module `task_roles.ts`; flag plumbed through the same three layers as `planningEnabled`/`reviewEnabled` (model → tools/API → UI).

**Tech Stack:** TypeScript ESM (strict, `.js` import suffixes), Node built-in test runner via tsx, Hono, React.

**Spec:** `docs/superpowers/specs/2026-07-17-planner-sdd-mode-design.md`

## Global Constraints

- Package manager: **pnpm** ≥10, from repo root. Never `npm`.
- Tests co-located `*.test.ts`; run with paths **relative to `packages/cli`**: `cd packages/cli && pnpm exec tsx --test src/...` (repo-root paths fail — pnpm exec runs in the package dir). `pnpm test` does NOT typecheck; always also run `pnpm -F caretaker-cli typecheck`.
- `process.env.CARETAKER_HOME` mutated at FILE scope only in tests.
- ESM: relative imports end in `.js`.
- No new dependencies. No path/glob configuration for SDD (spec: mechanism, not convention).
- `resolveSddEnabled` default is **false** (opt-in) — unlike the other two gates.
- Error copy for a denied write (exact string): `Error: planning phase (SDD mode): only markdown (.md) files may be written.`
- A changeset (minor, all five fixed-group packages) lands in the final task.

---

### Task 1: Data model + resolver + markdown-only wrapper

**Files:**
- Modify: `packages/types/src/index.ts` (ProjectConfig, after `reviewEnabled`)
- Modify: `packages/cli/src/store/db.ts` (Project + Task interfaces, after `reviewEnabled`)
- Modify: `packages/cli/src/cli/web/scheduler/task_roles.ts`
- Test: `packages/cli/src/cli/web/scheduler/task_roles.test.ts` (append)

**Interfaces:**
- Consumes: existing `PLANNER_TOOL_DENYLIST`, `Tool` type (`execute(args, ctx)` returning `{ content: string }`; fs tools report errors as `{ content: 'Error: …' }`).
- Produces (used by Tasks 2-4):
  - `sddEnabled?: boolean | null` on `Task`, `Project` (db.ts) and `ProjectConfig` (types).
  - `resolveSddEnabled(task: Pick<Task, 'sddEnabled'>, project?: Pick<ProjectConfig, 'sddEnabled'> | null): boolean` — `task.sddEnabled ?? project?.sddEnabled ?? false`.
  - `filterPlannerTools(tools: Tool[], sdd?: boolean): Tool[]` — `sdd` defaults to `false` (existing call sites keep compiling unchanged).

- [ ] **Step 1: Add the field to the three model types**

`packages/types/src/index.ts` — in `ProjectConfig`, after the `reviewEnabled` line:

```ts
  /** SDD mode default for tasks in this project: planner may write .md files. Unset = disabled. */
  sddEnabled?: boolean | null;
```

`packages/cli/src/store/db.ts` — add `sddEnabled?: boolean | null;` in **both** the `Project` interface (after its `reviewEnabled` line) and the `Task` interface (after its `reviewEnabled` line).

- [ ] **Step 2: Write the failing tests**

Append to `packages/cli/src/cli/web/scheduler/task_roles.test.ts` (add `resolveSddEnabled` to the existing dynamic import destructure; `makeTask`, `makeProject`, `Tool` import already exist in the file):

```ts
test('resolveSddEnabled: task overrides project; default is OFF', () => {
  assert.equal(resolveSddEnabled(makeTask(), makeProject()), false);
  assert.equal(resolveSddEnabled(makeTask(), undefined), false);
  assert.equal(resolveSddEnabled(makeTask({ sddEnabled: true }), makeProject()), true);
  assert.equal(resolveSddEnabled(makeTask(), makeProject({ sddEnabled: true })), true);
  assert.equal(resolveSddEnabled(makeTask({ sddEnabled: false }), makeProject({ sddEnabled: true })), false);
});

test('filterPlannerTools with sdd: bash stripped, write/edit/multiedit wrapped md-only', async () => {
  const calls: string[] = [];
  const mk = (name: string): Tool => ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      calls.push(name);
      return { content: 'ok' };
    },
  });
  const tools = filterPlannerTools(['write', 'edit', 'multiedit', 'bash', 'read_file'].map(mk), true);
  assert.deepEqual(tools.map((t) => t.name), ['write', 'edit', 'multiedit', 'read_file']);

  const ctx = { signal: new AbortController().signal, workingDir: '/w', readPaths: new Set<string>() } as any;
  const write = tools.find((t) => t.name === 'write')!;

  // Non-md path: denied without invoking the wrapped tool.
  const denied = await write.execute({ path: 'src/a.ts', content: 'x' }, ctx);
  assert.equal(denied.content, 'Error: planning phase (SDD mode): only markdown (.md) files may be written.');
  assert.deepEqual(calls, []);

  // Nested md path delegates; extension check is case-insensitive.
  const ok1 = await write.execute({ path: 'docs/specs/plan.md', content: 'x' }, ctx);
  assert.equal(ok1.content, 'ok');
  const edit = tools.find((t) => t.name === 'edit')!;
  const ok2 = await edit.execute({ path: 'SPEC.MD', oldString: 'a', newString: 'b' }, ctx);
  assert.equal(ok2.content, 'ok');
  assert.deepEqual(calls, ['write', 'edit']);

  // Missing/invalid path arg is denied too.
  const noPath = await write.execute({ content: 'x' }, ctx);
  assert.ok(noPath.content.startsWith('Error:'));
});

test('filterPlannerTools without sdd still strips all four (regression)', () => {
  const mk = (name: string): Tool => ({ name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) });
  const filtered = filterPlannerTools(['write', 'edit', 'multiedit', 'bash', 'grep'].map(mk));
  assert.deepEqual(filtered.map((t) => t.name), ['grep']);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/cli && pnpm exec tsx --test src/cli/web/scheduler/task_roles.test.ts`
Expected: FAIL — `resolveSddEnabled` is not a function / wrapper assertions fail.

- [ ] **Step 4: Implement in `task_roles.ts`**

Add after `resolveReviewEnabled`:

```ts
export function resolveSddEnabled(
  task: Pick<Task, 'sddEnabled'>,
  project?: Pick<ProjectConfig, 'sddEnabled'> | null,
): boolean {
  return task.sddEnabled ?? project?.sddEnabled ?? false;
}
```

Replace the existing `filterPlannerTools` (keep `PLANNER_TOOL_DENYLIST` as is) with:

```ts
/** Tools the SDD wrapper applies to: workspace writers that take a `path` arg. */
const SDD_WRAPPED_TOOLS = new Set(['write', 'edit', 'multiedit']);

/** Wrap a writing tool so it only accepts markdown targets. Everything else
 *  about the tool (schema, sandbox, read-before-write guard) is unchanged —
 *  the guard runs before delegation. Guard-rail, not a security boundary. */
function markdownOnly(tool: Tool): Tool {
  return {
    ...tool,
    description: `${tool.description} In this planning phase, only markdown (.md) files are accepted.`,
    execute: async (args, ctx) => {
      const p = (args as { path?: unknown }).path;
      if (typeof p !== 'string' || !p.toLowerCase().endsWith('.md')) {
        return { content: 'Error: planning phase (SDD mode): only markdown (.md) files may be written.' };
      }
      return tool.execute(args, ctx);
    },
  };
}

export function filterPlannerTools(tools: Tool[], sdd = false): Tool[] {
  if (!sdd) return tools.filter((t) => !PLANNER_TOOL_DENYLIST.has(t.name));
  // SDD mode: bash stays out (the actual implementation brake); the file
  // writers survive but only for markdown targets.
  return tools
    .filter((t) => t.name !== 'bash')
    .map((t) => (SDD_WRAPPED_TOOLS.has(t.name) ? markdownOnly(t) : t));
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/cli && pnpm exec tsx --test src/cli/web/scheduler/task_roles.test.ts && pnpm typecheck`
Expected: PASS (all, incl. pre-existing), clean typecheck. Also: `pnpm -F caretaker-types build`.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/index.ts packages/cli/src/store/db.ts packages/cli/src/cli/web/scheduler/task_roles.ts packages/cli/src/cli/web/scheduler/task_roles.test.ts
git commit -m "feat(tasks): sddEnabled flag and markdown-only planner tool wrapper"
```

---

### Task 2: Task tools — `sdd_enabled` on create, exposed in state

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts` (taskCreateTool, getTaskStateTool)
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `sddEnabled` field.
- Produces: `task_create` accepts `sdd_enabled?: boolean`; `task_get_state` returns `sddEnabled`.

- [ ] **Step 1: Write the failing test**

Append to `task_tools.test.ts` (add `getTaskStateTool` to the dynamic import if not present):

```ts
test('task_create persists sdd_enabled; task_get_state exposes it', async () => {
  await saveConfig({
    port: 3000, providers: [],
    projects: [{ id: 11, name: 'SddProj', description: '', workingDir: '/w', agentId: 'a', active: true }],
  } as any);
  const res = await taskCreateTool.execute(
    { project_id: 11, title: 'Sdd', objective: 'o', checklist: [], sdd_enabled: true },
    ctx(),
  );
  const parsed = JSON.parse(res.content);
  assert.equal(parsed.ok, true);
  assert.equal((await getTaskById(parsed.task_id))!.sddEnabled, true);

  const state = JSON.parse((await getTaskStateTool.execute({ task_id: parsed.task_id }, ctx())).content);
  assert.equal(state.sddEnabled, true);
  await saveConfig({ port: 3000, providers: [] } as any);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && pnpm exec tsx --test src/harness/tools/builtin/task_tools.test.ts`
Expected: the new test FAILS (`sddEnabled` undefined).

- [ ] **Step 3: Implement**

In `taskCreateTool.parameters.properties`, after `review_enabled`:

```ts
      sdd_enabled: { type: 'boolean', description: 'Override the project SDD-mode default for this task (planner may write .md files during planning).' },
```

In its `execute`, after the `reviewEnabled` const:

```ts
    const sddEnabled = typeof args.sdd_enabled === 'boolean' ? args.sdd_enabled : null;
```

and add `sddEnabled,` to the `createTask({ ... })` call after `reviewEnabled,`.

In `getTaskStateTool`'s returned JSON, after `reviewEnabled: task.reviewEnabled ?? null,`:

```ts
        sddEnabled: task.sddEnabled ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm exec tsx --test src/harness/tools/builtin/task_tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts
git commit -m "feat(tasks): sdd_enabled on task_create, sddEnabled in task_get_state"
```

---

### Task 3: Scheduler — SDD-aware planning cycle and prompt

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts`

**Interfaces:**
- Consumes: `resolveSddEnabled` (extend the existing `./task_roles.js` import), `filterPlannerTools(tools, sdd)`.
- Produces: planning cycles resolve the flag and pass it to the tool filter and the prompt.

No unit tests for this file (harness.run I/O wiring; none exist today) — covered by Task 1's pure tests + typecheck + the final live check.

- [ ] **Step 1: Extend the import**

```ts
import { resolveRoleAgent, resolveReviewEnabled, resolveSddEnabled, filterPlannerTools, TaskRole } from './task_roles.js';
```

- [ ] **Step 2: SDD parameter on the planning prompt**

Change `buildPlanningPrompt`'s signature to add a trailing `sdd: boolean` parameter:

```ts
function buildPlanningPrompt(
  systemPrompt: string,
  taskId: number,
  taskTitle: string,
  maxRunSeconds: number,
  maxTurns: number,
  workingDir: string | undefined,
  sdd: boolean,
): string {
```

Inside it, replace the fixed read-only paragraph

```
You have read-only access to the workspace: explore it with `read_file`, `glob`, and
`grep`. Write tools and `bash` are not available in this phase.
```

with an `accessBlock` computed above the template string and interpolated in its place:

```ts
  const accessBlock = sdd
    ? `You are in **SDD mode**: you may create and edit **markdown (.md) documents only** — specs, plans, ADRs — and you MUST follow this project's own documentation conventions (see the project context / AGENTS.md). Everything else stays read-only: explore with \`read_file\`, \`glob\`, and \`grep\`; non-markdown files and \`bash\` are not available. Reference the documents you created in the plan you submit.`
    : `You have read-only access to the workspace: explore it with \`read_file\`, \`glob\`, and
\`grep\`. Write tools and \`bash\` are not available in this phase.`;
```

(template usage: `${accessBlock}` on the line where the old paragraph was.)

- [ ] **Step 3: Resolve and plumb the flag in the planning branch**

In `runTaskHeartbeatTick`, the planning branch currently reads:

```ts
    const planning = task.status === 'planning';
    if (planning) {
      // Read-only phase: strip workspace-mutating tools (same post-filter
      // mechanism the review uses to strip mcp__task__*).
      tools = filterPlannerTools(tools);
    }
```

Replace with:

```ts
    const planning = task.status === 'planning';
    const sdd = planning && resolveSddEnabled(task, project);
    if (planning) {
      // Read-only phase: strip workspace-mutating tools (same post-filter
      // mechanism the review uses to strip mcp__task__*). In SDD mode the
      // file writers survive, wrapped to markdown-only targets.
      tools = filterPlannerTools(tools, sdd);
    }
```

and the prompt construction becomes:

```ts
    const prompt = planning
      ? buildPlanningPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir, sdd)
      : buildPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir);
```

- [ ] **Step 4: Typecheck + full cli tests**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F caretaker-cli test`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_strategy.ts
git commit -m "feat(tasks): SDD-aware planning cycle — md-only writers and prompt"
```

---

### Task 4: Web API — `sddEnabled` on flags, task create, project create

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts`

**Interfaces:**
- Consumes: Task 1's field.
- Produces: `PATCH /api/tasks/:id/flags` accepts `sddEnabled` (`true | false | null`, key-present semantics like the other two); `POST /api/projects/:id/tasks` and `POST /api/projects` accept `sddEnabled`.

- [ ] **Step 1: Flags route**

In the `PATCH /api/tasks/:id/flags` handler, after the `reviewEnabled` block:

```ts
    if ('sddEnabled' in body) {
      task.sddEnabled = typeof body.sddEnabled === 'boolean' ? body.sddEnabled : null;
    }
```

and add `sddEnabled: task.sddEnabled ?? null,` to its response JSON.

- [ ] **Step 2: Task create route**

In `POST /api/projects/:id/tasks`: add `sddEnabled` to the body destructure, and in the `createTask({ ... })` call after the `reviewEnabled` line:

```ts
      sddEnabled: typeof sddEnabled === 'boolean' ? sddEnabled : null,
```

- [ ] **Step 3: Project create route**

In `POST /api/projects`: add `sddEnabled` to the body destructure and to the `project` literal after `reviewEnabled`:

```ts
        sddEnabled: typeof sddEnabled === 'boolean' ? sddEnabled : null,
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm -F caretaker-cli typecheck`
Expected: clean.

```bash
git add packages/cli/src/cli/web/server.ts
git commit -m "feat(tasks): sddEnabled across flags/create web API"
```

---

### Task 5: Webview UI — SDD toggle on task and project

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx`
- Modify: `packages/webview-ui/src/ProjectsTabSettings.tsx`

**Interfaces:**
- Consumes: Task 4's API. `ProjectConfig.sddEnabled` via `caretaker-types` (Task 1).
- Produces: third tri-state select in the task edit view's "Phases" block; third select + legend in the project settings form.

- [ ] **Step 1: ProjectsTab — type + flag union + Phases entry**

In the local `Task` interface add `sddEnabled?: boolean | null;` after `reviewEnabled`.

Widen the flag union in BOTH `handleSetTaskFlag`'s signature and `TaskEditView`'s `onSetFlag` prop type from `'planningEnabled' | 'reviewEnabled'` to `'planningEnabled' | 'reviewEnabled' | 'sddEnabled'`.

In the `TaskEditView` "Phases" block, the flags array

```tsx
              [
                { flag: 'planningEnabled' as const, label: 'Planning phase', value: task.planningEnabled },
                { flag: 'reviewEnabled' as const, label: 'Review at DONE', value: task.reviewEnabled },
              ]
```

gains a third entry:

```tsx
              [
                { flag: 'planningEnabled' as const, label: 'Planning phase', value: task.planningEnabled },
                { flag: 'reviewEnabled' as const, label: 'Review at DONE', value: task.reviewEnabled },
                { flag: 'sddEnabled' as const, label: 'SDD mode (.md specs)', value: task.sddEnabled },
              ]
```

(the existing `.map` renders it — no other change; each label already has `flex: 1`.)

- [ ] **Step 2: ProjectsTabSettings — state, persist, select + legend**

After the `reviewEnabled` state line:

```ts
  const [sddEnabled, setSddEnabled] = useState<boolean | null>(null);
```

In `startEdit`, after the `setReviewEnabled(...)` line:

```ts
    setSddEnabled(proj.sddEnabled !== undefined ? proj.sddEnabled : null);
```

In `startCreate`, after `setReviewEnabled(true);` (match the surrounding style — if the current code resets with `null`, use `setSddEnabled(null);`):

```ts
    setSddEnabled(null);
```

In `validateAndSave`, add `sddEnabled,` next to `planningEnabled, reviewEnabled` in BOTH the `newProj` literal and the edit spread.

In the form, inside the same `form-group` flex row that holds the two phase selects, add a third `div` after "Review at DONE":

```tsx
            <div style={{ flex: 1 }}>
              <label htmlFor="project-sdd-enabled">SDD Mode</label>
              <select
                id="project-sdd-enabled"
                value={sddEnabled === true ? 'on' : sddEnabled === false ? 'off' : 'default'}
                onChange={(e) => setSddEnabled(e.target.value === 'default' ? null : e.target.value === 'on')}
              >
                <option value="default">Default (Off)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
```

Right below the flex row (still inside the form), add the legend:

```tsx
          <p style={{ fontSize: '11px', opacity: 0.65, margin: '6px 0 0 0' }}>
            SDD mode lets the planner write markdown documents (specs, plans) during the planning
            phase. How and where they are written is up to this project's own conventions
            (AGENTS.md, agent prompt — e.g. superpowers specs). Everything else stays read-only.
          </p>
```

- [ ] **Step 3: Build + typecheck + commit**

Run: `pnpm -F webview-ui build && pnpm -F caretaker-cli typecheck && pnpm -F caretaker-vscode build`
Expected: all clean.

```bash
git add packages/webview-ui/src/ProjectsTab.tsx packages/webview-ui/src/ProjectsTabSettings.tsx
git commit -m "feat(webview): SDD mode toggle on task phases and project settings"
```

---

### Task 6: Docs, changeset, full verification

**Files:**
- Modify: `CLAUDE.md` (layer-5 planning bullet + State on disk item 3)
- Modify: `README.md` (planning paragraph in the autonomous tasks section)
- Create: `.changeset/planner-sdd-mode.md`

- [ ] **Step 1: CLAUDE.md**

In the layer-5 **Planning phase** bullet, after the sentence describing the read-only strip, add: an opt-in **SDD mode** (`sddEnabled` tri-state on the task inheriting from the project, default **off**, resolved by `resolveSddEnabled`) keeps `write`/`edit`/`multiedit` but wraps them with a markdown-only path guard (`bash` stays stripped); spec conventions are deliberately left to the project (AGENTS.md / planner prompt), and the `.md` files land on the task branch via the per-cycle WIP commit.

In State on disk item 3, extend the tri-state gate list `planningEnabled`/`reviewEnabled` with `sddEnabled` (note its default off), and note `task_create` accepts `sdd_enabled` and `PATCH /api/tasks/:id/flags` accepts `sddEnabled`.

- [ ] **Step 2: README.md**

In the planning paragraph ("Each task can run with **three distinct agent roles**…"), append: an opt-in **SDD mode** (per project or per task, off by default) lets the planner write markdown documents — specs, plans, ADRs — during planning, following the project's own documentation conventions; everything else stays read-only and the docs land on the task branch together with the plan.

- [ ] **Step 3: Changeset**

Create `.changeset/planner-sdd-mode.md`:

```md
---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Planner SDD mode (opt-in): a new `sddEnabled` tri-state gate (task inherits from project, default off) lets the planner create and edit markdown files during the planning phase — write/edit/multiedit are wrapped with a `.md`-only path guard instead of stripped, while bash stays unavailable. Spec conventions (where/how) are left to the project's own AGENTS.md / agent prompt; the documents land on the task branch via the per-cycle WIP commit. Surfaced everywhere the other gates are: `task_create` (`sdd_enabled`), `task_get_state`, `PATCH /api/tasks/:id/flags`, task/project creation APIs, and the task/project settings UI.
```

- [ ] **Step 4: Full verification**

Run: `pnpm build && pnpm test && pnpm -F caretaker-cli typecheck`
Expected: all five packages build, all tests pass, typecheck clean.

Live check (manual, `CARETAKER_HOME=/tmp/ct-sdd pnpm -F caretaker-cli dev web`): project on a scratch git repo with SDD **on**, task with startActive → first planning cycle: `write` on a `.ts` path must return the SDD error, `write` on `docs/spec.md` must succeed and appear as a WIP commit on the task branch.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/planner-sdd-mode.md
git commit -m "docs: planner SDD mode; changeset"
```
