# Roadmap

Living checklist for the next pieces. Order is the order we plan to ship;
each pezzo is a single commit (or a small string of related commits) and
must be **prod-ready in its scope** before moving on. `[ ]` = todo,
`[x]` = shipped, with the closing commit hash next to it.

Last updated: 2026-05-10 (post `f1b482c`).

---

## In flight: subagent dispatch

Plugin agents are discovered, persisted, and managed (commit `f1b482c`).
They are first-class rows in `agents.json`. What's missing: an **agent that
chats with the user can invoke another agent as a tool** and pass it a task.
The invoked agent runs one-shot with its own system prompt + tool whitelist;
the result returns to the caller as a tool result.

Pattern reference: sister repo's `src/mcp/agent.ts` exposes `invoke_agent`
+ `list_agents` over MCP. We do the equivalent as **in-process builtin
tools** (no MCP wrap — same architectural choice we made for skills).

### Behavior contract

- [ ] **Builtin tool `list_agents`** — returns `[{name, description?, model, provider, managed}]` for every row in `agents.json` except the *current* caller (no self-recursion at the surface). No params. Auto-included in the registry like `list_skills` / `read_skill`.
- [ ] **Builtin tool `invoke_agent({name, task})`** — looks up the named agent, runs it one-shot, returns the final assistant text as the tool result. `name` is the AgentConfig.name (managed rows show as `<plugin>/<scoped>`).
- [ ] **Provider/model inheritance** — if the invoked agent has empty `provider` and/or `model`, inherit from the caller (recursively, so A→B→C with B blank uses A's resolution at C). The runtime fields don't get persisted back into `agents.json` — inheritance is per-invocation.
- [ ] **Tool surface for the invocation** — call `resolveAgentTools(invoked, registry)` so the invoked agent gets its own builtins/skills/MCP. Do NOT auto-grant the caller's tools — the whole point of dispatching is sandboxing.
- [ ] **No history** — the invoked agent starts with empty history; the only user message is the `task` string. (Matches the sister repo's one-shot semantics.) Persistence: optionally a sub-session under the parent — defer to a follow-up; for now no persistence at all.
- [ ] **Confirm gate inheritance** — the chat's `confirmTool` callback applies to the invoked agent's tool calls too (the user is still in the loop).
- [ ] **Signal propagation** — Esc on the parent run aborts the child run via the same `AbortSignal`.
- [ ] **Recursion guard** — track depth in `ToolContext.dispatchDepth`, cap at e.g. 5. An invoked agent calling `invoke_agent` again increments depth; cap exceeded → tool returns `Error: dispatch depth exceeded`.
- [ ] **Self-invocation guard** — invoking an agent by the same id as the caller errors out (catches accidental loops without relying on the depth cap).
- [ ] **Error surfacing** — provider error / abort during the child run → tool result is `Error: <msg>`, parent loop continues.

### Implementation notes

- New `ToolContext` fields: `callerAgent: AgentConfig`, `dispatchDepth: number` (default 0). Loop populates them.
- New file `src/agents/dispatch.ts` with `runOneShot(invoked, task, ctx, providerFallback, modelFallback)`. Internally calls `harness/loop.run(...)` and returns the final text.
- Builtin `list_agents` and `invoke_agent` live under `src/harness/tools/builtin/`. Registered in `registerBuiltins`. Auto-included by `resolveAgentTools` (or just always present? — decide: always present, since they're cheap and user needs them visible).
- Tests with `__setFetch` to mock the provider; verify tool exec, inheritance, recursion guard, abort propagation.

### Open question (not blocking)

- [ ] Sub-session persistence — do we want each invocation to leave a trace in the parent's session log? Probably "yes" eventually but not in iter 1.

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
