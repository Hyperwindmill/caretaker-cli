# ACP Runner — Design

Date: 2026-08-25
Status: approved (brainstorming complete)

## Goal

Add a new provider `type: 'acp'` that drives any agent speaking the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP v1, JSON-RPC over
stdio) as a caretaker runner. One client implementation, N runners: caretaker
implements the ACP client side once; each agent CLI is just a provider record
with a spawn command.

The existing `type: 'claude-code'` runner (`harness/claude_code_runner.ts`) is
**not touched**: the ACP runner ships alongside it (decision: side-by-side, not
cut-over). claude-code becomes a preset of the ACP runner — and the old code
path dies — only after ACP has demonstrated parity in real use; that is a
later, separate decision.

## Verified ecosystem (2026-08-25)

All three target runners have official ACP servers:

| Runner | ACP server | Maintainer | Distribution |
|---|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` (renamed from `@zed-industries/claude-code-acp`) | Zed / ACP org | npm; wraps the Claude **Agent SDK** (TS), not the CLI |
| Codex | `@agentclientprotocol/codex-acp` | ACP org | npm; very actively maintained |
| Antigravity | `agy_acp_server.par` / `.exe` | **Google LLC** (registry publisher) | proprietary binary from `dl.google.com/agy-extensions/releases/`, RC01 dated 2026-08-18 |

Notes:
- The `agy` CLI itself has no `--acp` flag (antigravity-cli#31 open); Google
  shipped the ACP server as a separate binary instead. Community wrappers
  (agy-acp etc.) exist but carry Google ToS risk — the official binary is the way.
- The official ACP Agent Registry (github.com/agentclientprotocol/registry,
  JSON at cdn.agentclientprotocol.com/registry/v1/latest/registry.json) is the
  discovery surface; deriving caretaker presets from it is deliberately out of
  scope (YAGNI).

## Architecture

### Dispatch

Same pattern as claude-code: a single check at the top of `run()`
(`opts.provider.type === 'acp'`, `harness/loop.ts`) hands the whole turn to a
new `harness/acp_runner.ts`. Because every consumer (TUI/web/VSCode/headless
chat, cron heartbeat, Telegram, autonomous task cycles, memory sweep) goes
through `run()`, the ACP runner is automatically available everywhere a
provider can be used. There is no per-surface scope: v1 is full provider
parity, implemented as the runner plus the small per-provider branch points
listed below.

### Provider config (`caretaker-types`)

New `ProviderConfig` variant:

- `type: 'acp'`
- `command: string` — spawn executable (`npx`, `/path/agy_acp_server.par`, …)
- `args: string[]`
- `env?: Record<string, string>`
- `selfLoadedContextFiles: string[]` (flattened directly on `ProviderConfig` rather than nested under `runnerHints`): context files the agent already loads itself and the prelude must therefore skip (claude → `CLAUDE.md`, codex → `AGENTS.md`). Same logic as today's CLAUDE.md exclusion in claude_code_runner.
- `endpoint`/`apiKey` stay empty as for claude-code. Auth belongs to the
  underlying agent (login done outside caretaker: `claude login`, ChatGPT
  login, Google account). v1 does not implement the ACP `authenticate` flow;
  if `initialize` reports auth is required, the run fails with the readable
  error.

Model selection is adapter configuration (env/args on the provider record),
not protocol — deliberate v1 scope cut.

### Process lifecycle

Unlike `claude -p` (one process per turn + `--resume`), the ACP child is
**long-lived per session**: spawn → `initialize` → `session/new`, then N
`session/prompt` on the same child. The runner keeps a `sessionId → child`
pool; an idle-timeout reaper closes forgotten children. Child death mid-
session → recreate via `session/load` when the agent declared the capability,
else a fresh session with caretaker-fabricated history replay (below).

`SessionMetaRecord` gains `acpSessionId` (alongside `claudeSessionId`).

### System prompt: fabricated client-side

ACP has no system-prompt field in `session/new` (only `cwd` + `mcpServers`)
and `_meta` extensions are per-adapter and not discoverable → unstable by
definition. Decision: caretaker fabricates it. The assembled prelude
(`harness/prelude.ts`) rides `session/prompt` as content blocks:

- **Stable parts** (caretaker prelude, agent `systemPrompt`, plugin/skill
  blocks, project context minus `selfLoadedContextFiles`) — first content
  block of the session's **first** turn only.
- **Volatile parts** (`<runtime-info>`, `<memories>`, voice block) — a small
  context block prepended to **every** turn.

Rationale: under ACP the prompt enters conversation history and accumulates;
this split avoids re-paying ~100KB of context per turn.

### Permission gate

`session/request_permission` maps onto one policy function for all runners:

- Interactive surfaces → today's confirm gate (same confirmation cards;
  ACP's "allow always" option maps onto the existing allow-always).
- Unattended runs (heartbeat, Telegram, tasks, sweep) → auto-allow
  (the `bypassPermissions` equivalent).
- **Planner cycles** → auto-deny by category: ACP tool calls carry a typed
  `kind` (`read`, `edit`, `delete`, `move`, `execute`, `search`, …). Planner
  read-only = deny `edit`/`delete`/`move`/`execute`, allow the rest. SDD mode:
  `edit` allowed only on `*.md` paths (requests carry `locations`). Replaces
  today's per-runner tangle (CLI flags for claude-code, tool filtering for
  native) with one function.

### Docker confinement

**With Docker** (task has `dockerContainer`):
- the `terminal` capability is **not advertised**;
- the permission gate auto-**denies** every `kind: 'execute'` tool call (the
  task system message already tells the agent it is in a container — it will
  also say "use `run_command`");
- the per-task MCP bridge exposes a caretaker-owned `run_command` tool bound
  to the task's container (`docker exec` via `containerExecArgs`, honouring
  `ctx.signal` + timeout like native tools). The tool lives only on the
  per-task bridge instance, never on the stdio `caretaker-cli mcp` server
  (no container to bind there).

Every shell command either goes through our tool (confined by construction)
or dies as a visible deny — no trust in adapter routing. This replaces the
claude-code PreToolUse Bash-rewrite hook for ACP runners.

**Without Docker**: the `terminal` capability IS advertised and implemented
host-side (`terminal/create`/`output`/`wait_for_exit`/`kill`/`release`) with
`commandEnv()` — no boundary to protect, and client terminals give streaming
and background commands for free.

`fs/read_text_file` / `fs/write_text_file` are implemented host-side against
the worktree (bind-mounted into the container — same files), mirroring
today's model where only shell is confined.

**Residual risk (per-runner parity criterion)**: the deny only works if the
adapter forwards execute permission decisions to the client.
`claude-agent-acp` does (the SDK's `canUseTool` is forwarded); Codex and
Antigravity must be verified. An adapter that does not ask is unfit for
Docker tasks until it does, and is documented as such.

**v1 deviations decided at planning time:** (a) the `terminal` client capability is NOT advertised in v1 even without Docker — agent-side host shell is the status quo and equivalent; with Docker the capability is absent by design. The capability is additive later if an adapter needs it. (b) `fs/read_text_file` / `fs/write_text_file` capabilities are NOT advertised in v1 — agent-side fs writes the same bind-mounted files. Both deviations were decided at planning time to eliminate dead surface.

### Task bridge / MCP servers

`session/new.mcpServers` accepts HTTP servers with headers: the per-task
bridge (`POST /api/mcp/task` + token) is injected as a structured field —
no more temp `--mcp-config` file. The same field carries the agent's
configured `mcpServers` (stdio and HTTP), resolved via
`resolvedServerRuntime` as today.

### Streaming and turn lifecycle

`session/update` notifications map onto existing harness events with no
bespoke parsing: `agent_message_chunk` → chunk, `agent_thought_chunk` →
thinking, `tool_call`/`tool_call_update` → tool events (with typed `kind`,
`status`, `locations` — richer than today's stream-json). ACP `plan` updates
render as thinking/text in v1 (no dedicated UI). The `session/prompt`
response's `stopReason` (`end_turn`, `max_tokens`, `refusal`, `cancelled`)
closes the turn.

### Abort and budgets

Pause and the wall-clock budget use today's `AbortController`; on signal the
runner sends `session/cancel` (clean stop, confirmed by
`stopReason: 'cancelled'`) and kills the child after a short grace timeout.
Task budget default for `type: 'acp'` is the external-runner class: 900s,
same as claude-code (`resolveMaxRunSeconds` in `scheduler/task_roles.ts`).
Like claude-code, no inner-turn bound — the wall-clock is the backstop.

### Per-provider branch points (the full checklist)

| Site | Today (claude-code) | ACP arm |
|---|---|---|
| `task_strategy.ts` / `task_review.ts` | `claudeCodeTaskExtras` (CLI flags, docker allowlist, temp mcp-config) | permission-gate policy + `run_command` bridge tool + `mcpServers` field |
| `task_roles.ts` | `isClaudeCode` → 900s default | same external-runner class → 900s |
| `title.ts` | skip AI titling (no HTTP endpoint) | same skip; truncation fallback |
| `session/types.ts` | `claudeSessionId` | `acpSessionId` |
| `memory_sweep.ts` | `claudeCode: {permissionMode: 'dontAsk'}` | auto-deny/auto-allow via the gate (unattended policy, no session persisted) |

### Resume

Live child → keep prompting. Dead child: `session/load` when the agent
declared `loadSession` (history replayed by the agent via `session/update`);
otherwise a fresh `session/new` with prior conversation fabricated by
caretaker as a context block of the first prompt (the JSONL history is ours).
Task cycles already replay history by construction — unchanged there.

## Testing

- Unit tests of the runner against a **fake ACP agent**: a small Node script
  speaking JSON-RPC over stdio with scripted responses (same approach as the
  existing claude_code_runner tests). Coverage: handshake, streaming mapping,
  planner permission deny, execute deny under Docker, cancel, load/new
  fallback, prelude split (first turn vs volatile block).
- End-to-end verification against the three real adapters is manual and is
  the exit criterion for the *future* claude_code_runner retirement — not a
  v1 gate.

## Out of scope (v1, declared)

- ACP `authenticate` flow (login happens in the agent's own CLI).
- Session modes UI.
- Model selection via protocol (stays adapter env/args config).
- Presets auto-derived from the ACP registry.
- Retiring `claude_code_runner.ts` (separate decision, gated on proven parity).

## Docs to update in the same unit of work

`CLAUDE.md` (layer 2: new provider type, dispatch, confinement model) and
`README.md` (user-facing: configuring an ACP provider, the three known
runners, auth expectations, Docker caveat per runner).
