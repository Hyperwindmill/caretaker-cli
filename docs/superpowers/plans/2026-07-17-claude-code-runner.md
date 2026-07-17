# Claude Code Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code (`claude -p`, stream-json) as an optional runner, selected via a new provider type, working on every surface including the autonomous task system (via an HTTP MCP bridge for the task tools).

**Architecture:** The abstraction is the existing `run(RunOptions, RunCallbacks): Promise<RunResult>` contract of `harness/loop.ts`. A new `harness/claude_code_runner.ts` implements it a second time; `loop.ts` gains a single `provider.type === 'claude-code'` dispatch at the top of `run()`. The web server exposes the built-in `mcp__task__*` tools over a token-guarded streamable-HTTP MCP endpoint so claude-code agents can drive the task state machine.

**Tech Stack:** TypeScript ESM, Node built-in test runner via tsx, Hono + @hono/node-server, `@modelcontextprotocol/sdk` ^1.29.0 (already a dependency — client AND server side), React (webview-ui), Ink (TUI).

**Spec:** `docs/superpowers/specs/2026-07-17-claude-code-runner-design.md` (read it first).

## Global Constraints

- pnpm ≥10 monorepo; run commands from repo root.
- Tests: Node test runner via tsx (`pnpm -F caretaker-cli exec tsx --test <file>`). Tests do NOT type-check — always run `pnpm -F caretaker-cli typecheck` before claiming done.
- Test env isolation: mutate `process.env.CARETAKER_HOME` at FILE level only (top of file, before imports resolve paths), never per-describe. Accessors (`dataDir()` etc.) resolve at call time.
- Atomic-write policy for persisted state: tmp file + rename (+ Windows retry); never direct `writeFile` on the destination.
- ESM only, `moduleResolution: bundler`, TS strict (`noImplicitAny: false`). Import specifiers end in `.js`.
- All code/comments in English.
- UI copy for the extra-usage note (verbatim, used in both provider forms): `Uses your local Claude Code session; Anthropic may bill programmatic use as extra usage.`
- Claude CLI flags verified against v2.1.207: `-p`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--model`, `--permission-mode` (choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `-r/--resume`, `--no-session-persistence`. There is NO `--max-turns`.
- Real captured fixtures already exist at `packages/cli/src/harness/fixtures/claude_code_stream_text.jsonl` and `claude_code_stream_tooluse.jsonl` (sanitized real `claude -p` output). Never hand-invent stream-json shapes; read the fixtures.
- Every task ends with a commit. One changeset (minor) at the end (Task 12).

---

### Task 1: Provider/agent type extensions

**Files:**
- Modify: `packages/types/src/index.ts:1-5` (ProviderConfig) and `:222-260` (AgentConfig)

**Interfaces:**
- Produces: `ProviderConfig.type?: 'openai' | 'claude-code'`, `ProviderConfig.command?: string`, `AgentConfig.permissionMode?: string`. Every later task relies on these exact names.

- [ ] **Step 1: Extend the types**

Replace the `ProviderConfig` block at `packages/types/src/index.ts:1-5` with:

```ts
export type ProviderConfig = {
  name: string;
  /** Runner kind. Absent = 'openai' (OpenAI-compatible HTTP endpoint). */
  type?: 'openai' | 'claude-code';
  /** OpenAI-compatible base URL. Unused when type === 'claude-code'. */
  endpoint: string;
  apiKey?: string;
  /** claude-code only: path to the Claude Code CLI binary. Default: 'claude' from PATH. */
  command?: string;
};
```

In `AgentConfig` (after the `mcpServers?` field, before the plugin-managed origin section) add:

```ts
  /** claude-code providers only: Claude Code permission mode passed as
   *  --permission-mode. Unset = detect from ~/.claude/settings.json
   *  permissions.defaultMode, falling back to 'acceptEdits'. Unattended
   *  runs (scheduler/tasks) force 'bypassPermissions' regardless. */
  permissionMode?: string;
```

Note: `endpoint` stays required (`string`) so all existing call sites keep compiling; claude-code providers store `endpoint: ''`.

- [ ] **Step 2: Verify**

Run: `pnpm -F caretaker-types build && pnpm -F caretaker-cli typecheck`
Expected: both pass (additive optional fields).

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "feat(types): provider type/command and agent permissionMode for claude-code runner"
```

---

### Task 2: stream-json parser

**Files:**
- Create: `packages/cli/src/harness/claude_code_stream.ts`
- Test: `packages/cli/src/harness/claude_code_stream.test.ts`
- Read (fixtures): `packages/cli/src/harness/fixtures/claude_code_stream_text.jsonl`, `claude_code_stream_tooluse.jsonl`

**Interfaces:**
- Consumes: `AssistantUsage` from `./provider.js`, `AssistantPart` from `../session/types.js`.
- Produces: `parseClaudeStreamLine(line: string): ClaudeStreamEvent[]` and the `ClaudeStreamEvent` union — Task 4 consumes both.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/harness/claude_code_stream.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeStreamLine, type ClaudeStreamEvent } from './claude_code_stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string[] =>
  readFileSync(path.join(here, 'fixtures', name), 'utf8').split('\n').filter(Boolean);

function parseAll(lines: string[]): ClaudeStreamEvent[] {
  return lines.flatMap((l) => parseClaudeStreamLine(l));
}

test('text fixture: init, text deltas, assistant message, result', () => {
  const events = parseAll(fixture('claude_code_stream_text.jsonl'));
  const init = events.find((e) => e.kind === 'init');
  assert.ok(init && init.kind === 'init' && init.sessionId.length > 10);
  const text = events.filter((e) => e.kind === 'text').map((e: any) => e.text).join('');
  assert.ok(text.toLowerCase().includes('ok'));
  const thinking = events.filter((e) => e.kind === 'thinking');
  assert.ok(thinking.length > 0);
  const result = events.find((e) => e.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.equal(result.isError, false);
  assert.ok(result.usage && result.usage.output > 0);
});

test('tooluse fixture: tool_use, tool_result, assistant parts, cost', () => {
  const events = parseAll(fixture('claude_code_stream_tooluse.jsonl'));
  const toolUses = events.filter((e) => e.kind === 'assistant_message')
    .flatMap((e: any) => e.parts.filter((p: any) => p.type === 'tool_use'));
  assert.ok(toolUses.length >= 2, `expected >=2 tool_use, got ${toolUses.length}`);
  assert.ok(toolUses.every((p: any) => typeof p.id === 'string' && typeof p.name === 'string'));
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  assert.equal(toolResults.length, toolUses.length);
  assert.ok(toolResults.every((e: any) => typeof e.content === 'string'));
  const result = events.find((e) => e.kind === 'result') as any;
  assert.ok(typeof result.costUsd === 'number' && result.costUsd > 0);
  // every assistant_message event carries the message id for merging
  const am = events.filter((e) => e.kind === 'assistant_message') as any[];
  assert.ok(am.every((e) => typeof e.id === 'string' && e.id.length > 0));
});

test('garbage and unknown lines yield no events', () => {
  assert.deepEqual(parseClaudeStreamLine('not json'), []);
  assert.deepEqual(parseClaudeStreamLine(''), []);
  assert.deepEqual(parseClaudeStreamLine('{"type":"system","subtype":"status"}'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_stream.test.ts`
Expected: FAIL — cannot find module `./claude_code_stream.js`.

- [ ] **Step 3: Implement the parser**

Create `packages/cli/src/harness/claude_code_stream.ts`. IMPORTANT: before finalizing, open both fixture files and confirm every field path you read exists there (event shapes below were derived from the real fixtures).

```ts
// Parser for `claude -p --output-format stream-json --verbose
// --include-partial-messages` output. One JSON object per line.
// Derived from real captured fixtures in ./fixtures/ — do not "fix"
// field paths from memory; check the fixtures.

import type { AssistantUsage } from './provider.js';
import type { AssistantPart } from '../session/types.js';

export type ClaudeStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'assistant_message';
      /** Anthropic message id — events for the same message id must be merged. */
      id: string;
      /** Blocks contained in THIS event (Claude Code emits one event per completed block). */
      parts: AssistantPart[];
      usage?: AssistantUsage;
    }
  | { kind: 'tool_result'; toolUseId: string; content: string }
  | {
      kind: 'result';
      subtype: string;
      text: string;
      usage?: AssistantUsage;
      costUsd?: number;
      isError: boolean;
    };

function mapUsage(u: any): AssistantUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const usage: AssistantUsage = {
    input: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
  };
  if (typeof u.cache_read_input_tokens === 'number') usage.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number')
    usage.cacheWrite = u.cache_creation_input_tokens;
  return usage;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

export function parseClaudeStreamLine(rawLine: string): ClaudeStreamEvent[] {
  const line = rawLine.trim();
  if (!line) return [];
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init' && typeof obj.session_id === 'string') {
        return [{ kind: 'init', sessionId: obj.session_id }];
      }
      return [];
    case 'stream_event': {
      const ev = obj.event;
      if (ev?.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
          return [{ kind: 'text', text: d.text }];
        }
        if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length > 0) {
          return [{ kind: 'thinking', text: d.thinking }];
        }
      }
      return [];
    }
    case 'assistant': {
      const msg = obj.message;
      if (!msg || !Array.isArray(msg.content)) return [];
      const parts: AssistantPart[] = [];
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          parts.push({ type: 'thinking', text: block.thinking });
        } else if (block?.type === 'tool_use') {
          parts.push({ type: 'tool_use', id: block.id, name: block.name, args: block.input });
        }
      }
      if (parts.length === 0) return [];
      return [
        {
          kind: 'assistant_message',
          id: typeof msg.id === 'string' ? msg.id : '',
          parts,
          usage: mapUsage(msg.usage),
        },
      ];
    }
    case 'user': {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return [];
      const out: ClaudeStreamEvent[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          out.push({
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            content: textFromToolResultContent(block.content),
          });
        }
      }
      return out;
    }
    case 'result':
      return [
        {
          kind: 'result',
          subtype: typeof obj.subtype === 'string' ? obj.subtype : '',
          text: typeof obj.result === 'string' ? obj.result : '',
          usage: mapUsage(obj.usage),
          costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
          isError: obj.is_error === true || String(obj.subtype ?? '').startsWith('error'),
        },
      ];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_stream.test.ts`
Expected: 3 passing. If an assertion about fixture content fails, inspect the fixture line by line and adjust the PARSER (not the fixture).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -F caretaker-cli typecheck`

```bash
git add packages/cli/src/harness/claude_code_stream.ts packages/cli/src/harness/claude_code_stream.test.ts packages/cli/src/harness/fixtures/
git commit -m "feat(harness): stream-json parser for claude-code runner (real fixtures)"
```

---

### Task 3: Session meta — persist the Claude Code session id

**Files:**
- Modify: `packages/cli/src/session/types.ts:25-32` (SessionMetaRecord)
- Modify: `packages/cli/src/session/store.ts` (new export)
- Test: `packages/cli/src/session/store.test.ts` (extend existing file if present, else create)

**Interfaces:**
- Produces: `SessionMetaRecord.claudeSessionId?: string`; `updateClaudeSessionId(meta: Pick<SessionMetaRecord,'agentId'|'id'>, claudeSessionId: string): Promise<void>` in `session/store.ts`. Task 4 reads `readSession(...).meta.claudeSessionId` and calls `updateClaudeSessionId`.

- [ ] **Step 1: Write the failing test**

Add to the session store test file (respect FILE-level env isolation — if a `store.test.ts` exists it already sets `CARETAKER_HOME` at file top; otherwise create a new file `packages/cli/src/session/claude_session_id.test.ts` with its own tmp `CARETAKER_HOME` set at file scope BEFORE other imports run):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccsid-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, readSession, listForAgent, updateClaudeSessionId } from './store.js';

test('claudeSessionId round-trips via appended meta (latest wins)', async () => {
  const meta = await createSession({ agentId: 'a1', title: 'hello world' });
  assert.equal((await readSession('a1', meta.id)).meta.claudeSessionId, undefined);
  await updateClaudeSessionId(meta, 'cc-session-123');
  const after = await readSession('a1', meta.id);
  assert.equal(after.meta.claudeSessionId, 'cc-session-123');
  // second update replaces
  await updateClaudeSessionId(meta, 'cc-session-456');
  assert.equal((await readSession('a1', meta.id)).meta.claudeSessionId, 'cc-session-456');
  // session listing still works (first-meta index unaffected)
  const list = await listForAgent('a1');
  assert.equal(list.length, 1);
  assert.equal(list[0].meta.title, 'hello world');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/session/claude_session_id.test.ts`
Expected: FAIL — `updateClaudeSessionId` is not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/session/types.ts` add to `SessionMetaRecord`:

```ts
  /** Claude Code CLI session id for claude-code runner agents; the next
   *  turn resumes it via `claude -p --resume <id>`. */
  claudeSessionId?: string;
```

In `packages/cli/src/session/store.ts` add (near `updateTitle`). `readSession` already applies "latest meta line wins" (store.ts:159-161), so appending a fresh meta record is sufficient and append-only — reuse the same appending mechanism `appendMessage` uses (same file path helper + `fs.appendFile` of one JSON line):

```ts
/** Persist the Claude Code session id by appending a fresh meta line
 *  (readSession picks the latest meta; listForAgent keeps using the first). */
export async function updateClaudeSessionId(
  meta: Pick<SessionMetaRecord, 'agentId' | 'id'>,
  claudeSessionId: string,
): Promise<void> {
  const current = await readSession(meta.agentId, meta.id);
  const record: SessionMetaRecord = { ...current.meta, claudeSessionId };
  await appendRecordLine(meta.agentId, meta.id, record);
}
```

Where `appendRecordLine` is whatever internal helper `appendMessage` uses to append one JSON line to `<sessions>/<agentId>/<id>.jsonl` — if `appendMessage` inlines it, extract the two lines into a small internal function used by both. Do NOT rewrite the file; append only.

- [ ] **Step 4: Run tests**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/session/claude_session_id.test.ts` → PASS
Run: `pnpm -F caretaker-cli exec tsx --test "packages/cli/src/session/*.test.ts"` → all pass (no regressions)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F caretaker-cli typecheck
git add packages/cli/src/session/
git commit -m "feat(session): persist claude-code session id on session meta"
```

---

### Task 4: MCP passthrough helper — resolved server runtime config

**Files:**
- Modify: `packages/cli/src/mcp/client.ts`
- Test: `packages/cli/src/mcp/resolved_runtime.test.ts`

**Interfaces:**
- Consumes: internal `decryptHeaders` (client.ts:42), `expandRecord`/`expandArray` (client.ts:65-81), `readOAuthBlob` from `./oauth_store.js`.
- Produces: `resolvedServerRuntime(server: McpServerConfig): Promise<ResolvedServerRuntime | null>` where

```ts
export type ResolvedServerRuntime =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };
```

Task 5's `buildMcpConfig` consumes this.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/mcp/resolved_runtime.test.ts` (file-scope `CARETAKER_HOME` to a tmp dir like Task 3, BEFORE importing anything that touches `dataDir()` — encryption key lives there):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-mcprt-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt } from '../lib/encryption.js';
import { resolvedServerRuntime } from './client.js';
import type { McpServerConfig } from '../types.js';

test('stdio server resolves to plain command/args/env', async () => {
  const s: McpServerConfig = {
    id: 's1', name: 's1', transport: 'stdio', enabled: true,
    command: 'npx', args: ['-y', 'some-server'], env: { FOO: 'bar' },
  };
  const r = await resolvedServerRuntime(s);
  assert.deepEqual(r, { type: 'stdio', command: 'npx', args: ['-y', 'some-server'], env: { FOO: 'bar' } });
});

test('http server decrypts headers', async () => {
  const s: McpServerConfig = {
    id: 's2', name: 's2', transport: 'http', enabled: true,
    url: 'https://example.com/mcp',
    headers: { Authorization: encrypt('Bearer sekret') },
  };
  const r = await resolvedServerRuntime(s);
  assert.equal(r?.type, 'http');
  assert.equal((r as any).headers.Authorization, 'Bearer sekret');
});

test('disabled server resolves to null', async () => {
  const s: McpServerConfig = { id: 's3', name: 's3', transport: 'stdio', enabled: false, command: 'x' };
  assert.equal(await resolvedServerRuntime(s), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/mcp/resolved_runtime.test.ts`
Expected: FAIL — `resolvedServerRuntime` not exported.

- [ ] **Step 3: Implement in client.ts**

Add to `packages/cli/src/mcp/client.ts`, reusing the module's existing internal helpers exactly as `openClient()` does (decrypt → `${VAR}` expansion → plugin-root expansion). For http servers with `oauthState`, read the blob via `readOAuthBlob(server)` and, when an access token exists, add `Authorization: Bearer <token>`; if the server has `oauthState` but no readable token, return `null` (callers log and skip — Claude Code can't drive our OAuth refresh):

```ts
export type ResolvedServerRuntime =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

/** Resolve a configured server into the plaintext runtime shape an external
 *  consumer (Claude Code --mcp-config) needs. Applies the same decrypt/expand
 *  pipeline openClient() uses. Returns null for disabled servers and for
 *  OAuth servers without a current access token. */
export async function resolvedServerRuntime(
  server: McpServerConfig,
): Promise<ResolvedServerRuntime | null> {
  if (!server.enabled) return null;
  if (server.transport === 'stdio') {
    if (!server.command) return null;
    return {
      type: 'stdio',
      command: server.command,
      ...(server.args ? { args: expandArray(server.args, server) } : {}),
      ...(server.env ? { env: expandRecord(server.env, server) } : {}),
    };
  }
  if (!server.url) return null;
  const headers = expandRecord(decryptHeaders(server.headers ?? {}), server);
  if (server.oauthState) {
    const blob = await readOAuthBlob(server).catch(() => null);
    const token = blob?.tokens?.access_token;
    if (!token) return null;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return {
    type: 'http',
    url: expandString(server.url, server),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}
```

Match the REAL internal helper names/signatures in client.ts (the exploration found `decryptHeaders(headers)` at :42 and `expandRecord`/`expandArray` around :65-81; a single-string expander may be named differently — reuse whatever `openClient` uses for `server.url` at :133). Do not duplicate logic; if a helper is scoped inside `openClient`, lift it to module scope.

- [ ] **Step 4: Run tests**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/mcp/resolved_runtime.test.ts` → PASS
Run: `pnpm -F caretaker-cli exec tsx --test "packages/cli/src/mcp/*.test.ts"` → no regressions

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F caretaker-cli typecheck
git add packages/cli/src/mcp/
git commit -m "feat(mcp): resolvedServerRuntime for external mcp-config consumers"
```

---

### Task 5: The runner — `claude_code_runner.ts`

**Files:**
- Create: `packages/cli/src/harness/claude_code_runner.ts`
- Test: `packages/cli/src/harness/claude_code_runner.test.ts`

**Interfaces:**
- Consumes: `RunOptions`, `RunCallbacks`, `RunResult` from `./loop.js` (Task 6 adds `RunOptions.claudeCode` — implement against the shape below; Task 6 lands the field); `parseClaudeStreamLine` (Task 2); `readSession`, `updateClaudeSessionId`, `assistantMessage`, `toolMessage` from `../session/store.js` (Task 3); `loadContextFiles`, `formatContextBlock`, `resolveFileReferences` from `./context_files.js`; `resolvedServerRuntime` (Task 4); `loadMcpServers` from `../store/json.js`.
- Produces:
  - `runClaudeCode(opts: RunOptions, cb?: RunCallbacks): Promise<RunResult>` — Task 6 dispatches to it.
  - `buildClaudeArgs(i: ClaudeArgsInput): string[]` (pure, exported for tests).
  - `detectClaudeDefaultPermissionMode(settingsPath?: string): string | null`.
  - `claudeCodeTaskExtras(p: { planning: boolean; sdd: boolean; bridge?: { url: string; token: string } }): ClaudeCodeRunExtras` — Task 9 consumes.
  - `type ClaudeCodeRunExtras = { permissionMode?: string; allowedTools?: string[]; disallowedTools?: string[]; extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> }` — Task 6 references this type for `RunOptions.claudeCode`.
  - Test hooks `__setSpawn(fn)` / `__resetSpawn()` (same pattern as loop.ts `__setFetch`).

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/harness/claude_code_runner.test.ts`. Strategy: file-scope tmp `CARETAKER_HOME`; a `FakeChild` (EventEmitter + PassThrough stdout/stderr + writable stdin) that replays a fixture file line-by-line on next tick, then emits `close`; `__setSpawn` captures `(command, args, opts)`.

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccrun-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runClaudeCode, buildClaudeArgs, detectClaudeDefaultPermissionMode,
  claudeCodeTaskExtras, __setSpawn, __resetSpawn,
} from './claude_code_runner.js';
import { createSession, readSession } from '../session/store.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const provider: ProviderConfig = { name: 'cc', type: 'claude-code', endpoint: '' };
const agent: AgentConfig = {
  id: 'ag1', name: 'A', systemPrompt: 'You are A.', provider: 'cc',
  model: 'sonnet', allowedTools: [], maxTurns: 30,
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  stdinData = '';
  constructor(private fixtureLines: string[], private exitCode = 0) {
    super();
    this.stdin.on('data', (d) => (this.stdinData += String(d)));
    this.stdin.on('finish', () => {
      setImmediate(() => {
        for (const l of this.fixtureLines) this.stdout.write(l + '\n');
        this.stdout.end();
        this.emit('close', this.exitCode);
      });
    });
  }
  kill() { this.killed = true; this.emit('close', null); return true; }
}

const fixtureLines = (name: string) =>
  readFileSync(path.join(here, 'fixtures', name), 'utf8').split('\n').filter(Boolean);

let lastSpawn: { command: string; args: string[]; opts: any } | null = null;
function useFixture(name: string, exitCode = 0): () => FakeChild {
  let child!: FakeChild;
  __setSpawn((command: string, args: string[], opts: any) => {
    lastSpawn = { command, args, opts };
    child = new FakeChild(fixtureLines(name), exitCode);
    return child as any;
  });
  return () => child;
}

afterEach(() => { __resetSpawn(); lastSpawn = null; });

test('buildClaudeArgs: full flag surface', () => {
  const args = buildClaudeArgs({
    model: 'sonnet', permissionMode: 'acceptEdits', appendSystemPrompt: 'SYS',
    allowedTools: ['Read', 'mcp__task'], disallowedTools: ['Bash'],
    mcpConfigPath: '/tmp/x.json', resumeId: 'abc', persistSession: true,
  });
  assert.deepEqual(args, [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', 'sonnet', '--permission-mode', 'acceptEdits',
    '--append-system-prompt', 'SYS',
    '--allowedTools', 'Read', 'mcp__task', '--disallowedTools', 'Bash',
    '--mcp-config', '/tmp/x.json', '--strict-mcp-config',
    '--resume', 'abc',
  ]);
  const oneShot = buildClaudeArgs({ model: 'sonnet', persistSession: false });
  assert.ok(oneShot.includes('--no-session-persistence'));
  assert.ok(!oneShot.includes('--resume'));
});

test('runClaudeCode maps stream to callbacks, messages, RunResult', async () => {
  useFixture('claude_code_stream_tooluse.jsonl');
  const chunks: string[] = []; const toolCalls: any[] = []; const toolResults: any[] = [];
  const messages: any[] = []; const thinking: string[] = [];
  const result = await runClaudeCode(
    { agent, provider, tools: [], prompt: 'read package.json', workingDir: process.cwd() },
    {
      onChunk: (c) => chunks.push(c),
      onThinking: (t) => thinking.push(t),
      onToolCall: (id, name, args) => toolCalls.push({ id, name, args }),
      onToolResult: (id, content) => toolResults.push({ id, content }),
      onMessage: (m) => { messages.push(m); },
    },
  );
  assert.equal(result.stop, 'done');
  assert.equal(result.toolCalls, 2);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolResults.length, 2);
  assert.ok(result.text.length > 0);
  assert.ok(result.usage.output > 0);
  // one assistant record per anthropic message id + one tool record per tool_result
  const assistantRecords = messages.filter((m) => m.role === 'assistant');
  const toolRecords = messages.filter((m) => m.role === 'tool');
  assert.equal(toolRecords.length, 2);
  assert.ok(assistantRecords.length >= 2);
  assert.ok(assistantRecords.some((m) => m.parts?.some((p: any) => p.type === 'tool_use')));
  // prompt travels via stdin, not argv
  assert.ok(!lastSpawn!.args.includes('read package.json'));
});

test('session resume: persists claudeSessionId and passes --resume next turn', async () => {
  const meta = await createSession({ agentId: agent.id, title: 't' });
  useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode({ agent, provider, tools: [], prompt: 'hi', sessionId: meta.id }, {});
  const stored = (await readSession(agent.id, meta.id)).meta.claudeSessionId;
  assert.ok(stored && stored.length > 10);
  assert.ok(!lastSpawn!.args.includes('--resume'));
  useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode({ agent, provider, tools: [], prompt: 'again', sessionId: meta.id }, {});
  const i = lastSpawn!.args.indexOf('--resume');
  assert.ok(i >= 0);
  assert.equal(lastSpawn!.args[i + 1], stored);
});

test('no sessionId: history folded into prompt, --no-session-persistence set', async () => {
  useFixture('claude_code_stream_text.jsonl');
  const getChild = useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode(
    {
      agent, provider, tools: [], prompt: 'continue',
      history: [
        { v: 1, type: 'message', id: 'm1', role: 'user', content: 'earlier question', createdAt: 'x' } as any,
        { v: 1, type: 'message', id: 'm2', role: 'assistant', content: 'earlier answer', createdAt: 'x' } as any,
      ],
    },
    {},
  );
  assert.ok(lastSpawn!.args.includes('--no-session-persistence'));
  assert.ok(getChild().stdinData.includes('earlier question'));
  assert.ok(getChild().stdinData.includes('continue'));
});

test('non-zero exit throws with stderr tail', async () => {
  useFixture('claude_code_stream_text.jsonl', 1);
  await assert.rejects(
    () => runClaudeCode({ agent, provider, tools: [], prompt: 'x' }, {}),
    /claude.*exited/i,
  );
});

test('abort kills the child and returns stop=aborted', async () => {
  const ac = new AbortController();
  __setSpawn(() => {
    const child = new FakeChild([], 0);
    // never end stdin flow; abort must resolve the run
    (child.stdin as any).on('finish', () => {});
    setImmediate(() => ac.abort());
    return child as any;
  });
  // Note: FakeChild replays on stdin finish; here we rely on kill() emitting close.
  const result = await runClaudeCode({ agent, provider, tools: [], prompt: 'x', signal: ac.signal }, {});
  assert.equal(result.stop, 'aborted');
});

test('detectClaudeDefaultPermissionMode reads permissions.defaultMode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ct-ccset-'));
  const p = path.join(dir, 'settings.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.equal(detectClaudeDefaultPermissionMode(p), 'bypassPermissions');
  assert.equal(detectClaudeDefaultPermissionMode(path.join(dir, 'missing.json')), null);
});

test('claudeCodeTaskExtras: developer / planner / planner+sdd', () => {
  const bridge = { url: 'http://127.0.0.1:3000/api/mcp/task', token: 'tok' };
  const dev = claudeCodeTaskExtras({ planning: false, sdd: false, bridge });
  assert.equal(dev.permissionMode, 'bypassPermissions');
  assert.equal(dev.extraMcpServers?.task.url, bridge.url);
  assert.equal(dev.extraMcpServers?.task.headers?.Authorization, 'Bearer tok');
  const plan = claudeCodeTaskExtras({ planning: true, sdd: false, bridge });
  assert.equal(plan.permissionMode, 'manual');
  assert.deepEqual(plan.allowedTools, ['Read', 'Glob', 'Grep', 'mcp__task']);
  assert.deepEqual(plan.disallowedTools, ['Bash']);
  const sdd = claudeCodeTaskExtras({ planning: true, sdd: true, bridge });
  assert.deepEqual(sdd.allowedTools, [
    'Read', 'Glob', 'Grep', 'mcp__task',
    'Write(**/*.md)', 'Edit(**/*.md)', 'MultiEdit(**/*.md)',
  ]);
  const noBridge = claudeCodeTaskExtras({ planning: false, sdd: false });
  assert.equal(noBridge.extraMcpServers, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

Create `packages/cli/src/harness/claude_code_runner.ts`:

```ts
// Claude Code runner: implements the same run() contract as loop.ts by
// spawning one `claude -p --output-format stream-json` process per turn.
// Claude Code owns the agentic loop, tools, and permissions; caretaker
// owns display persistence (via cb.onMessage) and session continuity
// (claudeSessionId on the session meta, resumed with --resume).

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunCallbacks, RunResult } from './loop.js';
import type { AssistantUsage } from './provider.js';
import { parseClaudeStreamLine } from './claude_code_stream.js';
import { loadContextFiles, formatContextBlock, resolveFileReferences } from './context_files.js';
import { readSession, updateClaudeSessionId, assistantMessage, toolMessage } from '../session/store.js';
import type { AssistantPart, MessageRecord } from '../session/types.js';
import { loadMcpServers } from '../store/json.js';
import { resolvedServerRuntime } from '../mcp/client.js';

export type ClaudeCodeRunExtras = {
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
};

// ─── test hooks (same pattern as loop.ts __setFetch) ────────────────────
type SpawnFn = typeof nodeSpawn;
let spawnImpl: SpawnFn = nodeSpawn;
export function __setSpawn(fn: SpawnFn): void { spawnImpl = fn; }
export function __resetSpawn(): void { spawnImpl = nodeSpawn; }

export function detectClaudeDefaultPermissionMode(
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): string | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const mode = raw?.permissions?.defaultMode;
    return typeof mode === 'string' && mode.length > 0 ? mode : null;
  } catch {
    return null;
  }
}

export interface ClaudeArgsInput {
  model?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfigPath?: string;
  resumeId?: string;
  persistSession: boolean;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (i.model) args.push('--model', i.model);
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  if (i.appendSystemPrompt) args.push('--append-system-prompt', i.appendSystemPrompt);
  if (i.allowedTools?.length) args.push('--allowedTools', ...i.allowedTools);
  if (i.disallowedTools?.length) args.push('--disallowedTools', ...i.disallowedTools);
  if (i.mcpConfigPath) args.push('--mcp-config', i.mcpConfigPath, '--strict-mcp-config');
  if (i.resumeId) args.push('--resume', i.resumeId);
  else if (!i.persistSession) args.push('--no-session-persistence');
  return args;
}

/** Role restrictions + task-bridge wiring for autonomous task runs. */
export function claudeCodeTaskExtras(p: {
  planning: boolean;
  sdd: boolean;
  bridge?: { url: string; token: string };
}): ClaudeCodeRunExtras {
  const extraMcpServers = p.bridge
    ? { task: { type: 'http' as const, url: p.bridge.url, headers: { Authorization: `Bearer ${p.bridge.token}` } } }
    : undefined;
  if (!p.planning) return { permissionMode: 'bypassPermissions', extraMcpServers };
  // Planner: 'manual' mode + explicit allowlist. In -p mode unanswered
  // permission prompts are denied, so everything off-list is blocked.
  // (Not 'plan' mode: it could also block mcp task_submit_plan.)
  const allowedTools = ['Read', 'Glob', 'Grep', 'mcp__task'];
  if (p.sdd) allowedTools.push('Write(**/*.md)', 'Edit(**/*.md)', 'MultiEdit(**/*.md)');
  return { permissionMode: 'manual', allowedTools, disallowedTools: ['Bash'], extraMcpServers };
}

async function buildMcpConfigFile(
  serverIds: string[],
  extra: ClaudeCodeRunExtras['extraMcpServers'],
): Promise<{ configPath: string; cleanup: () => Promise<void> } | null> {
  const servers: Record<string, unknown> = {};
  if (serverIds.length > 0) {
    const file = await loadMcpServers();
    for (const id of serverIds) {
      const cfg = file.servers.find((s) => s.id === id);
      if (!cfg) continue;
      const resolved = await resolvedServerRuntime(cfg).catch(() => null);
      if (!resolved) {
        console.warn(`[claude-code] skipping MCP server "${id}" (disabled or no usable credentials)`);
        continue;
      }
      servers[id] = resolved;
    }
  }
  for (const [name, def] of Object.entries(extra ?? {})) servers[name] = def;
  if (Object.keys(servers).length === 0) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caretaker-mcp-'));
  const configPath = path.join(dir, 'mcp-config.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return { configPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function foldHistory(history: MessageRecord[] | undefined, prompt: string): string {
  if (!history?.length) return prompt;
  const lines = history
    .filter((m) => m.role !== 'tool')
    .map((m) => `[${m.role}] ${m.content}`);
  return `<conversation-history>\n${lines.join('\n')}\n</conversation-history>\n\n${prompt}`;
}

const zeroUsage = (): AssistantUsage => ({ input: 0, output: 0 });
function addUsage(into: AssistantUsage, u: AssistantUsage): void {
  into.input += u.input;
  into.output += u.output;
  if (u.cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + u.cacheRead;
  if (u.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + u.cacheWrite;
}

export async function runClaudeCode(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  const { agent, provider } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const safeEmit = async (fn: (() => void | Promise<void>) | undefined) => {
    try { await fn?.(); } catch (err) { console.warn('[claude-code] callback error:', err); }
  };

  // 1. Resume id from session meta (chat surfaces pass sessionId).
  let resumeId: string | undefined;
  if (opts.sessionId) {
    try { resumeId = (await readSession(agent.id, opts.sessionId)).meta.claudeSessionId; } catch { /* new session */ }
  }

  // 2. --append-system-prompt: agent identity + non-CLAUDE.md context files
  //    (Claude Code auto-loads CLAUDE.md itself; AGENTS.md/GEMINI.md and
  //    ~/.caretaker/AGENTS.md it does not — verified on CLI 2.1.207).
  const sys = await resolveFileReferences(agent.systemPrompt ?? '', workingDir);
  const ctxEntries = (await loadContextFiles(workingDir)).filter(
    (e) => path.basename(e.path) !== 'CLAUDE.md',
  );
  const appendSystemPrompt = [sys, ctxEntries.length ? formatContextBlock(ctxEntries) : '']
    .filter(Boolean)
    .join('\n\n');

  // 3. Per-run mcp-config temp file (agent's servers + injected bridge).
  const mcp = await buildMcpConfigFile(agent.mcpServers ?? [], opts.claudeCode?.extraMcpServers);

  const permissionMode =
    opts.claudeCode?.permissionMode ??
    agent.permissionMode ??
    detectClaudeDefaultPermissionMode() ??
    'acceptEdits';

  const args = buildClaudeArgs({
    model: agent.model,
    permissionMode,
    appendSystemPrompt: appendSystemPrompt || undefined,
    allowedTools: opts.claudeCode?.allowedTools,
    disallowedTools: opts.claudeCode?.disallowedTools,
    mcpConfigPath: mcp?.configPath,
    resumeId,
    persistSession: Boolean(opts.sessionId),
  });
  // History only folds into the prompt when there is no CC session to resume.
  const prompt = resumeId ? opts.prompt : foldHistory(opts.history, opts.prompt);
  const command = provider.command || 'claude';

  const cumulative = zeroUsage();
  let text = '';
  let toolCalls = 0;
  let claudeSessionId: string | undefined;
  let resultEvent: { subtype: string; text: string; usage?: AssistantUsage; isError: boolean } | undefined;
  let aborted = false;
  let stderrTail = '';

  // Assistant events arrive one block per event, sharing the message id;
  // merge them and flush one MessageRecord per anthropic message.
  let pending: { id: string; parts: AssistantPart[]; usage?: AssistantUsage } | null = null;
  const flushPending = async () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    for (const part of p.parts) if (part.type === 'text') text += part.text;
    if (p.usage) {
      addUsage(cumulative, p.usage);
      await safeEmit(() => cb.onUsage?.(p.usage!));
    }
    await safeEmit(() => cb.onMessage?.(assistantMessage(p.parts, p.usage)));
  };

  try {
    const child = spawnImpl(command, args, {
      cwd: workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const onAbort = () => { aborted = true; child.kill('SIGTERM'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + String(d)).slice(-4096);
    });

    const spawnError: Promise<never> = new Promise((_, reject) =>
      child.on('error', (err) => reject(new Error(`claude-code runner failed to start "${command}": ${err.message}`))),
    );
    const closed: Promise<number | null> = new Promise((resolve) =>
      child.on('close', (code) => resolve(code)),
    );

    child.stdin?.write(prompt);
    child.stdin?.end();

    const rl = createInterface({ input: child.stdout! });
    const reading = (async () => {
      for await (const line of rl) {
        for (const evt of parseClaudeStreamLine(line)) {
          switch (evt.kind) {
            case 'init':
              claudeSessionId = evt.sessionId;
              break;
            case 'text':
              await safeEmit(() => cb.onChunk?.(evt.text));
              break;
            case 'thinking':
              await safeEmit(() => cb.onThinking?.(evt.text));
              break;
            case 'assistant_message': {
              if (pending && pending.id !== evt.id) await flushPending();
              if (!pending) pending = { id: evt.id, parts: [], usage: undefined };
              pending.parts.push(...evt.parts);
              if (evt.usage) pending.usage = evt.usage; // latest event wins per message
              for (const part of evt.parts) {
                if (part.type === 'tool_use') {
                  toolCalls += 1;
                  await safeEmit(() => cb.onToolCall?.(part.id, part.name, part.args));
                }
              }
              break;
            }
            case 'tool_result':
              await flushPending();
              await safeEmit(() => cb.onToolResult?.(evt.toolUseId, evt.content));
              await safeEmit(() => cb.onMessage?.(toolMessage(evt.toolUseId, evt.content)));
              break;
            case 'result':
              await flushPending();
              resultEvent = evt;
              break;
          }
        }
      }
    })();

    const exitCode = await Promise.race([Promise.all([reading, closed]).then(([, c]) => c), spawnError]);
    await flushPending();
    opts.signal?.removeEventListener('abort', onAbort);

    if (aborted) return { text, toolCalls, usage: cumulative, stop: 'aborted' };
    if (exitCode !== 0) {
      throw new Error(
        `claude-code runner: "${command}" exited with code ${exitCode}` +
          (stderrTail ? `: ${stderrTail.trim()}` : ' (is Claude Code installed and authenticated?)'),
      );
    }
    if (resultEvent?.usage) {
      // The result event's usage is authoritative for the whole run.
      cumulative.input = resultEvent.usage.input;
      cumulative.output = resultEvent.usage.output;
      if (resultEvent.usage.cacheRead !== undefined) cumulative.cacheRead = resultEvent.usage.cacheRead;
      if (resultEvent.usage.cacheWrite !== undefined) cumulative.cacheWrite = resultEvent.usage.cacheWrite;
    }
    if (opts.sessionId && claudeSessionId && claudeSessionId !== resumeId) {
      try {
        await updateClaudeSessionId({ agentId: agent.id, id: opts.sessionId }, claudeSessionId);
      } catch (err) {
        console.warn('[claude-code] failed to persist session id:', err);
      }
    }
    if (resultEvent?.isError) {
      if (resultEvent.subtype === 'error_max_turns') {
        return { text, toolCalls, usage: cumulative, stop: 'max_turns' };
      }
      throw new Error(`claude-code runner: ${resultEvent.subtype || 'error'}${resultEvent.text ? `: ${resultEvent.text}` : ''}`);
    }
    return { text, toolCalls, usage: cumulative, stop: 'done' };
  } finally {
    await mcp?.cleanup().catch(() => {});
  }
}
```

Adjust the `RunOptions.claudeCode` reference: until Task 6 lands, type it locally as `(opts as RunOptions & { claudeCode?: ClaudeCodeRunExtras })` or land Task 6's `RunOptions` field in the same commit — preferred: do the small `loop.ts` type addition here (field only, no dispatch), leaving Task 6 to add the dispatch. Add to `RunOptions` in `loop.ts`:

```ts
  /** claude-code runner extras (ignored by the native loop): permission
   *  mode override, tool allow/deny rules, extra per-run MCP servers. */
  claudeCode?: import('./claude_code_runner.js').ClaudeCodeRunExtras;
```

Note on the abort test: `FakeChild.kill()` emits `close(null)`; the runner treats `aborted === true` before inspecting the exit code, so `null` never reaches the error path.

- [ ] **Step 4: Run tests**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts`
Expected: all passing. Debug against the fixtures (e.g. the tooluse fixture has exactly 2 tool_use / 2 tool_result pairs and a final text message).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F caretaker-cli typecheck
git add packages/cli/src/harness/claude_code_runner.ts packages/cli/src/harness/claude_code_runner.test.ts packages/cli/src/harness/loop.ts
git commit -m "feat(harness): claude-code runner implementing the run() contract"
```

---

### Task 6: Dispatch in `run()` + title guard

**Files:**
- Modify: `packages/cli/src/harness/loop.ts:105-108` (top of `run()`)
- Modify: `packages/cli/src/harness/title.ts:25-30`
- Test: `packages/cli/src/harness/claude_code_dispatch.test.ts`, extend `packages/cli/src/harness/title.test.ts`

**Interfaces:**
- Consumes: `runClaudeCode` (Task 5).
- Produces: `run()` transparently routes claude-code providers — every surface (TUI, web, VSCode, headless, dispatch, scheduler) picks the runner up with zero changes.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/harness/claude_code_dispatch.test.ts` (file-scope tmp `CARETAKER_HOME` as in Task 5):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccdisp-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './loop.js';
import { __setSpawn, __resetSpawn } from './claude_code_runner.js';
// reuse the FakeChild pattern from claude_code_runner.test.ts (copy the class)

afterEach(() => __resetSpawn());

test('run() dispatches claude-code providers to the runner', async () => {
  let spawnedArgs: string[] | null = null;
  __setSpawn(((cmd: string, args: string[]) => {
    spawnedArgs = args;
    return new FakeChild(fixtureLines('claude_code_stream_text.jsonl')) as any;
  }) as any);
  const result = await run(
    {
      agent: { id: 'a', name: 'a', systemPrompt: '', provider: 'cc', model: 'sonnet', allowedTools: [], maxTurns: 30 },
      provider: { name: 'cc', type: 'claude-code', endpoint: '' },
      tools: [],
      prompt: 'hi',
    },
    {},
  );
  assert.equal(result.stop, 'done');
  assert.ok(spawnedArgs && spawnedArgs[0] === '-p');
});
```

Extend `packages/cli/src/harness/title.test.ts`:

```ts
test('generateTitle returns null for claude-code providers', async () => {
  const title = await generateTitle({
    agent: { id: 'a', name: 'a', systemPrompt: '', provider: 'cc', model: 'sonnet', allowedTools: [], maxTurns: 30 },
    provider: { name: 'cc', type: 'claude-code', endpoint: '' },
    firstUserPrompt: 'hello',
    firstAssistantText: 'world',
  });
  assert.equal(title, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run both test files. Expected: dispatch test fails (loop tries `provider.endpoint.replace` on `''` and issues a fetch, or errors); title test fails (it attempts a fetch against an empty endpoint — must return null immediately instead).

- [ ] **Step 3: Implement**

In `loop.ts` `run()` — the FIRST statement, before `provider.endpoint` is touched (currently line 107):

```ts
export async function run(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  if (opts.provider.type === 'claude-code') {
    // Single dispatch point: claude-code providers get the whole loop
    // replaced by the Claude Code CLI (see claude_code_runner.ts).
    const { runClaudeCode } = await import('./claude_code_runner.js');
    return runClaudeCode(opts, cb);
  }
  const { agent, provider, tools, prompt } = opts;
  // ... existing body unchanged
```

(Dynamic import avoids a static cycle: claude_code_runner imports types from loop.)

In `title.ts` `generateTitle()`, first line of the function body:

```ts
  if (input.provider.type === 'claude-code') return null; // no HTTP endpoint; keep fallback title
```

- [ ] **Step 4: Run tests**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/claude_code_dispatch.test.ts packages/cli/src/harness/title.test.ts packages/cli/src/harness/loop.test.ts`
Expected: all pass (loop.test.ts guards no regression on the native path).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F caretaker-cli typecheck
git add packages/cli/src/harness/
git commit -m "feat(harness): dispatch run() to claude-code runner; skip AI titles for claude-code"
```

---

### Task 7: Task-tools MCP bridge on the web server

**Files:**
- Create: `packages/cli/src/cli/web/mcp_bridge.ts`
- Modify: `packages/cli/src/cli/web/server.ts` (mount route ~line 590, set base URL after `serve()` at ~line 600)
- Test: `packages/cli/src/cli/web/mcp_bridge.test.ts`

**Interfaces:**
- Consumes: `tools` registry from `../../harness/tools/instance.js`; SDK server classes.
- Produces (all from `mcp_bridge.ts`):
  - `issueBridgeToken(): string` / `revokeBridgeToken(token: string): void`
  - `registerTaskBridge(app: Hono): void` — mounts `POST /api/mcp/task`
  - `setTaskBridgeUrl(url: string): void` / `getTaskBridgeUrl(): string | null`
  Task 9 consumes token functions and `getTaskBridgeUrl`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/cli/web/mcp_bridge.test.ts`. Serve a minimal Hono app on an ephemeral port and drive it with the SDK **client** (already a dependency):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-bridge-'));

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerTaskBridge, issueBridgeToken, revokeBridgeToken } from './mcp_bridge.js';
import { registerBuiltins } from '../../harness/tools/index.js';
import { tools } from '../../harness/tools/instance.js';

let server: ReturnType<typeof serve>;
let baseUrl: string;

before(async () => {
  registerBuiltins(tools); // idempotent guard: skip if instance.ts already registers
  const app = new Hono();
  registerTaskBridge(app);
  server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${(address as any).port}`;
});
after(() => server.close());

function client(token: string) {
  return {
    transport: new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp/task`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
    mcp: new Client({ name: 'test', version: '0.0.0' }),
  };
}

test('rejects missing/invalid token', async () => {
  const { transport, mcp } = client('nope');
  await assert.rejects(() => mcp.connect(transport));
});

test('lists task tools without the mcp__task__ prefix', async () => {
  const token = issueBridgeToken();
  const { transport, mcp } = client(token);
  await mcp.connect(transport);
  const { tools: listed } = await mcp.listTools();
  const names = listed.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.includes('task_complete'));
  assert.ok(names.includes('task_submit_plan'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));
  await mcp.close();
  revokeBridgeToken(token);
});

test('calls a task tool end-to-end', async () => {
  const token = issueBridgeToken();
  const { transport, mcp } = client(token);
  await mcp.connect(transport);
  // project_list works on an empty store and proves execute() plumbs through
  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');
  await mcp.close();
  revokeBridgeToken(token);
});

test('revoked token is rejected', async () => {
  const token = issueBridgeToken();
  revokeBridgeToken(token);
  const { transport, mcp } = client(token);
  await assert.rejects(() => mcp.connect(transport));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/cli/web/mcp_bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bridge**

Create `packages/cli/src/cli/web/mcp_bridge.ts`:

```ts
// Exposes the built-in mcp__task__* tools as a streamable-HTTP MCP endpoint
// so claude-code agents can drive the task state machine. Token-guarded:
// the task heartbeat issues a per-run bearer token and revokes it after.
// Stateless MCP (no session): a fresh Server per request. The task tools
// are context-free (they take task_id as an argument), so no per-run
// injection is needed.

import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../../harness/tools/instance.js';
import type { Tool, ToolContext } from '../../harness/tools/index.js';

const TASK_PREFIX = 'mcp__task__';
const activeTokens = new Set<string>();

export function issueBridgeToken(): string {
  const token = randomBytes(24).toString('hex');
  activeTokens.add(token);
  return token;
}
export function revokeBridgeToken(token: string): void {
  activeTokens.delete(token);
}

let bridgeUrl: string | null = null;
export function setTaskBridgeUrl(url: string): void { bridgeUrl = url; }
export function getTaskBridgeUrl(): string | null { return bridgeUrl; }

function taskTools(): Tool[] {
  return registry.list().filter((t) => t.name.startsWith(TASK_PREFIX));
}

function buildServer(): Server {
  const server = new Server(
    { name: 'caretaker-task', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: taskTools().map((t) => ({
      name: t.name.slice(TASK_PREFIX.length),
      description: t.description,
      inputSchema: t.parameters as any,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = taskTools().find((t) => t.name === TASK_PREFIX + req.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Error: unknown tool "${req.params.name}"` }], isError: true };
    }
    // ponytail: task tools ignore ctx entirely; a stub keeps the types happy.
    const ctx = { workingDir: process.cwd(), signal: new AbortController().signal } as unknown as ToolContext;
    try {
      const result = await tool.execute((req.params.arguments ?? {}) as any, ctx);
      return { content: [{ type: 'text', text: result.content }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
    }
  });
  return server;
}

export function registerTaskBridge(app: Hono): void {
  app.post('/api/mcp/task', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || !activeTokens.has(token)) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,      // plain JSON responses, no SSE needed
    });
    await server.connect(transport);
    const { incoming, outgoing } = (c.env ?? {}) as any; // @hono/node-server bindings
    await transport.handleRequest(incoming, outgoing, body);
    const { RESPONSE_ALREADY_SENT } = await import('@hono/node-server/utils/response');
    return RESPONSE_ALREADY_SENT as any;
  });
}
```

Implementation notes for the executor:
- The exact import path for `RESPONSE_ALREADY_SENT` depends on the @hono/node-server version — check `node_modules/@hono/node-server/dist` (it is exported from the package root in ≥1.13 / 2.x: `import { RESPONSE_ALREADY_SENT } from '@hono/node-server'`). Use the root export if available.
- If `registerBuiltins(tools)` is already invoked by `instance.ts` at import time (check `packages/cli/src/harness/tools/instance.ts`), drop that line from the test.
- SDK API drift: if `StreamableHTTPServerTransport` options differ in the installed 1.29.x, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and adapt — the stateless + JSON-response mode is documented there.

In `server.ts`:
- Import `registerTaskBridge`, `setTaskBridgeUrl` from `./mcp_bridge.js`.
- Call `registerTaskBridge(app);` next to `app.route('/api/fs', fsRouter)` (line ~188).
- After `serve({...})` (line ~596-600): `setTaskBridgeUrl(\`http://127.0.0.1:${port}/api/mcp/task\`);`

- [ ] **Step 4: Run tests**

Run: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/cli/web/mcp_bridge.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F caretaker-cli typecheck
git add packages/cli/src/cli/web/
git commit -m "feat(web): token-guarded streamable-HTTP MCP bridge exposing task tools"
```

---

### Task 8: Unattended runs force bypassPermissions

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/heartbeat.ts:118` (agent arg of `harness.run`)
- Modify: `packages/cli/src/cli/web/scheduler/telegram.ts:292` (same)
- Modify: `packages/cli/src/cli/web/scheduler/task_review.ts:55-67` (same, inside `runDoneReview`)
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts:183` (fold into `effectiveAgent`)

**Interfaces:**
- Consumes: `AgentConfig.permissionMode` (Task 1). Unconditional — the native loop ignores the field, so no `provider.type` check is needed.

- [ ] **Step 1: Apply the four spreads**

In each of the four `harness.run(...)` call sites, replace the `agent:` value with a spread forcing the mode. Example for `task_strategy.ts` (the `effectiveAgent` construction at line ~183):

```ts
const effectiveAgent = {
  ...agent,
  allowedTools: [...new Set([...(agent.allowedTools ?? []), 'mcp__task__*'])],
  permissionMode: 'bypassPermissions', // unattended: mirror the auto-approve confirm gate
};
```

For `heartbeat.ts` / `telegram.ts` / `task_review.ts`, where `agent` is passed directly: `agent: { ...agent, permissionMode: 'bypassPermissions' }` (task_review: `agent: { ...opts.agent, permissionMode: 'bypassPermissions' }`).

- [ ] **Step 2: Run existing scheduler tests + typecheck**

Run: `pnpm -F caretaker-cli exec tsx --test "packages/cli/src/cli/web/scheduler/*.test.ts" && pnpm -F caretaker-cli typecheck`
Expected: pass (behavioral no-op for native providers).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/
git commit -m "feat(scheduler): unattended runs force claude-code bypassPermissions"
```

---

### Task 9: Task heartbeat + review integration (claude-code branch)

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (around lines 156-282 and the `runReviewCycle`/`runDoneReview` invocation)
- Modify: `packages/cli/src/cli/web/scheduler/task_review.ts` (accept optional `claudeCode` extras)
- Test: extend `packages/cli/src/cli/web/scheduler/task_strategy.test.ts` if present; the extras helper itself is already covered by Task 5's tests.

**Interfaces:**
- Consumes: `claudeCodeTaskExtras` (Task 5), `issueBridgeToken`/`revokeBridgeToken`/`getTaskBridgeUrl` (Task 7), `RunOptions.claudeCode` (Task 5/6).

- [ ] **Step 1: Wire the developer/planner cycle in `task_strategy.ts`**

After the provider lookup (line ~156-160) and the planning/sdd resolution (lines ~197-204), add ONE branch around the `harness.run` call (lines ~257-282):

```ts
import { claudeCodeTaskExtras } from '../../../harness/claude_code_runner.js';
import { issueBridgeToken, revokeBridgeToken, getTaskBridgeUrl } from '../mcp_bridge.js';
```

```ts
const isClaudeCode = provider?.type === 'claude-code';
let bridgeToken: string | undefined;
let claudeCode: RunOptions['claudeCode'];
if (isClaudeCode) {
  const bridgeUrl = getTaskBridgeUrl();
  bridgeToken = bridgeUrl ? issueBridgeToken() : undefined;
  claudeCode = claudeCodeTaskExtras({
    planning,
    sdd,
    bridge: bridgeUrl && bridgeToken ? { url: bridgeUrl, token: bridgeToken } : undefined,
  });
  if (!bridgeUrl) {
    console.warn('[tasks] claude-code agent without task bridge URL — task tools unavailable this run');
  }
}
try {
  await harness.run(
    { agent: effectiveAgent, provider, tools, prompt, history: historyRecords, workingDir, claudeCode },
    { /* existing callbacks unchanged */ },
  );
} finally {
  if (bridgeToken) revokeBridgeToken(bridgeToken);
}
```

Keep the existing `filterPlannerTools` call as-is (it still governs native providers; the claude-code runner ignores `tools`).

- [ ] **Step 2: Wire the reviewer in `task_review.ts`**

`runDoneReview` gets the branch too — reviewer runs with bypass and NO task bridge (parity with the `mcp__task__*` strip; the agent's own `mcpServers` still pass through inside the runner):

```ts
const claudeCode =
  opts.provider.type === 'claude-code' ? { permissionMode: 'bypassPermissions' as const } : undefined;
const result = await harness.run(
  {
    agent: { ...opts.agent, permissionMode: 'bypassPermissions' },
    provider: opts.provider,
    tools: reviewTools,
    prompt: reviewPrompt(opts.objective, opts.branch, opts.round),
    history: [],
    workingDir: opts.workingDir,
    ...(claudeCode ? { claudeCode } : {}),
  },
  { confirmTool: async () => 'once' },
);
```

(If Task 8 already spread `permissionMode` here, keep a single spread — don't duplicate.)

- [ ] **Step 3: Run scheduler tests + typecheck**

Run: `pnpm -F caretaker-cli exec tsx --test "packages/cli/src/cli/web/scheduler/*.test.ts" && pnpm -F caretaker-cli typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/
git commit -m "feat(tasks): claude-code agents get role flags and the task MCP bridge"
```

---

### Task 10: Webview UI — provider type + agent permission mode

**Files:**
- Modify: `packages/webview-ui/src/ProvidersTab.tsx`
- Modify: `packages/webview-ui/src/AgentsTab.tsx`

**Interfaces:**
- Consumes: `ProviderConfig.type/command`, `AgentConfig.permissionMode` (Task 1). No bridge contract changes (`saveConfig`/`saveAgent` pass objects through as `isRecord`).

- [ ] **Step 1: ProvidersTab — type select, conditional fields, note**

Add state `const [type, setType] = useState<'openai' | 'claude-code'>('openai');` and `const [command, setCommand] = useState('');` (initialize from `editingProvider` in the edit path). Render a select above Name:

```tsx
<label>Type</label>
<select value={type} onChange={(e) => setType(e.target.value as any)}>
  <option value="openai">OpenAI-compatible endpoint</option>
  <option value="claude-code">Claude Code (local CLI)</option>
</select>
```

When `type === 'claude-code'`: hide the Endpoint and API Key inputs; show instead an optional Command input (placeholder `claude`) and the note (muted text, styled like existing helper text):

```tsx
<p className="hint">Uses your local Claude Code session; Anthropic may bill programmatic use as extra usage.</p>
```

In `validateAndSave` (lines ~46-105): gate the endpoint-required and `new URL(endpoint)` checks on `type !== 'claude-code'`. Build the record as:

```ts
const rec: ProviderConfig =
  type === 'claude-code'
    ? { name, type, endpoint: '', ...(command.trim() ? { command: command.trim() } : {}) }
    : { name, endpoint, ...(apiKey ? { apiKey } : {}) };
```

- [ ] **Step 2: AgentsTab — permission mode select, hide native-only pickers, static models**

Derive the selected provider's type: `const providerType = config.providers.find((p: any) => p.name === provider)?.type ?? 'openai';` and `const isClaudeCode = providerType === 'claude-code';`

- Add state `const [permissionMode, setPermissionMode] = useState('');` (initialize from `agent.permissionMode ?? ''` in `startEdit`).
- When `isClaudeCode`:
  - Model field: keep the free-text input, hide the Fetch button, placeholder `sonnet | opus | haiku (or full model id)`.
  - Hide: tool tri-state picker block (lines ~342-412), plugins block (~414-436), Max Turns input (~285-296). KEEP the MCP servers block (passthrough works).
  - Show instead of the tool picker:

```tsx
<label>Permission mode</label>
<select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
  <option value="">Auto (Claude Code default from ~/.claude/settings.json)</option>
  {['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'].map((m) => (
    <option key={m} value={m}>{m}</option>
  ))}
</select>
<p className="hint">
  Claude Code uses its own tools and permissions. Uses your local Claude Code session;
  Anthropic may bill programmatic use as extra usage.
</p>
```

- In `validateAndSave`: when `isClaudeCode`, include `...(permissionMode ? { permissionMode } : {})` in the built `AgentConfig` and keep `allowedTools: []` / omit `plugins`; `maxTurns` keeps its previous value (hidden, ignored at runtime).

- [ ] **Step 3: Build + verify**

Run: `pnpm -F webview-ui build && pnpm -F caretaker-cli typecheck && pnpm -F caretaker-vscode build`
Expected: clean builds.
Then a quick live check: `CARETAKER_HOME=/tmp/ct-ccui pnpm -F caretaker-cli dev web`, open http://127.0.0.1:3000, create a "Claude Code" provider and an agent on it; confirm the form swaps (no endpoint/apiKey; permission-mode select; note visible).

- [ ] **Step 4: Commit**

```bash
git add packages/webview-ui/src/
git commit -m "feat(webview): claude-code provider type and agent permission-mode UI"
```

---

### Task 11: TUI forms

**Files:**
- Modify: `packages/cli/src/tui/providers.tsx` (ProviderForm, lines ~174-267; detail view ~113-142)
- Modify: `packages/cli/src/tui/agents.tsx` (FormStep union ~404-413, ModelStep ~721-778, save ~503-507)

- [ ] **Step 1: ProviderForm — type step**

Extend the step machine to `'type' | 'name' | 'endpoint' | 'apiKey' | 'command'`, starting at `'type'` (a `SelectInput` with the two options, matching existing Ink form patterns in the file). Flow: `type → name → (openai: endpoint → apiKey) | (claude-code: command)`. `submit` builds the same shapes as Task 10 Step 1. Detail view: for claude-code providers show `type: claude-code` and `command` instead of endpoint/apiKey. Render the extra-usage note line in the claude-code branch of the form (same copy as Global Constraints).

- [ ] **Step 2: Agent form — skip native-only steps, add permissionMode**

In `agents.tsx`: derive `isClaudeCode` from the chosen provider. `ModelStep`: when claude-code, skip `fetchOpenAiStyleModels` and go straight to the manual `TextInput` with hint `sonnet | opus | haiku (or full model id)`. Step sequencing: when claude-code, skip the tools/plugins/maxTurns steps and insert a `permissionMode` `SelectInput` step (items: `Auto (Claude Code default)` → `''`, plus the six modes). Save: include `permissionMode` when set; `allowedTools: []`.

- [ ] **Step 3: Verify**

Run: `pnpm -F caretaker-cli typecheck && pnpm -F caretaker-cli test`
Then manually: `CARETAKER_HOME=/tmp/ct-cctui pnpm -F caretaker-cli dev`, walk provider-create and agent-create flows for both types.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/tui/
git commit -m "feat(tui): claude-code provider and agent form flows"
```

---

### Task 12: End-to-end smoke, docs, changeset

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Create: `.changeset/claude-code-runner.md`

- [ ] **Step 1: Full test suite + builds**

Run: `pnpm test && pnpm build`
Expected: everything green.

- [ ] **Step 2: Live smoke test (real Claude Code)**

With the developer's real `claude` login:

```bash
CARETAKER_HOME=/tmp/ct-ccsmoke pnpm -F caretaker-cli dev web
```

1. Create provider "Claude Code", agent on it (model `haiku`, permission mode Auto).
2. Chat: send "reply ok" → streamed text appears; send a follow-up → confirm continuity (the reply references the first message; `claudeSessionId` visible in the session JSONL under `/tmp/ct-ccsmoke/sessions/`).
3. Ask it to read a file in its workingDir → tool use renders collapsed.
4. Headless: `pnpm -F caretaker-cli dev run "say hi" --agent <name> --output json` → RunResult JSON with `stop: "done"`.
Record any deviation as a bug to fix before proceeding.

- [ ] **Step 3: Update docs**

- `CLAUDE.md`: in layer 2 (agent execution) add a paragraph: providers may be `type: 'claude-code'`; `run()` dispatches to `harness/claude_code_runner.ts` (one `claude -p` stream-json process per turn, `--resume` via `claudeSessionId` on session meta); caretaker tool policy/confirm gate do not apply (Claude Code's own permission modes do; unattended runs force `bypassPermissions`); context files are passed minus CLAUDE.md; task tools reach claude-code agents through the token-guarded `/api/mcp/task` bridge (web server only). In layer 5, note the planner restrictions mapping (`manual` + allowlist; SDD adds `Write/Edit/MultiEdit(**/*.md)`, denies `Bash`).
- `README.md`: user-facing section on the Claude Code provider type (requirements: Claude Code installed + authenticated; the extra-usage note; scheduler/task support requires the web server).

- [ ] **Step 4: Changeset**

Create `.changeset/claude-code-runner.md`:

```md
---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

Claude Code as an optional runner: new provider type `claude-code` runs agents
through `claude -p` (stream-json) on every surface — chat, headless, scheduler,
and autonomous tasks (task tools exposed via a token-guarded HTTP MCP bridge).
Agents on such providers use Claude Code's own tools and permission modes
(new per-agent permission-mode setting; unattended runs force bypassPermissions).
```

(Use the real package names from each package.json if they differ.)

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md README.md .changeset/
git commit -m "docs: claude-code runner architecture + changeset"
```

---

## Self-review checklist (already applied)

- Spec coverage: provider type (T1/T10/T11), runner+dispatch (T5/T6), context-file filtering (T5 §2), permission modes + detection (T5), session resume (T3/T5), MCP passthrough (T4/T5), task bridge + roles (T7/T9), unattended bypass (T8), title fallback (T6), errors (T5), fixtures-from-real-runs (pre-captured), UI note (T10/T11), docs+changeset (T12).
- Known deliberate gaps (spec "out of scope"): no confirm-gate bridge, no plugin passthrough, no cost metering. `get_agent_context` is not exposed to claude-code agents (they have no caretaker tools) — acceptable, documented in CLAUDE.md update.
- Type consistency: `ClaudeCodeRunExtras` defined once in the runner, referenced by `RunOptions.claudeCode`; bridge token API names match between T7 and T9; `updateClaudeSessionId` signature matches T3↔T5.
