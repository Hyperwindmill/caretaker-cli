# Memory Daemon Step 1 (Session Digests) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth loop in the background scheduler that periodically sweeps all chat sessions and maintains, per session, a cursor (last processed message) and a rolling summary produced by a dedicated model.

**Architecture:** One new sibling module `cli/web/scheduler/memory_sweep.ts` (pure helpers + summarize call + sweep + gated tick), a new `session_digests` collection in the morphql folder DB (`store/db.ts`), and a new `MemoryConfig` type in `caretaker-types`. The digest collection is a regenerable cache — deleting it costs one full re-scan.

**Tech Stack:** TypeScript ESM, Node ≥20, `@morphql/store` (already installed), Node test runner via tsx, plain `fetch` for the model call (no SDK).

**Spec:** `docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md`

## Global Constraints

- Node `>=20`, ESM only (`"type": "module"`), `moduleResolution: "bundler"` — all imports end in `.js`.
- No new dependencies of any kind.
- Tests: co-located `*.test.ts`, Node built-in runner via tsx. `process.env.CARETAKER_HOME` mutated at **file scope** (a `before` hook at the top-level `describe`, module under test imported dynamically after the env is set — see `packages/cli/src/store/db.test.ts` for the exact pattern). Never per-describe.
- `pnpm test` does not typecheck (tsx strips types); run `pnpm -F @hyperwindmill/caretaker-cli typecheck` before claiming a task done.
- Run single test file: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/<path>.test.ts`
- Never rewrite commits (no `--amend`, no rebase). New commit on top, always.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Changesets: the feature ships one changeset (Task 7); intermediate tasks don't each need one.

## Key invariant (read before Task 5)

`SessionDigest.scannedAt` is written **only when the digest is fully caught up** with what was read at that timestamp (all new messages summarized, or below the debounce threshold). The sweep skips a session without reading it when `sessionFileMtime < scannedAt`. Because `scannedAt` is captured *before* the file read, an append racing the read leaves `mtime ≥ scannedAt` and the session is re-read next sweep. When a sweep stops early (budget, model failure), `scannedAt` is NOT advanced — per-chunk cursor saves carry the *old* `scannedAt` — so a session with a backlog can never be mtime-skipped.

---

### Task 1: `session_digests` collection in the folder DB

**Files:**
- Modify: `packages/cli/src/store/db.ts` (add interface + 4 accessors at the end of the file)
- Test: `packages/cli/src/store/db_digest.test.ts` (new)

**Interfaces:**
- Consumes: existing `runQuery(sql)` and `safeId(id)` in `db.ts` (`safeId` is module-private — the new accessors live in the same file).
- Produces (Task 5 relies on these exact signatures):
  - `interface SessionDigest { id: string; agentId: string; lastMessageId: string; messageCount: number; summary: string; model: string; scannedAt: string; updatedAt: string }`
  - `getSessionDigest(sessionId: string): Promise<SessionDigest | null>`
  - `listSessionDigests(): Promise<SessionDigest[]>`
  - `saveSessionDigest(d: SessionDigest): Promise<void>` (stamps `updatedAt` itself)
  - `deleteSessionDigest(sessionId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/store/db_digest.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testHome: string;

describe('session digest store', () => {
  let db: typeof import('./db.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-digest-test-'));
    process.env.CARETAKER_HOME = testHome;
    db = await import('./db.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const digest = (over: Partial<import('./db.js').SessionDigest> = {}) => ({
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    agentId: 'agent-1',
    lastMessageId: 'msg-9',
    messageCount: 9,
    summary: "A summary with 'quotes' and\nnewlines — must survive verbatim.",
    model: 'gpt-test',
    scannedAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '',
    ...over,
  });

  it('save + get round-trips, stamping updatedAt', async () => {
    await db.saveSessionDigest(digest());
    const got = await db.getSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    assert.ok(got);
    assert.equal(got.summary, "A summary with 'quotes' and\nnewlines — must survive verbatim.");
    assert.equal(got.messageCount, 9);
    assert.notEqual(got.updatedAt, '');
  });

  it('save is an upsert: second save replaces, no duplicate rows', async () => {
    await db.saveSessionDigest(digest({ summary: 'v2', messageCount: 12 }));
    const all = await db.listSessionDigests();
    const mine = all.filter((d) => d.id === 'a1b2c3d4-0000-0000-0000-000000000001');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.summary, 'v2');
  });

  it('get of a missing or invalid id returns null', async () => {
    assert.equal(await db.getSessionDigest('a1b2c3d4-0000-0000-0000-00000000ffff'), null);
    assert.equal(await db.getSessionDigest("bad'id"), null);
  });

  it('delete removes the record and is idempotent', async () => {
    await db.deleteSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    await db.deleteSessionDigest('a1b2c3d4-0000-0000-0000-000000000001');
    assert.equal(await db.getSessionDigest('a1b2c3d4-0000-0000-0000-000000000001'), null);
  });

  it('benchmark: 300 writes + 300 point reads + list (timings logged)', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      await db.saveSessionDigest(digest({ id: `bench-${i}`, summary: `summary ${i} `.repeat(50) }));
    }
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) {
      const got = await db.getSessionDigest(`bench-${i}`);
      assert.equal(got?.id, `bench-${i}`);
    }
    const t2 = performance.now();
    const all = await db.listSessionDigests();
    const t3 = performance.now();
    assert.ok(all.length >= 300);
    // The measurement that decides the SQLite switch — logged, never asserted (timing asserts flake).
    console.log(
      `[bench] session_digests: 300 writes ${(t1 - t0).toFixed(0)}ms | 300 point reads ${(t2 - t1).toFixed(0)}ms | list ${(t3 - t2).toFixed(0)}ms`
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_digest.test.ts`
Expected: FAIL — `db.saveSessionDigest is not a function` (module loads, accessors missing).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/cli/src/store/db.ts` (after the existing task accessors):

```ts
/** Per-session memory digest: cursor + rolling summary maintained by the
 *  memory sweep daemon. The whole collection is a regenerable cache — never
 *  a source of truth; deleting it costs one full re-scan.
 *  See docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md */
export interface SessionDigest {
  /** = sessionId (uuid of the JSONL session file). */
  id: string;
  agentId: string;
  /** Cursor: last processed MessageRecord.id. '' = nothing processed yet. */
  lastMessageId: string;
  /** Messages processed so far (O(1) "how many new?" check). */
  messageCount: number;
  /** Rolling summary, standalone text. '' until the first summarize call. */
  summary: string;
  /** Model that produced the current summary. '' until then. */
  model: string;
  /** Start of the last *fully caught-up* scan. INVARIANT: written only when
   *  the digest covers everything read at this timestamp; the sweep's mtime
   *  gate (skip when file mtime < scannedAt) is only sound because of that. */
  scannedAt: string;
  updatedAt: string;
}

export async function getSessionDigest(sessionId: string): Promise<SessionDigest | null> {
  if (!safeId(sessionId)) return null;
  try {
    const rows = (await runQuery(`SELECT * FROM session_digests WHERE id = '${sessionId}'`)) as SessionDigest[];
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listSessionDigests(): Promise<SessionDigest[]> {
  try {
    return (await runQuery('SELECT * FROM session_digests')) as SessionDigest[];
  } catch {
    return [];
  }
}

export async function saveSessionDigest(d: SessionDigest): Promise<void> {
  if (!safeId(d.id)) throw new Error(`Invalid session id: ${d.id}`);
  // Delete + insert = upsert; summary goes through JSON.stringify, so quotes
  // and newlines never touch the interpolated SQL string.
  await runQuery(`DELETE FROM session_digests WHERE id = '${d.id}'`);
  await runQuery(
    `INSERT INTO session_digests ${JSON.stringify({ ...d, updatedAt: new Date().toISOString() })}`
  );
}

export async function deleteSessionDigest(sessionId: string): Promise<void> {
  if (!safeId(sessionId)) return;
  await runQuery(`DELETE FROM session_digests WHERE id = '${sessionId}'`);
}
```

Note: session ids are `randomUUID()` (lowercase hex + dashes) so they pass the existing `safeId` regex `^[a-z0-9][a-z0-9-]*$`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/store/db_digest.test.ts`
Expected: PASS (5 tests), benchmark line printed.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: clean.

```bash
git add packages/cli/src/store/db.ts packages/cli/src/store/db_digest.test.ts
git commit -m "feat(store): session_digests collection (cursor + rolling summary cache)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `MemoryConfig` type + config resolution

**Files:**
- Modify: `packages/types/src/index.ts` (add `MemoryConfig`, add `memory?` to `CaretakerConfig`)
- Create: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts` (new)

**Interfaces:**
- Consumes: `CaretakerConfig`, `ProviderConfig` from `caretaker-types` (re-exported by `packages/cli/src/types.ts`; from the scheduler dir the import is `../../../types.js`).
- Produces:
  - `type MemoryConfig = { provider: string; model: string; sweepMinutes?: number; minNewMessages?: number }` (in `caretaker-types`)
  - `interface ResolvedMemoryConfig { provider: ProviderConfig; model: string; sweepMinutes: number; minNewMessages: number }`
  - `resolveMemoryConfig(config: CaretakerConfig): ResolvedMemoryConfig | null`
  - Constants: `DEFAULT_SWEEP_MINUTES = 5`, `DEFAULT_MIN_NEW_MESSAGES = 4`, `MAX_CALLS_PER_SWEEP = 10`, `MAX_CHUNK_CHARS = 20_000`, `MAX_TOOL_RESULT_CHARS = 500`, `MAX_SUMMARY_CHARS = 4_000`

- [ ] **Step 1: Add the type (no test — types package has no runtime)**

In `packages/types/src/index.ts`, after `VoiceConfig`:

```ts
/** Memory subsystem configuration — step 1: the session-digest sweep daemon
 *  (web-server scheduler only). Unset ⇒ subsystem off, zero cost.
 *  See docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md */
export type MemoryConfig = {
  /** Provider name (ProviderConfig.name), like AgentConfig.provider.
   *  claude-code providers are rejected at runtime: the daemon makes fresh
   *  HTTP calls and they have no endpoint (same constraint as titling). */
  provider: string;
  /** Model id for the summarize calls. */
  model: string;
  /** Minimum minutes between sweeps. Default 5. */
  sweepMinutes?: number;
  /** Per-session debounce: summarize only when at least this many new
   *  messages accumulated since the cursor. Default 4. */
  minNewMessages?: number;
};
```

And extend `CaretakerConfig`:

```ts
export type CaretakerConfig = {
  port: number;
  providers: ProviderConfig[];
  scheduler?: {
    tasks: ServiceConfig[];
  };
  projects?: ProjectConfig[];
  voice?: VoiceConfig;
  memory?: MemoryConfig;
};
```

- [ ] **Step 2: Write the failing test for resolution**

Create `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaretakerConfig } from '../../../types.js';

let testHome: string;

describe('memory sweep', () => {
  let sweep: typeof import('./memory_sweep.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memsweep-test-'));
    process.env.CARETAKER_HOME = testHome;
    sweep = await import('./memory_sweep.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const baseConfig = (memory?: CaretakerConfig['memory']): CaretakerConfig => ({
    port: 3000,
    providers: [
      { name: 'local', endpoint: 'http://127.0.0.1:1234', apiKey: 'k' },
      { name: 'cc', type: 'claude-code', endpoint: '' },
    ],
    memory,
  });

  describe('resolveMemoryConfig', () => {
    it('returns null when memory is unset or incomplete', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig()), null);
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: '', model: 'm' })), null);
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'local', model: '' })), null);
    });

    it('returns null for an unknown provider name', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'nope', model: 'm' })), null);
    });

    it('rejects claude-code providers', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'cc', model: 'm' })), null);
    });

    it('resolves with defaults applied', () => {
      const r = sweep.resolveMemoryConfig(baseConfig({ provider: 'local', model: 'gpt-test' }));
      assert.ok(r);
      assert.equal(r.provider.name, 'local');
      assert.equal(r.model, 'gpt-test');
      assert.equal(r.sweepMinutes, sweep.DEFAULT_SWEEP_MINUTES);
      assert.equal(r.minNewMessages, sweep.DEFAULT_MIN_NEW_MESSAGES);
    });

    it('honours explicit overrides', () => {
      const r = sweep.resolveMemoryConfig(
        baseConfig({ provider: 'local', model: 'gpt-test', sweepMinutes: 30, minNewMessages: 1 })
      );
      assert.equal(r?.sweepMinutes, 30);
      assert.equal(r?.minNewMessages, 1);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — cannot find module `./memory_sweep.js`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/cli/src/cli/web/scheduler/memory_sweep.ts`:

```ts
// Memory sweep — step 1 of the memory subsystem: a periodic pass over all
// chat sessions maintaining, per session, a cursor (last processed message)
// and a rolling summary produced by a dedicated model. The session_digests
// collection is a regenerable cache: dropping it costs one full re-scan.
// Design: docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md

import type { CaretakerConfig, ProviderConfig } from '../../../types.js';

export const DEFAULT_SWEEP_MINUTES = 5;
export const DEFAULT_MIN_NEW_MESSAGES = 4;
export const MAX_CALLS_PER_SWEEP = 10;
export const MAX_CHUNK_CHARS = 20_000;
export const MAX_TOOL_RESULT_CHARS = 500;
export const MAX_SUMMARY_CHARS = 4_000;

export interface ResolvedMemoryConfig {
  provider: ProviderConfig;
  model: string;
  sweepMinutes: number;
  minNewMessages: number;
}

/** null = subsystem off (unset/incomplete config, unknown provider, or a
 *  claude-code provider — no HTTP endpoint for fresh calls). */
export function resolveMemoryConfig(config: CaretakerConfig): ResolvedMemoryConfig | null {
  const m = config.memory;
  if (!m?.provider || !m.model) return null;
  const provider = (config.providers || []).find((p) => p.name === m.provider);
  if (!provider || provider.type === 'claude-code') return null;
  return {
    provider,
    model: m.model,
    sweepMinutes: m.sweepMinutes ?? DEFAULT_SWEEP_MINUTES,
    minNewMessages: m.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck (both packages) and commit**

Run: `pnpm -F caretaker-types build && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: clean.

```bash
git add packages/types/src/index.ts packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts
git commit -m "feat(memory): MemoryConfig type + sweep config resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: transcript formatting, cursor location, chunking (pure functions)

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts` (extend)

**Interfaces:**
- Consumes: `MessageRecord`, `AssistantPart` from `../../../session/types.js`.
- Produces (Task 5 relies on these):
  - `formatMessage(m: MessageRecord): string` — role-labelled line; thinking parts dropped; tool results truncated to `MAX_TOOL_RESULT_CHARS`.
  - `locateCursor(messages: MessageRecord[], lastMessageId: string): number` — index of the cursor message, `-1` when `lastMessageId` is `''` or not found.
  - `chunkMessages(messages: MessageRecord[]): Array<{ messages: MessageRecord[]; text: string }>` — consecutive chunks under `MAX_CHUNK_CHARS`; one oversized message becomes its own chunk, hard-truncated (the cursor must always be able to advance past it).

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `memory_sweep.test.ts`:

```ts
  const msg = (
    id: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    parts?: import('../../../session/types.js').AssistantPart[]
  ): import('../../../session/types.js').MessageRecord => ({
    v: 1,
    type: 'message',
    id,
    role,
    content,
    ...(parts ? { parts } : {}),
    createdAt: '2026-08-24T10:00:00.000Z',
  });

  describe('formatMessage', () => {
    it('labels user and assistant messages by role', () => {
      assert.equal(sweep.formatMessage(msg('m1', 'user', 'hello')), 'user: hello');
      assert.equal(sweep.formatMessage(msg('m2', 'assistant', 'hi')), 'assistant: hi');
    });

    it('drops thinking parts, keeps text, names tool calls', () => {
      const out = sweep.formatMessage(
        msg('m3', 'assistant', 'ignored when parts exist', [
          { type: 'thinking', text: 'secret chain of thought' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', id: 't1', name: 'read_file', args: { path: 'x' } },
        ])
      );
      assert.ok(!out.includes('secret chain of thought'));
      assert.ok(out.includes('visible answer'));
      assert.ok(out.includes('read_file'));
    });

    it('hard-truncates tool results', () => {
      const out = sweep.formatMessage(msg('m4', 'tool', 'x'.repeat(10_000)));
      assert.ok(out.length < 600);
    });
  });

  describe('locateCursor', () => {
    const messages = [msg('a', 'user', '1'), msg('b', 'assistant', '2'), msg('c', 'user', '3')];
    it('finds the cursor index', () => {
      assert.equal(sweep.locateCursor(messages, 'b'), 1);
    });
    it('returns -1 for empty or unknown ids', () => {
      assert.equal(sweep.locateCursor(messages, ''), -1);
      assert.equal(sweep.locateCursor(messages, 'zzz'), -1);
    });
  });

  describe('chunkMessages', () => {
    it('keeps small conversations in one chunk, in order', () => {
      const chunks = sweep.chunkMessages([msg('a', 'user', 'one'), msg('b', 'assistant', 'two')]);
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0]!.messages.map((m) => m.id), ['a', 'b']);
      assert.ok(chunks[0]!.text.includes('user: one'));
      assert.ok(chunks[0]!.text.includes('assistant: two'));
    });

    it('splits when the char budget is exceeded, preserving message order', () => {
      const big = 'x'.repeat(9_000);
      const chunks = sweep.chunkMessages([
        msg('a', 'user', big),
        msg('b', 'user', big),
        msg('c', 'user', big),
      ]);
      assert.ok(chunks.length >= 2);
      assert.deepEqual(chunks.flatMap((c) => c.messages.map((m) => m.id)), ['a', 'b', 'c']);
    });

    it('an oversized single message becomes its own truncated chunk', () => {
      const chunks = sweep.chunkMessages([msg('a', 'user', 'x'.repeat(50_000))]);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]!.messages.length, 1);
      assert.ok(chunks[0]!.text.length <= sweep.MAX_CHUNK_CHARS + 1);
    });

    it('returns [] for no messages', () => {
      assert.deepEqual(sweep.chunkMessages([]), []);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — `sweep.formatMessage is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `memory_sweep.ts` (add `MessageRecord` to the imports):

```ts
import type { MessageRecord } from '../../../session/types.js';

/** One role-labelled line per message. Thinking parts are dropped (never fed
 *  to the memory model); tool results are hard-truncated — they are the
 *  largest strings in a session and carry the least durable meaning. */
export function formatMessage(m: MessageRecord): string {
  if (m.role === 'tool') {
    const body =
      m.content.length > MAX_TOOL_RESULT_CHARS
        ? m.content.slice(0, MAX_TOOL_RESULT_CHARS) + '…'
        : m.content;
    return `[tool result] ${body}`;
  }
  if (m.role === 'assistant' && m.parts?.length) {
    const parts: string[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) parts.push(p.text);
      else if (p.type === 'tool_use') parts.push(`[calls tool: ${p.name}]`);
    }
    return `assistant: ${parts.join('\n')}`;
  }
  return `${m.role}: ${m.content}`;
}

/** Index of the cursor message; -1 when lastMessageId is '' or not found
 *  (both mean: process from the beginning). */
export function locateCursor(messages: MessageRecord[], lastMessageId: string): number {
  if (!lastMessageId) return -1;
  return messages.findIndex((m) => m.id === lastMessageId);
}

/** Consecutive chunks whose formatted text stays under MAX_CHUNK_CHARS. A
 *  single oversized message becomes its own chunk with its text truncated —
 *  the cursor must always be able to advance past it. */
export function chunkMessages(
  messages: MessageRecord[]
): Array<{ messages: MessageRecord[]; text: string }> {
  const chunks: Array<{ messages: MessageRecord[]; text: string }> = [];
  let cur: MessageRecord[] = [];
  let curTexts: string[] = [];
  let curLen = 0;
  for (const m of messages) {
    let t = formatMessage(m);
    if (t.length > MAX_CHUNK_CHARS) t = t.slice(0, MAX_CHUNK_CHARS) + '…';
    if (curLen + t.length > MAX_CHUNK_CHARS && cur.length > 0) {
      chunks.push({ messages: cur, text: curTexts.join('\n') });
      cur = [];
      curTexts = [];
      curLen = 0;
    }
    cur.push(m);
    curTexts.push(t);
    curLen += t.length + 1;
  }
  if (cur.length > 0) chunks.push({ messages: cur, text: curTexts.join('\n') });
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck`

```bash
git add packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts
git commit -m "feat(memory): transcript formatting, cursor location, chunking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: summarize call (prompt + one-shot fetch)

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts` (extend)

**Interfaces:**
- Produces (Task 5 relies on these):
  - `type SummarizeFn = (prevSummary: string, chunkText: string) => Promise<string | null>` — null = failure, caller leaves the cursor and retries next sweep.
  - `buildSummarizePrompt(prevSummary: string, chunkText: string): string`
  - `makeSummarizer(resolved: ResolvedMemoryConfig): SummarizeFn` — real fetch against `<endpoint>/v1/chat/completions`, `title.ts` pattern, 60 s timeout, output hard-truncated to `MAX_SUMMARY_CHARS`.

- [ ] **Step 1: Write the failing tests**

The fetch test runs a throwaway `node:http` server as the fake OpenAI endpoint. Append inside the top-level `describe`:

```ts
  describe('buildSummarizePrompt', () => {
    it('embeds previous summary and chunk, marks a missing summary', () => {
      const p1 = sweep.buildSummarizePrompt('old facts', 'user: hi');
      assert.ok(p1.includes('old facts'));
      assert.ok(p1.includes('user: hi'));
      const p2 = sweep.buildSummarizePrompt('', 'user: hi');
      assert.ok(p2.includes('(none)'));
    });
  });

  describe('makeSummarizer', () => {
    // `createServer` from a static `import { createServer } from 'node:http';`
    // at the top of the test file.
    const withServer = async (
      handler: (body: any) => { status: number; payload: unknown },
      fn: (endpoint: string) => Promise<void>
    ) => {
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const out = handler(JSON.parse(raw));
          res.writeHead(out.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out.payload));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address() as { port: number };
      try {
        await fn(`http://127.0.0.1:${addr.port}`);
      } finally {
        server.close();
      }
    };

    const resolved = (endpoint: string): import('./memory_sweep.js').ResolvedMemoryConfig => ({
      provider: { name: 'local', endpoint, apiKey: 'secret-key' },
      model: 'gpt-test',
      sweepMinutes: 5,
      minNewMessages: 4,
    });

    it('POSTs model + prompt and returns the trimmed content', async () => {
      let seen: any = null;
      await withServer(
        (body) => {
          seen = body;
          return { status: 200, payload: { choices: [{ message: { content: '  the summary  ' } }] } };
        },
        async (endpoint) => {
          const out = await sweep.makeSummarizer(resolved(endpoint))('prev', 'user: hi');
          assert.equal(out, 'the summary');
          assert.equal(seen.model, 'gpt-test');
          assert.equal(seen.stream, false);
          assert.ok(seen.messages[0].content.includes('prev'));
          assert.ok(seen.messages[0].content.includes('user: hi'));
        }
      );
    });

    it('returns null on non-OK and on malformed payloads', async () => {
      await withServer(
        () => ({ status: 500, payload: { error: 'boom' } }),
        async (endpoint) => {
          assert.equal(await sweep.makeSummarizer(resolved(endpoint))('', 'x'), null);
        }
      );
      await withServer(
        () => ({ status: 200, payload: { unexpected: true } }),
        async (endpoint) => {
          assert.equal(await sweep.makeSummarizer(resolved(endpoint))('', 'x'), null);
        }
      );
    });

    it('returns null when the endpoint is unreachable', async () => {
      const out = await sweep.makeSummarizer(resolved('http://127.0.0.1:1'))('', 'x');
      assert.equal(out, null);
    });

    it('hard-truncates an over-long summary', async () => {
      await withServer(
        () => ({ status: 200, payload: { choices: [{ message: { content: 'y'.repeat(10_000) } }] } }),
        async (endpoint) => {
          const out = await sweep.makeSummarizer(resolved(endpoint))('', 'x');
          assert.ok(out !== null && out.length <= sweep.MAX_SUMMARY_CHARS + 1);
        }
      );
    });
  });
```

Note: add `import { createServer } from 'node:http';` to the static imports at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — `sweep.buildSummarizePrompt is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `memory_sweep.ts`:

```ts
const SUMMARIZE_INSTRUCTION =
  'You maintain a rolling summary of a conversation between a user and an AI agent. ' +
  'Integrate the NEW MESSAGES into the PREVIOUS SUMMARY and rewrite it as ONE standalone summary. ' +
  'Keep durable facts, decisions, preferences, constraints, and open threads; drop pleasantries and dead ends. ' +
  'Plain text, at most 300 words. Reply with only the summary.';

/** null = failure (network, non-OK, empty/malformed response). The caller
 *  leaves the cursor where it was; the next sweep retries. Best-effort, the
 *  same contract as titling (harness/title.ts). */
export type SummarizeFn = (prevSummary: string, chunkText: string) => Promise<string | null>;

export function buildSummarizePrompt(prevSummary: string, chunkText: string): string {
  return [
    SUMMARIZE_INSTRUCTION,
    '',
    'PREVIOUS SUMMARY:',
    prevSummary.trim() || '(none)',
    '',
    'NEW MESSAGES:',
    chunkText,
  ].join('\n');
}

export function makeSummarizer(resolved: ResolvedMemoryConfig): SummarizeFn {
  return async (prevSummary, chunkText) => {
    const baseUrl = resolved.provider.endpoint.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.provider.apiKey) headers.Authorization = `Bearer ${resolved.provider.apiKey}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolved.model,
          stream: false,
          messages: [{ role: 'user', content: buildSummarizePrompt(prevSummary, chunkText) }],
        }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const raw = json?.choices?.[0]?.message?.content?.trim();
      if (!raw) return null;
      return raw.length > MAX_SUMMARY_CHARS ? raw.slice(0, MAX_SUMMARY_CHARS) + '…' : raw;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck`

```bash
git add packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts
git commit -m "feat(memory): one-shot summarize call (title.ts pattern, 60s timeout)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: the sweep

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts` (extend)

**Interfaces:**
- Consumes: `sessionsRoot`, `readSession`, `createSession`, `appendMessage`, `userMessage`, `assistantMessage` from `../../../session/store.js` (the last four in tests only); `getSessionDigest`, `listSessionDigests`, `saveSessionDigest`, `deleteSessionDigest`, `SessionDigest` from `../../../store/db.js`; Task 3's pure functions; Task 4's `SummarizeFn`.
- Produces (Task 6 relies on this):
  - `sweepMemory(resolved: ResolvedMemoryConfig, summarize: SummarizeFn): Promise<SweepResult>`
  - `interface SweepResult { scanned: number; summarized: number; calls: number; budgetSkipped: number }`

**Behaviour to implement (the spec's sweep, plus the scannedAt invariant from the plan header):**
1. Enumerate `sessions/<agentId>/*.jsonl` from disk.
2. mtime gate: if a digest exists and `fileMtime < digest.scannedAt`, skip without reading.
3. Capture `scannedAt = now` BEFORE reading the file, then `readSession`.
4. Locate cursor; a non-empty `lastMessageId` that is not found ⇒ cursor lost ⇒ reset (cursor `''`, `messageCount 0`, `summary ''`) and reprocess from message zero.
5. Below `minNewMessages` ⇒ persist the digest with the new `scannedAt` (arms the mtime gate; debounce = wait for the next append) and continue.
6. Otherwise chunk and summarize; after each successful call persist the digest with advanced cursor but the OLD `scannedAt`. Stop on model failure (retry next sweep) or when `calls` hits `MAX_CALLS_PER_SWEEP` (count `budgetSkipped`).
7. Only when every chunk succeeded, persist once more with the NEW `scannedAt`.
8. Delete digests whose session file no longer exists (regenerable-cache hygiene).
9. Per-session read failures: warn and continue — one corrupt file never kills the sweep.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe`. These build real session files via the session store (same `CARETAKER_HOME`):

```ts
  describe('sweepMemory', () => {
    let store: typeof import('../../../session/store.js');
    let db: typeof import('../../../store/db.js');

    before(async () => {
      store = await import('../../../session/store.js');
      db = await import('../../../store/db.js');
    });

    const resolvedCfg = (over: Partial<import('./memory_sweep.js').ResolvedMemoryConfig> = {}) => ({
      provider: { name: 'local', endpoint: 'http://unused', apiKey: '' },
      model: 'gpt-test',
      sweepMinutes: 5,
      minNewMessages: 2,
      ...over,
    });

    /** Fake summarizer recording calls; returns "S<n>" per call, or null after `failAfter`. */
    const fakeSummarize = (failAfter = Infinity) => {
      const calls: Array<{ prev: string; chunk: string }> = [];
      const fn: import('./memory_sweep.js').SummarizeFn = async (prev, chunk) => {
        calls.push({ prev, chunk });
        if (calls.length > failAfter) return null;
        return `S${calls.length}`;
      };
      return { calls, fn };
    };

    const makeSession = async (agentId: string, texts: string[]) => {
      const meta = await store.createSession({ agentId, title: 't' });
      for (const t of texts) {
        await store.appendMessage(meta, store.userMessage(t));
      }
      return meta;
    };

    it('summarizes a new session and persists cursor + summary', async () => {
      const meta = await makeSession('ag-sweep-1', ['first', 'second', 'third']);
      const { calls, fn } = fakeSummarize();
      const res = await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(res.scanned >= 1);
      assert.equal(calls.length >= 1, true);
      const d = await db.getSessionDigest(meta.id);
      assert.ok(d);
      assert.equal(d.summary, `S${calls.length}`);
      assert.equal(d.agentId, 'ag-sweep-1');
      assert.equal(d.messageCount, 3);
      const session = await store.readSession('ag-sweep-1', meta.id);
      assert.equal(d.lastMessageId, session.messages[session.messages.length - 1]!.id);
      assert.notEqual(d.scannedAt, '');
    });

    it('is incremental: an unchanged session is not re-summarized (mtime gate)', async () => {
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), fn);
      assert.equal(calls.length, 0);
    });

    it('below the debounce threshold: no call, but scannedAt is refreshed', async () => {
      const meta = await makeSession('ag-sweep-2', ['only-one']);
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg({ minNewMessages: 5 }), fn);
      assert.equal(calls.length, 0);
      const d = await db.getSessionDigest(meta.id);
      assert.ok(d);
      assert.equal(d.summary, '');
      assert.equal(d.lastMessageId, '');
    });

    it('feeds the previous summary to the next round and advances the cursor', async () => {
      const meta = await makeSession('ag-sweep-3', ['a', 'b']);
      const r1 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r1.fn);
      assert.equal(r1.calls.length, 1);
      await store.appendMessage(meta, store.userMessage('c'));
      await store.appendMessage(meta, store.userMessage('d'));
      const r2 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r2.fn);
      assert.equal(r2.calls.length, 1);
      assert.equal(r2.calls[0]!.prev, 'S1');
      assert.ok(r2.calls[0]!.chunk.includes('user: c'));
      assert.ok(!r2.calls[0]!.chunk.includes('user: a'));
      const d = await db.getSessionDigest(meta.id);
      assert.equal(d?.messageCount, 4);
    });

    it('model failure leaves the cursor and scannedAt so the next sweep retries', async () => {
      const meta = await makeSession('ag-sweep-4', ['a', 'b', 'c']);
      const fail = fakeSummarize(0); // every call fails
      await sweep.sweepMemory(resolvedCfg(), fail.fn);
      const d1 = await db.getSessionDigest(meta.id);
      assert.ok(!d1 || d1.lastMessageId === '');
      const ok = fakeSummarize();
      const res2 = await sweep.sweepMemory(resolvedCfg(), ok.fn);
      assert.equal(ok.calls.length, 1); // retried despite no new appends
      assert.ok(res2.summarized >= 1);
    });

    it('lost cursor (id not found) resets and reprocesses from zero', async () => {
      const meta = await makeSession('ag-sweep-5', ['a', 'b']);
      const r1 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r1.fn);
      const d1 = await db.getSessionDigest(meta.id);
      assert.ok(d1);
      await db.saveSessionDigest({ ...d1, lastMessageId: 'gone-gone', scannedAt: '1970-01-01T00:00:00.000Z' });
      const r2 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r2.fn);
      assert.equal(r2.calls.length, 1);
      assert.equal(r2.calls[0]!.prev, ''); // summary reset, restarted from zero
      const d2 = await db.getSessionDigest(meta.id);
      assert.equal(d2?.messageCount, 2);
    });

    it('respects the per-sweep call budget and reports the skip', async () => {
      // 12 fresh 2-message sessions with budget 10 ⇒ 10 calls, ≥1 budget-skips.
      for (let i = 0; i < 12; i++) await makeSession('ag-sweep-6', ['x', 'y']);
      const { calls, fn } = fakeSummarize();
      const res = await sweep.sweepMemory(resolvedCfg(), fn);
      assert.equal(calls.length, sweep.MAX_CALLS_PER_SWEEP);
      assert.ok(res.budgetSkipped >= 1);
    });

    it('budget-skipped sessions are caught up by the following sweep', async () => {
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(calls.length >= 1); // the leftovers from the previous test
    });

    it('deletes digests whose session file is gone', async () => {
      const meta = await makeSession('ag-sweep-7', ['a', 'b']);
      await sweep.sweepMemory(resolvedCfg(), fakeSummarize().fn);
      assert.ok(await db.getSessionDigest(meta.id));
      await store.deleteSession('ag-sweep-7', meta.id);
      await sweep.sweepMemory(resolvedCfg(), fakeSummarize().fn);
      assert.equal(await db.getSessionDigest(meta.id), null);
    });
  });
```

Note for the executor: these tests are order-dependent within their `describe` (node:test runs them in declaration order — that is guaranteed). The budget pair intentionally spans two sweeps.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — `sweep.sweepMemory is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `memory_sweep.ts` (add the new imports at the top of the file):

```ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionsRoot, readSession } from '../../../session/store.js';
import {
  deleteSessionDigest,
  listSessionDigests,
  saveSessionDigest,
  type SessionDigest,
} from '../../../store/db.js';

export interface SweepResult {
  scanned: number;
  summarized: number;
  calls: number;
  budgetSkipped: number;
}

/** One full pass over every session on disk. Sessions written by any surface
 *  are picked up — the sweep reads shared state, it is not wired per surface.
 *  Failures are per-session and best-effort: warn, skip, retry next sweep. */
export async function sweepMemory(
  resolved: ResolvedMemoryConfig,
  summarize: SummarizeFn
): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, summarized: 0, calls: 0, budgetSkipped: 0 };
  const root = sessionsRoot();
  let agentIds: string[] = [];
  try {
    agentIds = await readdir(root);
  } catch {
    return result; // no sessions dir yet — nothing to do
  }
  const digests = new Map((await listSessionDigests()).map((d) => [d.id, d]));
  const seen = new Set<string>();

  for (const agentId of agentIds) {
    let files: string[] = [];
    try {
      files = (await readdir(join(root, agentId))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // stray non-directory entry
    }
    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length);
      seen.add(sessionId);
      const digest = digests.get(sessionId) ?? null;
      const path = join(root, agentId, file);

      // mtime gate: scannedAt is only ever written when the digest was fully
      // caught up (see invariant below), so mtime < scannedAt ⇒ nothing new.
      try {
        const st = await stat(path);
        if (digest && st.mtime.getTime() < new Date(digest.scannedAt).getTime()) continue;
      } catch {
        continue; // vanished between readdir and stat; cleanup pass handles the digest
      }

      // Captured BEFORE the read: an append racing the read keeps
      // mtime ≥ scannedAt, so the session is re-read next sweep.
      const scannedAt = new Date().toISOString();
      let session: Awaited<ReturnType<typeof readSession>>;
      try {
        session = await readSession(agentId, sessionId);
      } catch (err) {
        console.warn(`[memory] failed to read session ${sessionId}:`, err);
        continue;
      }
      result.scanned++;

      let record: SessionDigest = digest ?? {
        id: sessionId,
        agentId,
        lastMessageId: '',
        messageCount: 0,
        summary: '',
        model: '',
        scannedAt: '',
        updatedAt: '',
      };
      const idx = locateCursor(session.messages, record.lastMessageId);
      if (record.lastMessageId && idx === -1) {
        // Cursor lost (rewritten/truncated file): restart from message zero.
        record = { ...record, lastMessageId: '', messageCount: 0, summary: '', model: '' };
      }
      const fresh = session.messages.slice(idx + 1);

      if (fresh.length < resolved.minNewMessages) {
        // Debounce: arm the mtime gate and wait for the next append.
        await saveSessionDigest({ ...record, agentId, scannedAt });
        continue;
      }

      // INVARIANT: per-chunk saves keep the OLD scannedAt. The new one is
      // only persisted when every chunk succeeded — a budget stop or model
      // failure must leave the session mtime-gate-open for the next sweep.
      let caughtUp = true;
      for (const chunk of chunkMessages(fresh)) {
        if (result.calls >= MAX_CALLS_PER_SWEEP) {
          result.budgetSkipped++;
          caughtUp = false;
          break;
        }
        result.calls++;
        const summary = await summarize(record.summary, chunk.text);
        if (summary === null) {
          caughtUp = false;
          break; // cursor stays; next sweep retries
        }
        const last = chunk.messages[chunk.messages.length - 1]!;
        record = {
          ...record,
          agentId,
          lastMessageId: last.id,
          messageCount: record.messageCount + chunk.messages.length,
          summary,
          model: resolved.model,
        };
        await saveSessionDigest(record); // crash loses at most one chunk
        result.summarized++;
      }
      if (caughtUp) {
        await saveSessionDigest({ ...record, agentId, scannedAt });
      }
    }
  }

  // Regenerable-cache hygiene: drop digests whose session no longer exists.
  for (const [id] of digests) {
    if (!seen.has(id)) await deleteSessionDigest(id);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full CLI suite (regressions) + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli test && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts
git commit -m "feat(memory): session sweep — cursor, chunked summarize, budget, mtime gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: gated tick + scheduler wiring

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts`
- Modify: `packages/cli/src/cli/web/scheduler.ts` (wire the fourth loop into `runSchedulerTick`)
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts` (extend)

**Interfaces:**
- Consumes: `loadConfig` from `../../../store/json.js`, Task 2's `resolveMemoryConfig`, Task 4's `makeSummarizer`, Task 5's `sweepMemory`.
- Produces: `runMemorySweepTick(now: Date, summarizeOverride?: SummarizeFn): Promise<void>` and `__memorySweepTesting.reset()`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` (needs `writeFile`/`readFile` — reuse `node:fs/promises` imports; `configPath` comes from `../../../store/json.js`):

```ts
  describe('runMemorySweepTick', () => {
    let json: typeof import('../../../store/json.js');

    before(async () => {
      json = await import('../../../store/json.js');
    });

    const writeMemoryConfig = async (memory: unknown) => {
      const config = await json.loadConfig();
      await json.saveConfig({ ...config, providers: [{ name: 'local', endpoint: 'http://unused' }], memory } as any);
    };

    it('does nothing when memory is unconfigured', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig(undefined);
      const { calls, fn } = // reuse the fakeSummarize helper from the sweepMemory block:
        (() => {
          const calls: unknown[] = [];
          const fn: import('./memory_sweep.js').SummarizeFn = async () => {
            calls.push(1);
            return 'S';
          };
          return { calls, fn };
        })();
      await sweep.runMemorySweepTick(new Date(), fn);
      assert.equal(calls.length, 0);
    });

    it('interval gate: two ticks inside sweepMinutes run one sweep', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig({ provider: 'local', model: 'gpt-test', minNewMessages: 1 });
      let sweeps = 0;
      const fn: import('./memory_sweep.js').SummarizeFn = async () => {
        sweeps++;
        return 'S';
      };
      const t0 = new Date('2026-08-24T12:00:00.000Z');
      await sweep.runMemorySweepTick(t0, fn);
      const after = sweeps;
      await sweep.runMemorySweepTick(new Date(t0.getTime() + 15_000), fn); // next 15s tick
      assert.equal(sweeps, after); // no second sweep inside the window
      await sweep.runMemorySweepTick(new Date(t0.getTime() + 6 * 60_000), fn); // past 5 min
      // second sweep ran (mtime gates may make it a no-call sweep; assert via gate state, not calls):
      // the tick returning without throwing and the interval advancing is the observable contract.
    });

    it('overlap gate: a tick during an in-flight sweep returns immediately', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig({ provider: 'local', model: 'gpt-test', minNewMessages: 1 });
      // a fresh session so the sweep has work to do and stays in flight
      const store = await import('../../../session/store.js');
      const meta = await store.createSession({ agentId: 'ag-tick-1', title: 't' });
      await store.appendMessage(meta, store.userMessage('hello'));
      let release!: () => void;
      const blocked = new Promise<void>((r) => (release = r));
      let entered = 0;
      const slow: import('./memory_sweep.js').SummarizeFn = async () => {
        entered++;
        await blocked;
        return 'S';
      };
      const t0 = new Date('2026-08-24T13:00:00.000Z');
      const first = sweep.runMemorySweepTick(t0, slow);
      // busy-wait until the slow summarizer is actually entered
      while (entered === 0) await new Promise((r) => setTimeout(r, 5));
      const second = sweep.runMemorySweepTick(new Date(t0.getTime() + 10 * 60_000), slow);
      await second; // must resolve immediately (in-flight gate), not run a sweep
      assert.equal(entered, 1);
      release();
      await first;
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: FAIL — `sweep.runMemorySweepTick is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `memory_sweep.ts` (plus `import { loadConfig } from '../../../store/json.js';` at the top):

```ts
let lastSweepStartedAt = 0;
let sweepInFlight = false;
let warnedUnusable = false;

/** The scheduler-facing entry: called every 15 s tick, does work at most once
 *  per sweepMinutes, never overlapping. `summarizeOverride` is test-only. */
export async function runMemorySweepTick(
  now: Date,
  summarizeOverride?: SummarizeFn
): Promise<void> {
  const config = await loadConfig();
  if (!config.memory) return; // subsystem off — zero cost
  const resolved = resolveMemoryConfig(config);
  if (!resolved) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      console.warn(
        '[memory] memory config is set but unusable (unknown provider, claude-code provider, or missing model) — sweeps disabled until fixed'
      );
    }
    return;
  }
  warnedUnusable = false;
  if (sweepInFlight) return;
  if (now.getTime() - lastSweepStartedAt < resolved.sweepMinutes * 60_000) return;
  lastSweepStartedAt = now.getTime();
  sweepInFlight = true;
  try {
    const res = await sweepMemory(resolved, summarizeOverride ?? makeSummarizer(resolved));
    if (res.calls > 0 || res.budgetSkipped > 0) {
      console.log(
        `[memory] sweep: scanned=${res.scanned} calls=${res.calls} summarized=${res.summarized} budget-skipped=${res.budgetSkipped}`
      );
    }
  } catch (err) {
    console.error('[memory] sweep failed:', err);
  } finally {
    sweepInFlight = false;
  }
}

export const __memorySweepTesting = {
  reset(): void {
    lastSweepStartedAt = 0;
    sweepInFlight = false;
    warnedUnusable = false;
  },
};
```

Then wire it into `packages/cli/src/cli/web/scheduler.ts` — add the import:

```ts
import { runMemorySweepTick } from './scheduler/memory_sweep.js';
```

and, inside `runSchedulerTick()` right after the task-heartbeat block:

```ts
    // Memory sweep (session digests) — self-gated to at most one run per sweepMinutes.
    await runMemorySweepTick(now).catch((err) => {
      console.error('[scheduler] Memory sweep tick failed:', err);
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli test && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/memory_sweep.ts packages/cli/src/cli/web/scheduler/memory_sweep.test.ts packages/cli/src/cli/web/scheduler.ts
git commit -m "feat(memory): gated sweep tick wired as the scheduler's fourth loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: docs + changeset

**Files:**
- Modify: `CLAUDE.md` (scheduler section + State on disk)
- Create: `.changeset/memory-daemon-step1.md`

- [ ] **Step 1: Update CLAUDE.md**

In section “### 5. Scheduler”, change “runs **three** loops” to “runs **four** loops” and append a fourth bullet after the autonomous-task one:

```markdown
- **Memory sweep** (`scheduler/memory_sweep.ts`): step 1 of the memory
  subsystem (spec: `docs/superpowers/specs/2026-08-24-memory-daemon-step1-design.md`).
  Gated on `memory` in `caretaker.json` (`MemoryConfig`: `provider` — a
  provider *name*, claude-code rejected since fresh calls need an HTTP
  endpoint — `model`, `sweepMinutes` default 5, `minNewMessages` default 4;
  unset = off, zero cost). At most one sweep per `sweepMinutes` (in-process
  interval + overlap gates), the sweep walks `sessions/<agentId>/*.jsonl`
  from disk — sessions written by any surface are picked up — and maintains
  one `SessionDigest` per session in the folder DB: a cursor
  (`lastMessageId`/`messageCount`) plus a rolling summary produced by a
  one-shot call on the memory model (`title.ts` pattern, thinking dropped,
  tool results truncated). New messages go to the model in chunks under a
  char budget with the cursor persisted per chunk (crash loses at most one
  chunk); at most `MAX_CALLS_PER_SWEEP` (10) model calls per sweep, the rest
  waits. `scannedAt` is written **only when a digest is fully caught up**,
  which is what makes the cheap mtime skip (`fileMtime < scannedAt`) sound —
  a budget/failure stop keeps the gate open. The whole collection is a
  regenerable cache: deleting it costs one full re-scan, nothing else (also
  the future SQLite migration story). Failures are best-effort per session,
  never blocking. No settings UI in this step; config is hand-edited.
```

In “### State on disk”, point 3, mention the new collection: after the Tasks/TaskMessages description add “, and **SessionDigests** (per-session memory cursor + rolling summary maintained by the scheduler's memory sweep — a regenerable cache, see layer 5)”.

- [ ] **Step 2: Create the changeset**

`.changeset/memory-daemon-step1.md`:

```markdown
---
'@hyperwindmill/caretaker-cli': minor
---

Memory subsystem step 1: a scheduler memory-sweep loop maintaining a per-session cursor and rolling summary (`session_digests` collection), configured via the new `memory` key (`MemoryConfig` in caretaker-types). Off unless configured.
```

- [ ] **Step 3: Full workspace check**

Run: `pnpm build && pnpm test`
Expected: all packages build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .changeset/memory-daemon-step1.md
git commit -m "docs: memory sweep as the scheduler's fourth loop; changeset

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
