# caretaker-cli

Yet another agent CLI. Yes — but built the way I want one to be.

A terminal-native home for your agents: a quiet TUI where you create *named agents*, each with its own identity, its own tools, its own working directory, and its own conversations. You bring your keys. They do the work.

## What makes it caretaker

### Quick setup

`npm install`, `npm run dev`, and the first-run wizard walks you through adding a provider and creating your first agent. No accounts, no daemons, no signup.

State lives under `~/.caretaker/` as plain JSON and JSONL — readable, inspectable, deletable. Override the root with `CARETAKER_HOME=/path/to/dir` and you have an isolated environment in one env var.

### BYOK — bring your own keys

Any OpenAI-compatible provider works: hosted endpoints, internal gateways, local model servers. Add a base URL and an API key; the TUI auto-fetches the model list from `/v1/models` so you pick from real options instead of typing model strings.

Auth tokens for plugin sources are encrypted at rest (AES-256-GCM).

### Agent identities, not "an agent"

Caretaker is built around having *several* agents that mean different things to you — a code agent rooted in one repo with a focused toolset, a writing agent in your notes folder with no shell, a research agent with read-only tools and web fetch.

Each agent has its own model, system prompt, working directory, allowed tools, plugins, and persistent chat history. You switch between them; they don't bleed into each other.

### Closed by default

A new agent has *zero* tools. You opt in, one by one, in a tri-state picker: `[ ]` off, `[x]` allowed, `[!]` allowed-but-confirm-each-call.

The runtime confirm gate prompts before every call to a `[!]` tool: *Run once*, *Always (this session)*, or *Reject*. "Always" is per-session — a restart restores caution. A gate that throws is treated as reject. Esc rejects the single call without aborting the run.

There is no implicit shell, no implicit filesystem write, no surprise capability.

### Caretaker agents have a prelude

What makes an agent a *caretaker* agent and not a generic chat completion is a small, always-prepended system prompt. It tells the model it is a caretaker, and that being one means three things: **care about the goal** (the task is successful only when the user is satisfied), **care about the environment** (check that actions are never harmful), and **care about the project** (every change should leave it better — when the requested path won't, push back and propose a better one).

The prelude is followed by your agent's own system prompt, then by the active plugin/skill blocks, then by project context: `AGENTS.md` and the most commonly used alternatives, walked up from the agent's working directory, plus equivalent files in your home for cross-project rules. Everything is capped at 100 KB/file and 250 KB total, with `@<file>` refs resolved single-pass. The order is stable across every turn, so the model's sense of where it is doesn't drift.

### A soft filesystem jail

Tools that touch files refuse paths outside the agent's working directory and don't follow symlinks out of it. `write` enforces read-before-write. `edit` and `multiedit` rely on exact `oldString` match as an implicit invariant.

None of this is a security boundary against an adversary; all of it stops the boring accidents that happen ten times a day.

### Plugins

Agents can pull in plugins from git repositories or local paths. Sources are managed from the TUI (add, refresh, remove); each agent then opts in to the plugins it wants.

Refresh failures preserve the previous good state, so an outage doesn't strip plugins mid-session.

## Quick start

```bash
npm install
npm run dev                          # launch the TUI
CARETAKER_HOME=/tmp/ct npm run dev   # isolated dev environment
```

```bash
npm test          # node test runner
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
```

On first run: pick **Providers → New**, paste your base URL and key, save. Then **Agents → New**, choose a model, name the agent, set a working directory, pick your tools, write a system prompt, and start chatting.

## Built-in tools

`read_file`, `write`, `edit`, `multiedit`, `glob`, `grep`, `fetch`, `bash`. All sandboxed to the agent's working directory. All off until you turn them on.

## Layout

```
src/
├── index.ts             entry: TUI render + boot-time plugin refresh
├── types.ts             AgentConfig, ProviderConfig, PluginSource, PluginRecord, …
├── store/json.ts        file store (lazy paths, atomic writes)
├── lib/encryption.ts    AES-256-GCM (ENCRYPTION_KEY env)
├── harness/             loop, provider, prelude, context_files, title
├── harness/tools/       built-in tools
├── plugins/             source manager, fetchers (git/path), manifest, loader
├── tui/                 app, agents, providers, plugins, chat
└── session/             JSONL session store
```

## Status

`v0.0.1`. Harness, tools, TUI, confirm gate, plugin system, encrypted auth-token storage, and session persistence are in.
