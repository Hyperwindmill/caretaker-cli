# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

pnpm workspaces monorepo, three packages:

- `packages/cli/` — the Caretaker CLI/TUI (published as `caretaker-cli`). Authoritative source of the harness, store, plugins, MCP, commands, sub-agent dispatch, scheduler, and tool registry. Also ships a Hono-based local web server (`caretaker-cli web`).
- `packages/webview-ui/` — shared React UI bundled by esbuild. Consumed by both `cli/web/` (served by `caretaker-cli web`) and `vscode-extension/` (loaded into the sidebar webview). Public exports: `./` (App) and `./bridge` (host↔view message contract).
- `packages/vscode-extension/` — VSCode chat sidebar (`caretaker-vscode`). Embeds `caretaker-cli` as an ESM library via the public `./harness`, `./store`, `./session`, `./plugins`, `./mcp`, `./types` exports. Does not subprocess the CLI. See [packages/vscode-extension/README.md](packages/vscode-extension/README.md) for the F5 / dev loop.

All commands below run from the repo root unless noted.

## Commands

```bash
pnpm install                            # bootstrap the workspace
pnpm -F caretaker-cli dev               # launch the TUI (tsx packages/cli/src/index.ts)
pnpm -F caretaker-cli dev web           # launch the local web GUI on http://127.0.0.1:3000
pnpm -F caretaker-cli build             # tsc → packages/cli/dist/
pnpm -F caretaker-cli start             # node dist/index.js (after build)
pnpm -F caretaker-cli typecheck         # tsc --noEmit
pnpm -F caretaker-cli test              # tsx --test "packages/cli/src/**/*.test.ts"
pnpm -F webview-ui build                # esbuild → packages/webview-ui/dist/
pnpm -F webview-ui dev                  # esbuild --watch
pnpm -F caretaker-vscode build          # build extension host + webview bundles
pnpm build                              # build every package (pnpm -r build)
pnpm test                               # test every package (pnpm -r test)
```

Run a single test file: `pnpm -F caretaker-cli exec tsx --test packages/cli/src/harness/loop.test.ts`
Run a single test by name: `pnpm -F caretaker-cli exec tsx --test --test-name-pattern='resolves @refs once' packages/cli/src/harness/prelude.test.ts`

Isolated environment for manual TUI / web work: `CARETAKER_HOME=/tmp/ct pnpm -F caretaker-cli dev`. All on-disk state (providers, agents, sessions, plugins, MCP, scheduler logs) lives under `CARETAKER_HOME` (default `~/.caretaker/`).

Package manager: **pnpm** (≥10). The root has `pnpm-workspace.yaml`; `package-lock.json` and `npm install` are not supported.

## Architecture

The codebase is a multi-surface agent harness (TUI, web GUI, VSCode sidebar, headless `run`). All surfaces drive the same in-process harness against the same `~/.caretaker/` state. Five layers worth understanding before touching anything:

### 1. Surfaces are thin; harness is shared

- TUI: `packages/cli/src/tui/` (Ink). Default when `caretaker-cli` is invoked with no subcommand.
- Headless: `packages/cli/src/cli/run.ts`. `caretaker-cli run [prompt] --agent <name> [--tools …] [--output plain|json]`.
- Local web GUI: `packages/cli/src/cli/web/server.ts` — Hono HTTP + WebSocket bridge that serves the `webview-ui` bundle and proxies chat / settings / scheduler actions into the same harness functions the TUI uses.
- VSCode sidebar: `packages/vscode-extension/` imports `caretaker-cli` directly through its public exports. No subprocess; same harness, same store.

Subcommand routing lives in `packages/cli/src/cli/index.ts` (commander). Adding a new surface should reuse the harness/store/session modules — never re-implement the loop.

### 2. Agent execution = harness loop + resolved surface

`packages/cli/src/harness/loop.ts` is the chat loop. For each turn it calls `packages/cli/src/harness/provider.ts` (an OpenAI-compatible client) and dispatches tool calls. The set of tools available to a turn is **not** the agent's stored config — it is the output of `packages/cli/src/harness/tools/resolve.ts` (`resolveAgentTools`), which intersects what the agent opted into with what the registry exposes, auto-injects discovery builtins (`list_skills`, `read_skill`, `list_commands`, `invoke_command`, `list_agents`, `invoke_agent`, `get_agent_context`) when their preconditions hold, and applies the tri-state policy (`[ ]` off, `[x]` allowed, `[!]` confirm-each-call). The confirm gate (`ctx.confirmTool`) is plumbed into every tool invocation, including sub-agent dispatch.

When editing tools, register them in `packages/cli/src/harness/tools/builtin/index.ts` and the central registry — `resolveAgentTools` is the single source of truth at runtime.

### 3. System prompt is assembled, not stored

`packages/cli/src/harness/prelude.ts` builds the system prompt for every turn in a fixed order:

1. Caretaker prelude (the "care about goal/environment/project" preamble — what makes an agent a _caretaker_ agent).
2. The agent's own `systemPrompt`.
3. Active plugin/skill blocks.
4. Project context: `AGENTS.md` and equivalents walked up from the agent's `workingDir`, plus `~/.caretaker/AGENTS.md` for cross-project rules. `@<file>` refs resolved single-pass.
5. `<runtime-info>` block from `packages/cli/src/harness/runtime_info.ts`.

Caps: 100 KB per file, 250 KB total. Order is stable across turns by design — don't shuffle it.

### 4. Plugins, MCP, commands, and managed agents share one pattern

`packages/cli/src/plugins/source_manager.ts` clones sources (git or local path via `packages/cli/src/plugins/fetchers/`), `manifest.ts` discovers them (`cc-plugin`, skill globs, `cc-marketplace`), `loader.ts` parses YAML/JSON manifests into `PluginRecord`. A single record can contribute skills, slash commands (`packages/cli/src/commands/`), MCP servers (`packages/cli/src/mcp/`), and "managed agents" (`packages/cli/src/agents/sync.ts`). Refresh failures preserve the previous good state (`refresh_on_start.ts`).

MCP servers are pooled by `mcp/client.ts` (both stdio and HTTP/SSE); their tools/prompts/resources flow into the same registry as native builtins via `mcp/adapter.ts`. Managed agents and managed MCP servers follow a cascading-delete model tied to their source plugin. Sub-agent dispatch (`invoke_agent`, in `packages/cli/src/agents/dispatch.ts`) inherits empty runtime fields from the caller (provider/model/tools/plugins/mcpServers/workingDir) but **never** `systemPrompt` or `maxTurns`. Recursion is capped at depth 5; self-invocation is rejected.

### 5. Scheduler

The web server boots an in-process background scheduler (`packages/cli/src/cli/web/scheduler.ts`) that ticks every 15 s. Two strategies ship — both per-agent, configured from the Scheduler settings panel:

- **Heartbeat** (`scheduler/heartbeat.ts`): standard 5-field cron with wildcards, lists, ranges, and step patterns. Fires `executeTaskRun(task)`, which auto-approves all tool calls (the run is unattended).
- **Telegram** (`scheduler/telegram.ts`): polls `getUpdates` against the Telegram API and routes messages into `executeTelegramTaskRun` as an interactive conversation. Encryption applied on save; the update offset is committed atomically *before* processing to make duplicate runs impossible across concurrent ticks; messages from the same `chat.id` are grouped and processed sequentially (different chats progress in parallel) so a rapid second message from the same user can't be silently dropped.

Cross-strategy shared state lives in `scheduler/locks.ts` (`runningTasks` Set) and `scheduler/logs.ts` (log dir + JSONL append/read). Strategies depend on sibling modules, never on the parent `scheduler.ts`.

### State on disk

JSON for config (`providers.json`, `agents.json`, plugin records, MCP), JSONL for chat sessions and scheduler logs, all under `CARETAKER_HOME`. `packages/cli/src/store/json.ts` writes via tmp + atomic rename, with a Windows-safe retry loop on `EACCES`/`EPERM`/`EBUSY` (Defender, OneDrive, indexer locks rename targets briefly — retry 5× with exponential backoff before propagating, never fall back to a non-atomic direct write). The same pattern is mirrored in `scheduler/telegram.ts:saveTelegramOffset`. Secrets at rest (plugin auth tokens, MCP credentials, Telegram bot tokens) are AES-256-GCM encrypted via `packages/cli/src/lib/encryption.ts`; the key is persisted on disk with mode 0600.

### Tool sandbox

`packages/cli/src/harness/tools/sandbox.ts` rejects paths outside the agent's working directory and refuses to follow symlinks out. `write` enforces read-before-write. `edit`/`multiedit` rely on exact `oldString` match as an implicit invariant. This is convenience, not a security boundary.

## Conventions

- Tests are co-located with source as `*.test.ts`, run via Node's built-in test runner through `tsx`. No Jest, no vitest.
- TypeScript is `strict` but `noImplicitAny: false`. ESM only (`"type": "module"`), `moduleResolution: "bundler"`.
- ESLint (typescript-eslint + react + react-hooks, prettier-disable on top) and Prettier are wired up via `packages/cli/eslint.config.js` and `packages/cli/.prettierrc.json`. `pnpm -F caretaker-cli lint` / `lint:fix` / `format` / `format:check`. There is no CI gate enforcing them — match surrounding style and keep diffs clean.
- All paths under `~/.caretaker/` come from accessor functions (`dataDir()`, `configPath()`, …) resolved at call time, not at import time, so tests can swap `CARETAKER_HOME` between suites within the same process.
- Atomic-write policy for any persisted state: tmp file + rename + Windows-retry. Don't fall back to a direct `writeFile` on the destination path — that's exactly the case the atomicity is meant to protect against.
- `docs/roadmap.md` exists but is **stale** — do not rely on it for current state. Use `git log`, the code, and this file instead.
