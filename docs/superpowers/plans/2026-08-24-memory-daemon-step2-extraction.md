# Memory Daemon Step 2 (memory extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The memory sweep's per-chunk model call also extracts durable memories (project/global scope, kind+importance) and persists them in a new `memories` folder-DB collection — write path only.

**Architecture:** The existing per-chunk summarize call in `memory_sweep.ts` changes shape to a combined JSON call `{summary, memories[]}` — same call count, cursor mechanics, and budgets. A new pure sibling module `memory_extract.ts` owns prompt assembly, defensive JSON parsing, entry validation, dedup-block formatting, and host-side project resolution. `store/db.ts` gains the durable `Memory` record + accessors.

**Tech Stack:** TypeScript ESM, Node test runner via tsx, `@morphql/store` folder DB. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-memory-daemon-step2-extraction-design.md` — read it before starting; the plan argues from it.

## Global Constraints

- Work directly on branch `idea/memory-daemon` — **no git worktrees** (user rule).
- **Never rewrite a commit** — no `--amend`, no rebase; fixes are new commits (user rule).
- The husky pre-commit hook requires a `.changeset/*.md` file **staged in every commit** on this branch. The established pattern (see step-1 commits): create `.changeset/memory-daemon-step2.md` in Task 1 and re-stage it (with a small wording touch if unchanged content would not stage) in every subsequent commit.
- Tests: co-located `*.test.ts`, Node runner via tsx. `process.env.CARETAKER_HOME` is mutated at **FILE scope** (before/after at the top-level describe of the file), never per-describe (user rule: two describes with local env setup have clobbered a real store before).
- `pnpm test` does not type-check (tsx). Always run `pnpm -F @hyperwindmill/caretaker-cli typecheck` as a gate too.
- All code/comments in English.
- Commands run from the repo root.

---

### Task 1: `Memory` record + accessors in the folder DB

**Files:**
- Modify: `packages/cli/src/store/db.ts` (append after the SessionDigest block, ~line 289)
- Create: `packages/cli/src/store/db_memory.test.ts`
- Create: `.changeset/memory-daemon-step2.md`

**Interfaces:**
- Consumes: existing `runQuery`, `safeId` in `db.ts`.
- Produces (used by Tasks 2–3):
  - `interface Memory { id; projectId; kind; importance; title; body; keywords; sourceSessionId; sourceAgentId; model; createdAt }` (exact shape below)
  - `saveMemory(m: Memory): Promise<void>` — insert-only (append-only store), throws on non-safeId id
  - `listMemories(): Promise<Memory[]>` — all records, `[]` on error
  - `deleteMemory(id: string): Promise<void>`

- [ ] **Step 1: Create the changeset file** (satisfies the pre-commit hook for this and every later commit)

`.changeset/memory-daemon-step2.md`:

```markdown
---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 2: the memory sweep's per-chunk call now also extracts durable memories (project/global scope, fact/episode kind, tone-derived importance) into a new `memories` folder-DB collection. Write path only; same model-call count as before.
```

- [ ] **Step 2: Write the failing test**

`packages/cli/src/store/db_memory.test.ts` (pattern copied from `db_digest.test.ts` — file-scope env):

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('memory store', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memory-test-'));
    process.env.CARETAKER_HOME = testHome;
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const mem = (over: Partial<import('./db.js').Memory> = {}): import('./db.js').Memory => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    projectId: '',
    kind: 'fact',
    importance: 'normal',
    title: 'Uses pnpm',
    body: "The repo uses **pnpm** ≥10 — with 'quotes' and\nnewlines that must survive.",
    keywords: ['pnpm', 'package-manager'],
    sourceSessionId: 'f0e1d2c3-0000-0000-0000-000000000009',
    sourceAgentId: 'ag-1',
    model: 'gpt-test',
    createdAt: '2026-08-24T10:00:00.000Z',
    ...over,
  });

  it('save + list round-trips verbatim', async () => {
    await db.saveMemory(mem());
    const all = await db.listMemories();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], mem());
  });

  it('is append-only: a second save with a new id adds a record', async () => {
    await db.saveMemory(mem({ id: 'a1b2c3d4-0000-0000-0000-000000000002', projectId: 'proj-x' }));
    const all = await db.listMemories();
    assert.equal(all.length, 2);
    assert.ok(all.some((m) => m.projectId === 'proj-x'));
  });

  it('rejects a non-safeId id', async () => {
    await assert.rejects(() => db.saveMemory(mem({ id: "bad'id" })));
  });

  it('delete removes one record and is idempotent', async () => {
    await db.deleteMemory('a1b2c3d4-0000-0000-0000-000000000002');
    await db.deleteMemory('a1b2c3d4-0000-0000-0000-000000000002');
    const all = await db.listMemories();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, 'a1b2c3d4-0000-0000-0000-000000000001');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_memory.test.ts`
Expected: FAIL — `db.saveMemory is not a function`.

- [ ] **Step 4: Implement the record + accessors**

Append to `packages/cli/src/store/db.ts` (after `deleteSessionDigest`):

```ts
/** One durable memory extracted by the sweep's combined call. Unlike the
 *  digests this is NOT a regenerable cache — it is the first durable store
 *  of the memory subsystem. Append-only at write time; merge/supersede/decay
 *  are the future consolidation's job.
 *  See docs/superpowers/specs/2026-08-24-memory-daemon-step2-extraction-design.md */
export interface Memory {
  /** crypto.randomUUID() — passes safeId. */
  id: string;
  /** '' = global (user/machine level). Resolved host-side, never by the model. */
  projectId: string;
  /** Semantic/episodic split: timeless knowledge vs a dated event. */
  kind: 'fact' | 'episode';
  /** Initial strength, derived from the tone of the conversation at write
   *  time (the tone is unrecoverable later). Ordinal on purpose — models
   *  calibrate numeric scales poorly. */
  importance: 'low' | 'normal' | 'high';
  title: string;
  /** Markdown, self-contained. */
  body: string;
  /** Associative base for the future read path, emitted at write time. */
  keywords: string[];
  // ─── provenance — host-side facts, never model output ─────────────────
  sourceSessionId: string;
  /** The session's agent directory — NOT a scope; mined by a future
   *  personality step. */
  sourceAgentId: string;
  /** Extraction model. */
  model: string;
  createdAt: string;
}

export async function saveMemory(m: Memory): Promise<void> {
  if (!safeId(m.id)) throw new Error(`Invalid memory id: ${m.id}`);
  // Insert-only: memories are append-only; there is deliberately no upsert.
  await runQuery(`INSERT INTO memories ${JSON.stringify(m)}`);
}

export async function listMemories(): Promise<Memory[]> {
  try {
    return (await runQuery('SELECT * FROM memories')) as Memory[];
  } catch {
    return [];
  }
}

export async function deleteMemory(id: string): Promise<void> {
  if (!safeId(id)) return;
  await runQuery(`DELETE FROM memories WHERE id = '${id}'`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_memory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/store/db.ts packages/cli/src/store/db_memory.test.ts .changeset/memory-daemon-step2.md
git commit -m "feat(store): memories collection (durable extracted memories)"
```

---

### Task 2: `memory_extract.ts` — pure extraction helpers

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/memory_extract.ts`
- Create: `packages/cli/src/cli/web/scheduler/memory_extract.test.ts`

**Interfaces:**
- Consumes: `Memory` type from Task 1 (`../../../store/db.js`, type-only); `AgentConfig`, `ProjectConfig` from `../../../types.js`.
- Produces (used by Task 3):
  - `interface ExtractedMemory { level: 'project' | 'global'; kind: 'fact' | 'episode'; importance: 'low' | 'normal' | 'high'; title: string; body: string; keywords: string[] }`
  - `interface CombinedResult { summary: string; memories: ExtractedMemory[] }`
  - `interface SummarizeContext { prevSummary: string; chunkText: string; dedupBlock: string; hasProject: boolean }`
  - `buildCombinedPrompt(ctx: SummarizeContext): string`
  - `parseCombinedResponse(text: string): { summary: string; memories: unknown } | null`
  - `validateMemories(raw: unknown, hasProject: boolean): ExtractedMemory[]`
  - `formatDedupBlock(entries: Array<{ title: string; keywords: string[] }>): string` (caller passes them newest-first)
  - `resolveProjectId(sessionAgentId: string, agents: AgentConfig[], projects: ProjectConfig[]): string`
  - Constants: `MAX_DEDUP_CHARS = 4000`, `MAX_MEMORIES_PER_CALL = 5`, `MAX_MEMORY_TITLE_CHARS = 200`, `MAX_MEMORY_BODY_CHARS = 2000`, `MAX_MEMORY_KEYWORDS = 10`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/cli/web/scheduler/memory_extract.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig, ProjectConfig } from '../../../types.js';
import * as ex from './memory_extract.js';

// Pure functions only — no CARETAKER_HOME needed in this file.

describe('buildCombinedPrompt', () => {
  const ctx = (over: Partial<ex.SummarizeContext> = {}): ex.SummarizeContext => ({
    prevSummary: 'old facts',
    chunkText: 'user: hi',
    dedupBlock: '- Uses pnpm [pnpm]',
    hasProject: true,
    ...over,
  });

  it('embeds summary, chunk, and dedup block; marks missing ones', () => {
    const p = ex.buildCombinedPrompt(ctx());
    assert.ok(p.includes('old facts'));
    assert.ok(p.includes('user: hi'));
    assert.ok(p.includes('- Uses pnpm [pnpm]'));
    const empty = ex.buildCombinedPrompt(ctx({ prevSummary: '', dedupBlock: '' }));
    assert.ok(empty.includes('(none)'));
  });

  it('offers the project level only when a project is in scope', () => {
    assert.ok(ex.buildCombinedPrompt(ctx()).includes('"project"'));
    const globalOnly = ex.buildCombinedPrompt(ctx({ hasProject: false }));
    assert.ok(!globalOnly.includes('"level": "project"'));
    assert.ok(globalOnly.includes('always "global"'));
  });
});

describe('parseCombinedResponse', () => {
  it('parses a bare JSON object', () => {
    const r = ex.parseCombinedResponse('{"summary":" s ","memories":[]}');
    assert.ok(r);
    assert.equal(r.summary, 's');
    assert.deepEqual(r.memories, []);
  });

  it('parses JSON wrapped in a code fence or prose', () => {
    const r = ex.parseCombinedResponse('Here you go:\n```json\n{"summary":"s","memories":[]}\n```\n');
    assert.ok(r);
    assert.equal(r.summary, 's');
  });

  it('returns null on garbage, on missing/empty summary, and on non-JSON', () => {
    assert.equal(ex.parseCombinedResponse('plain text summary'), null);
    assert.equal(ex.parseCombinedResponse('{"memories":[]}'), null);
    assert.equal(ex.parseCombinedResponse('{"summary":"  ","memories":[]}'), null);
    assert.equal(ex.parseCombinedResponse('{broken'), null);
  });
});

describe('validateMemories', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    level: 'project',
    kind: 'fact',
    importance: 'high',
    title: 'T',
    body: 'B',
    keywords: ['k1', 'k2'],
    ...over,
  });

  it('accepts a valid entry as-is', () => {
    const out = ex.validateMemories([entry()], true);
    assert.deepEqual(out, [entry()]);
  });

  it('drops entries missing title or body; non-arrays yield []', () => {
    assert.deepEqual(ex.validateMemories([entry({ title: ' ' }), entry({ body: undefined })], true), []);
    assert.deepEqual(ex.validateMemories('nope', true), []);
    assert.deepEqual(ex.validateMemories(undefined, true), []);
  });

  it('coerces invalid kind/importance to fact/normal', () => {
    const out = ex.validateMemories([entry({ kind: 'weird', importance: 7 })], true);
    assert.equal(out[0]!.kind, 'fact');
    assert.equal(out[0]!.importance, 'normal');
  });

  it('degrades level project → global when no project is in scope', () => {
    const out = ex.validateMemories([entry()], false);
    assert.equal(out[0]!.level, 'global');
  });

  it('caps count, title, body, and keywords', () => {
    const many = Array.from({ length: 10 }, (_, i) => entry({ title: `T${i}` }));
    assert.equal(ex.validateMemories(many, true).length, ex.MAX_MEMORIES_PER_CALL);
    const big = ex.validateMemories(
      [entry({ title: 'x'.repeat(1000), body: 'y'.repeat(50_000), keywords: Array(50).fill('k') })],
      true
    );
    assert.equal(big[0]!.title.length, ex.MAX_MEMORY_TITLE_CHARS);
    assert.equal(big[0]!.body.length, ex.MAX_MEMORY_BODY_CHARS);
    assert.equal(big[0]!.keywords.length, ex.MAX_MEMORY_KEYWORDS);
  });

  it('drops non-string keywords instead of failing the entry', () => {
    const out = ex.validateMemories([entry({ keywords: ['ok', 42, ' ', 'fine'] })], true);
    assert.deepEqual(out[0]!.keywords, ['ok', 'fine']);
  });
});

describe('formatDedupBlock', () => {
  it('renders one line per entry, keywords bracketed', () => {
    const block = ex.formatDedupBlock([
      { title: 'Uses pnpm', keywords: ['pnpm'] },
      { title: 'No amend', keywords: [] },
    ]);
    assert.equal(block, '- Uses pnpm [pnpm]\n- No amend');
  });

  it('stops before exceeding the char cap, keeping the newest (first) entries', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      title: `memory number ${i} ` + 'x'.repeat(50),
      keywords: ['k'],
    }));
    const block = ex.formatDedupBlock(entries);
    assert.ok(block.length <= ex.MAX_DEDUP_CHARS);
    assert.ok(block.startsWith('- memory number 0'));
  });

  it('returns "" for no entries', () => {
    assert.equal(ex.formatDedupBlock([]), '');
  });
});

describe('resolveProjectId', () => {
  const agent = (id: string, workingDir?: string): AgentConfig => ({
    id,
    name: id,
    systemPrompt: '',
    provider: 'p',
    model: 'm',
    allowedTools: [],
    maxTurns: 5,
    ...(workingDir !== undefined ? { workingDir } : {}),
  });
  const project = (id: string, workingDir: string): ProjectConfig => ({
    id,
    name: id,
    description: '',
    workingDir,
    agentId: '',
    active: true,
  });

  const agents = [
    agent('ag-in', '/home/u/dev/proj-a/sub'),
    agent('ag-exact', '/home/u/dev/proj-a'),
    agent('ag-out', '/home/u/elsewhere'),
    agent('ag-nodir'),
    agent('ag-rel', 'relative/dir'),
  ];
  const projects = [project('proj-a', '/home/u/dev/proj-a'), project('proj-nested', '/home/u/dev/proj-a/sub')];

  it('matches exact dir and subdirectory (prefix, path-aware)', () => {
    assert.equal(ex.resolveProjectId('ag-exact', agents, projects), 'proj-a');
    // nested project wins over its parent (longest match)
    assert.equal(ex.resolveProjectId('ag-in', agents, projects), 'proj-nested');
  });

  it('does not match a sibling dir sharing a name prefix', () => {
    const p = [project('proj-a', '/home/u/dev/proj')];
    assert.equal(ex.resolveProjectId('ag-exact', agents, p), '');
  });

  it("returns '' for unknown agent, no workingDir, relative workingDir, or no match", () => {
    assert.equal(ex.resolveProjectId('nope', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-nodir', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-rel', agents, projects), '');
    assert.equal(ex.resolveProjectId('ag-out', agents, projects), '');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_extract.test.ts`
Expected: FAIL — cannot find module `./memory_extract.js`.

- [ ] **Step 3: Implement the module**

`packages/cli/src/cli/web/scheduler/memory_extract.ts`:

```ts
// Pure helpers for the sweep's combined summarize+extract call: prompt
// assembly, defensive JSON parsing, entry validation, dedup-block formatting,
// and host-side project resolution. No harness or store imports (types only)
// so everything here is unit-testable without CARETAKER_HOME.
// See docs/superpowers/specs/2026-08-24-memory-daemon-step2-extraction-design.md
import { isAbsolute, resolve, sep } from 'node:path';
import type { AgentConfig, ProjectConfig } from '../../../types.js';

export const MAX_DEDUP_CHARS = 4000;
export const MAX_MEMORIES_PER_CALL = 5;
export const MAX_MEMORY_TITLE_CHARS = 200;
export const MAX_MEMORY_BODY_CHARS = 2000;
export const MAX_MEMORY_KEYWORDS = 10;

/** One validated memory candidate out of the model. `level` is the model's
 *  only scope verb — the host maps it to a concrete projectId. */
export interface ExtractedMemory {
  level: 'project' | 'global';
  kind: 'fact' | 'episode';
  importance: 'low' | 'normal' | 'high';
  title: string;
  body: string;
  keywords: string[];
}

export interface CombinedResult {
  summary: string;
  memories: ExtractedMemory[];
}

/** Everything the combined call needs; assembled by the sweep per chunk. */
export interface SummarizeContext {
  prevSummary: string;
  chunkText: string;
  /** Preformatted "existing memories" lines (formatDedupBlock), '' when none. */
  dedupBlock: string;
  /** Whether a project is resolved for this session — gates the level choice. */
  hasProject: boolean;
}

const LEVEL_PROJECT =
  '"level": "project" for facts about this specific project, "global" for facts about the user or their machine/environment that hold everywhere.';
const LEVEL_GLOBAL_ONLY = '"level": always "global" (no project is in scope).';

export function buildCombinedPrompt(ctx: SummarizeContext): string {
  return [
    'You maintain a rolling summary of a conversation between a user and an AI agent, and you extract durable memories from it.',
    '',
    'Reply with ONLY a JSON object, no code fences, in this exact shape:',
    '{"summary": "<updated rolling summary>", "memories": [{"level": "...", "kind": "...", "importance": "...", "title": "...", "body": "...", "keywords": ["..."]}]}',
    '',
    'SUMMARY: integrate the NEW MESSAGES into the PREVIOUS SUMMARY and rewrite it as one standalone plain-text summary, at most 300 words. Keep durable facts, decisions, preferences, constraints, and open threads; drop pleasantries and dead ends.',
    '',
    `MEMORIES: at most ${MAX_MEMORIES_PER_CALL} facts worth remembering beyond this conversation, using the summary as context. Only NEW information — never re-emit anything under EXISTING MEMORIES. Most chunks contain nothing durable: an empty array is the normal answer. Fields:`,
    `- ${ctx.hasProject ? LEVEL_PROJECT : LEVEL_GLOBAL_ONLY}`,
    '- "kind": "fact" (timeless knowledge: conventions, preferences, constraints, decisions) or "episode" (a dated event: something that happened).',
    '- "importance": judge it from the TONE of the conversation. "high" only when the user marked it explicitly ("remember this", "never again"), was emphatic or frustrated, or corrected a mistake; "normal" for ordinary facts and decisions; "low" for incidental context.',
    `- "title": short and searchable. "body": the fact itself, self-contained markdown. "keywords": up to ${MAX_MEMORY_KEYWORDS} lowercase search words.`,
    '',
    'EXISTING MEMORIES (do not re-emit):',
    ctx.dedupBlock || '(none)',
    '',
    'PREVIOUS SUMMARY:',
    ctx.prevSummary.trim() || '(none)',
    '',
    'NEW MESSAGES:',
    ctx.chunkText,
  ].join('\n');
}

/** Outermost-braces JSON extraction (also strips fences/prose for free).
 *  null = failed chunk: the caller leaves the cursor, next sweep retries.
 *  Deliberately NO raw-text-as-summary fallback — it would poison the digest. */
export function parseCombinedResponse(text: string): { summary: string; memories: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj?.summary !== 'string' || !obj.summary.trim()) return null;
  return { summary: obj.summary.trim(), memories: obj.memories };
}

/** Host-side gate on model output: drop entries without title/body, coerce
 *  invalid enums to fact/normal, degrade project→global when no project is
 *  in scope, cap count and field sizes. Extraction is best-effort — a bad
 *  entry is dropped, never a failed chunk. */
export function validateMemories(raw: unknown, hasProject: boolean): ExtractedMemory[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedMemory[] = [];
  for (const e of raw as any[]) {
    if (out.length >= MAX_MEMORIES_PER_CALL) break;
    if (typeof e?.title !== 'string' || !e.title.trim()) continue;
    if (typeof e?.body !== 'string' || !e.body.trim()) continue;
    const keywords = Array.isArray(e.keywords)
      ? e.keywords
          .filter((k: unknown): k is string => typeof k === 'string' && k.trim() !== '')
          .map((k: string) => k.trim())
          .slice(0, MAX_MEMORY_KEYWORDS)
      : [];
    out.push({
      level: e.level === 'project' && hasProject ? 'project' : 'global',
      kind: e.kind === 'episode' ? 'episode' : 'fact',
      importance: e.importance === 'low' || e.importance === 'high' ? e.importance : 'normal',
      title: e.title.trim().slice(0, MAX_MEMORY_TITLE_CHARS),
      body: e.body.trim().slice(0, MAX_MEMORY_BODY_CHARS),
      keywords,
    });
  }
  return out;
}

/** One line per existing memory (newest first — caller sorts), stopping
 *  before MAX_DEDUP_CHARS. Titles + keywords only, never bodies. */
export function formatDedupBlock(entries: Array<{ title: string; keywords: string[] }>): string {
  const lines: string[] = [];
  let len = 0;
  for (const e of entries) {
    const line = e.keywords.length ? `- ${e.title} [${e.keywords.join(', ')}]` : `- ${e.title}`;
    if (len + line.length + 1 > MAX_DEDUP_CHARS) break;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

/** Host-side project resolution (scope ids are never chosen by a model):
 *  the session agent's workingDir prefix-matched, path-aware, against the
 *  configured projects' workingDir. Longest match wins (nested projects).
 *  '' = no project in scope → global-only extraction. */
export function resolveProjectId(
  sessionAgentId: string,
  agents: AgentConfig[],
  projects: ProjectConfig[]
): string {
  const dir = agents.find((a) => a.id === sessionAgentId)?.workingDir;
  if (!dir || !isAbsolute(dir)) return '';
  const agentDir = resolve(dir);
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (!p.workingDir || !isAbsolute(p.workingDir)) continue;
    const projDir = resolve(p.workingDir);
    if (agentDir === projDir || agentDir.startsWith(projDir + sep)) {
      if (!best || projDir.length > best.len) best = { id: p.id, len: projDir.length };
    }
  }
  return best?.id ?? '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_extract.test.ts`
Expected: PASS. Note: the ProjectConfig literal in the test must satisfy the real type — if tsc later complains about missing optional fields, fix the test literal, not the type.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
git add packages/cli/src/cli/web/scheduler/memory_extract.ts packages/cli/src/cli/web/scheduler/memory_extract.test.ts .changeset/memory-daemon-step2.md
git commit -m "feat(memory): extraction helpers — combined prompt, defensive parse, scope resolution"
```

(If git refuses because the changeset is unchanged, make a trivial wording improvement to `.changeset/memory-daemon-step2.md` and stage it — the hook requires it staged in every commit.)

---

### Task 3: rewire the sweep — combined call + memory persistence

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produces; `saveMemory`, `listMemories`, `Memory` from Task 1; existing `run()` from `harness/loop.js`.
- Produces (breaking changes inside the module — the scheduler-facing `runMemorySweepTick(now, summarizeOverride?)` signature is unchanged):
  - `SummarizeFn` becomes `(ctx: SummarizeContext) => Promise<CombinedResult | null>`
  - `ResolvedMemoryConfig` gains `agents: AgentConfig[]; projects: ProjectConfig[]`
  - `SweepResult` gains `memories: number`
  - `buildSummarizePrompt` is DELETED from `memory_sweep.ts` (replaced by `buildCombinedPrompt` in `memory_extract.ts`)

- [ ] **Step 1: Update the existing tests to the new shapes and add the new behaviour tests**

In `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`:

**1a.** Delete the `describe('buildSummarizePrompt', …)` block (the prompt is now tested in `memory_extract.test.ts`).

**1b.** In `describe('makeSummarizer', …)`: the model must now answer JSON. Replace the `resolved()` helper and the openai-path tests:

```ts
    const resolved = (): import('./memory_sweep.js').ResolvedMemoryConfig => ({
      agent: testAgents[0]!,
      provider: { name: 'local', endpoint: 'http://fake', apiKey: 'secret-key' },
      sweepMinutes: 5,
      minNewMessages: 4,
      agents: testAgents,
      projects: [],
    });

    const ctx = (
      over: Partial<import('./memory_extract.js').SummarizeContext> = {}
    ): import('./memory_extract.js').SummarizeContext => ({
      prevSummary: 'prev facts',
      chunkText: 'user: hi',
      dedupBlock: '',
      hasProject: false,
      ...over,
    });

    it('openai path: one turn with the combined prompt, returns summary + memories', async () => {
      let seenBody: any = null;
      loop.__setFetch(async (_url, init) => {
        seenBody = JSON.parse(String((init as RequestInit).body));
        return sse(
          sseText(
            JSON.stringify({
              summary: '  the summary  ',
              memories: [
                { level: 'global', kind: 'fact', importance: 'high', title: 'T', body: 'B', keywords: ['k'] },
              ],
            })
          )
        );
      });
      const out = await sweep.makeSummarizer(resolved())(ctx());
      assert.ok(out);
      assert.equal(out.summary, 'the summary');
      assert.equal(out.memories.length, 1);
      assert.equal(out.memories[0]!.title, 'T');
      assert.equal(seenBody.model, 'gpt-test');
      const lastMsg = seenBody.messages[seenBody.messages.length - 1];
      assert.ok(lastMsg.content.includes('prev facts'));
      assert.ok(lastMsg.content.includes('user: hi'));
      assert.ok(!seenBody.tools?.length, 'summarize runs with no tools');
    });

    it('returns null on HTTP failure, on empty text, and on non-JSON output', async () => {
      loop.__setFetch(async () => new Response('boom', { status: 500 }));
      assert.equal(await sweep.makeSummarizer(resolved())(ctx()), null);
      loop.__setFetch(async () => sse(sseText('')));
      assert.equal(await sweep.makeSummarizer(resolved())(ctx()), null);
      loop.__setFetch(async () => sse(sseText('a plain-text summary, not JSON')));
      assert.equal(await sweep.makeSummarizer(resolved())(ctx()), null);
    });

    it('hard-truncates an over-long summary', async () => {
      loop.__setFetch(async () =>
        sse(sseText(JSON.stringify({ summary: 'y'.repeat(10_000), memories: [] })))
      );
      const out = await sweep.makeSummarizer(resolved())(ctx());
      assert.ok(out !== null && out.summary.length <= sweep.MAX_SUMMARY_CHARS + 1);
    });
```

**1c.** claude-code path: the fixture's model answer is the literal text `"ok"`, which is not JSON — rewrite the fixture lines in-memory, replacing the unescaped `"ok"` payloads with a JSON-string-encoded combined object (the escaped `\"ok\"` occurrences inside thinking text don't match and are untouched):

```ts
    it('claude-code path: spawns a one-shot claude and parses its JSON answer', async () => {
      const { EventEmitter } = await import('node:events');
      const { PassThrough } = await import('node:stream');
      const { readFile } = await import('node:fs/promises');
      const fixturePath = join(process.cwd(), 'src/harness/fixtures/claude_code_stream_text.jsonl');
      const payload = JSON.stringify({ summary: 'cc summary', memories: [] });
      const lines = (await readFile(fixturePath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replaceAll('"ok"', JSON.stringify(payload)));
      const spawnCalls: string[][] = [];
      runner.__setSpawn(((_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => {
          child.emit('close', null);
          return true;
        };
        child.stdin.on('finish', () => {
          setImmediate(() => {
            for (const l of lines) child.stdout.write(l + '\n');
            child.stdout.end();
            child.emit('close', 0);
          });
        });
        return child;
      }) as any);
      const ccResolved: import('./memory_sweep.js').ResolvedMemoryConfig = {
        agent: testAgents[1]!,
        provider: { name: 'cc', type: 'claude-code', endpoint: '' },
        sweepMinutes: 5,
        minNewMessages: 4,
        agents: testAgents,
        projects: [],
      };
      const out = await sweep.makeSummarizer(ccResolved)(ctx());
      assert.ok(out);
      assert.equal(out.summary, 'cc summary');
      assert.equal(spawnCalls.length, 1);
      assert.ok(spawnCalls[0]!.includes('dontAsk'), 'tool calls denied via dontAsk');
    });
```

**1d.** In `describe('sweepMemory', …)`: update the shared helpers —

```ts
    const resolvedCfg = (over: Partial<import('./memory_sweep.js').ResolvedMemoryConfig> = {}) => ({
      agent: testAgents[0]!,
      provider: { name: 'local', endpoint: 'http://unused', apiKey: '' },
      sweepMinutes: 5,
      minNewMessages: 2,
      agents: testAgents,
      projects: [],
      ...over,
    });

    /** Fake summarizer recording contexts; returns {summary:'S<n>', memories}
     *  per call, or null after `failAfter`. */
    const fakeSummarize = (
      failAfter = Infinity,
      memories: import('./memory_extract.js').ExtractedMemory[] = []
    ) => {
      const calls: import('./memory_extract.js').SummarizeContext[] = [];
      const fn: import('./memory_sweep.js').SummarizeFn = async (ctx) => {
        calls.push(ctx);
        if (calls.length > failAfter) return null;
        return { summary: `S${calls.length}`, memories };
      };
      return { calls, fn };
    };
```

Then mechanically adapt every existing assertion that used the old shapes:
- `calls[0]!.prev` → `calls[0]!.prevSummary`; `calls[0]!.chunk` → `calls[0]!.chunkText`.
- The inline fake in `runMemorySweepTick`'s "does nothing when memory is unconfigured" test and the `fn`s in the interval/overlap tests return `{ summary: 'S', memories: [] }` instead of `'S'`.
- Everything else (digest assertions, budget, mtime gate, cleanup, safeId-skip) is unchanged behaviour and must keep passing as-is.

**1e.** Add the new behaviour tests at the end of `describe('sweepMemory', …)`:

```ts
    it('persists extracted memories with host-side provenance and scope', async () => {
      const projDir = join(testHome, 'proj-mem');
      const agents: import('../../../types.js').AgentConfig[] = [
        { ...testAgents[0]!, id: 'ag-proj', workingDir: projDir },
      ];
      const projects: import('../../../types.js').ProjectConfig[] = [
        { id: 'proj-mem', name: 'P', description: '', workingDir: projDir, agentId: '', active: true },
      ];
      const meta = await makeSession('ag-proj', ['we decided X', 'noted']);
      const { calls, fn } = fakeSummarize(Infinity, [
        { level: 'project', kind: 'fact', importance: 'high', title: 'Decided X', body: 'X.', keywords: ['x'] },
        { level: 'global', kind: 'episode', importance: 'low', title: 'It happened', body: 'Y.', keywords: [] },
      ]);
      await sweep.sweepMemory(resolvedCfg({ agents, projects }), fn);
      assert.equal(calls[0]!.hasProject, true);
      const saved = (await db.listMemories()).filter((m) => m.sourceSessionId === meta.id);
      assert.equal(saved.length, 2);
      const proj = saved.find((m) => m.title === 'Decided X')!;
      assert.equal(proj.projectId, 'proj-mem');
      assert.equal(proj.importance, 'high');
      const glob = saved.find((m) => m.title === 'It happened')!;
      assert.equal(glob.projectId, '');
      for (const m of saved) {
        assert.equal(m.sourceAgentId, 'ag-proj');
        assert.equal(m.model, 'gpt-test');
        assert.ok(m.id.length > 0);
      }
    });

    it('no project resolved: hasProject is false and a project-level entry degrades to global', async () => {
      const meta = await makeSession('ag-nomatch', ['a', 'b']);
      const { calls, fn } = fakeSummarize(Infinity, [
        { level: 'project', kind: 'fact', importance: 'normal', title: 'Stray', body: 'Z.', keywords: [] },
      ]);
      await sweep.sweepMemory(resolvedCfg(), fn); // agents have no workingDir, projects: []
      assert.equal(calls[calls.length - 1]!.hasProject, false);
      const saved = (await db.listMemories()).filter((m) => m.sourceSessionId === meta.id);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.projectId, '');
    });

    it('feeds existing memory titles to the call as the dedup block, newest first', async () => {
      await db.saveMemory({
        id: 'a1b2c3d4-0000-0000-0000-0000000000aa',
        projectId: '',
        kind: 'fact',
        importance: 'normal',
        title: 'Pre-existing fact',
        body: 'B',
        keywords: ['pre'],
        sourceSessionId: 'x',
        sourceAgentId: 'x',
        model: 'm',
        createdAt: '2026-08-24T09:00:00.000Z',
      });
      await makeSession('ag-dedup', ['a', 'b']);
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), fn);
      const last = calls[calls.length - 1]!;
      assert.ok(last.dedupBlock.includes('Pre-existing fact [pre]'));
    });

    it('a memory saved for an earlier chunk appears in the next chunk’s dedup block', async () => {
      // Two chunks: a message big enough to force a split.
      const big = 'x'.repeat(15_000);
      await makeSession('ag-twochunk', [big, big]);
      const emitted: import('./memory_extract.js').ExtractedMemory = {
        level: 'global', kind: 'fact', importance: 'normal', title: 'FirstChunkFact', body: 'B', keywords: [],
      };
      const calls: import('./memory_extract.js').SummarizeContext[] = [];
      const fn: import('./memory_sweep.js').SummarizeFn = async (ctx) => {
        calls.push(ctx);
        return { summary: `S${calls.length}`, memories: calls.length === 1 ? [emitted] : [] };
      };
      await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(calls.length >= 2);
      assert.ok(calls[1]!.dedupBlock.includes('FirstChunkFact'));
    });

    it('counts saved memories in the sweep result', async () => {
      await makeSession('ag-count', ['a', 'b']);
      const { fn } = fakeSummarize(Infinity, [
        { level: 'global', kind: 'fact', importance: 'normal', title: 'C', body: 'B', keywords: [] },
      ]);
      const res = await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(res.memories >= 1);
    });
```

- [ ] **Step 2: Run the sweep tests to verify the new ones fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — type/shape errors and failing new tests (the module still has the old `SummarizeFn`).

- [ ] **Step 3: Rewire `memory_sweep.ts`**

**3a.** Imports — add:

```ts
import { randomUUID } from 'node:crypto';
import type { ProjectConfig } from '../../../types.js';
import { listMemories, saveMemory, type Memory } from '../../../store/db.js';
import {
  buildCombinedPrompt,
  formatDedupBlock,
  parseCombinedResponse,
  resolveProjectId,
  validateMemories,
  type CombinedResult,
  type SummarizeContext,
} from './memory_extract.js';
```

**3b.** `ResolvedMemoryConfig` gains the two lists (needed to resolve the *session's* agent — not the memory agent — to a project):

```ts
export interface ResolvedMemoryConfig {
  agent: AgentConfig;
  provider: ProviderConfig;
  sweepMinutes: number;
  minNewMessages: number;
  /** Full lists, for per-session project resolution (the session's agent is
   *  a different agent than the memory agent). */
  agents: AgentConfig[];
  projects: ProjectConfig[];
}
```

and `resolveMemoryConfig` returns `{ agent, provider, sweepMinutes: …, minNewMessages: …, agents, projects: config.projects ?? [] }`.

**3c.** Delete `SUMMARIZE_INSTRUCTION` and `buildSummarizePrompt`. Replace the `SummarizeFn` type and `makeSummarizer`:

```ts
/** null = failure (network, non-OK, empty or non-JSON response). The caller
 *  leaves the cursor where it was; the next sweep retries. Best-effort, the
 *  same contract as titling (harness/title.ts). */
export type SummarizeFn = (ctx: SummarizeContext) => Promise<CombinedResult | null>;
```

In `makeSummarizer`, the body keeps the run() call verbatim except `prompt: buildCombinedPrompt(ctx)`, and the tail becomes:

```ts
      if (result.stop !== 'done') return null;
      const parsed = parseCombinedResponse(result.text);
      if (!parsed) return null;
      const summary =
        parsed.summary.length > MAX_SUMMARY_CHARS
          ? parsed.summary.slice(0, MAX_SUMMARY_CHARS) + '…'
          : parsed.summary;
      return { summary, memories: validateMemories(parsed.memories, ctx.hasProject) };
```

(The signature is now `return async (ctx) => { … }`.)

**3d.** `SweepResult` gains `memories: number` (init 0 in the literal).

**3e.** In `sweepMemory`, inside the per-session guarded body, right after the debounce check (`fresh.length < resolved.minNewMessages` block) and before the chunk loop, resolve scope and dedup once per session:

```ts
        // Scope + dedup context, once per session. `dedup` is mutated as new
        // memories are saved so the NEXT chunk of this session sees them too;
        // across sessions the fresh listMemories() covers it.
        const projectId = resolveProjectId(agentId, resolved.agents, resolved.projects);
        const dedup: Array<{ title: string; keywords: string[] }> = (await listMemories())
          .filter((m) => m.projectId === '' || m.projectId === projectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
```

**3f.** The chunk loop body: the call site becomes

```ts
          const res = await summarize({
            prevSummary: record.summary,
            chunkText: chunk.text,
            dedupBlock: formatDedupBlock(dedup),
            hasProject: projectId !== '',
          });
          if (res === null) {
            caughtUp = false;
            break; // cursor stays; next sweep retries
          }
          // Memories BEFORE the digest record: a crash between the two
          // re-extracts this chunk next sweep, but the titles just saved are
          // then in the dedup block, so the model omits them — duplicates
          // with a dedup guard beat silent loss.
          for (const em of res.memories) {
            const memory: Memory = {
              id: randomUUID(),
              projectId: em.level === 'project' && projectId ? projectId : '',
              kind: em.kind,
              importance: em.importance,
              title: em.title,
              body: em.body,
              keywords: em.keywords,
              sourceSessionId: sessionId,
              sourceAgentId: agentId,
              model: resolved.agent.model,
              createdAt: new Date().toISOString(),
            };
            await saveMemory(memory);
            result.memories++;
            dedup.unshift({ title: memory.title, keywords: memory.keywords });
          }
```

then the existing `record = { …, summary: res.summary, … }; await saveSessionDigest(record);` continues unchanged (note `summary` now comes from `res.summary`).

**3g.** The tick's log line adds the count:

```ts
        `[memory] sweep: scanned=${res.scanned} calls=${res.calls} summarized=${res.summarized} memories=${res.memories} budget-skipped=${res.budgetSkipped}`
```

- [ ] **Step 4: Run both scheduler test files to verify they pass**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts packages/cli/src/cli/web/scheduler/memory_extract.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and run the full CLI suite** (the SummarizeFn change must not have leaked anywhere else — `git grep -n 'buildSummarizePrompt\|SummarizeFn' packages/` should only hit `memory_sweep*` and `memory_extract*`)

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
```

Expected: typecheck clean; all tests pass (596+ before this branch).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts .changeset/memory-daemon-step2.md
git commit -m "feat(memory): combined sweep call extracts durable memories (project/global scope)"
```

---

### Task 4: documentation + final gates

**Files:**
- Modify: `CLAUDE.md` (two spots: the layer-5 **Memory sweep** bullet; the **State on disk** folder-DB item 3)

**Interfaces:** none — docs only.

- [ ] **Step 1: Update the layer-5 memory-sweep bullet**

In the `- **Memory sweep** (…)` bullet, after the sentence about chunks/cursor (“New messages go to the model in chunks under a char budget with the cursor persisted per chunk (crash loses at most one chunk)”), weave in the extraction — keep the existing prose style, content to convey:

- The per-chunk call is now combined: `{summary, memories[]}` JSON — same call count; unparsable JSON fails the chunk (cursor stays, retry; deliberately no raw-text fallback, it would poison the digest).
- Extracted memories are persisted to the durable `memories` collection (NOT a regenerable cache, unlike the digests) with host-side scope: the model picks only `project | global`; projectId is resolved by prefix-matching the session agent's `workingDir` against `projects[].workingDir` (no match → global-only). Classification is `kind: fact|episode` + `importance: low|normal|high` derived from conversation tone. Dedup via existing titles+keywords in the prompt; append-only (no supersede — that is future consolidation); memories are saved before the digest record on purpose.

- [ ] **Step 2: Update the State-on-disk folder-DB item**

In item 3 (the `@morphql/store` folder DB list), after **SessionDigests**, add **Memories** (durable extracted memories: project/global scope via `projectId` empty = global, `kind`/`importance`, keywords, provenance `sourceSessionId`/`sourceAgentId`; written by the memory sweep's combined call, append-only until consolidation exists). Also update the SessionDigests parenthetical if it still says the sweep only maintains summaries.

- [ ] **Step 3: Final verification gates**

```bash
pnpm -F @hyperwindmill/caretaker-cli typecheck
pnpm -F @hyperwindmill/caretaker-cli test
pnpm -F webview-ui test
```

Expected: all green (webview untouched but cheap to confirm).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .changeset/memory-daemon-step2.md
git commit -m "docs: memory extraction in the sweep + memories collection"
```

---

## Self-review notes (already applied)

- Spec coverage: combined call (T3), data model + accessors (T1), scope resolution + degradation (T2/T3), dedup block + within-session propagation (T2/T3), persistence order (T3 comment + crash rationale), validation/caps (T2), no new config flag (nothing to do — resolveMemoryConfig unchanged apart from carrying lists), tests (each task), CLAUDE.md + changeset (T1/T4).
- The scheduler-facing `runMemorySweepTick` signature is unchanged, so `scheduler.ts` needs no edits.
- `formatDedupBlock` is called per chunk (cheap string work) so `dedup.unshift` propagates within a session; `listMemories()` is re-read per session so it propagates across sessions within one sweep.
