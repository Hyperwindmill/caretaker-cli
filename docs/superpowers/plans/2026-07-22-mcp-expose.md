# MCP Expose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a general-purpose caretaker MCP server over **stdio** (`caretaker-cli mcp`) that exposes the full `mcp__task__*` toolset to an external MCP client, reusing the existing task-tool definitions and the bridge's server-wrapping logic (no fork). Trust boundary = local process access to `CARETAKER_HOME`; no token. The existing `/api/mcp/task` per-task-token HTTP bridge is untouched except for a mechanical extraction of shared code.

**Architecture:** Extract the private `TASK_PREFIX` / `taskTools()` / `buildServer()` from `mcp_bridge.ts` into a shared `mcp/task_server.ts`. The bridge keeps its HTTP + token wiring and imports the shared builder. A new thin subcommand module `cli/mcp.ts` attaches a `StdioServerTransport` to `buildTaskMcpServer()`. `index.ts` skips its background boots for the `mcp` subcommand to keep stdout clean and startup lean.

**Tech Stack:** TypeScript ESM (strict, `.js` import suffixes), Node built-in test runner via tsx, `@modelcontextprotocol/sdk` ^1.29.0 (already a dependency, server + stdio transports), commander.

**Spec:** `docs/superpowers/specs/2026-07-22-mcp-expose-design.md`

## Global Constraints

- Package manager: **pnpm** ≥10, from repo root. Never `npm`.
- Tests co-located `*.test.ts`; run relative to `packages/cli`: `cd packages/cli && pnpm exec tsx --test src/...`. `pnpm test` does NOT typecheck; always also run `pnpm -F @hyperwindmill/caretaker-cli typecheck`.
- `process.env.CARETAKER_HOME` mutated at **FILE scope** only in tests (see `mcp_bridge.test.ts` line 4 for the pattern).
- ESM: relative imports end in `.js`.
- **No new dependencies.**
- **stdout is the MCP wire** for the `mcp` subcommand — it must emit nothing to stdout but JSON-RPC. All diagnostics go to stderr.
- Do not change any `mcp__task__*` tool behaviour, and do not change `/api/mcp/task`'s token model.
- A changeset (minor, all five fixed-group packages) lands in the final task.
- Keep `CLAUDE.md` and `README.md` in sync in the same unit of work (final task).

---

### Task 1: Extract the shared task-MCP-server builder

Pure refactor — no behaviour change. Moves `TASK_PREFIX`, `taskTools()`, and the server-building logic out of `mcp_bridge.ts` into a shared module so both the HTTP bridge and the new stdio subcommand build one server from one tool-definition source.

**Files:**
- Create: `packages/cli/src/mcp/task_server.ts`
- Create: `packages/cli/src/mcp/task_server.test.ts`
- Modify: `packages/cli/src/cli/web/mcp_bridge.ts` (import the extracted pieces; delete the local copies)

**Interfaces:**
- Consumes: `tools` registry (`../harness/tools/instance.js`), `Tool`/`ToolContext` types (`../harness/tools/index.js`), `Server`, `ListToolsRequestSchema`, `CallToolRequestSchema` from the SDK.
- Produces (used by the bridge and Task 2):
  - `export const TASK_PREFIX = 'mcp__task__'`
  - `export function taskTools(): Tool[]`
  - `export function buildTaskMcpServer(info?: { name: string; version: string }): Server` — defaults to `{ name: 'caretaker-task', version: '0.0.0' }` so the bridge is byte-for-byte unchanged in behaviour.

- [ ] **Step 1: Write the failing test** — `packages/cli/src/mcp/task_server.test.ts`

Mirror `mcp_bridge.test.ts` but drive the server directly via an in-memory transport pair (see `mcp/client.test.ts` for `InMemoryTransport` usage):

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-taskserver-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildTaskMcpServer } from './task_server.js';
// instance.ts registers builtins as a load-time side effect.
import '../harness/tools/instance.js';

async function connected() {
  const server = buildTaskMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return { mcp, server };
}

test('lists task tools un-prefixed', async () => {
  const { mcp } = await connected();
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.includes('task_complete'));
  assert.ok(names.includes('task_submit_plan'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));
  await mcp.close();
});

test('calls a task tool end-to-end on an empty store', async () => {
  const { mcp } = await connected();
  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');
  await mcp.close();
});

test('unknown tool returns isError', async () => {
  const { mcp } = await connected();
  const res = await mcp.callTool({ name: 'does_not_exist', arguments: {} });
  assert.equal(res.isError, true);
  await mcp.close();
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/cli && pnpm exec tsx --test src/mcp/task_server.test.ts` → FAIL (module `./task_server.js` not found).

- [ ] **Step 3: Create `packages/cli/src/mcp/task_server.ts`**

Move the logic verbatim from `mcp_bridge.ts` (`TASK_PREFIX`, `taskTools`, `buildServer` → renamed `buildTaskMcpServer` with an optional `info` param). Note the import path depth changes (`mcp/` is one level shallower than `cli/web/`):

```ts
// Shared builder: wraps the built-in mcp__task__* registry tools as an MCP
// Server. Used by BOTH the per-task HTTP bridge (cli/web/mcp_bridge.ts) and
// the general stdio subcommand (cli/mcp.ts) so the task surface has one
// definition and one wrapping. The task tools are context-free (they take
// task_id/project_id as arguments), so a stub ToolContext is sufficient.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as registry } from '../harness/tools/instance.js';
import type { Tool, ToolContext } from '../harness/tools/index.js';

export const TASK_PREFIX = 'mcp__task__';

export function taskTools(): Tool[] {
  return registry.list().filter((t) => t.name.startsWith(TASK_PREFIX));
}

export function buildTaskMcpServer(
  info: { name: string; version: string } = { name: 'caretaker-task', version: '0.0.0' },
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
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
      return {
        content: [{ type: 'text', text: `Error: unknown tool "${req.params.name}"` }],
        isError: true,
      };
    }
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      readPaths: new Set(),
    };
    try {
      const result = await tool.execute(req.params.arguments ?? {}, ctx);
      return { content: [{ type: 'text', text: result.content }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  });
  return server;
}
```

- [ ] **Step 4: Slim down `mcp_bridge.ts`** — delete the moved code and import it instead. Remove the now-unused imports (`Server`, `ListToolsRequestSchema`, `CallToolRequestSchema`, `tools as registry`, and the `Tool`/`ToolContext` type import — keep whatever the file still uses). Keep `StreamableHTTPServerTransport`, `RESPONSE_ALREADY_SENT`, `randomBytes`, the token set, and the URL setters. Replace the local `TASK_PREFIX`/`taskTools`/`buildServer` with:

```ts
import { buildTaskMcpServer } from '../../mcp/task_server.js';
```

and in `registerTaskBridge`, `const server = buildServer();` becomes `const server = buildTaskMcpServer();`.

- [ ] **Step 5: Run tests + typecheck** — `cd packages/cli && pnpm exec tsx --test src/mcp/task_server.test.ts src/cli/web/mcp_bridge.test.ts && pnpm typecheck`. Expected: both suites PASS (bridge test unchanged proves the extraction is behaviour-preserving), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/mcp/task_server.ts packages/cli/src/mcp/task_server.test.ts packages/cli/src/cli/web/mcp_bridge.ts
git commit -m "refactor(mcp): extract shared buildTaskMcpServer from the task bridge"
```

---

### Task 2: `caretaker-cli mcp` stdio subcommand

**Files:**
- Create: `packages/cli/src/cli/mcp.ts`
- Create: `packages/cli/src/cli/mcp.test.ts`
- Modify: `packages/cli/src/cli/index.ts` (register the subcommand)
- Modify: `packages/cli/src/index.ts` (skip background boots for the `mcp` subcommand)

**Interfaces:**
- Consumes: `buildTaskMcpServer` (Task 1), `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- Produces: `export async function startMcpStdioServer(): Promise<void>` — builds the server (name `caretaker`), connects a stdio transport, and returns a promise that stays pending while the connection is open (process stays alive on stdin; exits when the client closes the pipe).

- [ ] **Step 1: Create `packages/cli/src/cli/mcp.ts`**

```ts
// `caretaker-cli mcp` — serve the built-in mcp__task__* tools over stdio so an
// external MCP client (e.g. Claude Code) can steer caretaker's task/project
// system symmetrically. No auth: the trust boundary is local process access to
// CARETAKER_HOME (the caller could edit the folder DB directly). stdout carries
// the JSON-RPC wire — never write anything else to it here.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildTaskMcpServer } from '../mcp/task_server.js';

export async function startMcpStdioServer(): Promise<void> {
  const server = buildTaskMcpServer({ name: 'caretaker', version: '0.0.0' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client closes stdin. Resolve on transport close so
  // the caller can let the process exit cleanly.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
```

(If the installed SDK's `StdioServerTransport` does not surface an `onclose` hook, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts` and adapt — the `server.onclose`/`transport.onclose` callback is the documented close signal; a fallback is to await a never-resolving promise since the SDK closes the process on stdin EOF.)

- [ ] **Step 2: Register the subcommand in `cli/index.ts`** — after the `web` command block:

```ts
  program
    .command('mcp')
    .description('Serve the caretaker task/project tools over stdio for an external MCP client.')
    .action(async () => {
      const { startMcpStdioServer } = await import('./mcp.js');
      await startMcpStdioServer();
    });
```

- [ ] **Step 3: Keep boot lean + stdout clean in `index.ts`** — guard the three background boots (refresh-on-start, shell-env probe, model limits) so they do not run for the `mcp` subcommand. At the top, after imports:

```ts
const isMcpStdio = process.argv[2] === 'mcp';
```

Wrap `refreshSourcesOnStart()`, `probeShellEnv()`, and `initModelLimits()` in `if (!isMcpStdio) { … }`. Leave the MCP-shutdown hooks (`process.on('exit'|'SIGINT'|'SIGTERM')`) untouched — they only write to stdout via nothing (best-effort close), harmless. Rationale in a short comment: the stdio MCP server needs none of these and stdout must stay clean.

- [ ] **Step 4: Write the end-to-end test** — `packages/cli/src/cli/mcp.test.ts`

Spawn the real entry via `tsx` through `StdioClientTransport` (which spawns `command`+`args` and speaks stdio), under an isolated `CARETAKER_HOME`. This proves stdout hygiene and the full subcommand path.

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '../index.ts'); // packages/cli/src/index.ts

test('caretaker-cli mcp serves task tools over stdio', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-cli-'));
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [path.resolve(HERE, '../../node_modules/tsx/dist/cli.mjs'), ENTRY, 'mcp'],
    env: { ...process.env, CARETAKER_HOME: home },
  });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(transport);

  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('task_get_state'));
  assert.ok(names.every((n) => !n.startsWith('mcp__')));

  const res = await mcp.callTool({ name: 'project_list', arguments: {} });
  const textBlock = (res.content as any[]).find((c) => c.type === 'text');
  assert.ok(typeof textBlock?.text === 'string');

  await mcp.close();
});
```

Notes for the executor:
- Verify the `tsx` CLI entry path (`node_modules/tsx/dist/cli.mjs`) resolves from `packages/cli`; if the layout differs, resolve it via `require.resolve('tsx/cli')` or spawn `pnpm exec tsx`. The exact spawn shape is an implementation detail — the assertions are the contract.
- Give the test a generous timeout if the runner defaults are tight (cold `tsx` start). If a real subprocess spawn proves flaky in this environment, the Task 1 in-memory builder test is the guaranteed coverage; keep this one but do not let a spawn-environment quirk block the task — document any deviation in the task thread.

- [ ] **Step 5: Run the test + typecheck** — `cd packages/cli && pnpm exec tsx --test src/cli/mcp.test.ts && pnpm typecheck`. Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/mcp.ts packages/cli/src/cli/mcp.test.ts packages/cli/src/cli/index.ts packages/cli/src/index.ts
git commit -m "feat(mcp): caretaker-cli mcp — stdio server exposing task tools to external clients"
```

---

### Task 3: Docs, changeset, full verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Create: `.changeset/mcp-expose.md`

- [ ] **Step 1: CLAUDE.md** — in layer 2 (the paragraph describing the `/api/mcp/task` bridge), add a sentence that the same task-tool set is also served over **stdio** by a new general-purpose `caretaker-cli mcp` subcommand for **external** MCP clients, built from the shared `mcp/task_server.ts` (`buildTaskMcpServer`) — no token (trust boundary = local process access to `CARETAKER_HOME`; it grants nothing beyond editing the folder DB or running the TUI against the same store), no running web server required, and it exposes the full `mcp__task__*` set because those tools are context-free (explicit `task_id`/`project_id`). Note this is an additional egress surface only: `/api/mcp/task`'s per-task token model is unchanged. Update the "Subcommand routing" note in layer 1 to mention `mcp` alongside `run`/`web`.

- [ ] **Step 2: README.md** — in the Autonomous task/project section (or a short new bullet under "Surfaces"/Install), document that an external MCP client can register caretaker's task tools with `caretaker-cli mcp` over stdio:

```jsonc
// .mcp.json (or: claude mcp add caretaker -- caretaker-cli mcp)
{ "mcpServers": { "caretaker": { "command": "caretaker-cli", "args": ["mcp"] } } }
```

State plainly: no web server or token needed; the server operates on the `CARETAKER_HOME` store it inherits from the client's env; it exposes only the task/project tools (no file/bash), and the security model is "local process access to the store" — the same boundary the TUI already trusts. Also add `caretaker-cli mcp` to the quick-run list near the other subcommands.

- [ ] **Step 3: Changeset** — `.changeset/mcp-expose.md`:

```md
---
"caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-vscode": minor
"caretaker-desktop": minor
---

New `caretaker-cli mcp` subcommand: a general-purpose MCP server over stdio that exposes caretaker's `mcp__task__*` task/project tools to external MCP clients (e.g. Claude Code), so they can inspect and steer autonomous tasks/projects symmetrically with in-harness agents — no running web server and no token. The server reuses the exact task-tool definitions and server-wrapping the per-task HTTP bridge uses (extracted into a shared `mcp/task_server.ts`), and its trust boundary is local process access to `CARETAKER_HOME`. The existing token-guarded, per-task `/api/mcp/task` bridge is unchanged.
```

- [ ] **Step 4: Full verification** — `pnpm build && pnpm test && pnpm -F @hyperwindmill/caretaker-cli typecheck`. Expected: all five packages build, all tests pass, typecheck clean.

- [ ] **Step 5: Live smoke (manual)** — in an isolated home, register and drive the server with a real MCP client:

```bash
CARETAKER_HOME=/tmp/ct-mcp caretaker-cli mcp   # (or via `pnpm -F @hyperwindmill/caretaker-cli exec tsx src/index.ts mcp`)
```

From an external client (`claude mcp add caretaker -- caretaker-cli mcp` with `CARETAKER_HOME` set), confirm `project_list` and `task_search` return, and `task_create`/`task_get_state` round-trip against that store. Confirm nothing but JSON-RPC ever appears on the server's stdout.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md .changeset/mcp-expose.md
git commit -m "docs(mcp): document caretaker-cli mcp stdio server; changeset"
```

---

## Risks / notes for the executor

- **SDK API drift:** `StdioServerTransport` and its close hook live in `@modelcontextprotocol/sdk@1.29.0`. If the `onclose` shape differs, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts` and adapt — the goal (stay alive until stdin EOF) is stable even if the exact API isn't.
- **stdout hygiene is load-bearing.** Any stray `console.log` in the import graph of the `mcp` path corrupts the protocol. The `index.ts` boot guard (Task 2 Step 3) is the main defence; the Task 2 spawn test is what catches a regression.
- **No ambient task:** every exposed tool takes an explicit id — verified in `task_tools.ts`. Do not add any "current task" convenience state to the general server; that would reintroduce the coupling the stdio model deliberately avoids.
- **Keep the two producers in sync via the shared builder only.** If a future task tool is added to the registry, both the bridge and the stdio server pick it up automatically (prefix filter) — do not maintain a second allowlist.
