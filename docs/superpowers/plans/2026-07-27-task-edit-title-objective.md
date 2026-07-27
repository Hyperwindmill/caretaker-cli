# Task Edit: editable title and objective — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a task's title and objective editable after creation — the "edit" view currently renders both read-only, and no HTTP route or tool can change them.

**Architecture:** New builtin `mcp__task__task_update_details` (`{task_id, title?, objective?}`, absent key = unchanged, non-empty title enforced) → registered in the builtin registry, so both MCP producers pick it up via the `mcp__task__` prefix. New `PATCH /api/tasks/:id` in the web server with the same body shape. `TaskEditView` gains a title input + objective textarea backed by local draft state with Save/Cancel (not save-on-blur — the 3 s task poll would clobber typing).

**Tech Stack:** TypeScript ESM, Hono, React, Node built-in test runner via tsx, pnpm workspaces, Changesets.

**Spec:** `docs/superpowers/specs/2026-07-27-task-edit-title-objective-design.md`

## Global Constraints

- No running-task 409 guard on this edit (see spec §3) — text edits land on the next cycle.
- `title` present ⇒ trimmed and must be non-empty; `objective` present ⇒ trimmed, may be empty. Non-string ⇒ error.
- Absent key means "leave unchanged" (`'x' in body` pattern, as in `PATCH …/flags`).
- Conventional commits, **no** Co-Authored-By / AI attribution.
- Tests: Node built-in runner via tsx, co-located `*.test.ts`, run from repo root. `pnpm test` does **not** typecheck — run `pnpm -F @hyperwindmill/caretaker-cli typecheck` too.
- Every feature needs a changeset (`.changeset/*.md`, five-package fixed group, this one: `minor`).
- Docs (`CLAUDE.md`, `README.md`) updated in the same unit of work.

---

### Task 1: Tool — `mcp__task__task_update_details`

**Files:**
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts` (add after `updateChecklistTool`, ~line 162)
- Modify: `packages/cli/src/harness/tools/builtin/index.ts` (import list ~line 27, `registerBuiltins` ~line 80, re-export block ~line 120)
- Test: `packages/cli/src/harness/tools/builtin/task_tools.test.ts` (append at end of file)

**Interfaces:**
- Consumes: `getTaskById`, `saveTask` from `store/db.js`; local `ok()` / `err()` helpers.
- Produces: `taskUpdateDetailsTool` (export) named `mcp__task__task_update_details`. Task 2's route mirrors its validation; `taskTools()` in `packages/cli/src/mcp/task_server.ts` picks it up automatically by prefix (no allowlist to touch).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/harness/tools/builtin/task_tools.test.ts`, and add `taskUpdateDetailsTool` to the destructured import on line 14:

```ts
test('task_update_details rewrites title and objective, trimming both', async () => {
  const t = await createTask({ ...base, title: 'Old', objective: 'old objective' });

  const res = await taskUpdateDetailsTool.execute(
    { task_id: t.id, title: '  New title  ', objective: '  new objective  ' },
    ctx(),
  );
  assert.equal(JSON.parse(res.content).ok, true);

  const after = await getTaskById(t.id);
  assert.equal(after!.title, 'New title');
  assert.equal(after!.objective, 'new objective');
});

test('task_update_details leaves absent fields untouched', async () => {
  const t = await createTask({ ...base, title: 'Keep me', objective: 'first' });

  await taskUpdateDetailsTool.execute({ task_id: t.id, objective: 'second' }, ctx());

  const after = await getTaskById(t.id);
  assert.equal(after!.title, 'Keep me');
  assert.equal(after!.objective, 'second');
});

test('task_update_details rejects an empty title and a missing task', async () => {
  const t = await createTask({ ...base, title: 'Untouched', objective: 'o' });

  const blank = await taskUpdateDetailsTool.execute({ task_id: t.id, title: '   ' }, ctx());
  assert.match(JSON.parse(blank.content).error, /title/i);

  const after = await getTaskById(t.id);
  assert.equal(after!.title, 'Untouched');

  const missing = await taskUpdateDetailsTool.execute({ task_id: 999999, title: 'x' }, ctx());
  assert.match(JSON.parse(missing.content).error, /not found/i);
});

test('task_update_details with an empty objective is allowed', async () => {
  const t = await createTask({ ...base, title: 'T', objective: 'something' });
  await taskUpdateDetailsTool.execute({ task_id: t.id, objective: '' }, ctx());
  const after = await getTaskById(t.id);
  assert.equal(after!.objective, '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts
```
Expected: the four new tests FAIL (`taskUpdateDetailsTool` is undefined → TypeError). Pre-existing tests still PASS.

- [ ] **Step 3: Implement the tool**

In `packages/cli/src/harness/tools/builtin/task_tools.ts`, after `updateChecklistTool` (~line 162):

```ts
export const taskUpdateDetailsTool: Tool = {
  name: 'mcp__task__task_update_details',
  description:
    'Rewrite a task\'s title and/or objective. Omit a field to leave it unchanged. The title cannot be blank; the objective may be empty.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'number' },
      title: { type: 'string' },
      objective: { type: 'string' },
    },
    required: ['task_id'],
  },
  execute: async (args: any): Promise<ToolResult> => {
    const taskId = Number(args.task_id);
    const hasTitle = args.title !== undefined;
    const hasObjective = args.objective !== undefined;
    if (!hasTitle && !hasObjective) return err('Nothing to update: pass title, objective, or both.');
    if (hasTitle && typeof args.title !== 'string') return err('title must be a string.');
    if (hasObjective && typeof args.objective !== 'string') return err('objective must be a string.');

    // A blank title leaves the task unidentifiable in the list; an empty
    // objective is fine (task_create already allows one).
    const title = hasTitle ? String(args.title).trim() : null;
    if (hasTitle && !title) return err('title cannot be empty.');

    const task = await getTaskById(taskId);
    if (!task) return err(`Task ${taskId} not found`);

    if (title !== null) task.title = title;
    if (hasObjective) task.objective = String(args.objective).trim();
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return ok({ title: task.title, objective: task.objective });
  },
};
```

In `packages/cli/src/harness/tools/builtin/index.ts`, add `taskUpdateDetailsTool` in three places, next to `updateChecklistTool` each time: the import list (~line 27), a `registry.register(taskUpdateDetailsTool);` line in `registerBuiltins` (~line 80), and the re-export block (~line 120).

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/task_tools.test.ts
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: all tests in the file PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/task_tools.ts packages/cli/src/harness/tools/builtin/task_tools.test.ts packages/cli/src/harness/tools/builtin/index.ts
git commit -m "feat(cli): add task_update_details tool for editing title and objective"
```

---

### Task 2: Server — `PATCH /api/tasks/:id`

**Files:**
- Modify: `packages/cli/src/cli/web/server.ts` (add after the `PATCH /api/tasks/:id/flags` route, ~line 653)

**Interfaces:**
- Consumes: `getTaskById`, `saveTask` (already imported in this file).
- Produces: `PATCH /api/tasks/:id` — body `{ title?: string, objective?: string }` → `200 {ok:true, title, objective}` | `400 {ok:false,error}` | `404 {ok:false,error:'not found'}`. Task 3's UI calls it.

No route test: `server.ts` registers routes inline in the same function that calls `serve()`, so no task route is covered today and no `server.test.ts` exists (spec §5). The logic lives in the Task 1 tool, which is tested; this is a thin adapter verified by typecheck + the Task 4 manual check.

- [ ] **Step 1: Add the route**

In `packages/cli/src/cli/web/server.ts`, after the `flags` route (~line 653):

```ts
  // Rewrite a task's title/objective. Absent key = leave unchanged. No running
  // guard (unlike …/agent): the objective is read at the start of each cycle, so
  // an edit simply lands on the next one — no reason to force a pause for a typo.
  app.patch('/api/tasks/:id', async (c) => {
    const taskId = Number(c.req.param('id'));
    const body = await c.req.json();

    const hasTitle = 'title' in body;
    const hasObjective = 'objective' in body;
    if (!hasTitle && !hasObjective) {
      return c.json({ ok: false, error: 'Nothing to update: pass title, objective, or both.' }, 400);
    }
    if (hasTitle && typeof body.title !== 'string') {
      return c.json({ ok: false, error: 'title must be a string.' }, 400);
    }
    if (hasObjective && typeof body.objective !== 'string') {
      return c.json({ ok: false, error: 'objective must be a string.' }, 400);
    }
    const title = hasTitle ? body.title.trim() : null;
    if (hasTitle && !title) {
      return c.json({ ok: false, error: 'Title cannot be empty.' }, 400);
    }

    const task = await getTaskById(taskId);
    if (!task) return c.json({ ok: false, error: 'not found' }, 404);

    if (title !== null) task.title = title;
    if (hasObjective) task.objective = body.objective.trim();
    task.updatedAt = new Date().toISOString();
    await saveTask(task);

    return c.json({ ok: true, title: task.title, objective: task.objective });
  });
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```
Expected: typecheck clean, all CLI tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/cli/web/server.ts
git commit -m "feat(cli): add PATCH /api/tasks/:id for title and objective"
```

---

### Task 3: UI — editable title + objective in `TaskEditView`

**Files:**
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (handler after `handleSetTaskMaxRun` ~line 583; `TaskEditView` prop wiring ~line 703; `TaskEditViewProps` ~line 1388; component body ~line 1407; header title ~line 1417; Objective block ~line 1487-1494)

**Interfaces:**
- Consumes: `PATCH /api/tasks/:id` from Task 2. Existing locals: `fetchTasks`, `selectedProjectId`, `setTaskError`.
- Produces: `onSaveDetails: (t: Task, title: string, objective: string) => Promise<void>` prop on `TaskEditView`. Nothing downstream.

No component test: the file has no component tests and this adds no extractable pure logic (dirty-check + fetch). Verified by build/typecheck + the Task 4 manual check.

- [ ] **Step 1: Add the save handler in `ProjectsTab`**

After `handleSetTaskMaxRun` (~line 583):

```tsx
  // Rewrite a task's title/objective from the edit view.
  const handleSaveTaskDetails = async (task: Task, title: string, objective: string) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, objective }),
      });
      if (res.ok) {
        if (selectedProjectId !== null) fetchTasks(selectedProjectId);
      } else {
        const data = await res.json().catch(() => ({}));
        setTaskError(data.error || 'Failed to save task details');
      }
    } catch (err) {
      console.error('Failed to save task details:', err);
      setTaskError('Failed to save task details');
    }
  };
```

Pass it to `TaskEditView` (~line 703, next to `onSetMaxRun`):

```tsx
              onSaveDetails={handleSaveTaskDetails}
```

- [ ] **Step 2: Draft state in `TaskEditView`**

Add to `TaskEditViewProps` (~line 1388):

```tsx
  onSaveDetails: (t: Task, title: string, objective: string) => Promise<void>;
```

Add `onSaveDetails` to the destructured params (~line 1404, next to `onSetMaxRun`), and inside the component body right after the `isRunning` line (~line 1408):

```tsx
  // Local draft, not save-on-blur: this view re-renders from a 3 s task poll,
  // so an uncontrolled input keyed on remote state would eat in-flight typing.
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftObjective, setDraftObjective] = useState(task.objective);
  // Re-seed when switching task, and when the stored values change from
  // elsewhere (an agent rewrote them) while there is nothing to lose.
  useEffect(() => {
    setDraftTitle(task.title);
    setDraftObjective(task.objective);
  }, [task.id]);
  const trimmedTitle = draftTitle.trim();
  const isDirty = trimmedTitle !== task.title || draftObjective.trim() !== task.objective;
  const canSave = isDirty && trimmedTitle.length > 0;
  const resetDraft = () => {
    setDraftTitle(task.title);
    setDraftObjective(task.objective);
  };
```

Make sure `useState` / `useEffect` are in the file's React import (they already are — used by `ProjectsTab`).

- [ ] **Step 3: Replace the static title and Objective block**

Header (~line 1417): keep the `Task #{task.id}` prefix as static text, make the name an input.

```tsx
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ opacity: 0.6 }}>Task #{task.id}</span>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              aria-label="Task title"
              title="Task title"
              style={{
                background: 'var(--vscode-input-background, #252526)',
                color: 'var(--vscode-input-foreground)',
                border: '1px solid var(--vscode-input-border, #3c3c3c)',
                borderRadius: '4px',
                padding: '3px 6px',
                fontSize: '14px',
                fontWeight: 700,
                outline: 'none',
                minWidth: '240px',
              }}
            />
          </h3>
```

Objective block (~line 1487-1494) becomes a textarea plus the Save/Cancel pair, which only appears when dirty:

```tsx
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6 }}>
            Objective
          </h4>
          <textarea
            value={draftObjective}
            onChange={(e) => setDraftObjective(e.target.value)}
            rows={6}
            aria-label="Task objective"
            title="What the agent should achieve. Read at the start of every cycle, so an edit applies from the next one."
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: '12px',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              background: 'var(--vscode-input-background, #252526)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border, #3c3c3c)',
              borderRadius: '6px',
              padding: '10px',
              outline: 'none',
              resize: 'vertical',
            }}
          />
          {isDirty && (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '8px' }}>
              <button
                className="confirm__btn confirm__btn--primary"
                onClick={() => onSaveDetails(task, trimmedTitle, draftObjective.trim())}
                disabled={!canSave}
                title={canSave ? 'Save title and objective' : 'The title cannot be empty'}
                style={{ padding: '3px 10px', fontSize: '10px' }}
              >
                Save
              </button>
              <button className="confirm__btn" onClick={resetDraft} style={{ padding: '3px 10px', fontSize: '10px' }}>
                Cancel
              </button>
              {isRunning && (
                <span style={{ fontSize: '10px', opacity: 0.6 }}>Applies from the next cycle.</span>
              )}
            </div>
          )}
        </div>
```

- [ ] **Step 4: Build + typecheck**

```bash
pnpm -F webview-ui build
pnpm -F webview-ui test
pnpm -F @hyperwindmill/caretaker-cli typecheck
```
Expected: build clean, existing webview tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webview-ui/src/ProjectsTab.tsx
git commit -m "feat(webview): make task title and objective editable in the edit view"
```

---

### Task 4: Docs, changeset, end-to-end check

**Files:**
- Modify: `CLAUDE.md` (§"State on disk" — the `mcp__task__*` tool list and the "web API mirrors the role/flag surface" sentence)
- Modify: `README.md` (§"Autonomous task/project system", the `mcp__task__*` enumeration paragraph, ~line 102)
- Create: `.changeset/task-edit-title-objective.md`

**Interfaces:**
- Consumes: the feature as shipped by Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Update `CLAUDE.md`**

In the §"State on disk" tool enumeration, add `task_update_details` right after `task_update_checklist_item`:

```
`task_update_checklist_item`, `task_update_details` (rewrite title/objective),
```

And in the same section's web-API sentence — currently `«PATCH /api/tasks/:id/agent takes an optional role, PATCH /api/tasks/:id/flags sets the tri-state gates …»` — insert before it:

```
`PATCH /api/tasks/:id` rewrites `title`/`objective` (absent key = unchanged, blank title rejected, no running-task guard — the objective is re-read at the start of each cycle),
```

- [ ] **Step 2: Update `README.md`**

In the `mcp__task__*` enumeration on ~line 102, add `task_update_details` after `task_update_checklist_item`. Then append one sentence to that same paragraph (after the "Show archived" / delete sentence):

```
A task's **title and objective are editable** from its edit view in the web GUI — change either, press **Save**, and the next cycle picks the new text up; a running task is not interrupted (the same edit is available to agents as `task_update_details`).
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/task-edit-title-objective.md`:

```md
---
'@hyperwindmill/caretaker-cli': minor
'webview-ui': minor
'caretaker-vscode': minor
'caretaker-desktop': minor
'caretaker-types': minor
---

Make a task's title and objective editable after creation. The task edit view now shows a title input and an objective textarea with Save/Cancel instead of read-only text, backed by a new `PATCH /api/tasks/:id` route and a new `mcp__task__task_update_details` tool (both accept either field on its own; a blank title is rejected, an empty objective is allowed). Edits are not blocked while a task is running — the objective is re-read at the start of each cycle.
```

- [ ] **Step 4: Full test pass + manual end-to-end**

```bash
pnpm test
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm build
```
Expected: all packages PASS, typecheck clean, build clean.

Manual check:
```bash
CARETAKER_HOME=/tmp/ct-taskedit pnpm -F @hyperwindmill/caretaker-cli dev web
```
In Projects → pick a project → create a task → open its edit view (pencil icon):
1. Objective is a textarea; edit it → Save/Cancel appear → **Save** → reopen the view, the new text is there.
2. Edit, then **Cancel** → the field reverts to the stored text.
3. Clear the title → Save is disabled; type a title → Save enabled and works (header and list row both show the new title).
4. With a task left untouched, wait ~10 s on the edit view: the 3 s poll must not wipe text typed into the textarea.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .changeset/task-edit-title-objective.md
git commit -m "docs: document editable task title and objective"
```
