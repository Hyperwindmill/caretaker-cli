# Memory Daemon Step 3 (Recall / Read Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memories written by the sweep become readable: a host-side lexical match on the user message injects top-K memory titles into the prelude, and a `mcp__memory__memory_read` tool returns bodies on demand, bumping recall accounting.

**Architecture:** A pure matcher module (`harness/memory_recall.ts`) scores memories by inverted keyword match (`promptLowercase.includes(keyword)`) × importance × acquired strength (`recallCount`), formats a `<memories>` titles-only block, and one async wrapper gates on `MemoryConfig` and injects it in both runners (native loop + claude-code). A new builtin namespace `mcp__memory__` rides the existing prefix-filter plumbing (`buildBuiltinMcpServer`) to both MCP surfaces. No model in the read loop.

**Tech Stack:** TypeScript ESM, Node built-in test runner via tsx, `@morphql/store` folder DB.

**Spec:** `docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md`

## Global Constraints

- Package manager: **pnpm**; all commands from the repo root.
- Tests co-located as `*.test.ts`; run one file: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test <path>`.
- `process.env.CARETAKER_HOME` mutated at FILE scope only (one describe per file, before/after hooks — the `db_memory.test.ts` pattern).
- Folder-DB rules: ids through `safeId`, records interpolated through `JSON.stringify` only.
- Never rewrite a commit (no `--amend`/`rebase`/`reset`); commit after every task.
- The pre-commit hook requires a **staged** `.changeset/*.md` on every feature-branch commit (`git diff --cached`, so a changeset merely existing in history does not pass). Convention verified on the step-2 commits (each staged `.changeset/memory-daemon-step2.md` with a progressive wording refinement): **every task's commit makes a small wording refinement to `.changeset/memory-daemon-step3.md` and stages it.** Task 1 creates the file; each later commit step says "tweak + stage the changeset". Never `--no-verify`.
- Reasoning constants live at the top of their module, exported, tunable.

---

### Task 1: Recall accounting on `Memory` (`recallCount`, `lastRecalledAt`, `bumpMemoryRecall`) + changeset

**Files:**
- Modify: `packages/cli/src/store/db.ts` (Memory interface ~line 296, accessors ~line 336)
- Test: `packages/cli/src/store/db_memory.test.ts`
- Create: `.changeset/memory-daemon-step3.md`

**Interfaces:**
- Consumes: existing `Memory`, `safeId`, `runQuery` in `db.ts`.
- Produces: `Memory.recallCount?: number`, `Memory.lastRecalledAt?: string`, `bumpMemoryRecall(id: string): Promise<void>` — used by Task 4's tool and Task 3's scoring.

- [x] **Step 1: Write the failing tests**

Append inside the existing `describe('memory store', …)` in `packages/cli/src/store/db_memory.test.ts` (after the delete test):

```ts
  it('bumpMemoryRecall increments recallCount and sets lastRecalledAt', async () => {
    const id = 'a1b2c3d4-0000-0000-0000-000000000001';
    await db.bumpMemoryRecall(id);
    let m = (await db.listMemories()).find((x) => x.id === id)!;
    assert.equal(m.recallCount, 1); // absent field treated as 0
    assert.ok(m.lastRecalledAt);
    assert.equal(m.title, 'Uses pnpm'); // rest of the record untouched
    await db.bumpMemoryRecall(id);
    m = (await db.listMemories()).find((x) => x.id === id)!;
    assert.equal(m.recallCount, 2);
  });

  it('bumpMemoryRecall is a no-op on unknown or invalid ids', async () => {
    await db.bumpMemoryRecall('a1b2c3d4-0000-0000-0000-00000000dead');
    await db.bumpMemoryRecall("bad'id");
    const all = await db.listMemories();
    assert.equal(all.length, 1);
  });
```

Note: the earlier `save + list round-trips verbatim` test uses `assert.deepEqual(all[0], mem())` and runs BEFORE the bump tests (node test runner preserves order within a describe) — no change needed there.

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_memory.test.ts`
Expected: FAIL — `db.bumpMemoryRecall is not a function`.

- [x] **Step 3: Implement**

In `packages/cli/src/store/db.ts`, add to the `Memory` interface (after `keywords: string[];`, before the provenance banner):

```ts
  // ─── recall accounting (step 3) — the acquired-strength signal for the
  //     future consolidation/decay; bumped ONLY by memory_read ────────────
  /** Times delivered by memory_read. Absent on pre-step-3 records = 0. */
  recallCount?: number;
  /** ISO timestamp of the last memory_read delivery. */
  lastRecalledAt?: string;
```

After `deleteMemory`, add:

```ts
/** Recall event: memory_read delivered this memory to an agent. Delete +
 *  insert (saveSessionDigest pattern — the store has no UPDATE). No-op on
 *  unknown ids: a stale id in a prelude block is not an error. */
export async function bumpMemoryRecall(id: string): Promise<void> {
  if (!safeId(id)) return;
  const rows = (await runQuery(`SELECT * FROM memories WHERE id = '${id}'`)) as Memory[];
  const m = rows[0];
  if (!m) return;
  await runQuery(`DELETE FROM memories WHERE id = '${id}'`);
  await runQuery(
    `INSERT INTO memories ${JSON.stringify({
      ...m,
      recallCount: (m.recallCount ?? 0) + 1,
      lastRecalledAt: new Date().toISOString(),
    })}`
  );
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_memory.test.ts`
Expected: PASS (all tests in the file).

- [x] **Step 5: Create the changeset**

Create `.changeset/memory-daemon-step3.md`:

```markdown
---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 3: the read path. A host-side lexical keyword match on the user message injects a `<memories>` block (top-K titles) into the prelude on every surface, and a new `mcp__memory__memory_read` builtin returns memory bodies on demand — each read increments the memory's recall accounting (`recallCount`/`lastRecalledAt`), the acquired-strength signal for future consolidation.
```

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/store/db.ts packages/cli/src/store/db_memory.test.ts .changeset/memory-daemon-step3.md
git commit -m "feat(memory): recall accounting fields + bumpMemoryRecall accessor"
```

---

### Task 2: `resolveProjectIdForDir` in `lib/project_resolve.ts` (shared by write and read paths)

**Files:**
- Create: `packages/cli/src/lib/project_resolve.ts`
- Create: `packages/cli/src/lib/project_resolve.test.ts`
- Modify: `packages/cli/src/cli/web/scheduler/memory_extract.ts:131-152` (`resolveProjectId` delegates)

**Interfaces:**
- Consumes: `ProjectConfig` from `packages/cli/src/types.ts`.
- Produces: `resolveProjectIdForDir(dir: string, projects: ProjectConfig[]): string` — '' = no project. Used by Task 3 and by `memory_extract.resolveProjectId`.

- [x] **Step 1: Write the failing tests**

Create `packages/cli/src/lib/project_resolve.test.ts` (pure — no CARETAKER_HOME needed):

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectIdForDir } from './project_resolve.js';
import type { ProjectConfig } from '../types.js';

const proj = (id: string, workingDir: string): ProjectConfig =>
  ({ id, name: id, workingDir }) as ProjectConfig;

describe('resolveProjectIdForDir', () => {
  const projects = [proj('outer', '/home/u/dev'), proj('inner', '/home/u/dev/app')];

  it('matches exact dir and subdirectories', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev/app', projects), 'inner');
    assert.equal(resolveProjectIdForDir('/home/u/dev/app/src', projects), 'inner');
    assert.equal(resolveProjectIdForDir('/home/u/dev/other', projects), 'outer');
  });

  it('longest prefix wins (nested projects)', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev/app/deep/x', projects), 'inner');
  });

  it('no false prefix match on sibling names', () => {
    assert.equal(resolveProjectIdForDir('/home/u/dev-other', projects), '');
  });

  it("'' on empty/relative dirs and on projects without workingDir", () => {
    assert.equal(resolveProjectIdForDir('', projects), '');
    assert.equal(resolveProjectIdForDir('relative/path', projects), '');
    assert.equal(resolveProjectIdForDir('/x', [proj('p', '')]), '');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/project_resolve.test.ts`
Expected: FAIL — cannot find module `./project_resolve.js`.

- [x] **Step 3: Implement**

Create `packages/cli/src/lib/project_resolve.ts` (body extracted verbatim from `memory_extract.resolveProjectId`, minus the agent lookup):

```ts
// Host-side project resolution — scope ids are never chosen by a model.
// Shared by the memory write path (sweep extraction, via the session agent's
// workingDir) and the read path (recall, via the run's workingDir).
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md
import { isAbsolute, resolve, sep } from 'node:path';
import type { ProjectConfig } from '../types.js';

/** Path-aware prefix match of `dir` against the configured projects'
 *  workingDir. Longest match wins (nested projects). '' = no project. */
export function resolveProjectIdForDir(dir: string, projects: ProjectConfig[]): string {
  if (!dir || !isAbsolute(dir)) return '';
  const target = resolve(dir);
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (!p.workingDir || !isAbsolute(p.workingDir)) continue;
    const projDir = resolve(p.workingDir);
    if (target === projDir || target.startsWith(projDir + sep)) {
      if (!best || projDir.length > best.len) best = { id: p.id, len: projDir.length };
    }
  }
  return best?.id ?? '';
}
```

In `packages/cli/src/cli/web/scheduler/memory_extract.ts`:
- Replace the import line `import { isAbsolute, resolve, sep } from 'node:path';` with `import { resolveProjectIdForDir } from '../../../lib/project_resolve.js';` (the path helpers are only used by `resolveProjectId`).
- Replace the whole `resolveProjectId` body (keep the doc comment, note the delegation):

```ts
/** Host-side project resolution (scope ids are never chosen by a model):
 *  the session agent's workingDir prefix-matched, path-aware, against the
 *  configured projects' workingDir. Longest match wins (nested projects).
 *  '' = no project in scope → global-only extraction.
 *  Delegates to lib/project_resolve.ts — shared with the read path. */
export function resolveProjectId(
  sessionAgentId: string,
  agents: AgentConfig[],
  projects: ProjectConfig[]
): string {
  const dir = agents.find((a) => a.id === sessionAgentId)?.workingDir;
  return dir ? resolveProjectIdForDir(dir, projects) : '';
}
```

- [x] **Step 4: Run tests to verify they pass (new + existing regression)**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/lib/project_resolve.test.ts packages/cli/src/cli/web/scheduler/memory_extract.test.ts`
Expected: PASS — the existing `memory_extract` resolveProjectId tests now exercise the delegation.

- [x] **Step 5: Commit** (tweak one word in the changeset description first, then stage it — hook requirement)

```bash
git add packages/cli/src/lib/project_resolve.ts packages/cli/src/lib/project_resolve.test.ts packages/cli/src/cli/web/scheduler/memory_extract.ts .changeset/memory-daemon-step3.md
git commit -m "refactor(memory): extract resolveProjectIdForDir to lib, shared write/read scope resolution"
```

---

### Task 3: Matcher + block formatter + `buildMemoriesBlock` (`harness/memory_recall.ts`)

**Files:**
- Create: `packages/cli/src/harness/memory_recall.ts`
- Create: `packages/cli/src/harness/memory_recall.test.ts`

**Interfaces:**
- Consumes: `Memory` + `listMemories` from `store/db.js`, `loadConfig` from `store/json.js`, `resolveProjectIdForDir` from Task 2.
- Produces (used by Task 5):
  - `RECALL_TOP_K = 5`, `MIN_KEYWORD_LENGTH = 3` (exported consts)
  - `matchMemories(prompt: string, memories: Memory[]): Memory[]`
  - `formatMemoriesBlock(matches: Memory[]): string` — `''` when empty
  - `buildMemoriesBlock(prompt: string, workingDir: string): Promise<string>` — `''` when memory unconfigured / no match / any error

- [x] **Step 1: Write the failing tests**

Create `packages/cli/src/harness/memory_recall.test.ts`. CARETAKER_HOME at file scope (db pattern) because `buildMemoriesBlock` touches the store; the pure tests don't care:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../store/db.js';

let testHome: string;

describe('memory recall', () => {
  let recall: typeof import('./memory_recall.js');
  let db: typeof import('../store/db.js');
  let json: typeof import('../store/json.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-recall-test-'));
    process.env.CARETAKER_HOME = testHome;
    recall = await import('./memory_recall.js');
    db = await import('../store/db.js');
    json = await import('../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const mem = (over: Partial<Memory>): Memory => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    projectId: '',
    kind: 'fact',
    importance: 'normal',
    title: 'Uses pnpm',
    body: 'body',
    keywords: ['pnpm'],
    sourceSessionId: 's',
    sourceAgentId: 'a',
    model: 'm',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  });

  describe('matchMemories', () => {
    it('inverted match: keyword contained in the prompt, case-insensitive', () => {
      const m = mem({ keywords: ['pnpm', 'memory sweep'] });
      assert.deepEqual(recall.matchMemories('how does the Memory Sweep work?', [m]), [m]);
      assert.deepEqual(recall.matchMemories('unrelated prompt', [m]), []);
    });

    it('ignores keywords shorter than MIN_KEYWORD_LENGTH', () => {
      const m = mem({ keywords: ['ab'] });
      assert.deepEqual(recall.matchMemories('ab initio', [m]), []);
    });

    it('scores by matched count × importance × recall strength', () => {
      const weak = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['docker'], importance: 'low' });
      const strong = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['docker'], importance: 'high' });
      const recalled = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000c', keywords: ['docker'], importance: 'low', recallCount: 7 });
      const out = recall.matchMemories('docker question', [weak, strong, recalled]);
      // high (2) > low×(1+log2(8))=0.5×4=2 → tie broken by lastRecalledAt/createdAt; both beat plain low (0.5)
      assert.equal(out[out.length - 1]!.id, weak.id);
      assert.equal(out.length, 3);
    });

    it('recallCount raises rank at equal importance', () => {
      const a = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000a', keywords: ['docker'] });
      const b = mem({ id: 'a1b2c3d4-0000-0000-0000-00000000000b', keywords: ['docker'], recallCount: 3 });
      const out = recall.matchMemories('docker', [a, b]);
      assert.equal(out[0]!.id, b.id);
    });

    it('caps at RECALL_TOP_K', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        mem({ id: `a1b2c3d4-0000-0000-0000-00000000010${i}`, keywords: ['docker'] })
      );
      assert.equal(recall.matchMemories('docker', many).length, recall.RECALL_TOP_K);
    });
  });

  describe('formatMemoriesBlock', () => {
    it('empty matches → empty string', () => {
      assert.equal(recall.formatMemoriesBlock([]), '');
    });

    it('one line per memory with id, title, kind, importance', () => {
      const block = recall.formatMemoriesBlock([mem({ importance: 'high' })]);
      assert.ok(block.startsWith('<memories>'));
      assert.ok(block.endsWith('</memories>'));
      assert.ok(block.includes('- a1b2c3d4-0000-0000-0000-000000000001 — Uses pnpm (fact, high)'));
      assert.ok(block.includes('memory_read'));
      assert.ok(!block.includes('body')); // titles only, never bodies
    });
  });

  describe('buildMemoriesBlock', () => {
    it("'' when memory is not configured", async () => {
      await db.saveMemory(mem({}));
      assert.equal(await recall.buildMemoriesBlock('pnpm question', '/nowhere'), '');
    });

    it('matches global + resolved-project memories, excludes other projects', async () => {
      const config = await json.loadConfig();
      await json.saveConfig({
        ...config,
        projects: [
          { id: 'proj-a', name: 'A', workingDir: '/tmp/proj-a' },
          { id: 'proj-b', name: 'B', workingDir: '/tmp/proj-b' },
        ],
        memory: { agentId: 'mem-agent' },
      } as any);
      await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000002', projectId: 'proj-a', title: 'A-fact', keywords: ['pnpm'] }));
      await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000003', projectId: 'proj-b', title: 'B-fact', keywords: ['pnpm'] }));
      const block = await recall.buildMemoriesBlock('pnpm question', '/tmp/proj-a/src');
      assert.ok(block.includes('Uses pnpm')); // global
      assert.ok(block.includes('A-fact'));    // resolved project
      assert.ok(!block.includes('B-fact'));   // other project excluded
    });

    it("'' when nothing matches", async () => {
      assert.equal(await recall.buildMemoriesBlock('completely unrelated', '/tmp/proj-a'), '');
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/memory_recall.test.ts`
Expected: FAIL — cannot find module `./memory_recall.js`.

- [x] **Step 3: Implement**

Create `packages/cli/src/harness/memory_recall.ts`:

```ts
// Read path of the memory subsystem (step 3): host-side lexical recall.
// No model in the loop by design — matching is programmatic, synchronous,
// free; the memory agent's read-side role (digestion) is a future step.
// Pure matcher/formatter first; buildMemoriesBlock at the bottom is the one
// I/O wrapper both runners (native loop, claude-code) call per turn.
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md
import type { Memory } from '../store/db.js';
import { listMemories } from '../store/db.js';
import { loadConfig } from '../store/json.js';
import { resolveProjectIdForDir } from '../lib/project_resolve.js';

export const RECALL_TOP_K = 5;
export const MIN_KEYWORD_LENGTH = 3;
const IMPORTANCE_WEIGHT: Record<Memory['importance'], number> = {
  low: 0.5,
  normal: 1,
  high: 2,
};

/** Inverted lexical match — no query tokenization: a stored keyword matches
 *  when the lowercased prompt contains it (multi-word keywords work free).
 *  score = matched × importanceWeight × (1 + log2(1 + recallCount)):
 *  acquired strength weighs in — much-recalled memories surface more easily.
 *  Ties: lastRecalledAt desc, then createdAt desc. Top-K, score > 0 only. */
export function matchMemories(prompt: string, memories: Memory[]): Memory[] {
  const text = prompt.toLowerCase();
  const scored: Array<{ m: Memory; score: number }> = [];
  for (const m of memories) {
    let matched = 0;
    for (const k of m.keywords) {
      const kw = k.trim().toLowerCase();
      if (kw.length >= MIN_KEYWORD_LENGTH && text.includes(kw)) matched++;
    }
    if (matched === 0) continue;
    const score =
      matched * IMPORTANCE_WEIGHT[m.importance] * (1 + Math.log2(1 + (m.recallCount ?? 0)));
    scored.push({ m, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.m.lastRecalledAt ?? '').localeCompare(a.m.lastRecalledAt ?? '') ||
      b.m.createdAt.localeCompare(a.m.createdAt)
  );
  return scored.slice(0, RECALL_TOP_K).map((s) => s.m);
}

/** The prelude block. Titles only, never bodies: the explicit memory_read
 *  IS the recall event that feeds acquired strength — a system that always
 *  injects bodies never learns what mattered. '' when no matches. */
export function formatMemoriesBlock(matches: Memory[]): string {
  if (matches.length === 0) return '';
  return [
    '<memories>',
    'Stored memories that may be relevant to the current message:',
    ...matches.map((m) => `- ${m.id} — ${m.title} (${m.kind}, ${m.importance})`),
    'To read their full content, call the memory_read tool with the ids (when available).',
    '</memories>',
  ].join('\n');
}

/** One-stop per-turn recall: gate on MemoryConfig (present = read path on,
 *  same gate as the sweep), resolve the project from the run's workingDir,
 *  match global + project memories, format. Never throws — recall must
 *  never break a chat turn. */
export async function buildMemoriesBlock(prompt: string, workingDir: string): Promise<string> {
  try {
    const config = await loadConfig();
    if (!config.memory) return '';
    const projectId = resolveProjectIdForDir(workingDir, config.projects ?? []);
    const candidates = (await listMemories()).filter(
      (m) => m.projectId === '' || m.projectId === projectId
    );
    return formatMemoriesBlock(matchMemories(prompt, candidates));
  } catch {
    return '';
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/memory_recall.test.ts`
Expected: PASS.

- [x] **Step 5: Commit** (tweak + stage the changeset for the hook)

```bash
git add packages/cli/src/harness/memory_recall.ts packages/cli/src/harness/memory_recall.test.ts .changeset/memory-daemon-step3.md
git commit -m "feat(memory): lexical recall matcher and <memories> prelude block builder"
```

---

### Task 4: `mcp__memory__memory_read` tool + namespace registration

**Files:**
- Create: `packages/cli/src/harness/tools/builtin/memory_tools.ts`
- Create: `packages/cli/src/harness/tools/builtin/memory_tools.test.ts`
- Modify: `packages/cli/src/harness/tools/builtin/index.ts` (import + register)
- Modify: `packages/cli/src/mcp/builtin_server.ts:22-24` (`MEMORY_PREFIX`, `SERVED_PREFIXES`) and its header comment ("Two namespaces today" → three)

**Interfaces:**
- Consumes: `listMemories`, `bumpMemoryRecall` from Task 1; `Tool`/`ToolResult` from `harness/tools/types.js`.
- Produces: `memoryReadTool: Tool` named `mcp__memory__memory_read`; args `{ ids: string[] }`; result JSON `{ memories: [{id,title,body,kind,importance,projectId,createdAt}], missing: string[] }`. Exported `MEMORY_PREFIX = 'mcp__memory__'` from `builtin_server.ts`.

- [x] **Step 1: Write the failing tests**

Create `packages/cli/src/harness/tools/builtin/memory_tools.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types.js';

let testHome: string;

const ctx = (): ToolContext => ({
  workingDir: process.cwd(),
  signal: new AbortController().signal,
  readPaths: new Set(),
});

describe('memory_read tool', () => {
  let tools: typeof import('./memory_tools.js');
  let db: typeof import('../../../store/db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memtool-test-'));
    process.env.CARETAKER_HOME = testHome;
    tools = await import('./memory_tools.js');
    db = await import('../../../store/db.js');
    await db.saveMemory({
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
      projectId: '',
      kind: 'fact',
      importance: 'normal',
      title: 'Uses pnpm',
      body: 'The repo uses pnpm.',
      keywords: ['pnpm'],
      sourceSessionId: 's',
      sourceAgentId: 'a',
      model: 'm',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  it('returns bodies and reports unknown ids as missing', async () => {
    const res = await tools.memoryReadTool.execute(
      { ids: ['a1b2c3d4-0000-0000-0000-000000000001', 'a1b2c3d4-0000-0000-0000-00000000dead'] },
      ctx()
    );
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.memories[0].body, 'The repo uses pnpm.');
    assert.deepEqual(parsed.missing, ['a1b2c3d4-0000-0000-0000-00000000dead']);
  });

  it('each delivery bumps recall accounting', async () => {
    const m = (await db.listMemories())[0]!;
    assert.equal(m.recallCount, 1); // bumped by the previous test
    assert.ok(m.lastRecalledAt);
  });

  it('rejects an empty ids array', async () => {
    await assert.rejects(() => tools.memoryReadTool.execute({ ids: [] }, ctx()));
  });

  it('is registered and served over the builtin MCP prefix filter', async () => {
    const { tools: registry } = await import('../instance.js');
    const { builtinMcpTools, MEMORY_PREFIX } = await import('../../../mcp/builtin_server.js');
    assert.ok(registry.list().some((t) => t.name === 'mcp__memory__memory_read'));
    assert.ok(builtinMcpTools().some((t) => t.name === MEMORY_PREFIX + 'memory_read'));
  });
});
```

Note: check `harness/tools/instance.ts` — if `registerBuiltins` is not invoked at import of `instance.js`, look at how existing tests assert registration and mirror that; if none do, drop only the first assertion of the last test and keep the `builtinMcpTools()` one (it uses the same registry instance the MCP producers use).

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/memory_tools.test.ts`
Expected: FAIL — cannot find module `./memory_tools.js`.

- [x] **Step 3: Implement**

Create `packages/cli/src/harness/tools/builtin/memory_tools.ts`:

```ts
// Agent-facing memory tools. Named `mcp__memory__*` so the shared builtin MCP
// server (mcp/builtin_server.ts) picks them up by prefix and serves them over
// both the stdio subcommand and the per-task HTTP bridge, exactly like the
// `mcp__task__*` set. Native agents opt in via allowedTools (the
// `mcp__<ns>__*` wildcard is generic in resolveAgentTools and the pickers).
//
// memory_read is THE recall event of the memory subsystem: every delivered id
// bumps the memory's acquired strength (recallCount / lastRecalledAt) — the
// signal the future consolidation/decay feeds on. That is why the prelude
// injects titles only: a system that always injects bodies never learns what
// mattered. Read-only w.r.t. content — no planner deny needed.
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md

import type { Tool, ToolResult } from '../types.js';
import { listMemories, bumpMemoryRecall } from '../../../store/db.js';

export const memoryReadTool: Tool = {
  name: 'mcp__memory__memory_read',
  description:
    'Read the full content of stored memories by id. Ids come from the <memories> block in the system prompt. Reading a memory reinforces it (recall statistics are updated), so read the ones actually relevant, not all of them.',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory ids to read.',
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  execute: async (args, _ctx): Promise<ToolResult> => {
    const ids = Array.isArray(args.ids)
      ? (args.ids as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.trim() !== ''
        )
      : [];
    if (ids.length === 0) throw new Error('memory_read requires a non-empty `ids` array');
    const byId = new Map((await listMemories()).map((m) => [m.id, m]));
    const memories: object[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m) {
        missing.push(id);
        continue;
      }
      await bumpMemoryRecall(id);
      memories.push({
        id: m.id,
        title: m.title,
        body: m.body,
        kind: m.kind,
        importance: m.importance,
        projectId: m.projectId,
        createdAt: m.createdAt,
      });
    }
    return { content: JSON.stringify({ memories, missing }) };
  },
};
```

In `packages/cli/src/harness/tools/builtin/index.ts`: add `import { memoryReadTool } from './memory_tools.js';` next to the email import, and in `registerBuiltins` after the email registrations:

```ts
  // Memory subsystem read path (recall accounting lives in the tool).
  registry.register(memoryReadTool);
```

(Find the email registrations at the end of `registerBuiltins` — search `emailSendTool`.)

In `packages/cli/src/mcp/builtin_server.ts`:

```ts
export const TASK_PREFIX = 'mcp__task__';
export const EMAIL_PREFIX = 'mcp__email__';
export const MEMORY_PREFIX = 'mcp__memory__';
const SERVED_PREFIXES = [TASK_PREFIX, EMAIL_PREFIX, MEMORY_PREFIX];
```

and update the header comment: "Two namespaces today — `task` (…) and `email` (…)" → "Three namespaces today — `task` (drive the autonomous task state machine), `email` (send mail through a configured account), and `memory` (read stored memories, bumping recall accounting)".

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/memory_tools.test.ts`
Expected: PASS.

- [x] **Step 5: Commit** (tweak + stage the changeset for the hook)

```bash
git add packages/cli/src/harness/tools/builtin/memory_tools.ts packages/cli/src/harness/tools/builtin/memory_tools.test.ts packages/cli/src/harness/tools/builtin/index.ts packages/cli/src/mcp/builtin_server.ts .changeset/memory-daemon-step3.md
git commit -m "feat(memory): mcp__memory__memory_read builtin, served over both MCP surfaces"
```

---

### Task 5: Prelude injection in both runners + `skipMemoryRecall` opt-out for the sweep

**Files:**
- Modify: `packages/cli/src/harness/loop.ts` (RunOptions ~line 99, injection after the runtime block ~line 169)
- Modify: `packages/cli/src/harness/claude_code_runner.ts` (~line 353, the `appendSystemPrompt` array)
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts` (~line 143, the `run({...})` call in `makeSummarizer`)

**Interfaces:**
- Consumes: `buildMemoriesBlock(prompt, workingDir)` from Task 3.
- Produces: `RunOptions.skipMemoryRecall?: boolean` — set ONLY by the memory sweep.

- [x] **Step 1: Add the flag to RunOptions**

In `packages/cli/src/harness/loop.ts`, after `voiceConversation?: boolean;`:

```ts
  /** Skip the per-turn <memories> recall block. Set by the memory sweep's
   *  own summarize runs: injecting recalled memories into the call that
   *  extracts memories would pollute its carefully-shaped prompt. */
  skipMemoryRecall?: boolean;
```

- [x] **Step 2: Inject in the native loop**

In `packages/cli/src/harness/loop.ts`, add the import `import { buildMemoriesBlock } from './memory_recall.js';` next to the prelude import, and after the runtime-info append (line ~169, `effectiveSystemPrompt = \`${effectiveSystemPrompt}\n\n${runtimeBlock}\`.trim();`) and BEFORE the voice block:

```ts
  // Memory recall (read path): per-turn <memories> block — titles matched
  // host-side against the user prompt, zero model calls. '' when memory is
  // unconfigured or nothing matches.
  if (!opts.skipMemoryRecall) {
    const memoriesBlock = await buildMemoriesBlock(prompt, toolCtx.workingDir);
    if (memoriesBlock) {
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${memoriesBlock}`.trim();
    }
  }
```

- [x] **Step 3: Inject in the claude-code runner**

In `packages/cli/src/harness/claude_code_runner.ts`, add the import `import { buildMemoriesBlock } from './memory_recall.js';`, then extend the `appendSystemPrompt` assembly (~line 353) — the memories block sits between context files and the voice block, mirroring the native order:

```ts
  const memoriesBlock = opts.skipMemoryRecall
    ? ''
    : await buildMemoriesBlock(opts.prompt, workingDir);
  const appendSystemPrompt = [
    sys,
    ctxEntries.length ? formatContextBlock(ctxEntries) : '',
    memoriesBlock,
    opts.voiceConversation ? VOICE_CONVERSATION_PRELUDE : '',
  ]
    .filter(Boolean)
    .join('\n\n');
```

- [x] **Step 4: Opt the sweep out**

In `packages/cli/src/cli/web/scheduler/memory_sweep.ts`, in `makeSummarizer`'s `run({...})` call, add one property after `claudeCode: { permissionMode: 'dontAsk' },`:

```ts
        skipMemoryRecall: true,
```

- [x] **Step 5: Typecheck + full test suite**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: typecheck clean; all tests pass (the sweep tests exercise `makeSummarizer` and would catch a broken run call; `pnpm test` runs via tsx and does NOT typecheck — that is why typecheck runs explicitly).

- [x] **Step 6: Commit** (tweak + stage the changeset for the hook)

```bash
git add packages/cli/src/harness/loop.ts packages/cli/src/harness/claude_code_runner.ts packages/cli/src/cli/web/scheduler/memory_sweep.ts .changeset/memory-daemon-step3.md
git commit -m "feat(memory): per-turn <memories> recall block in both runners, sweep opts out"
```

---

### Task 6: Documentation (CLAUDE.md) + final verification

**Files:**
- Modify: `CLAUDE.md` (layers 2, 3, 5; State-on-disk folder-DB section)
- Modify: `docs/superpowers/plans/2026-08-25-memory-daemon-step3-recall.md` (mark steps done)

- [x] **Step 1: Update CLAUDE.md**

Four surgical edits, current-behaviour phrasing (no history):

1. **Layer 2** — where the builtin namespaces are enumerated ("Two namespaces are served today: `mcp__task__` and `mcp__email__`"): make it three, adding `mcp__memory__` (`memory_read` — read stored memories by id, bumping recall accounting; read-only, no planner deny).
2. **Layer 3 (prelude order)** — the numbered list in "System prompt is assembled, not stored": note the per-turn `<memories>` block (top-K titles from the host-side lexical match on the user message, after the `<runtime-info>` block; claude-code: joins `--append-system-prompt`). Gate: `MemoryConfig` present; skipped for the sweep's own runs.
3. **Layer 5 memory-sweep bullet** — extend with one or two sentences: step 3 read path (spec link `docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md`); recall works on every surface (folder DB, no scheduler needed), unlike the sweep.
4. **State on disk, Memories collection** — add the recall-accounting fields: `recallCount`/`lastRecalledAt` bumped only by `memory_read` (acquired strength for future consolidation).

- [x] **Step 2: Final verification**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test && pnpm -F @hyperwindmill/caretaker-cli lint`
Expected: all clean/pass (lint has no CI gate — fix only new-file complaints).

- [x] **Step 3: Commit** (tweak + stage the changeset for the hook)

```bash
git add CLAUDE.md docs/superpowers/plans/2026-08-25-memory-daemon-step3-recall.md .changeset/memory-daemon-step3.md
git commit -m "docs: memory step 3 read path in CLAUDE.md (namespaces, prelude order, recall fields)"
```
