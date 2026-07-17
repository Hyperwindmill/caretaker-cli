# Claude Code as a runner — design

**Date:** 2026-07-17
**Status:** approved design, pre-plan

## Problem

caretaker v1 was born with Claude Code as its runner; caretaker-cli grew its own
in-process harness because provider TOS closed the programmatic-use path. That
constraint has shifted: Anthropic is expected to treat programmatic Claude Code
use as billable extra usage, which is acceptable. We reintroduce Claude Code as
an optional runner, everywhere, as a peer of the native harness — via
`claude -p` with JSON streaming output.

## Decisions (brainstorming outcomes)

- **Scope:** all surfaces — chat (TUI/web/VSCode), headless `run`, scheduler
  strategies (cron heartbeat, Telegram), and the autonomous task system.
- **Config shape:** a provider *type*, not a new agent field.
- **Tools/permissions:** Claude Code's native tools with a Claude Code
  permission mode; no per-call caretaker confirm gate for these agents.
- **Task system:** supported from day one via an MCP bridge exposing the task
  tools.
- **Cost:** a UI note stating that programmatic use may be billed as extra
  usage by Anthropic. No metering on our side.

## 1. Provider type

`ProviderConfig` gains `type?: 'openai' | 'claude-code'` (absent = `'openai'`;
no migration needed). A `claude-code` provider has:

- no `endpoint`, no `apiKey` — it rides the user's local Claude Code login;
- optional `command?: string`, default `claude` resolved from `PATH`;
- a provider-form note: *"Uses your local Claude Code session; Anthropic may
  bill programmatic use as extra usage."*

Provider health check: `<command> --version`.

Agents select it like any provider; `AgentConfig.model` is passed through as
`--model` (alias or full model id).

## 2. Runner module

New `packages/cli/src/harness/claude_code_runner.ts`, a peer of `loop.ts`. The
abstraction is the existing `run(RunOptions, RunCallbacks): Promise<RunResult>`
contract — the runner implements it a second time; `loop.ts` stays untouched
and the dispatch is a single `provider.type === 'claude-code'` check at the
`run()` entry. No runner registry, no capability flags — with two runners
that's speculative; a third runner can promote the branch to a lookup later.
Callers keep passing `tools`/`provider`/`agent` as today (the claude-code
runner ignores the resolved toolset). No surface changes: TUI, web, VSCode,
headless `run`, scheduler and tasks all flow through the same entry point.
Role-specific flag assembly for task runs (planner/reviewer) is encapsulated
in the runner module so the heartbeat keeps a single branch.

Per turn, spawn one process:

```
claude -p <prompt>
  --output-format stream-json --include-partial-messages --verbose
  --model <agent.model>
  --permission-mode <mode>
  --append-system-prompt <agent.systemPrompt>
  [--mcp-config <tmpfile> --strict-mcp-config]
  [-r <ccSessionId>]
```

with `cwd = workingDir` (worktree path for task runs).

- **Session continuity:** the Claude Code `session_id` from the stream-json
  init event is persisted in the caretaker session JSONL metadata; subsequent
  turns pass `--resume <id>`. Caretaker's JSONL remains the display record;
  Claude Code owns the canonical conversation state.
- **Event mapping:** assistant text deltas → `onContent`; thinking →
  `onThinking`; `tool_use` blocks → `onToolCall` (rendered collapsed like
  native tool use); `tool_result` → `onToolResult`; the final `result` event →
  usage (input/output/cache tokens) plus `total_cost_usd`, surfaced in the UI.
- **Abort:** kill the child process.
- **Flags verified against the installed CLI** (`--help`, 2026-07-17). The
  current CLI has no `--max-turns`; `AgentConfig.maxTurns` is ignored (and
  hidden) for claude-code agents.

## 3. System prompt and context

`--append-system-prompt` carries the agent's `systemPrompt` plus a filtered
project context. The caretaker prelude, plugin/skill blocks and
`<runtime-info>` are **not** sent — Claude Code has its own system prompt.

Context files need care: Claude Code auto-loads **only CLAUDE.md** (project,
parents, `~/.claude/CLAUDE.md`) — verified against the installed binary
(2.1.207), where AGENTS.md appears only in the `/init` prompt. Caretaker's
walk covers `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and the global
`~/.caretaker/AGENTS.md`. So the runner reuses the existing
`context_files.ts` walk and appends its output **minus the CLAUDE.md
entries** (Claude Code already reads those itself), same 100 KB / 250 KB
caps. Projects whose rules live in AGENTS.md/GEMINI.md, and the caretaker
global rules, keep working on the claude-code runner.

- Caretaker plugins do not apply to claude-code agents (hidden in the form).
- The agent's `mcpServers` **do** apply: per run, caretaker writes a temporary
  mcp-config JSON translating the selected servers (stdio command / HTTP URL,
  credentials decrypted at spawn time) and passes it via
  `--mcp-config --strict-mcp-config`. Temp file removed after the run.

## 4. Agent form UI

When the selected provider is claude-code:

- hide the tool picker (tri-state), plugins picker, and maxTurns;
- show a **permission mode** select with the CLI's real choices:
  `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`;
- default = `permissions.defaultMode` read from `~/.claude/settings.json` when
  present (best-effort detection), else `acceptEdits`;
- show the extra-usage note here too.

Unattended runs (cron heartbeat, Telegram, task heartbeat) force
`bypassPermissions`, mirroring today's auto-approve for unattended harness
runs. Persisted as `AgentConfig.permissionMode?: string` (only meaningful for
claude-code agents).

## 5. Task system — MCP bridge

The task heartbeat only runs inside the web server, so the bridge lives there:
the web server exposes the built-in task tools as a **streamable HTTP MCP
endpoint** guarded by a per-run token. When the resolved role agent is
claude-code:

- the generated mcp-config names the server `task`, so tool names remain
  `mcp__task__*` — prompts and docs unchanged;
- the per-cycle prompt (including replayed `plan`/`review` messages) is passed
  as the `-p` prompt text;
- **planner (non-SDD):** `--permission-mode manual` plus
  `--allowedTools Read Glob Grep mcp__task` — in `-p` mode unanswered
  permission prompts are denied, so everything outside the allowlist is
  effectively blocked. (Not `--permission-mode plan`: plan mode could also
  block MCP calls, and `mcp__task__task_submit_plan` must go through.)
- **planner (SDD):** same, with `Write(**/*.md)`, `Edit(**/*.md)`,
  `MultiEdit(**/*.md)` added to the allowlist and `Bash` in
  `--disallowedTools` — equivalent of the `.md`-only path guard;
- **reviewer:** task tools omitted from the mcp-config — equivalent of the
  `mcp__task__*` strip.

Worktree creation, per-cycle WIP commits, the no-progress guard and the review
verdict parsing are untouched: they live outside the runner.

Because the MCP endpoint runs in the same process as the store, no second
process ever opens the folder DB — no concurrent-access risk.

## 6. Error handling

- Binary missing or not authenticated → clear first-turn error in chat
  ("Claude Code CLI not found / not authenticated"), not a silent hang.
- Non-zero exit or a `result` event with an error subtype → surfaced as an
  error message on the turn.
- Abort kills the child; a killed turn is recorded as interrupted, same as
  native harness aborts.

## 7. Testing

- stream-json parser tested against **fixtures captured from real
  `claude -p` runs** (never reconstructed from memory), co-located as
  `claude_code_runner.test.ts`.
- Provider-type resolution and branch selection unit-tested.
- MCP bridge: token gating and tool exposure tested at the web-server layer.
- `pnpm typecheck` is mandatory (tests via tsx do not type-check).

## Out of scope

- Bridging caretaker's confirm gate into Claude Code via
  `--permission-prompt-tool` (possible later evolution).
- Passing caretaker plugins/skills into Claude Code.
- Cost metering or budget enforcement.

## Versioning

One changeset, `minor`, on the fixed group.
