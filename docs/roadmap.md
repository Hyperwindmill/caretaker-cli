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

## Next: commands

Slash commands as defined by Claude Code: `<plugin-root>/commands/*.md` with
frontmatter `description` + `argument-hint`, body with `$1`/`$2`/`$ARGUMENTS`
interpolation. Discovery + persistence mirrors agents/MCP.

Open design questions to resolve in brainstorm:

- [ ] **Trigger surface in our TUI** — slash-command parser in chat input (`/foo bar`) vs top-level "Commands" menu vs both. The first is more Claude-Code-ish; the second is more TUI-ish.
- [ ] **Argument prompting** — when `argument-hint` is set, do we collect args via a small form before sending the expanded prompt, or do we require the user to pass everything inline?
- [ ] **Per-agent vs global commands** — should a command be available for every agent, or only when the originating plugin is active for the current agent?

Implementation: discovery in `manifest.ts`, persisted on `PluginRecord.commands`, sync into a new `commands.json`? Or just scoped to plugin (no separate store) and resolved on the fly when the user types `/`. Decide in brainstorm.

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

- [ ] Per-skill granularity (today: 1 plugin = 1 entry in `list_skills`/`read_skill`). For cc-plugin packs (e.g. superpowers) this matters — each `skills/<name>/SKILL.md` should expose individually.
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
- [x] `next` — subagent dispatch (`list_agents`, `invoke_agent`) with recursion + self-invoke guards, confirm-gate + abort passthrough
