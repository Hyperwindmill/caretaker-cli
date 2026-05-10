# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # launch the TUI (tsx src/index.ts)
npm run build        # tsc → dist/
npm start            # node dist/index.js (after build)
npm run typecheck    # tsc --noEmit
npm test             # tsx --test "src/**/*.test.ts"
```

Run a single test file: `npx tsx --test src/harness/loop.test.ts`
Run a single test by name: `npx tsx --test --test-name-pattern='resolves @refs once' src/harness/prelude.test.ts`

Isolated environment for manual TUI work: `CARETAKER_HOME=/tmp/ct npm run dev`. All on-disk state (providers, agents, sessions, plugins) lives under `CARETAKER_HOME` (default `~/.caretaker/`).

## Architecture

The codebase is a TUI agent harness. Three layers worth understanding before touching anything:

### 1. Agent execution = harness loop + resolved surface

`src/harness/loop.ts` is the chat loop. For each turn it calls `src/harness/provider.ts` (an OpenAI-compatible client) and dispatches tool calls. The set of tools available to a turn is **not** the agent's stored config — it is the output of `src/harness/tools/resolve.ts` (`resolveAgentTools`), which intersects what the agent opted into with what the registry exposes, auto-injects discovery builtins (`list_skills`, `list_commands`, `list_agents`) when their preconditions hold, and applies the tri-state policy (`[ ]` off, `[x]` allowed, `[!]` confirm-each-call). The confirm gate (`ctx.confirmTool`) is plumbed into every tool invocation, including sub-agent dispatch.

When editing tools, register them in `src/harness/tools/builtin/index.ts` and the central registry — `resolveAgentTools` is the single source of truth at runtime.

### 2. System prompt is assembled, not stored

`src/harness/prelude.ts` builds the system prompt for every turn in a fixed order:

1. Caretaker prelude (the "care about goal/environment/project" preamble — what makes an agent a *caretaker* agent).
2. The agent's own `systemPrompt`.
3. Active plugin/skill blocks.
4. Project context: `AGENTS.md` and equivalents walked up from the agent's `workingDir`, plus the same files in `$HOME` for cross-project rules. `@<file>` refs resolved single-pass.
5. `<runtime-info>` block from `src/harness/runtime_info.ts`.

Caps: 100 KB per file, 250 KB total. Order is stable across turns by design — don't shuffle it.

### 3. Plugins, MCP, and managed agents share one pattern

`src/plugins/source_manager.ts` clones sources (git or local path via `src/plugins/fetchers/`), `manifest.ts` discovers them (`cc-plugin`, skill globs, `cc-marketplace`), `loader.ts` parses YAML/JSON manifests into `PluginRecord`. The same record can contribute skills, slash commands, MCP servers, and "managed agents." Refresh failures preserve the previous good state (`refresh_on_start.ts`).

Managed agents and managed MCP servers both follow a cascading-delete model tied to their source plugin. Sub-agent dispatch (`invoke_agent`) inherits empty runtime fields from the caller (provider/model/tools/plugins/mcpServers/workingDir) but **never** `systemPrompt` or `maxTurns`. Recursion is capped at depth 5; self-invocation is rejected.

### State on disk

JSON for config (`providers.json`, `agents.json`, plugin records), JSONL for chat sessions, all under `CARETAKER_HOME`. `src/store/json.ts` does atomic writes with lazy paths. Auth tokens for plugin sources are AES-256-GCM encrypted via `src/lib/encryption.ts`; the key is persisted on disk with mode 0600.

### Tool sandbox

`src/harness/tools/sandbox.ts` rejects paths outside the agent's working directory and refuses to follow symlinks out. `write` enforces read-before-write. `edit`/`multiedit` rely on exact `oldString` match as an implicit invariant. This is convenience, not a security boundary.

## Conventions

- Tests are co-located with source as `*.test.ts`, run via Node's built-in test runner through `tsx`. No Jest, no vitest.
- TypeScript is `strict` but `noImplicitAny: false`. ESM only (`"type": "module"`), `moduleResolution: "bundler"`.
- No linter or formatter is configured — match surrounding style.
- `docs/roadmap.md` is the living design log: shipped items are kept with their commit hash, in-flight items have explicit decisions recorded. Read it before proposing architecture changes — many design questions are already answered there.
