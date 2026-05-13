# Roadmap

Living checklist for the next pieces. Order is the order we plan to ship;
each pezzo is a single commit (or a small string of related commits) and
must be **prod-ready in its scope** before moving on. `[ ]` = todo,
`[x]` = shipped, with the closing commit hash next to it.

Last updated: 2026-05-11 (post `543e539`).

---

## ~~In flight~~ Done: subagent dispatch (commit `377b3bf`)

All checklist items below shipped. Plugin-managed agents are now usable as
sub-agents straight after a plugin refresh — empty runtime fields inherit
from the caller, so a plugin agent with no MCP/tools/provider configuration
runs with the parent's surface.

- [x] **Builtin tool `list_agents`** — returns `[{name, model, provider, managed}]` for every row in `agents.json` except the caller; auto-included by `resolveAgentTools` whenever ≥1 other agent exists.
- [x] **Builtin tool `invoke_agent({name, task})`** — one-shot dispatch, returns final assistant text or `Error: …`.
- [x] **Field-level inheritance** — provider, model, allowedTools, confirmTools, plugins, mcpServers, workingDir all inherit when empty/undefined; systemPrompt never; maxTurns never.
- [x] **Tool surface resolution** — `resolveAgentTools(effective, registry)` so the inherited surface is bounded by what the caller had.
- [x] **No history** — child starts fresh, only `task` as user message.
- [x] **Confirm gate inheritance** — `ctx.confirmTool` is plumbed through; user gates child tool calls.
- [x] **Signal propagation** — `ctx.signal` shared with the child run.
- [x] **Recursion guard** — `dispatchDepth` capped at 5; over → `Error: dispatch depth exceeded`.
- [x] **Self-invocation guard** — same id rejected with `Error: agent cannot invoke itself`.
- [x] **Error surfacing** — guard errors / aborted / max_turns rendered as tool-result strings; parent loop continues.

### Open question (not blocking)

- [ ] Sub-session persistence — each invocation leaving a trace in the parent's session log. Defer.

---

## ~~Next~~ Done: commands (commit `42f8d46`)

Decisions taken:

- [x] Trigger surface = slash parser in chat input (`/foo args`). No top-level menu.
- [x] Arguments = inline. `argument-hint` is just a free-text placeholder, no form prompting.
- [x] Per-agent gating = via `agent.plugins`. Same model as skills — the plugin must be active for the agent for `/foo` to resolve.
- [x] Persistence = no separate store; `PluginRecord.commands` is the source of truth. Resolved at chat time.
- [x] Naming = scopedName (filename basename). On collision (two active plugins both define `/foo`), first plugin in `agent.plugins` wins.
- [x] Expansion = `$1`..`$9` and `$ARGUMENTS` only. Missing positionals collapse to empty. Quoted spans (double quotes) preserved as one positional.
- [x] Unknown command = inline error banner, chat stays in input mode (no session pollution).
- [x] **Agent-side invocation** — `list_commands` + `invoke_command` builtins so the LLM can enumerate and expand commands itself (mirrors `list_skills` / `read_skill`). Same gating: auto-included when `agent.plugins` is non-empty.

---

## Next: hooks

Shell hooks fired on lifecycle events (SessionStart, PreToolUse, PostToolUse, Stop).
Discovery: `<plugin-root>/hooks/<event>.<sh|js|*>` or a manifest mapping events → executables.

Open design questions:

- [ ] **Spec source** — Claude Code uses `~/.claude/settings.json` + `hooks` field with explicit shell command + matcher. Our angle: do we mimic that, or restrict to plugin-shipped hooks for now?
- [ ] **Mapping to our loop** — SessionStart at `loop.run` entry; PreToolUse/PostToolUse already correspond to our confirm gate; Stop on `loop.run` exit. Custom events?
- [ ] **Sandboxing** — hook scripts get full shell. Acceptable since it's user-installed plugins, but worth surfacing in the TUI when adding a new source ("this plugin defines hooks that will run on …").

---

## Sandbox / plugin-cache access

The fs tools (`read_file`, `glob`, `grep`, `bash`) reject paths outside
`ctx.workingDir`. Legitimate use case that hits this wall: an agent wants
to inspect plugin assets it knows about — the body of a skill it's about
to follow, a script referenced by an MCP server's `args`, the template
of a command it's about to expand — but those files live under
`~/.caretaker/plugin-cache/<source-uuid>/<plugin-relPath>/...` (or under
the user's `path` source dir), outside the working directory.

Three candidate solutions, to weigh when we tackle this:

- [ ] **Extra sandbox roots** — `ToolContext.extraReadRoots: string[]`
  populated by the loop with the absolute paths of every plugin root
  active for this agent. `assertWithinRoot` accepts a path that's inside
  any of the configured roots, not just `workingDir`. Read-only by
  default; writes still gated to `workingDir`.
- [ ] **Dedicated `read_plugin_file({plugin, relPath})` builtin** — same
  kind of resolver as the MCP / skills loaders, scopes by `agent.plugins`,
  bypasses the path sandbox via an explicit absolute-root resolution.
  More restrictive surface but redundant with `read_file` for the user.
- [ ] **Auto-expand `read_skill` to also expose dir-level reads** — fits
  the "follow what list_skills tells you" pattern but doesn't help with
  MCP scripts or command templates.

Inclination is option 1 — generalizes naturally, keeps the existing tool
surface, requires only a small change in `sandbox.ts`. Decide when the
need is hot.

## ~~IDE extensions~~ Done: VSCode MVP (commits `9d563c4` → `9e5267d`)

Shipped as `packages/vscode-extension/` — chat sidebar driven in-process
by the same `harness.run` the TUI uses. Decision recap (overrides the
previous "child-process + JSON-RPC" lean once `caretaker run` proved
the harness was already headless-capable):

- **In-process library import** won over child-process + JSON-RPC.
  The original argument against ("we'd have to invent headless mode")
  vanished when `caretaker run` shipped; the embed cost is `pnpm
  workspaces` + two barrel files, the subprocess cost was a full
  JSON-RPC protocol on both sides. Lifecycle concerns (MCP children
  adopted by the extension host, session JSONL contention) are
  addressed by abort-on-deactivate plumbing and a documented
  single-window assumption.
- **Working directory**: the open VSCode workspace folder wins
  unconditionally over `agent.workingDir` (option a from the design's
  Q3). `@file` refs in the system prompt resolve from the workspace.
- **CRUD surface**: read-only / chat-only MVP. Agent / plugin / MCP
  management stays in the TUI for now.
- **Session-store contention**: accepted as a documented limit.
  Two VSCode windows on the same workspace + same agent will
  interleave JSONL appends. A `session.lock` is a follow-up if anyone
  hits it.
- **Tool calls as first-class events**: ✅ separate bridge messages,
  never folded into the chunk stream.
- **Confirm gate**: tri-state inline card (Run once / Always (this
  chat) / Reject) matches the TUI 1:1.

Spec: [`docs/superpowers/specs/2026-05-13-vscode-extension-design.md`](superpowers/specs/2026-05-13-vscode-extension-design.md).
Progress log with per-step commit hashes: [`docs/superpowers/specs/2026-05-13-vscode-extension-progress.md`](superpowers/specs/2026-05-13-vscode-extension-progress.md).

### Future evolution path (not in flight)

The subprocess + JSON-RPC route is preserved for the day it pays for
itself. Triggers:

- A second consumer materializes (desktop app, JetBrains plugin) that
  wants shared state with the VSCode extension. The library-embed
  becomes a *per-process* duplicate; a long-lived daemon over a Unix
  socket is the natural answer.
- Isolation becomes load-bearing (MCP servers misbehaving and bringing
  down the VSCode extension host; user wants to upgrade caretaker
  without reloading every IDE window).

When that happens: promote `caretaker run` to an interactive
JSON-RPC mode (`caretaker run --rpc`, LSP-style framing) and the
extension becomes a thin client. Wire format already sketched (chunk,
toolUse, toolResult, permissionRequest, done as notifications; confirm
as server→client request, mirroring `window/showMessageRequest`). Bump
a `protocol` capability on the handshake so installed extensions don't
break on every CLI patch.

## caretaker-agents-platform revamp (exploration)

The sister repo (`caretaker-agents-platform`) is the Hono+Drizzle web
server this CLI was forked from. Once the IDE-extension contract is
clear, the agentic surface should adopt caretaker-cli as its runner
instead of carrying its own harness — and shed most of the DB along
the way. Net effect: a thin server around the parts the single-user
CLI can't host (scheduling, long-running services, multi-user auth),
with all chat/config delegated to the CLI.

### Replacement scope: what the new stack must do

The old caretaker is in production today. Before deciding revamp vs
greenfield, pin what minimum surface the replacement must cover:

1. **Autonomous tasks system** — recurring agent runs, with run history.
2. **Email / Telegram integration** — outbound notifications, inbound
   triggers.

Both naturally suggest a web UI for management, which raises the
architectural prior:

**Is the new caretaker web/desktop a frontend of the core, or a sibling?**

- [ ] **Frontend of core** (leaning here) — tasks + integrations live in
  caretaker-cli. TUI gets parity automatically. Same forcing-function as
  the "user affordance = also a model tool" principle: if the TUI can't
  reach the feature, it's in the wrong place. Implies *something* hosts
  the scheduler when it needs to run (see "Always-on hosting" below).
  Web becomes a render layer over the same primitives.
- [ ] **Sibling that uses core as runner only** — tasks + integrations
  live in the web/server package; TUI stays foreground-only and ignores
  them. Cleaner separation but the TUI is permanently smaller, and the
  forcing-function on the core API disappears.

Implications either way:

- [ ] **Always-on hosting** — the scheduler needs *something* running.
  The whole framing is: ship one well-behaved long-running process
  (`caretaker web`), and let each use case wrap it appropriately.
  Three concrete shapes, in order of how much we ship:
  - **`caretaker web` as the single primitive.** Starts the server
    with scheduler attached; user keeps the terminal open. Same shape
    as `opencode web`. This is what we *build*. Dies with the
    terminal — fine for exploration / dev.
  - **Docker as the production wrapper we ship.** A well-made
    Dockerfile that runs `caretaker web` as the container's main
    process. No systemd, no launchd, no per-OS launcher in our
    codebase. This is the recommended always-on for autonomous tasks.
  - **System-service wrap as the user's job.** Any advanced user can
    systemd-unit / launchd / nssm wrap `caretaker web` themselves to
    get always-on without Docker. We don't ship the units; we just
    make sure the process is service-wrappable — clean SIGTERM,
    stdout/stderr logging, no TTY requirement.
  - **Tray-icon wrapper** stays an optional, ship-later niche: only
    useful for non-technical users who want always-on on a laptop and
    won't learn either Docker or systemd. Decide when (if) we see
    that user.
  - Net effect: zero "per-OS daemon launcher" code in caretaker. One
    foreground process, one Docker image, advanced users self-serve.
- [ ] **Persistence** — task definitions, run history, retry state.
  This is where SQLite earns its keep; JSON files model "run history
  with filtering / pagination" badly.
- [ ] **Email / Telegram asymmetry** — outbound (notify on
  success/failure) fits cleanly in core, no extra surface needed.
  Inbound splits: polling (IMAP, telegram `getUpdates`) can live in the
  daemon; webhooks need a public HTTP endpoint which is server-only.
  Default to polling for core-side parity; webhooks become a web
  frontend add-on for users who want lower latency.

Lean: frontend-of-core. The TUI being able to schedule a task and wire
a Telegram bot is a strong design forcing-function; the sibling shape
ends up making the TUI a toy.

### Big-picture undecided: revamp vs greenfield monorepo

Two plausible shapes, decision pending:

- [ ] **Revamp in place** — keep agents-platform as the home, swap its
  internal harness for caretaker-cli, drop the dropped tables. Right
  call if the scheduler / services / auth code is substantial and
  works; pays the cost of an in-place migration with live users.
- [ ] **Greenfield monorepo here** — stop touching the old repo,
  rebuild as a monorepo rooted at caretaker-cli (or a new root) with
  packages for runner (this CLI), scheduler/services, auth, and
  whichever UI(s). Port only what we explicitly want, archive the
  rest. Right call if we'd be rewriting most of the platform anyway,
  and we want clean layout from day one. No live-DB migration; users
  re-onboard.

Either way the chat-persistence question (next subsection) and the
bundling/cleanup outline below still apply. The DB-cleanup list
becomes "what to *port*" rather than "what to *drop*" under the
greenfield reading.

### Chat persistence and the "no-history" runner pattern

The old caretaker has a useful pattern when it delegates to a
third-party harness: it does **not** forward the chat history — the
external harness is expected to resume its own session by id. We can
adopt the same pattern with caretaker-cli as the runner: the consumer
says "resume session X" or "start new session", and the CLI loads the
JSONL itself. The consumer never ferries chat history over the wire.

If we commit to that pattern:

- [ ] Chat state lives in CLI JSONL, full stop. `chat_messages` /
  `chat_sessions` tables go away (or are never created in greenfield).
- [ ] The wire protocol carries `sessionId` references, not message
  arrays. Lighter payloads, single source of truth.
- [ ] Server-side full-text search / analytics over chats becomes an
  *indexer* job that reads CLI JSONLs, not a parallel store. Defer
  until actually needed.

Open at this layer:

- [ ] **Multi-user JSONL layout on a server host** — needs to fit the
  multi-tenancy decision (per-user `CARETAKER_HOME` vs threaded
  `home` param).
- [ ] **Concurrent reads while the CLI appends** — JSONL is
  append-only so safe enough, but a "subscribe to session" notification
  needs file-watching or in-process eventing.

### Bundling: how does agents-platform load the CLI?

- [ ] **npm dependency, library import** (`import { run } from
  "caretaker-cli/harness"`). Both are Node; no IPC, direct callbacks,
  the platform server stays in-process. Trade-off: the platform adopts
  caretaker's MCP child processes and plugin-cache writes, but unlike a
  VS Code extension host this is what the platform is *for*. Most
  natural option here.
- [ ] **Spawn the built binary via child_process** — same model as the
  IDE extension (JSON-RPC over stdio). Stricter isolation, easier
  independent upgrade, but Node-in-Node overhead and a double event
  loop just to ferry JSON. Hard to justify when both sides are TS.
- [ ] **Monorepo workspace** (npm/pnpm workspaces or git submodule) —
  share the package without publishing. Useful while the API is
  unstable; bad story for external consumers later. Tactical, not
  strategic.

Inclination: option 1. We get to ship a real `caretaker-cli/harness`
entrypoint (currently the package is TUI-oriented), which is also a
prerequisite for the IDE extension's library-import path if we ever
revisit it.

### DB cleanup: what stays, what goes

The CLI is authoritative for everything that's "config the user owns
on this machine". The DB shrinks to what's intrinsically server-side.

Drops from the Drizzle schema:

- [ ] **providers / agents / mcp_servers / plugin_sources / plugins**
  — already file-backed in the CLI (`providers.json`, `agents.json`,
  `mcp.json`, `plugins.json`). Platform reads them via the CLI's
  loaders, doesn't shadow them.
- [ ] **chat_messages / chat_sessions** — already JSONL in the CLI
  under `<CARETAKER_HOME>/sessions/<agentId>/<sessionId>.jsonl`.
  Migration: one-shot export of existing rows into JSONL files.
- [ ] **skills** — superseded by plugin-discovered skills (on-demand
  via `list_skills` / `read_skill`).

Stays in the DB:

- [ ] **Scheduled tasks / cron jobs** — the recurring agentic surface
  is inherently a server concern; single-user CLI has no daemon.
- [ ] **Long-running services** — anything that holds open connections
  on behalf of users beyond a single chat turn.
- [ ] **Users / auth / tenancy metadata** — multi-user is the platform's
  job; the CLI is per-`$HOME`.

Migration plan, rough:

- [ ] **Step 1** — publish `caretaker-cli` as `@caretaker/cli` (or
  similar) on npm, with a stable `harness` entrypoint exporting `run`,
  `resolveAgentTools`, the loaders, and the type surface.
- [ ] **Step 2** — in agents-platform, add CLI as a dependency and
  shadow-read config (DB still authoritative). One-shot scripts to
  sync DB → JSON/JSONL files under a per-user `CARETAKER_HOME`.
- [ ] **Step 3** — flip authority: platform reads from CLI files,
  writes go through CLI loaders. DB tables for the dropped surfaces
  become read-only.
- [ ] **Step 4** — drop the tables, drop the runner code, the platform
  becomes a thin server around scheduler/services/auth.

### Open questions

- [ ] **Multi-tenancy on a server** — the CLI uses one `CARETAKER_HOME`
  per process. Platform serves many users. Two paths: spawn per-user
  CLI subprocesses (heavy but clean isolation) or thread a `home`
  parameter through the harness API so one Node process can serve many
  homes (lighter but pollutes every loader signature). Lean toward
  per-user `CARETAKER_HOME` injected via `AsyncLocalStorage` if the
  loaders cooperate.
- [ ] **Stable harness API** — today the CLI exports are organic
  (mostly meant for its own TUI). Need an explicit `harness` /
  `loaders` surface with semver discipline before the platform can
  depend on it without churn.
- [ ] **Streaming to the web frontend** — platform forwards CLI events
  to the browser over SSE/WebSocket. The JSON-RPC notification shape
  defined for the IDE extension should fit verbatim — same vocabulary
  on both sides keeps clients interchangeable.
- [ ] **Plugin / MCP cache locality** — `~/.caretaker/plugin-cache/...`
  is per-user. On a multi-tenant server, do we share clones across
  users (git URLs are public, why re-clone) or strictly isolate? Share
  by URL hash, isolate auth-bearing sources. Decide together with the
  multi-tenancy story.

## Manifest enrichment (lower priority, eventually)

- [x] ~~Per-skill granularity~~ — shipped (commit `b5f1485`). cc-plugin packs now expose each `skills/<name>/SKILL.md` individually; `list_skills` returns one entry per skill, `read_skill` reads exactly one file.
- [ ] Marketplace `source` as object (`git-subdir` with `path`/`ref`/`sha` for pinning). Today we accept only the string form.
- [ ] Metadata extra: `category`, `tags`, `homepage`, `author` propagated to `PluginRecord` and shown in the TUI detail.

---

## Done in this session

- [x] `3c5a791` — skills as on-demand tools (`list_skills`/`read_skill`), no more system-prompt injection
- [x] `1ad5740` — encryption key persisted on disk (chmod 0600), drops all-zero fallback
- [x] `cb8b11b` — MCP backend (stdio + Streamable HTTP), TUI CRUD, agent form step
- [x] `a26299e` — managed MCP servers from plugin manifests with cascading delete (had a parser bug — see next entry)
- [x] `717e2f8` — MCP pool/adapter unit tests via SDK `InMemoryTransport`
- [x] `a5830b4` — fix: read `.mcp.json` from plugin root (not `plugin.json`); `${CLAUDE_PLUGIN_ROOT}` + `${ENV}` expansion at connect
- [x] `f1b482c` — managed agents from plugin manifests, mirroring the MCP pattern
- [x] `2c47a72` / `43d9c2f` — roadmap doc + subagent inheritance broadened to all runtime fields
- [x] `377b3bf` — subagent dispatch (`list_agents`, `invoke_agent`) with recursion + self-invoke guards, confirm-gate + abort passthrough
- [x] `42f8d46` — slash commands: chat-input parser + `list_commands`/`invoke_command` builtins, `$N` + `$ARGUMENTS` expansion, per-agent gating via `agent.plugins`
- [x] `2cd14b9` — `<runtime-info>` block in system prompt + `get_agent_context` builtin (live token usage; context-window % deferred to a models.dev fetcher)
- [x] `b5f1485` — per-skill granularity for `list_skills` / `read_skill`: cc-plugin packs (e.g. superpowers) now expose each `skills/<name>/SKILL.md` as its own entry
- [x] `7f8634c` — anonymous sub-agent dispatch: `invoke_agent({task})` without a name spins up an ephemeral child that inherits provider/model/tools/plugins/mcpServers/workingDir from the caller and runs with no systemPrompt of its own. Use case: speculative subtasks isolated from caller's history without dragging caller's identity along. Self-invocation by name remains rejected (an agent's identity/goal in its systemPrompt would just spin on itself).
- [x] `aa46b1e` — `resolveAgentTools` always exposes dispatch builtins (`list_agents` / `invoke_agent`); the previous `loadAgents()` gate was redundant and caused dispatch to disappear when the registry was momentarily empty.
- [x] `a243593` — universal ESC=back in the TUI: every list/detail/delete view in Agents/Providers/Plugins/MCP responds to Esc with the right back-target; root menu Esc quits. Form/chat handlers untouched.
- [x] `39b18a7` / `b8f29bf` / `76ab68e` / `543e539` — context-window meter end-to-end: ported `model_limits.ts` (models.dev fetcher with 24h cache, `:cloud`/`-cloud` suffix fallback) and `computeContextUsage` from the sister repo, wired `initModelLimits()` at boot, unblocked `get_agent_context` (now returns real `contextWindow` + `percent`), and added a sticky ctx bar at the bottom of the chat (`ctx ▓▓▓░░ NN%  ·  Xk / Yk`, dim/yellow/red thresholds). When the model is unknown to models.dev, the bar falls back to the absolute token count.
