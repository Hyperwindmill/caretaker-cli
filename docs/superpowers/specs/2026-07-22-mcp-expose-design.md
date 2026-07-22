# MCP Expose — Design

**Date:** 2026-07-22
**Task:** 21 — MCP expose
**Status:** design approved for planning

## Problem

Agents *inside* the caretaker harness can drive the autonomous task/project system
through the built-in `mcp__task__*` tools. A Claude Code (or any MCP-client) session
running *outside* the harness — editing the same repo — cannot: to inspect or steer
tasks/projects from outside you must hand-edit the `@morphql/store` folder DB. This is
a capability disparity. We want the task/project surface reachable **symmetrically** by
registering a caretaker-owned MCP server in an external client's config.

## What already exists (verified in code)

- **Tool definitions — single source of truth:** `packages/cli/src/harness/tools/builtin/task_tools.ts`
  defines every `mcp__task__*` tool; they are registered into the process-wide registry
  by `builtin/index.ts` → `instance.ts` (`export const tools`).
- **Existing MCP *producer*:** `packages/cli/src/cli/web/mcp_bridge.ts` — a
  token-guarded streamable-HTTP endpoint `POST /api/mcp/task`, web-server-only, wired via
  `setTaskBridgeUrl` right after `serve()`. It:
  - filters the registry by the `mcp__task__` prefix (`taskTools()`),
  - builds a fresh stateless `Server` per request (`buildServer()`), stripping the prefix
    from tool names and delegating `execute()` with a **stub `ToolContext`** (task tools
    ignore `ctx` entirely — they take explicit ids as arguments),
  - guards every request with a per-run bearer token (`issueBridgeToken`/`revokeBridgeToken`),
    issued by the task heartbeat and scoped to one task's run.
- **Key property:** the bridge's own comment states the task tools are *context-free* —
  each takes `task_id`/`project_id` as an argument, so no per-run task injection happens.
  This is the linchpin of the security analysis below.
- **CLI routing:** `packages/cli/src/cli/index.ts` (commander). Subcommands `run`, `web`.
- **SDK:** `@modelcontextprotocol/sdk@1.29.0` — already a dependency, server + stdio
  transports available (`server/index.js`, `server/stdio.js`).

## Decision 1 — Transport: **stdio subcommand**, not HTTP

Ship a new subcommand `caretaker-cli mcp` that speaks MCP over **stdio**.

An external client registers it declaratively with no running web server and no token
dance, e.g.:

```jsonc
// .mcp.json / claude mcp add
{
  "mcpServers": {
    "caretaker": { "command": "caretaker-cli", "args": ["mcp"] }
  }
}
```

**Why stdio over the streamable-HTTP path:**
- **No lifecycle coupling.** HTTP requires a running `caretaker-cli web` process *and*
  a valid bearer token. The bridge's token is issued per-heartbeat-run and revoked after
  — there is no long-lived token an external client could hold, and inventing one would
  mean building token minting/rotation/storage. stdio needs none of that: the client
  spawns the process on demand and tears it down when the connection closes.
- **No new network surface.** HTTP would expose caretaker's full task-mutation surface on
  a local port; stdio is a private pipe between the client and the child process.
- **CARETAKER_HOME follows the client.** The child inherits its env from the spawning
  client, so the client picks which store it targets (`{ "env": { "CARETAKER_HOME": "…" } }`),
  resolved at call time by the existing accessors.

The streamable-HTTP path is rejected for the general server (it stays exactly as-is for
the per-task bridge, which *must* be HTTP because the claude-code subprocess reaches it
over the loopback interface).

## Decision 2 — Tool set: the **full `mcp__task__*` set**, reused verbatim

The stdio server exposes the same set the bridge does — every registry tool with the
`mcp__task__` prefix — via a shared builder. No subset, no fork.

**Rationale (resolves the "which tools are safe without a per-task token" open question):**
every task tool is already context-free. There is **no ambient-task assumption anywhere**
in `task_tools.ts`: `task_create` requires `project_id`; `task_complete`/`task_block`/
`task_yield`/`task_submit_plan`/… all require an explicit `task_id`. Write tools behave
identically whether called from the heartbeat bridge or a general server. `task_submit_plan`
and `task_yield` are heartbeat-lifecycle-oriented but harmless from outside (they mutate
`status`/`lockedAt` for an explicitly named task). So the safe subset *is* the full set,
and shipping the full set keeps a single source of truth instead of a diverging allowlist.
Read-only introspection (`project_list`, `task_search`, `task_get_state`) is included as
part of that same set.

## Decision 3 — Security / auth model: **local process = the boundary**, no token

The stdio server ships **no authentication**. The trust boundary is: *whoever can spawn
`caretaker-cli mcp` with a given `CARETAKER_HOME` already has filesystem access to that
store.* Such a caller can already:
- edit the `@morphql/store` folder DB directly, or
- run `caretaker-cli` (TUI) / `caretaker-cli run` against the same store — both operate on
  it with no auth today.

The MCP server grants no capability beyond what local filesystem access to `CARETAKER_HOME`
already grants. There is no network listener. Adding a token would protect nothing (the
attacker who could read the token is the local user who already owns the store).

**This does not weaken `/api/mcp/task`.** That endpoint stays token-guarded and per-task
scoped, unchanged — it is a *network*-reachable HTTP surface consumed by a spawned
claude-code subprocess, a fundamentally different threat model. The two coexist: HTTP +
per-task token for the in-harness claude-code bridge; stdio + local-process trust for the
external general server.

## Decision 4 — Dedup: extract one shared MCP-server builder

Today `mcp_bridge.ts` privately owns `TASK_PREFIX`, `taskTools()`, and `buildServer()`.
Extract these into a new **`packages/cli/src/mcp/task_server.ts`**:

- `export const TASK_PREFIX = 'mcp__task__'`
- `export function taskTools(): Tool[]` — registry filtered by prefix
- `export function buildTaskMcpServer(info?: { name; version }): Server` — the un-prefix /
  list / call-with-stub-ctx logic, verbatim from the current `buildServer()`.

`mcp_bridge.ts` imports these (its HTTP wiring and token machinery stay). The new
subcommand imports `buildTaskMcpServer` and attaches a `StdioServerTransport`. Both
producers share one wrapping of one tool-definition source → no fork.

## Decision 5 — stdout hygiene + lean boot

stdio MCP uses **stdout for JSON-RPC framing** — the subcommand must write nothing else to
stdout (no banner, unlike `run`/`web`; diagnostics → stderr only). It must also **not** boot
the scheduler, MCP client pool, refresh-on-start, or shell-env probe: those are irrelevant
to a task-state server, add latency, and spawn side processes / network fetches. Guard the
three background boots in `index.ts` when the subcommand is `mcp` (the MCP-shutdown hook is
harmless and stays). The server stays alive on the transport (stdin open); it exits when the
client disconnects — no `process.exit` banner path.

## Out of scope

- No file/bash/edit builtins on this server (the external client has its own).
- No change to in-harness tool resolution (`resolve.ts` tri-state / plugin gating).
- No change to `/api/mcp/task` behaviour or its token model.

## Testing strategy

- **Shared builder** (`mcp/task_server.test.ts`): connect an in-memory `Client` to
  `buildTaskMcpServer()`; assert task tools are listed un-prefixed (`task_get_state`,
  `task_complete`, `task_submit_plan`, no `mcp__` leak) and `project_list` executes on an
  empty store — mirrors `mcp_bridge.test.ts`.
- **Subcommand end-to-end** (`cli/mcp.test.ts`): spawn the built/tsx entry with `mcp` via
  `StdioClientTransport` under an isolated `CARETAKER_HOME`; `listTools` + call `project_list`.
  This is the real proof of stdout hygiene and the whole subcommand path.
- **Regression:** `mcp_bridge.test.ts` unchanged and still green after the extraction.
