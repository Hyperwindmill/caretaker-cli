<p align="center">
  <img src="packages/cli/assets/caretaker.png" alt="caretaker" width="220" />
</p>

# caretaker

Yet another agent harness. Yes — but built the way I want one to be.

A terminal-native home for your agents that you can also drive from a browser or from a VSCode sidebar. You create _named agents_, each with its own identity, its own tools, its own working directory, and its own conversations. You bring your keys. They do the work. All on-disk state lives under `~/.caretaker/` as plain JSON and JSONL.

## Three surfaces, one harness

The same in-process harness, agents store, plugins, MCP servers, skills, and confirm gate are shared across every entry point:

- **TUI** — `pnpm -F caretaker-cli dev` launches the Ink terminal app.
- **Web GUI** — `pnpm -F caretaker-cli dev web` (or `caretaker-cli web --port 3000`) starts a local Hono server that serves the webview as a desktop-grade two-column web app.
- **VSCode sidebar** — `packages/vscode-extension/` embeds the harness as an ESM library (no subprocess). Same `~/.caretaker/` state, same agents, same conversations. See [packages/vscode-extension/README.md](packages/vscode-extension/README.md) for the F5 / dev loop.
- **Headless** — `caretaker-cli run [prompt...] --agent <name>` does one-shot dispatches for scripts and CI; `--output json` for a structured blob.

## What makes it caretaker

### Quick setup

`pnpm install`, `pnpm -F caretaker-cli dev`, and the first-run wizard walks you through adding a provider and creating your first agent. No accounts, no daemons, no signup.

State lives under `~/.caretaker/` as plain JSON and JSONL — readable, inspectable, deletable. Override the root with `CARETAKER_HOME=/path/to/dir` and you have an isolated environment in one env var. Writes go through a tmp-file + atomic rename, with a Windows-safe retry on EACCES/EPERM/EBUSY so Defender or OneDrive locking the file doesn't corrupt your config.

### BYOK — bring your own keys

Any OpenAI-compatible provider works: hosted endpoints, internal gateways, local model servers. Add a base URL and an API key; the TUI auto-fetches the model list from `/v1/models` so you pick from real options instead of typing model strings.

Secrets at rest are AES-256-GCM encrypted: plugin-source auth tokens, MCP server credentials, scheduler Telegram bot tokens. The encryption key is persisted with mode 0600.

### Agent identities, not "an agent"

Caretaker is built around having _several_ agents that mean different things to you — a code agent rooted in one repo with a focused toolset, a writing agent in your notes folder with no shell, a research agent with read-only tools and web fetch.

Each agent has its own model, system prompt, working directory, allowed tools, plugins, MCP servers, and persistent chat history. You switch between them; they don't bleed into each other.

### Closed by default

A new agent has _zero_ tools. You opt in, one by one, in a tri-state picker: `[ ]` off, `[x]` allowed, `[!]` allowed-but-confirm-each-call.

The runtime confirm gate prompts before every call to a `[!]` tool: _Run once_, _Always (this session)_, or _Reject_. "Always" is per-session — a restart restores caution. A gate that throws is treated as reject. Esc rejects the single call without aborting the run.

There is no implicit shell, no implicit filesystem write, no surprise capability.

### Caretaker agents have a prelude

What makes an agent a _caretaker_ agent and not a generic chat completion is a small, always-prepended system prompt. It tells the model it is a caretaker, and that being one means three things: **care about the goal** (the task is successful only when the user is satisfied), **care about the environment** (check that actions are never harmful), and **care about the project** (every change should leave it better — when the requested path won't, push back and propose a better one).

The prelude is followed by your agent's own system prompt, then by the active plugin/skill blocks, then by project context: `AGENTS.md` and the most commonly used alternatives, walked up from the agent's working directory, plus equivalent files in your home for cross-project rules. Everything is capped at 100 KB/file and 250 KB total, with `@<file>` refs resolved single-pass. The order is stable across every turn, so the model's sense of where it is doesn't drift.

### A soft filesystem jail

Tools that touch files refuse paths outside the agent's working directory and don't follow symlinks out of it. `write` enforces read-before-write. `edit` and `multiedit` rely on exact `oldString` match as an implicit invariant.

None of this is a security boundary against an adversary; all of it stops the boring accidents that happen ten times a day.

### Plugins, MCP, skills, slash commands

Agents can pull in plugins from git repositories or local paths. Sources are managed from the TUI/web GUI (add, refresh, remove); each agent then opts in to the plugins it wants. A single plugin record can ship:

- **skills** — markdown blocks injected into the system prompt when the agent opts in, plus the `list_skills` / `read_skill` builtins so the model can pull a skill in on demand.
- **slash commands** — `/foo args` parsed from the chat input. Per-agent gating via `agent.plugins`; arguments expand via `$1..$9` / `$ARGUMENTS`. Mirrored on the agent side as `list_commands` / `invoke_command` so the model itself can enumerate and expand.
- **managed agents** — extra agent rows that show up alongside the ones you created by hand.
- **MCP servers** — both stdio and HTTP/SSE clients are pooled and tracked; tools, prompts and resources are surfaced through the same registry as native builtins.

Refresh failures preserve the previous good state, so an outage doesn't strip plugins mid-session. Managed agents and managed MCP servers follow a cascading-delete model tied to their source plugin.

### Sub-agent dispatch

When more than one agent exists, every agent gets `list_agents` and `invoke_agent({name, task})` auto-injected. The child inherits provider/model/tools/plugins/mcpServers/workingDir from the caller when its own fields are empty, but **never** `systemPrompt` or `maxTurns`. Recursion is capped at depth 5; self-invocation is rejected. The confirm gate is plumbed all the way through, so the user still gates child tool calls.

### Scheduler

An in-process background scheduler runs as long as the TUI / web server is up. Two strategies ship today, both per-agent and configurable from the **Scheduler** settings panel:

- **Heartbeat** — standard cron expression (`* * * * *`, lists, ranges, step patterns) fires a one-shot run of the agent with a fixed prompt. Tool calls auto-approve (it's unattended).
- **Telegram poller** — polls Telegram `getUpdates` and routes incoming messages to the agent as an interactive conversation. The bot token is encrypted at rest; the offset is committed atomically before processing to prevent duplicate runs; messages from the same chat are serialised so a rapid second message never gets dropped. The Allowed Chat IDs whitelist is the only access boundary — without it, anyone who knows the token can execute every tool the agent has enabled, which the UI calls out explicitly.

Each task gets its own JSONL execution log under `~/.caretaker/scheduler-logs/`; the web GUI's Execution Console shows past runs with full message rendering.

## Quick start

```bash
pnpm install
pnpm -F caretaker-cli dev                          # launch the TUI
pnpm -F caretaker-cli dev web                      # local web GUI
CARETAKER_HOME=/tmp/ct pnpm -F caretaker-cli dev   # isolated dev environment
```

```bash
pnpm build                       # build every package (cli + vscode + webview-ui)
pnpm test                        # run every package's tests
pnpm -F caretaker-cli test       # node test runner for the cli alone
pnpm -F caretaker-cli typecheck  # tsc --noEmit
```

Package manager: **pnpm** (≥10). The repo is a pnpm workspaces monorepo.

On first run: pick **Providers → New**, paste your base URL and key, save. Then **Agents → New**, choose a model, name the agent, set a working directory, pick your tools, write a system prompt, and start chatting.

## Built-in tools

Filesystem (sandboxed to the agent's working directory): `read_file`, `write`, `edit`, `multiedit`, `glob`, `grep`.

Network: `fetch`. Shell: `bash`.

Auto-injected by the resolver when their preconditions hold (so the agent's opt-in surface isn't polluted by them):

- `list_skills`, `read_skill` — when the agent has at least one active plugin.
- `list_commands`, `invoke_command` — same gating as skills.
- `list_agents`, `invoke_agent` — when there is more than one agent configured.
- `get_agent_context` — always present, so the agent can introspect "how much context am I using".

## Layout

```
packages/cli/src/
├── index.ts                entry: TUI render + boot-time plugin refresh + MCP shutdown
├── types.ts                AgentConfig, ProviderConfig, PluginSource, ScheduledTaskConfig, …
├── cli/                    subcommand router (commander): TUI default, `run`, `web`
│   ├── run.ts                one-shot headless dispatch
│   └── web/                  local Hono server + WebSocket bridge to the webview
│       ├── server.ts             HTTP/WS routes, harness invocation, scheduler boot
│       ├── scheduler.ts          tick loop, daemon lifecycle, public re-exports
│       └── scheduler/            strategy pattern: heartbeat, telegram, locks, logs
├── store/json.ts           atomic JSON writes (tmp+rename, Windows-safe retry)
├── lib/encryption.ts       AES-256-GCM helpers used by every secret at rest
├── harness/                loop, provider, prelude, context_files, runtime_info
├── harness/tools/          built-in tools (sandboxed) + registry + resolver
├── plugins/                source manager, fetchers (git/path), manifest, loader
├── mcp/                    client pool, server_manager, adapter to the tool registry
├── commands/               slash-command loader and expansion
├── agents/                 sub-agent dispatch + plugin↔agent sync
├── tui/                    Ink screens: agents, providers, plugins, MCP, chat, scheduler
└── session/                JSONL session store

packages/vscode-extension/  VSCode sidebar — embeds caretaker-cli as an ESM library
packages/webview-ui/        shared React webview (used by both vscode-extension and `caretaker-cli web`)
```

## Status

`caretaker-cli` `v0.0.1`, `caretaker-vscode` `v0.1.12`, `webview-ui` `v0.1.0`. Personal project, kept prod-ready piece-by-piece — every shipped subsystem is complete in its scope rather than a half-done MVP.
