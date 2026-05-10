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
