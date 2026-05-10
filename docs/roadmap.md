# Roadmap

Living checklist for the next pieces. Order is the order we plan to ship;
each pezzo is a single commit (or a small string of related commits) and
must be **prod-ready in its scope** before moving on. `[ ]` = todo,
`[x]` = shipped, with the closing commit hash next to it.

Last updated: 2026-05-10 (post `f1b482c`).

---

## ~~In flight~~ Done: subagent dispatch (commit `next`)

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

## ~~Next~~ Done: commands (commit `next`)

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

## Manifest enrichment (lower priority, eventually)

- [x] ~~Per-skill granularity~~ — shipped (commit `next`). cc-plugin packs now expose each `skills/<name>/SKILL.md` individually; `list_skills` returns one entry per skill, `read_skill` reads exactly one file.
- [ ] Marketplace `source` as object (`git-subdir` with `path`/`ref`/`sha` for pinning). Today we accept only the string form.
- [ ] Metadata extra: `category`, `tags`, `homepage`, `author` propagated to `PluginRecord` and shown in the TUI detail.
- [ ] **`get_agent_context` context-window resolution** — sister repo had a `model_limits.ts` that fetched from models.dev (24h cache) and resolved `model_id → context_tokens`. Today the tool returns `contextWindow: null` and `percent: null`. Port the fetcher + cache when a user asks for usage % display.

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
- [x] `next` — anonymous sub-agent dispatch: `invoke_agent({task})` without a name spins up an ephemeral child that inherits provider/model/tools/plugins/mcpServers/workingDir from the caller and runs with no systemPrompt of its own. Use case: speculative subtasks isolated from caller's history without dragging caller's identity along. Self-invocation by name remains rejected (an agent's identity/goal in its systemPrompt would just spin on itself).
