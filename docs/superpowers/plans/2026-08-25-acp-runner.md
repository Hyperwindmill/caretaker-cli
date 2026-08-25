# ACP Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider `type: 'acp'` that drives any Agent Client Protocol agent (claude-agent-acp, codex-acp, Google's agy_acp_server, …) as a caretaker runner, side-by-side with the existing claude-code runner.

**Architecture:** A new `harness/acp_runner.ts` implements the same `run()` contract as `claude_code_runner.ts`, dispatched by one check at the top of `loop.ts`. The child ACP process is long-lived per session (pool in `acp_pool.ts`), the permission policy is one pure function for all runners (`acp_policy.ts`), Docker confinement is deny-`execute`-at-the-gate plus a bridge-injected `run_command` tool, and the system prompt is fabricated client-side as content blocks (stable part on the first turn, volatile part per turn).

**Tech Stack:** TypeScript ESM, `@agentclientprotocol/sdk` v1.4 (Apache-2.0), Node built-in test runner via tsx, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-25-acp-runner-design.md`

## Global Constraints

- The existing claude-code runner is **not touched** except where a task says so explicitly (one `export` keyword on `foldHistory`).
- `pnpm -F @hyperwindmill/caretaker-cli typecheck` and `pnpm -F @hyperwindmill/caretaker-cli test` must pass after every task. `pnpm test` runs via tsx and does NOT type-check — always run typecheck too.
- Test files that touch on-disk state set `process.env.CARETAKER_HOME` at FILE scope (before imports), never inside a describe.
- All code/comments in English. Never rewrite commits — new commits only.
- Every persisted-state write follows the atomic tmp+rename policy (no new writes are added by this plan).
- **Spec deviations decided at planning time** (record in the spec in Task 9): (a) the `terminal` client capability is NOT implemented in v1 — without Docker, agent-side shell on the host is the status quo and equivalent; with Docker the capability is absent by design. (b) `fs/read_text_file`/`fs/write_text_file` are NOT advertised in v1 — agent-side fs writes the same bind-mounted worktree files. Both are additive later if an adapter needs them.

## SDK crib sheet (verified against @agentclientprotocol/sdk 1.4.0 d.ts)

- `client({ name }): ClientApp` → `.onRequest('session/request_permission', h)` / `.onNotification('session/update', h)` → `.connect(stream): ClientConnection` (also `.connect(agentApp)` in-process for tests). Handler context: `ctx.params` (typed), `ctx.agent` (ClientContext).
- `ClientConnection.agent: ClientContext` → `.request('initialize'|'session/new'|'session/load'|'session/prompt', params)` / `.notify('session/cancel', {sessionId})`. `ClientConnection.closed: Promise<void>`, `.close()`, `.signal`.
- `ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream` — wrap child stdio with `Writable.toWeb(child.stdin)` / `Readable.toWeb(child.stdout)` from `node:stream`.
- `PROTOCOL_VERSION` exported. Key types (all from the package root): `InitializeResponse` (`agentCapabilities?.loadSession?: boolean`), `NewSessionRequest {cwd, mcpServers}`, `NewSessionResponse {sessionId}`, `LoadSessionRequest {sessionId, cwd, mcpServers}`, `PromptRequest {sessionId, prompt: ContentBlock[]}`, `PromptResponse {stopReason, usage?}`, `StopReason = 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled'`, `SessionNotification {sessionId, update: SessionUpdate}`, `SessionUpdate` discriminated on `sessionUpdate` (`agent_message_chunk`/`agent_thought_chunk` carry `content: ContentBlock`; `tool_call` carries `toolCallId,title,name?,kind?,rawInput?`; `tool_call_update` carries `toolCallId,status?,content?: ToolCallContent[]`), `ToolKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'switch_mode'|'other'`, `RequestPermissionRequest {sessionId, toolCall: ToolCallUpdate, options: PermissionOption[]}`, `PermissionOption {optionId, name, kind: 'allow_once'|'allow_always'|'reject_once'|'reject_always'}`, `RequestPermissionResponse {outcome: {outcome:'cancelled'} | {outcome:'selected', optionId}}`, `McpServer = (McpServerHttp & {type:'http'}) | (McpServerSse & {type:'sse'}) | (McpServerAcp & {type:'acp'}) | McpServerStdio` (stdio is the UNTAGGED variant: `{name, command, args, env: EnvVariable[]}`; http: `{type:'http', name, url, headers: HttpHeader[]}`; `EnvVariable`/`HttpHeader` are `{name, value}`), `Usage {totalTokens, inputTokens, outputTokens, cachedReadTokens?, cachedWriteTokens?}` — **session-cumulative**, per-turn = diff vs previous snapshot.

---

### Task 1: Provider type + SDK dependency

**Files:**
- Modify: `packages/types/src/index.ts:1-10` (ProviderConfig)
- Modify: `packages/cli/package.json` (dependency)
- Modify: `packages/webview-ui/src/ProvidersTab.tsx` — NOT in this task (Task 8)

**Interfaces:**
- Produces: `ProviderConfig.type` now includes `'acp'`; new optional fields `args: string[]`, `env: Record<string,string>`, `selfLoadedContextFiles: string[]`.

- [x] **Step 1: Extend ProviderConfig**

In `packages/types/src/index.ts` replace the ProviderConfig block with:

```ts
export type ProviderConfig = {
  name: string;
  /** Runner kind. Absent = 'openai' (OpenAI-compatible HTTP endpoint). */
  type?: 'openai' | 'claude-code' | 'acp';
  /** OpenAI-compatible base URL. Unused when type === 'claude-code' | 'acp'. */
  endpoint: string;
  apiKey?: string;
  /** claude-code: path to the Claude Code CLI binary (default: 'claude' from PATH).
   *  acp: the ACP agent server executable (required — e.g. 'npx' or an absolute
   *  binary path). */
  command?: string;
  /** acp only: arguments for the spawned ACP agent server,
   *  e.g. ['@agentclientprotocol/claude-agent-acp']. */
  args?: string[];
  /** acp only: extra environment variables for the spawned agent process. */
  env?: Record<string, string>;
  /** acp only: context files the agent already self-loads (skipped from the
   *  fabricated context block), e.g. ['CLAUDE.md'] for claude-agent-acp,
   *  ['AGENTS.md'] for codex-acp. */
  selfLoadedContextFiles?: string[];
};
```

- [x] **Step 2: Add the SDK dependency**

Run: `pnpm -F @hyperwindmill/caretaker-cli add @agentclientprotocol/sdk`
Expected: `@agentclientprotocol/sdk` ^1.4.0 in `packages/cli/package.json` dependencies.

- [x] **Step 3: Typecheck + build types package**

Run: `pnpm -F caretaker-types build && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS (the new fields are optional; no consumer breaks).

- [x] **Step 4: Commit**

```bash
git add packages/types/src/index.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(acp): provider type 'acp' + @agentclientprotocol/sdk dependency"
```

---

### Task 2: Permission policy (`acp_policy.ts`)

**Files:**
- Create: `packages/cli/src/harness/acp_policy.ts`
- Test: `packages/cli/src/harness/acp_policy.test.ts`

**Interfaces:**
- Consumes: SDK types only.
- Produces:
  - `type AcpPolicyMode = 'interactive' | 'unattended' | 'planner' | 'deny-all'`
  - `type AcpRunExtras = { mode?: AcpPolicyMode; sdd?: boolean; extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>; docker?: { container: string; workdir: string } }`
  - `decidePermission(req: RequestPermissionRequest, extras: AcpRunExtras): 'allow' | 'deny' | 'ask'`
  - `buildPermissionResponse(options: PermissionOption[], decision: ConfirmDecision | 'deny'): RequestPermissionResponse` (ConfirmDecision = `'once'|'always'|'reject'` from `./tools/index.js`)
  - `acpTaskExtras(p: { planning: boolean; sdd: boolean; bridge?: { url: string; token: string }; docker?: { container: string; workdir: string } }): AcpRunExtras`

- [x] **Step 1: Write the failing test**

`packages/cli/src/harness/acp_policy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePermission, buildPermissionResponse, acpTaskExtras } from './acp_policy.js';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';

const req = (kind: string | null, locations?: { path: string }[]): RequestPermissionRequest => ({
  sessionId: 's1',
  toolCall: { toolCallId: 't1', kind: kind as any, locations },
  options: [],
});

test('interactive mode asks', () => {
  assert.equal(decidePermission(req('execute'), {}), 'ask');
  assert.equal(decidePermission(req('edit'), { mode: 'interactive' }), 'ask');
});

test('unattended allows everything (no docker)', () => {
  assert.equal(decidePermission(req('execute'), { mode: 'unattended' }), 'allow');
  assert.equal(decidePermission(req('edit'), { mode: 'unattended' }), 'allow');
});

test('docker denies execute in every mode', () => {
  const docker = { container: 'c', workdir: '/w' };
  assert.equal(decidePermission(req('execute'), { mode: 'unattended', docker }), 'deny');
  assert.equal(decidePermission(req('execute'), { mode: 'interactive', docker }), 'deny');
  assert.equal(decidePermission(req('read'), { mode: 'unattended', docker }), 'allow');
});

test('planner denies mutating kinds, allows read/search/other', () => {
  const p = { mode: 'planner' as const };
  for (const k of ['edit', 'delete', 'move', 'execute']) assert.equal(decidePermission(req(k), p), 'deny');
  for (const k of ['read', 'search', 'think', 'fetch', 'other', null]) assert.equal(decidePermission(req(k), p), 'allow');
});

test('planner SDD allows edit only when every location is .md', () => {
  const sdd = { mode: 'planner' as const, sdd: true };
  assert.equal(decidePermission(req('edit', [{ path: '/w/spec.md' }]), sdd), 'allow');
  assert.equal(decidePermission(req('edit', [{ path: '/w/spec.md' }, { path: '/w/a.ts' }]), sdd), 'deny');
  assert.equal(decidePermission(req('edit', []), sdd), 'deny'); // no locations = can't verify = deny
  assert.equal(decidePermission(req('execute'), sdd), 'deny');
});

test('deny-all denies reads too', () => {
  assert.equal(decidePermission(req('read'), { mode: 'deny-all' }), 'deny');
});

const opts: PermissionOption[] = [
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
  { optionId: 'aA', name: 'Always', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];

test('buildPermissionResponse maps decisions to option kinds', () => {
  assert.deepEqual(buildPermissionResponse(opts, 'once').outcome, { outcome: 'selected', optionId: 'a1' });
  assert.deepEqual(buildPermissionResponse(opts, 'always').outcome, { outcome: 'selected', optionId: 'aA' });
  assert.deepEqual(buildPermissionResponse(opts, 'reject').outcome, { outcome: 'selected', optionId: 'r1' });
  assert.deepEqual(buildPermissionResponse(opts, 'deny').outcome, { outcome: 'selected', optionId: 'r1' });
  assert.deepEqual(buildPermissionResponse([], 'deny').outcome, { outcome: 'cancelled' });
});

test('acpTaskExtras shapes the run extras per role', () => {
  const dev = acpTaskExtras({ planning: false, sdd: false, bridge: { url: 'http://b', token: 'T' } });
  assert.equal(dev.mode, 'unattended');
  assert.deepEqual(dev.extraMcpServers, { task: { type: 'http', url: 'http://b', headers: { Authorization: 'Bearer T' } } });
  const plan = acpTaskExtras({ planning: true, sdd: true });
  assert.equal(plan.mode, 'planner');
  assert.equal(plan.sdd, true);
  assert.equal(plan.extraMcpServers, undefined);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_policy.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement `acp_policy.ts`**

```ts
// Permission policy for ACP runs: one pure function replaces the per-runner
// tangle (claude-code CLI flags, native tool filtering). Every ACP
// session/request_permission goes through decidePermission; 'ask' is resolved
// by the caller via the ordinary confirm gate.

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { ConfirmDecision } from './tools/index.js';

export type AcpPolicyMode = 'interactive' | 'unattended' | 'planner' | 'deny-all';

export type AcpRunExtras = {
  /** Permission policy. Default 'interactive' (route to the confirm gate). */
  mode?: AcpPolicyMode;
  /** Planner SDD mode: edits allowed on markdown-only locations. */
  sdd?: boolean;
  /** Extra per-run MCP servers (the task bridge), same shape as claude-code's. */
  extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  /** Docker confinement: 'execute' tool calls are denied (the bridge-injected
   *  run_command tool is the only shell path). */
  docker?: { container: string; workdir: string };
};

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Kinds a planner must never perform. 'other' stays allowed on purpose:
 *  MCP tool calls (task_submit_plan, task_get_state) surface as 'other'. */
const PLANNER_DENIED_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

export function decidePermission(
  req: RequestPermissionRequest,
  extras: AcpRunExtras,
): PermissionDecision {
  const mode = extras.mode ?? 'interactive';
  const kind = req.toolCall.kind ?? 'other';
  // Docker confinement outranks every mode: shell goes through run_command or dies.
  if (extras.docker && kind === 'execute') return 'deny';
  switch (mode) {
    case 'deny-all':
      return 'deny';
    case 'unattended':
      return 'allow';
    case 'planner': {
      if (!PLANNER_DENIED_KINDS.has(kind)) return 'allow';
      if (extras.sdd && kind === 'edit') {
        const locations = req.toolCall.locations ?? [];
        if (locations.length > 0 && locations.every((l) => l.path.endsWith('.md'))) return 'allow';
      }
      return 'deny';
    }
    case 'interactive':
      return 'ask';
  }
}

/** Map a gate decision onto the agent-provided options. Fail-safe: when no
 *  matching option exists, respond 'cancelled' (never invent an optionId). */
export function buildPermissionResponse(
  options: PermissionOption[],
  decision: ConfirmDecision | 'deny',
): RequestPermissionResponse {
  const pick = (kinds: string[]) =>
    kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
  const opt =
    decision === 'reject' || decision === 'deny'
      ? pick(['reject_once', 'reject_always'])
      : decision === 'always'
        ? pick(['allow_always', 'allow_once'])
        : pick(['allow_once', 'allow_always']);
  return opt
    ? { outcome: { outcome: 'selected', optionId: opt.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** Role restrictions + task-bridge wiring for autonomous task runs — the ACP
 *  mirror of claudeCodeTaskExtras. */
export function acpTaskExtras(p: {
  planning: boolean;
  sdd: boolean;
  bridge?: { url: string; token: string };
  docker?: { container: string; workdir: string };
}): AcpRunExtras {
  const extraMcpServers = p.bridge
    ? {
        task: {
          type: 'http' as const,
          url: p.bridge.url,
          headers: { Authorization: `Bearer ${p.bridge.token}` },
        },
      }
    : undefined;
  return { mode: p.planning ? 'planner' : 'unattended', sdd: p.sdd, extraMcpServers, docker: p.docker };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_policy.test.ts`
Expected: PASS. Also run `pnpm -F @hyperwindmill/caretaker-cli typecheck`.

- [x] **Step 5: Commit**

```bash
git add packages/cli/src/harness/acp_policy.ts packages/cli/src/harness/acp_policy.test.ts
git commit -m "feat(acp): permission policy (interactive/unattended/planner/deny-all + docker execute deny)"
```

---

### Task 3: Agent process pool (`acp_pool.ts`)

**Files:**
- Create: `packages/cli/src/harness/acp_pool.ts`
- Test: `packages/cli/src/harness/acp_pool.test.ts`

**Interfaces:**
- Consumes: `AcpRunExtras` shape indirectly (bindings are opaque callbacks), `ProviderConfig`, `mergeShellEnv` from `./tools/builtin/shell-env.js`.
- Produces:
  - `type TurnBinding = { acpSessionId: string | null; onUpdate: (n: SessionNotification) => void | Promise<void>; onPermission: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse> }`
  - `type AcpAgentHandle = { conn: ClientConnection; init: InitializeResponse; binding: { current: TurnBinding | null }; acpSessionId?: string; lastUsage?: Usage; kill: () => void; lastUsed: number }`
  - `acquireAcpAgent(provider: ProviderConfig, poolKey: string | null): Promise<AcpAgentHandle>` — pooled when poolKey is set (reused across turns), ephemeral otherwise
  - `releaseAcpAgent(poolKey: string | null, handle: AcpAgentHandle): void` — kills ephemeral handles, stamps lastUsed on pooled ones
  - `__setConnector(fn) / __resetConnector()` test hooks
  - `__shutdownAcpPool(): void` — kills everything (tests / process exit)

- [x] **Step 1: Write the failing test**

`packages/cli/src/harness/acp_pool.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  acquireAcpAgent,
  releaseAcpAgent,
  __setConnector,
  __resetConnector,
  __shutdownAcpPool,
} from './acp_pool.js';
import type { ProviderConfig } from '../types.js';

const provider: ProviderConfig = { name: 'acp', type: 'acp', endpoint: '', command: 'fake' };

function fakeAgentApp() {
  return agent({ name: 'fake' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }));
}

/** In-process connector: ClientApp.connect(AgentApp) needs no transport. */
function useFakeAgent(app = fakeAgentApp()) {
  let killed = 0;
  __setConnector((_provider, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => { killed += 1; conn.close(); } };
  });
  return { killedCount: () => killed };
}

afterEach(() => {
  __shutdownAcpPool();
  __resetConnector();
});

test('acquire initializes and pools by key; second acquire reuses', async () => {
  useFakeAgent();
  const h1 = await acquireAcpAgent(provider, 'ag1:sess1');
  assert.equal(h1.init.agentCapabilities?.loadSession, true);
  releaseAcpAgent('ag1:sess1', h1);
  const h2 = await acquireAcpAgent(provider, 'ag1:sess1');
  assert.equal(h2, h1); // same handle object
});

test('ephemeral acquire (null key) is killed on release', async () => {
  const fake = useFakeAgent();
  const h = await acquireAcpAgent(provider, null);
  releaseAcpAgent(null, h);
  assert.equal(fake.killedCount(), 1);
});

test('a closed connection is discarded and re-created on next acquire', async () => {
  useFakeAgent();
  const h1 = await acquireAcpAgent(provider, 'k');
  releaseAcpAgent('k', h1);
  h1.conn.close();
  await h1.conn.closed;
  const h2 = await acquireAcpAgent(provider, 'k');
  assert.notEqual(h2, h1);
});

test('missing command errors with a readable message', async () => {
  __resetConnector();
  await assert.rejects(
    () => acquireAcpAgent({ name: 'x', type: 'acp', endpoint: '' }, null),
    /provider "x".*command/i,
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_pool.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement `acp_pool.ts`**

```ts
// ACP agent process pool. Unlike claude -p (one process per turn + --resume),
// an ACP child is long-lived: spawn → initialize → session/new, then N
// session/prompt calls on the same child. One child per caretaker session
// (poolKey = `${agentId}:${sessionId}`); sessionId-less runs (tasks, sweep,
// headless one-shots) get an ephemeral child killed at end of run.
//
// Handlers are registered once per child at client() construction and route
// through a mutable `binding` the runner sets at turn start — turns on one
// session are serialized by the surfaces, so there is no race.

import { spawn as nodeSpawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Usage,
} from '@agentclientprotocol/sdk';
import type { ProviderConfig } from '../types.js';
import { mergeShellEnv } from './tools/builtin/shell-env.js';

export type TurnBinding = {
  /** null until session/new returns (drop nothing: the first updates can only
   *  belong to our session — one child, one session). */
  acpSessionId: string | null;
  onUpdate: (n: SessionNotification) => void | Promise<void>;
  onPermission: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
};

export type AcpAgentHandle = {
  conn: ClientConnection;
  init: InitializeResponse;
  binding: { current: TurnBinding | null };
  /** ACP session id once created/loaded — reused across turns of this handle. */
  acpSessionId?: string;
  /** Last session-cumulative usage snapshot (per-turn usage is the diff). */
  lastUsage?: Usage;
  kill: () => void;
  lastUsed: number;
};

// ─── connector (test hook, same pattern as claude_code_runner __setSpawn) ──
type Connector = (
  provider: ProviderConfig,
  app: ClientApp,
) => { conn: ClientConnection; kill: () => void };

const defaultConnector: Connector = (provider, app) => {
  if (!provider.command) {
    throw new Error(
      `acp runner: provider "${provider.name}" has no command — set the ACP agent server executable (e.g. npx) in the provider settings`,
    );
  }
  const child = nodeSpawn(provider.command, provider.args ?? [], {
    // Same env policy as the claude-code runner: probed interactive-shell PATH
    // merged WITHOUT scrubbing secrets, so env-based auth survives; provider.env on top.
    env: { ...mergeShellEnv(process.env), ...provider.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + String(d)).slice(-4096);
  });
  child.on('error', (err) => {
    console.warn(`[acp] failed to start "${provider.command}": ${err.message}`);
  });
  child.on('close', (code) => {
    if (code !== 0 && code !== null && stderrTail) {
      console.warn(`[acp] "${provider.command}" exited ${code}: ${stderrTail.trim()}`);
    }
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const conn = app.connect(stream);
  return { conn, kill: () => child.kill('SIGTERM') };
};

let connector: Connector = defaultConnector;
export function __setConnector(fn: Connector): void {
  connector = fn;
}
export function __resetConnector(): void {
  connector = defaultConnector;
}

// ─── pool ───────────────────────────────────────────────────────────────
const pool = new Map<string, AcpAgentHandle>();
const IDLE_TTL_MS = 10 * 60_000;
let reaper: NodeJS.Timeout | null = null;

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of pool) {
      if (h.binding.current === null && now - h.lastUsed > IDLE_TTL_MS) {
        pool.delete(key);
        h.kill();
        h.conn.close();
      }
    }
  }, 60_000);
  reaper.unref?.();
}

async function createHandle(provider: ProviderConfig): Promise<AcpAgentHandle> {
  const binding: { current: TurnBinding | null } = { current: null };
  const app = client({ name: 'caretaker' })
    .onNotification('session/update', async (ctx) => {
      const b = binding.current;
      if (!b) return;
      if (b.acpSessionId !== null && ctx.params.sessionId !== b.acpSessionId) return;
      await b.onUpdate(ctx.params);
    })
    .onRequest('session/request_permission', async (ctx) => {
      const b = binding.current;
      // No turn in flight: fail-safe cancel (never allow unattended).
      if (!b) return { outcome: { outcome: 'cancelled' as const } };
      return b.onPermission(ctx.params);
    });
  const { conn, kill } = connector(provider, app);
  const init = await conn.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // v1 deliberately advertises neither fs nor terminal (see spec):
      // agent-side fs writes the same bind-mounted files; shell confinement
      // under docker is deny-execute + the bridge run_command tool.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'caretaker', version: '1' },
  });
  return { conn, init, binding, kill, lastUsed: Date.now() };
}

export async function acquireAcpAgent(
  provider: ProviderConfig,
  poolKey: string | null,
): Promise<AcpAgentHandle> {
  if (poolKey) {
    const existing = pool.get(poolKey);
    if (existing) {
      if (!existing.conn.signal.aborted) {
        existing.lastUsed = Date.now();
        return existing;
      }
      pool.delete(poolKey); // dead child: recreate below
    }
  }
  const handle = await createHandle(provider);
  if (poolKey) {
    pool.set(poolKey, handle);
    ensureReaper();
    // Self-cleanup when the child dies on its own.
    void handle.conn.closed.then(() => {
      if (pool.get(poolKey) === handle) pool.delete(poolKey);
    });
  }
  return handle;
}

export function releaseAcpAgent(poolKey: string | null, handle: AcpAgentHandle): void {
  handle.lastUsed = Date.now();
  if (!poolKey) {
    handle.kill();
    handle.conn.close();
  }
}

export function __shutdownAcpPool(): void {
  for (const [key, h] of pool) {
    pool.delete(key);
    h.kill();
    h.conn.close();
  }
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_pool.test.ts`
Expected: PASS. Note: if `ClientApp.connect(AgentApp)`'s in-process overload behaves differently than documented, adapt the test connector (e.g. create a pair of in-memory streams) — the production code must not change for the test's sake. Also run typecheck.

- [x] **Step 5: Commit**

```bash
git add packages/cli/src/harness/acp_pool.ts packages/cli/src/harness/acp_pool.test.ts
git commit -m "feat(acp): long-lived agent process pool with idle reaper and test connector hook"
```

---

### Task 4: The runner (`acp_runner.ts`)

**Files:**
- Create: `packages/cli/src/harness/acp_runner.ts`
- Modify: `packages/cli/src/harness/claude_code_runner.ts:165` — add `export` to `function foldHistory` (only change to that file)
- Test: `packages/cli/src/harness/acp_runner.test.ts`

**Interfaces:**
- Consumes: `acquireAcpAgent`/`releaseAcpAgent`/`TurnBinding` (Task 3), `decidePermission`/`buildPermissionResponse`/`AcpRunExtras` (Task 2), `foldHistory` (claude_code_runner), `loadContextFiles`/`formatContextBlock`/`resolveFileReferences`, `buildMemoriesBlock`, `VOICE_CONVERSATION_PRELUDE`, `readSession`/`assistantMessage`/`toolMessage` (session/store), `loadMcpServers` + `resolvedServerRuntime`, `updateAcpSessionId` (created in Task 5 — in THIS task import from `../session/store.js` and add the function there as part of this task's store step below).
- Produces: `runAcp(opts: RunOptions, cb?: RunCallbacks): Promise<RunResult>` — same contract as `runClaudeCode`.

Note on ordering: this task also adds `acpSessionId` to `SessionMetaRecord` and `updateAcpSessionId` to the store (2 small edits), because the runner needs them; Task 5 then only wires dispatch + title.

- [x] **Step 1: Store support**

In `packages/cli/src/session/types.ts` after `claudeSessionId?: string;` (line ~34) add:

```ts
  /** ACP session id for acp runner agents; reused across turns and offered
   *  to session/load when the agent supports it. */
  acpSessionId?: string;
```

In `packages/cli/src/session/store.ts`, mirror `updateClaudeSessionId` (line 259) right below it:

```ts
export async function updateAcpSessionId(
  ref: { agentId: string; id: string },
  acpSessionId: string,
): Promise<void> {
  const current = await readSession(ref.agentId, ref.id);
  const record: SessionMetaRecord = { ...current.meta, acpSessionId };
  await writeSessionMeta(ref.agentId, ref.id, record);
}
```

(Copy the exact persistence call used by `updateClaudeSessionId` — read lines 259-266 first and mirror them; the helper name for the final write may differ.)

- [x] **Step 2: Export foldHistory**

In `claude_code_runner.ts:165` change `function foldHistory(` to `export function foldHistory(`.

- [x] **Step 3: Write the failing test**

`packages/cli/src/harness/acp_runner.test.ts` (CARETAKER_HOME at file scope, fake agent in-process via the Task 3 connector hook):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-acprun-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agent as acpAgent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { PromptRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { runAcp } from './acp_runner.js';
import { __setConnector, __resetConnector, __shutdownAcpPool } from './acp_pool.js';
import { createSession, readSession } from '../session/store.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

const provider: ProviderConfig = { name: 'acp', type: 'acp', endpoint: '', command: 'fake' };
const agentCfg: AgentConfig = {
  id: 'ag1',
  name: 'A',
  systemPrompt: 'You are A.',
  provider: 'acp',
  model: '',
  allowedTools: [],
  maxTurns: 30,
};

type PromptHandler = (ctx: any, params: PromptRequest) => Promise<any> | any;
function useFakeAgent(onPrompt: PromptHandler, caps: Record<string, unknown> = {}) {
  const prompts: PromptRequest[] = [];
  const app = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: caps }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }))
    .onRequest('session/prompt', async (ctx: any) => {
      prompts.push(ctx.params);
      return onPrompt(ctx, ctx.params);
    });
  __setConnector((_p, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => conn.close() };
  });
  return { prompts, app };
}

const textUpdate = (text: string) => ({
  sessionId: 'acp-1',
  update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } },
});

afterEach(() => {
  __shutdownAcpPool();
  __resetConnector();
});

test('streams text, returns done, first turn carries the fabricated context block', async () => {
  const { prompts } = useFakeAgent(async (ctx) => {
    await ctx.client.notify('session/update', textUpdate('hel'));
    await ctx.client.notify('session/update', textUpdate('lo'));
    return { stopReason: 'end_turn' };
  });
  const chunks: string[] = [];
  const res = await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'hi' },
    { onChunk: (c) => chunks.push(c) },
  );
  assert.equal(res.text, 'hello');
  assert.equal(res.stop, 'done');
  assert.deepEqual(chunks, ['hel', 'lo']);
  const blocks = prompts[0].prompt;
  const joined = blocks.map((b: any) => b.text).join('\n');
  assert.match(joined, /caretaker-context/);
  assert.match(joined, /You are A\./);
  assert.match(joined, /hi$/);
});

test('permission ask routes to confirmTool; deny-all mode denies without asking', async () => {
  const seen: string[] = [];
  const mkPrompt = (): PromptHandler => async (ctx) => {
    const resp = await ctx.client.request('session/request_permission', {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 't1', kind: 'execute', title: 'run x' },
      options: [
        { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ],
    } satisfies RequestPermissionRequest);
    seen.push(JSON.stringify(resp.outcome));
    return { stopReason: 'end_turn' };
  };
  useFakeAgent(mkPrompt());
  await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'x' },
    { confirmTool: async () => 'reject' },
  );
  assert.match(seen[0], /"optionId":"r1"/);

  __shutdownAcpPool();
  useFakeAgent(mkPrompt());
  await runAcp({ agent: agentCfg, provider, tools: [], prompt: 'x', acp: { mode: 'deny-all' } }, {});
  assert.match(seen[1], /"optionId":"r1"/);
});

test('tool_call + tool_call_update emit callbacks and persistable records', async () => {
  useFakeAgent(async (ctx) => {
    await ctx.client.notify('session/update', {
      sessionId: 'acp-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read file', kind: 'read', rawInput: { path: '/a' } },
    });
    await ctx.client.notify('session/update', {
      sessionId: 'acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
    });
    return { stopReason: 'end_turn' };
  });
  const calls: string[] = [];
  const results: string[] = [];
  const res = await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'x' },
    { onToolCall: (_id, name) => calls.push(name), onToolResult: (_id, c) => results.push(c) },
  );
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(calls, ['Read file']);
  assert.deepEqual(results, ['file body']);
});

test('abort sends session/cancel and returns stop aborted', async () => {
  let cancelled = false;
  const app = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }))
    .onNotification('session/cancel', () => {
      cancelled = true;
    })
    .onRequest('session/prompt', async () => {
      while (!cancelled) await new Promise((r) => setTimeout(r, 5));
      return { stopReason: 'cancelled' };
    });
  __setConnector((_p, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => conn.close() };
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const res = await runAcp({ agent: agentCfg, provider, tools: [], prompt: 'x', signal: ac.signal }, {});
  assert.equal(res.stop, 'aborted');
});

test('sessionId runs persist acpSessionId and reuse the pooled child; second turn has no context block', async () => {
  const { prompts } = useFakeAgent(async () => ({ stopReason: 'end_turn' }));
  const meta = await createSession(agentCfg.id, 'chat');
  const opts = { agent: agentCfg, provider, tools: [], sessionId: meta.id };
  await runAcp({ ...opts, prompt: 'one' }, {});
  const persisted = await readSession(agentCfg.id, meta.id);
  assert.equal(persisted.meta.acpSessionId, 'acp-1');
  await runAcp({ ...opts, prompt: 'two' }, {});
  assert.equal(prompts.length, 2);
  const secondJoined = prompts[1].prompt.map((b: any) => b.text).join('\n');
  assert.ok(!secondJoined.includes('caretaker-context'));
});
```

(Check `createSession`'s real signature in `session/store.ts` before using it — mirror what `claude_code_runner.test.ts` does.)

- [x] **Step 4: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_runner.test.ts`
Expected: FAIL (module not found).

- [x] **Step 5: Implement `acp_runner.ts`**

```ts
// ACP runner: implements the same run() contract as loop.ts by driving an
// Agent Client Protocol agent (claude-agent-acp, codex-acp, agy_acp_server, …)
// over JSON-RPC/stdio. The agent owns the loop and its tools; caretaker owns
// the permission policy (acp_policy.ts), display persistence (cb.onMessage),
// and session continuity (acpSessionId + session/load when supported).
//
// System prompt is fabricated client-side (ACP has no system-prompt field):
// the stable context block (agent systemPrompt + context files minus the
// runner's self-loaded ones — the mirror of claude-code's
// --append-system-prompt) rides the FIRST turn of each ACP session; volatile
// parts (<memories>, voice block) ride every turn. Under ACP the prompt enters
// history and accumulates, hence the split.

import path from 'node:path';
import type {
  ContentBlock,
  PromptResponse,
  SessionNotification,
  McpServer,
  Usage,
} from '@agentclientprotocol/sdk';
import type { RunOptions, RunCallbacks, RunResult } from './loop.js';
import type { AssistantUsage } from './provider.js';
import type { AssistantPart } from '../session/types.js';
import { loadContextFiles, formatContextBlock, resolveFileReferences } from './context_files.js';
import { buildMemoriesBlock } from './memory_recall.js';
import { VOICE_CONVERSATION_PRELUDE } from './prelude.js';
import { foldHistory } from './claude_code_runner.js';
import { decidePermission, buildPermissionResponse, type AcpRunExtras } from './acp_policy.js';
import { acquireAcpAgent, releaseAcpAgent, type AcpAgentHandle } from './acp_pool.js';
import { readSession, updateAcpSessionId, assistantMessage, toolMessage } from '../session/store.js';
import { loadMcpServers } from '../store/json.js';
import { resolvedServerRuntime } from '../mcp/client.js';

const CANCEL_GRACE_MS = 5_000;

/** Agent's configured MCP servers + per-run extras (task bridge) as ACP shapes. */
async function resolveAcpMcpServers(
  serverIds: string[],
  extra: AcpRunExtras['extraMcpServers'],
): Promise<McpServer[]> {
  const out: McpServer[] = [];
  if (serverIds.length > 0) {
    const file = await loadMcpServers();
    for (const id of serverIds) {
      const cfg = file.servers.find((s) => s.id === id);
      if (!cfg) continue;
      const r = await resolvedServerRuntime(cfg).catch(() => null);
      if (!r) {
        console.warn(`[acp] skipping MCP server "${id}" (disabled or no usable credentials)`);
        continue;
      }
      if (r.type === 'stdio') {
        out.push({
          name: id,
          command: r.command,
          args: r.args ?? [],
          env: Object.entries(r.env ?? {}).map(([name, value]) => ({ name, value })),
        });
      } else {
        out.push({
          type: 'http',
          name: id,
          url: r.url,
          headers: Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      }
    }
  }
  for (const [name, def] of Object.entries(extra ?? {})) {
    out.push({
      type: 'http',
      name,
      url: def.url,
      headers: Object.entries(def.headers ?? {}).map(([n, v]) => ({ name: n, value: v })),
    });
  }
  return out;
}

/** Session-cumulative → per-turn usage (clamped; unknown baseline = full total). */
function diffUsage(prev: Usage | undefined, cur: Usage): AssistantUsage {
  const d = (a: number, b: number | undefined) => Math.max(0, a - (b ?? 0));
  const usage: AssistantUsage = {
    input: d(cur.inputTokens, prev?.inputTokens),
    output: d(cur.outputTokens, prev?.outputTokens),
  };
  if (cur.cachedReadTokens != null)
    usage.cacheRead = d(cur.cachedReadTokens, prev?.cachedReadTokens ?? undefined);
  if (cur.cachedWriteTokens != null)
    usage.cacheWrite = d(cur.cachedWriteTokens, prev?.cachedWriteTokens ?? undefined);
  return usage;
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) =>
      c?.type === 'content' && c.content?.type === 'text' ? String(c.content.text) : '',
    )
    .filter(Boolean)
    .join('\n');
}

export async function runAcp(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  const { agent, provider } = opts;
  const extras: AcpRunExtras = opts.acp ?? {};
  const workingDir = opts.workingDir ?? process.cwd();
  const safeEmit = async (fn: (() => void | Promise<void>) | undefined) => {
    try {
      await fn?.();
    } catch (err) {
      console.warn('[acp] callback error:', err);
    }
  };

  // 1. Stable context block (mirror of claude-code's --append-system-prompt,
  //    minus files this runner self-loads).
  const selfLoaded = new Set(provider.selfLoadedContextFiles ?? []);
  const sys = await resolveFileReferences(agent.systemPrompt ?? '', workingDir);
  const ctxEntries = (await loadContextFiles(workingDir)).filter(
    (e) => !selfLoaded.has(path.basename(e.path)),
  );
  const stableBlock = [sys, ctxEntries.length ? formatContextBlock(ctxEntries) : '']
    .filter(Boolean)
    .join('\n\n');

  // 2. Volatile per-turn block.
  const memoriesBlock = opts.skipMemoryRecall
    ? ''
    : await buildMemoriesBlock(opts.prompt, workingDir, opts.memoryProjectId);
  const volatileBlock = [memoriesBlock, opts.voiceConversation ? VOICE_CONVERSATION_PRELUDE : '']
    .filter(Boolean)
    .join('\n\n');

  const mcpServers = await resolveAcpMcpServers(agent.mcpServers ?? [], extras.extraMcpServers);

  // 3. Acquire child (pooled per caretaker session; ephemeral otherwise).
  const poolKey = opts.sessionId ? `${agent.id}:${opts.sessionId}` : null;
  let handle: AcpAgentHandle;
  try {
    handle = await acquireAcpAgent(provider, poolKey);
  } catch (err: any) {
    throw new Error(
      `acp runner failed to start the agent for provider "${provider.name}": ${err?.message ?? err} ` +
        `(is it installed and authenticated? Log in with the agent's own CLI first.)`,
    );
  }

  // 4. Turn accumulation state.
  const parts: AssistantPart[] = [];
  let text = '';
  let toolCalls = 0;
  const pushText = (t: string) => {
    text += t;
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text += t;
    else parts.push({ type: 'text', text: t });
  };

  const onUpdate = async (n: SessionNotification) => {
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') {
          pushText(u.content.text);
          await safeEmit(() => cb.onChunk?.((u.content as any).text));
        }
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') await safeEmit(() => cb.onThinking?.((u.content as any).text));
        break;
      case 'tool_call': {
        toolCalls += 1;
        const name = u.name ?? u.title;
        parts.push({ type: 'tool_use', id: u.toolCallId, name, args: u.rawInput ?? {} });
        await safeEmit(() => cb.onToolCall?.(u.toolCallId, name, u.rawInput ?? {}));
        break;
      }
      case 'tool_call_update': {
        if (u.status === 'completed' || u.status === 'failed') {
          const resultText = extractToolResultText(u.content);
          await safeEmit(() => cb.onToolResult?.(u.toolCallId, resultText));
          await safeEmit(() => cb.onMessage?.(toolMessage(u.toolCallId, resultText)));
        }
        break;
      }
      default:
        break; // plan / usage_update / mode updates: not rendered in v1
    }
  };

  const onPermission = async (req: Parameters<typeof decidePermission>[0]) => {
    const decision = decidePermission(req, extras);
    if (decision === 'allow') return buildPermissionResponse(req.options, 'once');
    if (decision === 'deny') return buildPermissionResponse(req.options, 'deny');
    // 'ask' → the ordinary confirm gate; no gate wired means allow (the caller
    // decides which surfaces gate, same contract as the native loop).
    if (!cb.confirmTool) return buildPermissionResponse(req.options, 'once');
    const name = req.toolCall.name ?? req.toolCall.title ?? 'tool';
    const answer = await cb.confirmTool(String(name), req.toolCall.rawInput ?? {});
    return buildPermissionResponse(req.options, answer);
  };

  let stopReason: PromptResponse['stopReason'] | 'error' = 'error';
  let usage: AssistantUsage = { input: 0, output: 0 };
  let aborted = false;
  let graceTimer: NodeJS.Timeout | undefined;

  try {
    // 5. Resolve the ACP session: pooled live id → persisted id via
    //    session/load (capability-gated) → session/new (+ folded history).
    let acpSessionId = handle.acpSessionId;
    let isNewSession = false;
    if (!acpSessionId) {
      let persisted: string | undefined;
      if (opts.sessionId) {
        try {
          persisted = (await readSession(agent.id, opts.sessionId)).meta.acpSessionId;
        } catch {
          /* new session */
        }
      }
      if (persisted && handle.init.agentCapabilities?.loadSession) {
        // Load BEFORE arming the binding: the replayed history streams as
        // session/update notifications we deliberately drop (our own store
        // already has the conversation).
        try {
          await handle.conn.agent.request('session/load', {
            sessionId: persisted,
            cwd: workingDir,
            mcpServers,
          });
          acpSessionId = persisted;
        } catch (err) {
          console.warn(`[acp] session/load "${persisted}" failed; starting fresh:`, err);
        }
      }
      if (!acpSessionId) {
        const res = await handle.conn.agent.request('session/new', { cwd: workingDir, mcpServers });
        acpSessionId = res.sessionId;
        isNewSession = true;
      }
      handle.acpSessionId = acpSessionId;
      if (opts.sessionId && acpSessionId !== persisted) {
        try {
          await updateAcpSessionId({ agentId: agent.id, id: opts.sessionId }, acpSessionId);
        } catch (err) {
          console.warn('[acp] failed to persist session id:', err);
        }
      }
    }

    // 6. Prompt blocks: stable context on the session's first turn; volatile
    //    every turn; history folded only into a brand-new session.
    const blocks: ContentBlock[] = [];
    if (isNewSession && stableBlock) {
      blocks.push({ type: 'text', text: `<caretaker-context>\n${stableBlock}\n</caretaker-context>` });
    }
    if (volatileBlock) blocks.push({ type: 'text', text: volatileBlock });
    blocks.push({
      type: 'text',
      text: isNewSession ? foldHistory(opts.history, opts.prompt) : opts.prompt,
    });

    // 7. Arm the binding, wire abort, send the prompt.
    handle.binding.current = { acpSessionId, onUpdate, onPermission };
    const onAbort = () => {
      aborted = true;
      void handle.conn.agent.notify('session/cancel', { sessionId: acpSessionId! }).catch(() => {});
      graceTimer = setTimeout(() => handle.kill(), CANCEL_GRACE_MS);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await handle.conn.agent.request('session/prompt', {
        sessionId: acpSessionId,
        prompt: blocks,
      });
      stopReason = res.stopReason;
      if (res.usage) {
        usage = diffUsage(handle.lastUsage, res.usage);
        handle.lastUsage = res.usage;
        await safeEmit(() => cb.onUsage?.(usage));
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      handle.binding.current = null;
    }

    if (parts.length > 0) await safeEmit(() => cb.onMessage?.(assistantMessage(parts, usage)));

    if (aborted || stopReason === 'cancelled') return { text, toolCalls, usage, stop: 'aborted' };
    if (stopReason === 'max_turn_requests') return { text, toolCalls, usage, stop: 'max_turns' };
    return { text, toolCalls, usage, stop: 'done' };
  } catch (err: any) {
    if (aborted) return { text, toolCalls, usage, stop: 'aborted' };
    throw new Error(`acp runner: ${err?.message ?? String(err)}`);
  } finally {
    releaseAcpAgent(poolKey, handle);
  }
}
```

- [x] **Step 6: Run test to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_runner.test.ts`
Expected: PASS. Note the pool key mismatch trap: `runAcp` must not double-create children in the sessionId test (assert `prompts.length === 2` catches it). Also run typecheck and the claude_code_runner suite (`… exec tsx --test packages/cli/src/harness/claude_code_runner.test.ts`) to prove the `export` change is inert.

- [x] **Step 7: Commit**

```bash
git add packages/cli/src/harness/acp_runner.ts packages/cli/src/harness/acp_runner.test.ts \
  packages/cli/src/harness/claude_code_runner.ts packages/cli/src/session/types.ts packages/cli/src/session/store.ts
git commit -m "feat(acp): runner — fabricated context blocks, permission gate, session load/new, cancel"
```

---

### Task 5: Dispatch + RunOptions + title skip

**Files:**
- Modify: `packages/cli/src/harness/loop.ts:93-129` (RunOptions + dispatch)
- Modify: `packages/cli/src/harness/title.ts:27`
- Test: extend `packages/cli/src/harness/acp_runner.test.ts` (one dispatch test) and `packages/cli/src/harness/title.test.ts` if it exists (check; otherwise skip — the change is a one-line condition)

**Interfaces:**
- Produces: `RunOptions.acp?: AcpRunExtras`; `run()` dispatches `provider.type === 'acp'` → `runAcp`.

- [x] **Step 1: RunOptions field**

In `loop.ts` after the `claudeCode?` field (line 95) add:

```ts
  /** acp runner extras (ignored by the native loop): permission policy mode,
   *  extra per-run MCP servers, docker confinement. */
  acp?: import('./acp_policy.js').AcpRunExtras;
```

- [x] **Step 2: Dispatch**

In `run()` right after the claude-code dispatch block (line 124-129) add:

```ts
  if (opts.provider.type === 'acp') {
    // Same single-dispatch pattern: ACP providers get the whole loop replaced
    // by an external ACP agent (see acp_runner.ts).
    const { runAcp } = await import('./acp_runner.js');
    return runAcp(opts, cb);
  }
```

- [x] **Step 3: Title skip**

In `title.ts:27` change the condition to:

```ts
  if (input.provider.type === 'claude-code' || input.provider.type === 'acp') return null; // no HTTP endpoint; keep fallback title
```

- [x] **Step 4: Dispatch test**

Append to `acp_runner.test.ts`:

```ts
import { run } from './loop.js';

test('loop.run dispatches acp providers to runAcp', async () => {
  useFakeAgent(async () => ({ stopReason: 'end_turn' }));
  const res = await run({ agent: agentCfg, provider, tools: [], prompt: 'x' });
  assert.equal(res.stop, 'done');
});
```

- [x] **Step 5: Run tests + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/acp_runner.test.ts && pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/harness/loop.ts packages/cli/src/harness/title.ts packages/cli/src/harness/acp_runner.test.ts
git commit -m "feat(acp): dispatch acp providers from run(); skip AI titling like claude-code"
```

---

### Task 6: Bridge `run_command` tool

**Files:**
- Create: `packages/cli/src/mcp/run_command_tool.ts`
- Modify: `packages/cli/src/mcp/builtin_server.ts` (opts.tools override)
- Modify: `packages/cli/src/cli/web/mcp_bridge.ts` (token payload + tool list)
- Test: `packages/cli/src/mcp/run_command_tool.test.ts`, extend existing `builtin_server` tests if present (check for `packages/cli/src/mcp/builtin_server.test.ts`)

**Interfaces:**
- Produces:
  - `makeRunCommandTool(bind: { container: string; workdir: string }): Tool` — Tool named `mcp__task__run_command` (external name `run_command`), executes `docker exec -w <workdir> <container> sh -lc <command>`.
  - `buildBuiltinMcpServer(info?, opts?: { callerAgent?: AgentConfig; tools?: Tool[] })` — `tools` overrides the served list (default `builtinMcpTools()`).
  - `issueBridgeToken(agentId?: string, opts?: { exec?: { container: string; workdir: string }; execOnly?: boolean }): string`.

- [x] **Step 1: Write the failing test**

`packages/cli/src/mcp/run_command_tool.test.ts` — test the tool via a stubbed exec. Make the exec function injectable:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunCommandTool, __setExec, __resetExec } from './run_command_tool.js';
import type { ToolContext } from '../harness/tools/index.js';

const ctx: ToolContext = { workingDir: '/w', signal: new AbortController().signal, readPaths: new Set() };

afterEach(__resetExec);

test('run_command execs docker with containerExecArgs and returns output', async () => {
  let seen: { cmd: string; args: string[] } | null = null;
  __setExec(async (cmd, args) => {
    seen = { cmd, args };
    return { stdout: 'ok\n', stderr: '' };
  });
  const tool = makeRunCommandTool({ container: 'caretaker-task-t1', workdir: '/w' });
  assert.equal(tool.name, 'mcp__task__run_command');
  const res = await tool.execute({ command: 'ls -la' }, ctx);
  assert.match(res.content, /ok/);
  assert.deepEqual(seen!.args, ['exec', '-w', '/w', 'caretaker-task-t1', 'sh', '-lc', 'ls -la']);
});

test('missing command arg errors without exec', async () => {
  __setExec(async () => {
    throw new Error('should not run');
  });
  const tool = makeRunCommandTool({ container: 'c', workdir: '/w' });
  const res = await tool.execute({}, ctx);
  assert.match(res.content, /Error: command is required/);
});

test('non-zero exit reports code and output', async () => {
  __setExec(async () => {
    const err: any = new Error('failed');
    err.code = 2;
    err.stdout = '';
    err.stderr = 'boom';
    throw err;
  });
  const tool = makeRunCommandTool({ container: 'c', workdir: '/w' });
  const res = await tool.execute({ command: 'false' }, ctx);
  assert.match(res.content, /exit code 2/);
  assert.match(res.content, /boom/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/mcp/run_command_tool.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement `run_command_tool.ts`**

```ts
// Per-task shell tool for ACP runs under Docker confinement: the ACP policy
// denies every kind:'execute' tool call, and this bridge-injected tool is the
// only shell path — confined to the task's container by construction. Built
// per token (bound container), so it is never part of the registry and never
// served by the stdio `caretaker-cli mcp` server (no container to bind there).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../harness/tools/index.js';
import { containerExecArgs } from '../lib/docker.js';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';

const TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 30_000;

type ExecFn = (cmd: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>;
const realExec: ExecFn = promisify(execFile) as unknown as ExecFn;
let execImpl: ExecFn = realExec;
export function __setExec(fn: ExecFn): void {
  execImpl = fn;
}
export function __resetExec(): void {
  execImpl = realExec;
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]' : s;
}

export function makeRunCommandTool(bind: { container: string; workdir: string }): Tool {
  return {
    name: 'mcp__task__run_command',
    description:
      "Run a shell command inside this task's Docker container (the only way to execute " +
      'commands in this run — direct shell tool calls are denied). Runs from the task ' +
      `working directory. 5-minute timeout, output capped at ${MAX_OUTPUT_CHARS} chars.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run (sh -c syntax).' },
      },
      required: ['command'],
    },
    execute: async (args) => {
      const command = String((args as { command?: unknown })?.command ?? '').trim();
      if (!command) return { content: 'Error: command is required' };
      try {
        const { stdout, stderr } = await execImpl(
          'docker',
          containerExecArgs(bind.container, bind.workdir, command),
          { env: commandEnv(), timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        );
        return { content: cap([stdout, stderr].filter(Boolean).join('\n')) || '(no output)' };
      } catch (err: any) {
        const out = [err?.stdout, err?.stderr].filter(Boolean).join('\n');
        const code = err?.code ?? 'unknown';
        return { content: cap(`Error: exit code ${code}\n${out || err?.message || ''}`) };
      }
    },
  };
}
```

(If the `Tool.execute` return type in `harness/tools/types.ts` is richer than `{ content: string }`, match it — read `ToolResult` first.)

- [x] **Step 4: builtin_server tools override**

In `builtin_server.ts` change the signature and both handlers:

```ts
export function buildBuiltinMcpServer(
  info: { name: string; version: string } = { name: 'caretaker-task', version: '0.0.0' },
  opts: { callerAgent?: AgentConfig; tools?: Tool[] } = {},
): Server {
  const served = () => opts.tools ?? builtinMcpTools();
```

…and replace both `builtinMcpTools()` call sites inside the handlers with `served()`.

- [x] **Step 5: mcp_bridge token payload**

In `mcp_bridge.ts`:

```ts
type TokenInfo = {
  agentId: string;
  /** When set, a run_command tool bound to this container is served. */
  exec?: { container: string; workdir: string };
  /** Serve ONLY run_command (review runs: shell yes, task-state tools no). */
  execOnly?: boolean;
};
const activeTokens = new Map<string, TokenInfo>();

export function issueBridgeToken(
  agentId = '',
  opts: { exec?: { container: string; workdir: string }; execOnly?: boolean } = {},
): string {
  const token = randomBytes(24).toString('hex');
  activeTokens.set(token, { agentId, exec: opts.exec, execOnly: opts.execOnly });
  return token;
}
```

…and in the request handler, after resolving `callerAgent`:

```ts
    const tokenInfo = activeTokens.get(token)!;
    const extraTools = tokenInfo.exec ? [makeRunCommandTool(tokenInfo.exec)] : [];
    const tools = tokenInfo.execOnly ? extraTools : [...builtinMcpTools(), ...extraTools];
    const server = buildBuiltinMcpServer(undefined, { callerAgent, tools });
```

(adjust the existing `const agentId = activeTokens.get(token) ?? ''` line to read `tokenInfo.agentId`; import `makeRunCommandTool` and `builtinMcpTools`.)

- [x] **Step 6: Run tests + typecheck**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/mcp/run_command_tool.test.ts && pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: PASS (full suite catches any bridge/builtin_server regression).

- [x] **Step 7: Commit**

```bash
git add packages/cli/src/mcp/run_command_tool.ts packages/cli/src/mcp/run_command_tool.test.ts \
  packages/cli/src/mcp/builtin_server.ts packages/cli/src/cli/web/mcp_bridge.ts
git commit -m "feat(acp): bridge-injected run_command tool bound to the task container"
```

---

### Task 7: Scheduler arms (tasks, review, sweep, budget)

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/task_roles.ts:15-26` (external-runner budget)
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts:348,415-453,636` (ACP extras + bridge token + prompt hint)
- Modify: `packages/cli/src/cli/web/scheduler/task_review.ts:69-115` (ACP arm + exec-only bridge token)
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts:150` (deny-all)
- Test: extend `packages/cli/src/cli/web/scheduler/task_roles.test.ts` if it exists (check first); the strategy/review arms are exercised by typecheck + existing suites (they are thin wiring around already-tested functions).

- [x] **Step 1: task_roles budget**

Rename the parameter to reflect the class (claude-code AND acp are external runners):

```ts
export function resolveMaxRunSeconds(
  task: { maxRunSeconds?: number },
  project: { maxRunSeconds?: number } | null,
  isExternalRunner: boolean,
): number {
  // …body unchanged except the final line:
  return isExternalRunner ? CLAUDE_CODE_DEFAULT_RUN_SECONDS : DEFAULT_RUN_SECONDS;
}
```

(Keep the constant names — renaming them would touch many call sites for zero behavior. Update the doc comment above the function to say "external runners (claude-code, acp)".)

- [x] **Step 2: task_strategy ACP arm**

At line ~348:

```ts
    const isClaudeCode = provider.type === 'claude-code';
    const isAcp = provider.type === 'acp';
    const maxRunSeconds = resolveMaxRunSeconds(task, project, isClaudeCode || isAcp);
```

After the `if (isClaudeCode) { … }` block (line ~453) add:

```ts
    let acp: RunOptions['acp'];
    if (isAcp) {
      const bridgeUrl = getTaskBridgeUrl();
      const exec =
        dockerContainer && !planning ? { container: dockerContainer, workdir: workingDir } : undefined;
      bridgeToken = bridgeUrl ? issueBridgeToken(effectiveAgent.id, { exec }) : undefined;
      acp = acpTaskExtras({
        planning,
        sdd,
        bridge: bridgeUrl && bridgeToken ? { url: bridgeUrl, token: bridgeToken } : undefined,
        docker: exec,
      });
      if (!bridgeUrl) {
        console.warn('[tasks] acp agent without task bridge URL — task tools unavailable this run');
      }
    }
```

Import `acpTaskExtras` from `'../../../harness/acp_policy.js'`. Pass `acp` in the `harness.run` options next to `claudeCode`.

Extend the docker prompt hint (line ~361) so ACP agents know the shell path:

```ts
    if (dockerContainer && !planning) {
      let env = `\n\n**Execution environment:** your shell commands run inside a Docker container (image \`${dockerImage}\`) mounted at \`${workingDir}\`. File reads/writes are confined to this directory.`;
      if (isAcp) {
        env += ` Shell commands MUST go through the \`run_command\` tool — direct shell/execute tool calls are denied in this run.`;
      }
      if (!dockerHasGit) {
        // …unchanged
```

Line ~636 (the second `resolveMaxRunSeconds` call): change the third argument to `provider.type === 'claude-code' || provider.type === 'acp'`.

- [x] **Step 3: task_review ACP arm**

In `runDoneReview` (after the `claudeCode` const, line ~81) add:

```ts
  const isAcp = opts.provider.type === 'acp';
  let acp: RunOptions['acp'];
  let reviewBridgeToken: string | undefined;
  if (isAcp) {
    const exec = opts.dockerContainer
      ? { container: opts.dockerContainer, workdir: opts.workingDir }
      : undefined;
    let extraMcpServers: NonNullable<RunOptions['acp']>['extraMcpServers'];
    if (exec) {
      // The reviewer needs shell in the container but must NOT see the task
      // state tools: an exec-only bridge token serves run_command alone.
      const bridgeUrl = getTaskBridgeUrl();
      reviewBridgeToken = bridgeUrl ? issueBridgeToken(opts.agent.id, { exec, execOnly: true }) : undefined;
      if (bridgeUrl && reviewBridgeToken) {
        extraMcpServers = {
          task: { type: 'http', url: bridgeUrl, headers: { Authorization: `Bearer ${reviewBridgeToken}` } },
        };
      }
    }
    acp = { mode: 'unattended', docker: exec, extraMcpServers };
  }
```

Pass `...(acp ? { acp } : {})` in the `harness.run` options, and in the existing `finally` add:

```ts
    if (reviewBridgeToken) revokeBridgeToken(reviewBridgeToken);
```

Import `getTaskBridgeUrl`/`issueBridgeToken`/`revokeBridgeToken` from `'../mcp_bridge.js'` (check the existing relative path used by task_strategy.ts and mirror it).

- [x] **Step 4: memory_sweep deny-all**

In `makeSummarizer` (line ~150) add next to the claudeCode extra:

```ts
        claudeCode: { permissionMode: 'dontAsk' },
        acp: { mode: 'deny-all' },
```

- [x] **Step 5: Verify**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: PASS (the resolveMaxRunSeconds param rename is source-compatible: positional boolean).

- [x] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/scheduler/task_roles.ts packages/cli/src/cli/web/scheduler/task_strategy.ts \
  packages/cli/src/cli/web/scheduler/task_review.ts packages/cli/src/cli/web/scheduler/memory_sweep.ts
git commit -m "feat(acp): task/review/sweep arms — planner policy, docker run_command bridge, external-runner budget"
```

---

### Task 8: Settings UI (webview + TUI)

**Files:**
- Modify: `packages/webview-ui/src/ProvidersTab.tsx`
- Modify: `packages/cli/src/tui/providers.tsx`
- Test: `pnpm -F webview-ui test && pnpm -F webview-ui build`, `pnpm -F @hyperwindmill/caretaker-cli typecheck`

- [x] **Step 1: ProvidersTab**

Extend the form state and rendering (current shape at `ProvidersTab.tsx:18-31,56-94,160-245`):

- `const [type, setType] = useState<'openai' | 'claude-code' | 'acp'>('openai');` and the matching cast in the `<select>` onChange; add `<option value="acp">ACP agent (external CLI)</option>`.
- New state: `const [args, setArgs] = useState('');` — loaded as `setArgs((provider.args ?? []).join(' '))` in the edit-populate effect.
- When `type === 'acp'` render two fields instead of the endpoint/apiKey pair:
  - **Command** (required): placeholder `npx` — reuse the existing command input, but label it "Command" and make save reject an empty value for acp (same inline-error pattern the form uses for empty endpoint).
  - **Arguments**: single text input, placeholder `@agentclientprotocol/claude-agent-acp`, hint text "Space-separated. Env vars can be added by editing caretaker.json."
- Save path for acp:

```ts
    if (type === 'acp') {
      const p: ProviderConfig = { name: name.trim(), type: 'acp', endpoint: '', command: trimmedCommand };
      const argList = args.trim() ? args.trim().split(/\s+/) : [];
      if (argList.length) p.args = argList;
      // …existing save flow
    }
```

- List row label (line ~243): `prov.type === 'acp' ? \`ACP — ${prov.command ?? ''} ${(prov.args ?? []).join(' ')}\`.trim() : …` alongside the existing claude-code branch.

- [x] **Step 2: TUI providers.tsx**

Mirror the same additions in the Ink form (`tui/providers.tsx:187-250`): add `'acp'` to `ProviderType` and the type-step choices; for acp the step sequence is `type → name → command → args` (new `args` FormStep, same TextInput pattern as `command`, space-split on save); detail view (line ~110-117) shows `type: acp`, `command`, `args`. Empty command on save for acp: keep the user on the command step (same pattern the form uses for required fields — check how `name` emptiness is handled and mirror it).

- [x] **Step 3: Verify**

Run: `pnpm -F webview-ui test && pnpm -F webview-ui build && pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F caretaker-vscode build`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add packages/webview-ui/src/ProvidersTab.tsx packages/cli/src/tui/providers.tsx
git commit -m "feat(acp): provider settings UI (webview + TUI) for ACP agents"
```

---

### Task 9: Docs + changeset + full verification

**Files:**
- Modify: `CLAUDE.md` (layer 2)
- Modify: `README.md` (user-facing provider docs)
- Modify: `docs/superpowers/specs/2026-08-25-acp-runner-design.md` (record the two v1 deviations)
- Create: `.changeset/acp-runner.md`

- [x] **Step 1: Spec deviations**

In the spec's "Docker confinement" section append a short "v1 deviation" note: the `terminal` capability is not advertised in v1 even without Docker (agent-side host shell is the status quo; the capability is additive later), and the fs capabilities are not advertised (agent-side fs writes the same bind-mounted files). Both were decided at planning time to cut dead surface. Also note in the provider-config section that `runnerHints` was flattened: `selfLoadedContextFiles` sits directly on `ProviderConfig`.

- [x] **Step 2: CLAUDE.md layer 2**

Add a paragraph after the claude-code provider paragraph, covering: `type: 'acp'` providers (spawn command/args/env, official servers for Claude/Codex/Antigravity), the single dispatch point in `loop.ts`, long-lived per-session child + pool + idle reaper, fabricated context blocks (stable first turn / volatile per turn, `selfLoadedContextFiles`), the permission policy modes and how planner/SDD/docker map onto them, the run_command bridge tool (exec-only token for reviews), `acpSessionId` + `session/load`, external-runner budget class, no AI titling. Keep it as dense as the claude-code paragraph — same style.

- [x] **Step 3: README**

User-facing: how to configure an ACP provider (three worked examples: `npx @agentclientprotocol/claude-agent-acp`, `npx @agentclientprotocol/codex-acp`, downloaded `agy_acp_server`), auth expectation (log in with the agent's own CLI first), the Docker caveat (an adapter that does not forward execute permission requests is unfit for Docker tasks until verified), and that caretaker plugins/tool pickers do not apply to ACP agents (same as claude-code).

- [x] **Step 4: Changeset**

`.changeset/acp-runner.md`:

```md
---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

New provider type `acp`: drive any Agent Client Protocol agent (claude-agent-acp, codex-acp, Google agy_acp_server, …) as a caretaker runner — side-by-side with the claude-code runner. One ACP client implementation covers chat on every surface, scheduled runs, and autonomous task cycles (planner read-only via permission policy, Docker confinement via deny-execute + a bridge-injected run_command tool).
```

(Check `.changeset/config.json` fixed-group package names before writing — copy the exact names from an existing changeset.)

- [x] **Step 5: Full verification**

Run: `pnpm build && pnpm test`
Expected: every package builds and every suite passes.

- [x] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/superpowers/specs/2026-08-25-acp-runner-design.md .changeset/acp-runner.md
git commit -m "docs(acp): architecture + user docs + changeset for the ACP runner"
```

---

## Out of scope (per spec)

ACP `authenticate` flow, session modes UI, model via protocol, registry-derived presets, terminal/fs client capabilities, retiring `claude_code_runner.ts`.

## Manual verification (post-merge, not a task)

Against the three real adapters (needs the agents installed + authenticated): chat turn with streaming on the web GUI, a confirm-gated tool call, a Docker task cycle (verify execute denial + run_command usage in the task log), a planner cycle (verify read-only), review pass, `--resume` behavior after killing the web server. This is the parity ledger for the future claude-code retirement decision.
