# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

pnpm workspaces monorepo, five packages, versioned together as one Changesets fixed group. Four are `private: true`; only `packages/cli/` is published to npm (as `@hyperwindmill/caretaker-cli`):

- `packages/cli/` — the Caretaker CLI/TUI (`caretaker-cli`). Authoritative source of the harness, store, plugins, MCP, commands, sub-agent dispatch, scheduler, and tool registry. Also ships a Hono-based local web server (`caretaker-cli web`).
- `packages/webview-ui/` — shared React UI bundled by esbuild. Consumed by both `cli/web/` (served by `caretaker-cli web`) and `vscode-extension/` (loaded into the sidebar webview). Public exports: `./` (App) and `./bridge` (host↔view message contract).
- `packages/vscode-extension/` — VSCode chat sidebar (`caretaker-vscode`). Embeds `caretaker-cli` as an ESM library via the public `./harness`, `./store`, `./session`, `./plugins`, `./mcp`, `./types` exports. Does not subprocess the CLI. See [packages/vscode-extension/README.md](packages/vscode-extension/README.md) for the F5 / dev loop.
- `packages/desktop/` — Electron desktop wrapper (`caretaker-desktop`). **Not** a separate GUI: the main process picks a free port, forks the CLI web server (`caretaker-cli web`) as an Electron `utilityProcess`, and frames `http://127.0.0.1:<port>` in a `BrowserWindow` with a system tray and single-instance lock. Because it runs the full web server, the scheduler runs under it too. Packaged with electron-builder (win/mac/linux).
- `packages/types/` — shared TypeScript definitions (`caretaker-types`): `AgentConfig`, `ProviderConfig`, `PluginSource`, `ScheduledTaskConfig`, etc. Consumed as a workspace dependency by cli and webview-ui.

All commands below run from the repo root unless noted.

## Commands

```bash
pnpm install                            # bootstrap the workspace
pnpm -F @hyperwindmill/caretaker-cli dev               # launch the TUI (tsx packages/cli/src/index.ts)
pnpm -F @hyperwindmill/caretaker-cli dev web           # launch the local web GUI on http://127.0.0.1:3000
pnpm -F @hyperwindmill/caretaker-cli build             # tsc → packages/cli/dist/
pnpm -F @hyperwindmill/caretaker-cli start             # node dist/index.js (after build)
pnpm -F @hyperwindmill/caretaker-cli typecheck         # tsc --noEmit
pnpm -F @hyperwindmill/caretaker-cli test              # tsx --test "packages/cli/src/**/*.test.ts"
pnpm -F webview-ui build                # esbuild → packages/webview-ui/dist/
pnpm -F webview-ui dev                  # esbuild --watch
pnpm -F caretaker-vscode build          # build extension host + webview bundles
pnpm desktop:dev                        # build all + launch the Electron desktop app
pnpm desktop:dist                       # package desktop installers (electron-builder)
pnpm build                              # build every package (pnpm -r build)
pnpm test                               # test every package (pnpm -r test)
```

Run a single test file: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/loop.test.ts`
Run a single test by name: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test --test-name-pattern='resolves @refs once' packages/cli/src/harness/prelude.test.ts`

Isolated environment for manual TUI / web work: `CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev`. All on-disk state (providers, agents, sessions, plugins, MCP, scheduler logs) lives under `CARETAKER_HOME` (default `~/.caretaker/`).

Package manager: **pnpm** (≥10). The root has `pnpm-workspace.yaml`; `package-lock.json` and `npm install` are not supported.

## Architecture

The codebase is a multi-surface agent harness (TUI, web GUI, Electron desktop, VSCode sidebar, headless `run`). All surfaces drive the same in-process harness against the same `~/.caretaker/` state. **The web server is the functional superset** — the scheduler and the scheduler UI live only there (and, transitively, in the desktop app, which forks the web server). Five layers worth understanding before touching anything:

### 1. Surfaces are thin; harness is shared; the web server is the superset

- TUI: `packages/cli/src/tui/` (Ink). Default when `caretaker-cli` is invoked with no subcommand. No scheduler boot, no scheduler UI.
- Headless: `packages/cli/src/cli/run.ts`. `caretaker-cli run [prompt] --agent <name> [--tools …] [--output plain|json]`.
- Local web GUI: `packages/cli/src/cli/web/server.ts` — Hono HTTP + WebSocket bridge that serves the `webview-ui` bundle and proxies chat / settings / scheduler actions into the same harness functions the TUI uses. **Only this surface calls `startBackgroundScheduler()`** (see layer 5), so any scheduled work needs a web-server process up.
- Electron desktop: `packages/desktop/` — the main process forks `caretaker-cli web` as a child `utilityProcess` and frames it in a `BrowserWindow`. It runs no harness logic itself; everything happens in the forked web server. Consequence: the scheduler **does** run under the desktop app (it's a web server), unlike the bare TUI/VSCode.
- VSCode sidebar: `packages/vscode-extension/` imports `caretaker-cli` directly through its public exports. No subprocess; same harness, same store; does not boot the scheduler.

Subcommand routing lives in `packages/cli/src/cli/index.ts` (commander). Adding a new surface should reuse the harness/store/session modules — never re-implement the loop. If the new surface needs scheduled work, it must `startBackgroundScheduler()` explicitly (today only `cli/web/server.ts` does, and the desktop app inherits it by forking that server).

### 2. Agent execution = harness loop + resolved surface

`packages/cli/src/harness/loop.ts` is the chat loop. For each turn it calls `packages/cli/src/harness/provider.ts` (an OpenAI-compatible client) and dispatches tool calls. The set of tools available to a turn is **not** the agent's stored config — it is the output of `packages/cli/src/harness/tools/resolve.ts` (`resolveAgentTools`), which intersects what the agent opted into with what the registry exposes, layers on auto-injected builtins, and applies the tri-state policy (`[ ]` off, `[x]` allowed, `[!]` confirm-each-call). The auto-injection has two tiers, kept narrow on purpose:

- **Always on**: `get_agent_context`. Pure introspection (live token usage / context-window %), read-only — there's no reason to ever hide it.
- **Plugin-gated**: `list_skills`/`read_skill` and `list_commands`/`invoke_command` are added only when the agent has at least one active plugin (otherwise they'd return empty lists). MCP tools are resolved per-run from the configured servers (namespaced `mcp__<id>__<toolName>`) and never registered into the process-wide registry.

Every other builtin — including `list_agents` and `invoke_agent` — is gated by `allowedTools` like any other tool: if the user clicks `[ ]` off in the picker, the runtime honours that. `invoke_agent`'s anonymous mode (`invoke_agent({task})` with no `name`) is useful even with a single agent configured, so users typically opt it in regardless of agent count — but that's a UX hint, not a runtime override. **Do not re-introduce a silent always-on list for capability tools**: the UI / runtime mismatch hides behaviour from the user.

The confirm gate (`ctx.confirmTool`) is plumbed into every tool invocation, including sub-agent dispatch.

When editing tools, register them in `packages/cli/src/harness/tools/builtin/index.ts` and the central registry — `resolveAgentTools` is the single source of truth at runtime.

Providers may be `type: 'claude-code'` instead of the default OpenAI-compatible HTTP endpoint (`endpoint` stays `''`, unused for this type). A single dispatch check at the very top of `run()` (`opts.provider.type === 'claude-code'`, `harness/loop.ts`) hands the whole turn to `packages/cli/src/harness/claude_code_runner.ts`, which spawns one `claude -p --output-format stream-json --include-partial-messages` process per turn instead of driving `provider.ts`. Session continuity uses `SessionMetaRecord.claudeSessionId` (`--resume <id>`, captured from the CLI's `init` stream event and persisted via `updateClaudeSessionId`). `--append-system-prompt` is the agent's `systemPrompt` plus the same project context files as layer 3, minus `CLAUDE.md` — Claude Code auto-loads that one itself. The caretaker tool policy (`allowedTools`/confirm-each-call gate), plugins, and the tool picker do not apply to claude-code agents: they use Claude Code's own tools and its own `permissionMode` (agent-level override → detected from `~/.claude/settings.json`'s `permissions.defaultMode` → `acceptEdits` fallback), passed through as `--permission-mode`. Unattended runs (scheduler, autonomous tasks) force `bypassPermissions` regardless of the configured mode. Configured `mcpServers` (plus, for autonomous tasks, the task bridge below) are resolved via `resolvedServerRuntime` and written to a temp `--mcp-config` file (`--strict-mcp-config`), cleaned up after the run. Autonomous-task tools reach claude-code agents only through a token-guarded streamable-HTTP MCP bridge at `POST /api/mcp/task` (web-server only — `setTaskBridgeUrl` is set right after `serve()`); there is no equivalent bridge for the TUI/VSCode/headless surfaces. The bridge is injected only for task-heartbeat/review runs (`scheduler/task_strategy.ts` / `task_review.ts`): a claude-code agent gets no `mcp__task__*` tools in ordinary chat, cron-heartbeat, or Telegram runs, even with the web server up. Native (non-claude-code) agents aren't limited this way — they can opt `mcp__task__*` into `allowedTools` like any other builtin, anywhere. AI-generated session titles are skipped for claude-code providers (no HTTP endpoint to call for the hidden titling request) — sessions keep the truncation-based fallback title.

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

### 5. Scheduler (web-server-only: `caretaker-cli web` or the desktop app)

`packages/cli/src/cli/web/scheduler.ts` exposes `startBackgroundScheduler()` / `stopBackgroundScheduler()`. The only caller today is `cli/web/server.ts` — neither the TUI nor the VSCode extension boots it (the desktop app does, transitively, by forking the web server). Scheduled work therefore only fires while a web-server process is up; document this clearly when wiring new surfaces. The daemon ticks every 15 s and runs **three** loops:

- **Cron heartbeat** (`scheduler/heartbeat.ts`): a per-agent scheduled task with a standard 5-field cron (wildcards, lists, ranges, step patterns). Fires `executeTaskRun(task)`, which auto-approves all tool calls (the run is unattended).
- **Telegram** (`scheduler/telegram.ts`): a per-agent scheduled task that polls `getUpdates` and routes messages into `executeTelegramTaskRun` as an interactive conversation. Encryption applied on save; the update offset is committed atomically *before* processing to make duplicate runs impossible across concurrent ticks; messages from the same `chat.id` are grouped and processed sequentially (different chats progress in parallel) so a rapid second message from the same user can't be silently dropped.
- **Autonomous task heartbeat** (`scheduler/task_strategy.ts`): `runTaskHeartbeatTick(now)` runs unconditionally every tick, independent of any configured scheduled task. It advances the autonomous task/project system (see State on disk) one step per invocation, under per-invocation time and turn budgets. The agent is resolved **per role** (`scheduler/task_roles.ts`): the task's phase decides who runs — `planning` → planner, `reviewing` → reviewer, otherwise developer. Planner/reviewer overrides (`plannerAgentId`/`reviewerAgentId`, task-level falling back to project-level) degrade onto the developer chain (`task.agentId` → `project.agentId` → first agent in `agents.json`); a role id pointing to a deleted agent falls through silently. Three things wrap the agent run:
  - **Planning phase via a `planning` state** (default on; `planningEnabled` tri-state on the task inheriting from the project, resolved in `task_roles.ts`): activation sends a task to `planning` instead of `active`. The planning cycle runs the planner agent **read-only** — `write`/`edit`/`multiedit`/`bash` are stripped from the resolved toolset by `filterPlannerTools` (same post-filter mechanism as the review's `mcp__task__*` strip) — with a dedicated prompt. An opt-in **SDD mode** (`sddEnabled` tri-state on the task inheriting from the project, default **off**, resolved by `resolveSddEnabled`) keeps `write`/`edit`/`multiedit` but wraps them with a markdown-only path guard (`bash` stays stripped); spec conventions are deliberately left to the project (AGENTS.md / planner prompt), and the `.md` files land on the task branch via the per-cycle WIP commit. The planner explores via `read_file`/`glob`/`grep`, can iterate across cycles, and hands off explicitly via `mcp__task__task_submit_plan`, which persists the plan as a `plan` message (replayed into history like `review` messages) and transitions `planning → active`. `task_complete` errors during planning; without a submit the task stays in `planning` (fail-safe). The (re)activation rule is derived from the message stream, not a stored counter: activate/unpause/unblock/wake-up go to `planning` iff planning is enabled and no `plan` message exists yet. The no-progress guard applies to planning cycles too. UI renders `planning` as active-family (cyan, Pause not Activate). For claude-code planner agents there's no in-process tool list to filter, so the same restriction is expressed as CLI flags via `claudeCodeTaskExtras`: `--permission-mode manual` plus an explicit allowlist (`Read`, `Glob`, `Grep`, `mcp__task`); SDD mode appends `Write(**/*.md)`/`Edit(**/*.md)`/`MultiEdit(**/*.md)` to that allowlist, and `Bash` is always on the disallowed list.
  - **Git worktree isolation** (`lib/task_git.ts`): if the task's project `workingDir` is inside a git repo, the first heartbeat lazily creates a dedicated worktree + branch (`caretaker/task-<id>-<slug>`, under `~/.caretaker/worktrees/<projectId>-<taskId>`), persisted on the task as `branch`/`worktreePath`; the agent runs there instead of the live tree. Each cycle commits WIP (`--no-verify`, with a fallback identity only when the repo has none). Non-git projects run in place, unchanged. Cleanup happens at DONE (below) or via the manual discard affordance (`task_discard_worktree` tool + `POST /api/tasks/:id/discard-worktree` + a webview button).
  - **Review gate via a `reviewing` state** (`scheduler/task_review.ts` + `runReviewCycle` in `scheduler/task_strategy.ts`): git worktree tasks don't finalize directly. When the agent calls `task_complete`, a git task goes to `reviewing` (non-git → `done`, no review — the review is git-diff based and needs a branch). The gate is **toggleable** (`reviewEnabled` tri-state on the task inheriting from the project, default on) and read at decision time: `task_complete` with the gate off goes straight to `done` (the worktree is finalized by the heartbeat's post-run git step, never inside `task_complete` — the agent is still running inside it), and a task already `reviewing` when the gate is turned off is finalized on the next tick without running the review. The heartbeat selection includes `reviewing`, and such a task runs one independent review pass (`runReviewCycle` → `runDoneReview`, **reviewer-role agent identity** with `mcp__task__*` stripped) over the branch **as its own tick**, not inline in the agent loop. The verdict comes from a sentinel line parsed by `parseReviewVerdict` (fail-safe: anything but an explicit `PASS` → changes). `CHANGES_REQUESTED` reopens the task (`active`, worktree kept) and stores the review as a replayed `review` message the agent reads next cycle; `PASS` (or hitting `MAX_REVIEW_ROUNDS` = 3) finalizes — sets `done`, removes the worktree, keeps the branch. Round count is derived from the `review` message stream, not a stored counter. A Pause landing mid-review is respected (the cycle re-reads the status before transitioning) and a crash mid-review leaves the task `reviewing` so the next tick retries. The UI renders `reviewing` as active (purple, Pause not Activate).

The first two are per-agent strategies keyed by `task.type` and configured from the Scheduler settings panel; the task heartbeat is always-on. Cross-strategy shared state lives in `scheduler/locks.ts` (`runningTasks` Set) and `scheduler/logs.ts` (log dir + JSONL append/read). Strategies depend on sibling modules, never on the parent `scheduler.ts`.

### State on disk

Three stores under `CARETAKER_HOME`:

1. **JSON** for config (`caretaker.json`, `agents.json`, `plugins.json`, `mcp.json`), written by `packages/cli/src/store/json.ts` via tmp + atomic rename, with a Windows-safe retry loop on `EACCES`/`EPERM`/`EBUSY` (Defender, OneDrive, indexer locks rename targets briefly — retry 5× with exponential backoff before propagating, never fall back to a non-atomic direct write). The same pattern is mirrored in `scheduler/telegram.ts:saveTelegramOffset`.
2. **JSONL** for chat sessions (one file per session under `sessions/<agentId>/`) and scheduler logs (`scheduler-logs/`).
3. **`@morphql/store` folder DB** under `store/` (`packages/cli/src/store/db.ts`) backing the autonomous task/project system: **Projects**, **Tasks** (draft/planning/active/reviewing/paused/blocked/done, with checklist items and no-progress guards, plus `branch`/`worktreePath` for git isolation, `archived` for soft-delete, per-role agent assignment overriding the project default — `agentId` = developer, plus optional `plannerAgentId`/`reviewerAgentId` — and tri-state `planningEnabled`/`reviewEnabled`/`sddEnabled` phase gates inheriting from the project, default on for first two, default off for `sddEnabled`), and **TaskMessages** (`messageType` includes `review` and `plan`, both replayed into agent history). Agents drive it through the built-in `mcp__task__*` tools (`task_create` (accepts `sdd_enabled`), `task_get_state` (returns `sddEnabled`), `task_update_checklist_item`, `task_add_message`, `task_complete`, `task_block`, `task_unblock`, `task_yield`, `task_activate`, `task_unpause`, `task_search`, `project_list`, `task_discard_worktree`, `task_archive`, `task_unarchive`, `task_delete`, `task_set_agent` (with a `role` param: developer/planner/reviewer), `task_submit_plan`), one step per invocation; the always-on task heartbeat (layer 5) advances planning/active/reviewing tasks, isolating each in its own git worktree/branch and gating DONE behind a `reviewing` review pass (when `reviewEnabled`). Role resolution is per-role via `scheduler/task_roles.ts` (see layer 5). The web API mirrors the role/flag surface: `PATCH /api/tasks/:id/agent` takes an optional `role`, `PATCH /api/tasks/:id/flags` sets the tri-state gates (including `sddEnabled`), and task/project creation accepts the role/flag fields. Archived tasks are excluded from the heartbeat and hidden from the default task list (toggle with "Show archived"); delete permanently removes a task and all its messages from the store (confirm-gated in the UI).

Secrets at rest (plugin auth tokens, MCP credentials, Telegram bot tokens) are AES-256-GCM encrypted via `packages/cli/src/lib/encryption.ts`; the key is persisted on disk with mode 0600.

### Tool sandbox

`packages/cli/src/harness/tools/sandbox.ts` rejects paths outside the agent's working directory and refuses to follow symlinks out. `write` enforces read-before-write. `edit`/`multiedit` rely on exact `oldString` match as an implicit invariant. This is convenience, not a security boundary.

## Conventions

- **Keep the docs in sync**: whenever a change alters architecture, a state machine, a public contract, or user-facing behaviour, update `CLAUDE.md` (and `README.md` when the change is user-facing) in the same unit of work — a stale architecture doc is worse than none. Both files describe *current* behaviour, not history.
- Tests are co-located with source as `*.test.ts`, run via Node's built-in test runner through `tsx`. No Jest, no vitest.
- TypeScript is `strict` but `noImplicitAny: false`. ESM only (`"type": "module"`), `moduleResolution: "bundler"`.
- ESLint (typescript-eslint + react + react-hooks, prettier-disable on top) and Prettier are wired up via `packages/cli/eslint.config.js` and `packages/cli/.prettierrc.json`. `pnpm -F @hyperwindmill/caretaker-cli lint` / `lint:fix` / `format` / `format:check`. There is no CI gate enforcing them — match surrounding style and keep diffs clean.
- All paths under `~/.caretaker/` come from accessor functions (`dataDir()`, `configPath()`, …) resolved at call time, not at import time, so tests can swap `CARETAKER_HOME` between suites within the same process.
- Atomic-write policy for any persisted state: tmp file + rename + Windows-retry. Don't fall back to a direct `writeFile` on the destination path — that's exactly the case the atomicity is meant to protect against.
- **Automated Versioning (Changesets)**: This monorepo uses `@changesets/cli` for versioning and changelog orchestration. For EVERY feature, package edit, or modification you implement, you MUST draft an appropriate changeset file by running `pnpm run changeset` (or creating a valid markdown changeset under `.changeset/`) detailing the semver impact (patch/minor/major) and explanation. Never omit this.
- **Cutting a release**: the five packages are one Changesets **fixed group**, so they always share one version. Only `@hyperwindmill/caretaker-cli` is published to npm (the other four stay `private`). Steps:
  1. `pnpm version-packages` (= `changeset version`) — bumps all five to the max pending semver, rewrites CHANGELOGs, deletes consumed changesets, and **auto-commits** with the default `@changesets/cli/commit` message `RELEASING: Releasing 5 package(s)` (the `commit` config in `.changeset/config.json`). No manual commit needed.
  2. Tag it with an **annotated** tag: `git tag -a v<newVersion> -m v<newVersion>` (tags are `vX.Y.Z`, one per release). The tag **must** be annotated: `git push --follow-tags` only pushes annotated tags, so a lightweight `git tag v<v>` silently won't reach the remote and the release workflow never fires.
  3. `git push origin main --follow-tags` (pushes the branch and the annotated tag together). If you created a lightweight tag by mistake, push it explicitly: `git push origin v<newVersion>`.
  Pushing the `v*` tag triggers `.github/workflows/release.yml`: the `publish-npm` job publishes `@hyperwindmill/caretaker-cli` to npm via **OIDC trusted publishing** (`pnpm publish`, no `NPM_TOKEN` — requires the trusted publisher configured on npmjs.com for this repo+workflow, pnpm 10, Node ≥ 22.14), and the other jobs build the Electron `.deb`/`.exe` and the VSIX and attach them to the GitHub Release. Version bump and tagging stay manual; publishing is automated from the tag.
- `docs/roadmap.md` exists but is **stale** — do not rely on it for current state. Use `git log`, the code, and this file instead.
