# VSCode extension — implementation progress

Companion to [2026-05-13-vscode-extension-design.md](./2026-05-13-vscode-extension-design.md). Tracks the iterative step-by-step build (commit-per-feature, no formal contract/plan cycle by user request).

## Done

### Step 1 — monorepo migration (commit `9d563c4`)
- Moved CLI sources to `packages/cli/`. Root is now a pnpm workspaces monorepo.
- `pnpm-workspace.yaml` added; `package-lock.json` removed; `pnpm-lock.yaml` generated.
- Root `package.json` reduced to workspace coordinator with `pnpm -r` / `pnpm -F caretaker-cli` scripts.
- Surfaced one phantom dep: `zod` (transitively from `@modelcontextprotocol/sdk`, used in `mcp/client.test.ts`) — declared as devDep.
- CLAUDE.md and README updated for pnpm commands.
- Verified: 287/287 tests green, typecheck green, build green.

### Step 2 — public API for embedding (commit `98336e2`)
- Added barrel files:
  - `packages/cli/src/harness/index.ts` — re-exports `run`, `resolveAgentTools`, `ToolRegistry`, `registerBuiltins`, `toOpenAiTool`, `tools` (singleton), and the relevant types.
  - `packages/cli/src/session/index.ts` — re-exports the JSONL session store helpers and types.
- Declared `exports` map in `packages/cli/package.json` with `types` + `default` conditions for `.`, `./harness`, `./store`, `./session`, `./types`.
- Enabled `declaration: true` + `declarationMap: true` in `packages/cli/tsconfig.json` so external embedders get type-checked imports.
- Public-API smoke tests guard the surface (`harness/public_api.test.ts`, `session/public_api.test.ts`).

### Step 3 — VSCode extension scaffold (commit `2db8185`)
- New package `packages/vscode-extension/` (name `caretaker-vscode`).
- Manifest contributes: Activity Bar container, `caretaker.chatView` webview view, `caretaker.openChat` command, `caretaker.home` + `caretaker.defaultAgent` settings.
- esbuild → single CJS bundle (`dist/extension.js`, ~1.5 MB with `caretaker-cli` inlined so `vsce package` doesn't have to walk pnpm's symlinks).
- Pure helper `resolveCaretakerHome` (env > setting > default) extracted to `config.ts` and unit-tested.
- `activate()` imports `caretaker-cli/harness` at load time as a smoke check; the `openChat` command is a placeholder for now.
- Verified: typecheck green, 4/4 config tests green, esbuild bundle produced.

## Next up

### Step 4 — chat sidebar webview + bridge protocol (echo only)
- `src/sidebar.ts` — `SidebarWebviewProvider implements vscode.WebviewViewProvider`. Loads webview HTML + bundled JS.
- `src/webview/` — vanilla TS + template literals (no React for MVP). Bundled separately by esbuild → `dist/webview.js` (+ `dist/webview.css`).
- `src/bridge.ts` — shared message types: `HostToView` (`chunk`, `toolCall`, `toolResult`, `confirmRequest`, `done`, `error`, `agentsLoaded`), `ViewToHost` (`start`, `abort`, `confirmResponse`, `selectAgent`).
- Echo wire: webview `start { prompt }` → host replies with a fixed `chunk` "echo: …" + `done`. No harness call yet — purely validates the round-trip.
- `extension.ts` registers the provider for `caretaker.chatView`.
- Unit tests on bridge protocol typing / parsing.
- User picked **vanilla TS** for the webview (vs React) — confirm before starting.
- Commit: `feat(vscode): chat sidebar webview with echo bridge`.

### Step 5 — wire harness into the sidebar (real chat, no confirm yet)
- `src/session.ts` — `ChatSessionController` owning an agent + conversation. Calls `harness.run({ ... }, { onChunk, onToolCall, onToolResult })` and forwards callbacks to the webview.
- Replace echo with real harness invocation.
- Agent picker (dropdown) sourced from `loadAgents()`.
- `workingDir` = `workspace.workspaceFolders[0].uri.fsPath`. Show empty state if no folder open.
- Append session JSONL via the public `session/` API.
- Unit tests on `ChatSessionController` with a faked harness module.
- Commit: `feat(vscode): live harness-driven chat`.

### Step 6 — confirm gate inline
- Plumb `confirmTool: (name, args) => Promise<boolean>` into `harness.run`. The promise is held by the controller and resolved by a `confirmResponse` from the webview.
- Webview renders the confirm bubble inline (`🔒 Allow toolName(args)?` with Allow / Deny).
- `abort` rejects any pending confirm.
- Tests: round-trip confirm in controller; abort cancels pending.
- Commit: `feat(vscode): inline confirm gate for [!] tools`.

### Step 7 — polish + manual checklist + roadmap update
- README for the extension (how to run from source, F5 dev loop).
- `docs/roadmap.md`: mark §IDE extensions MVP shipped (with commit hashes), keep subprocess + JSON-RPC as the deferred evolution path.
- Manual checklist run from the design doc (§Testing).
- Decide on first publish (private vsix package vs marketplace).

## Open follow-ups (not blocking MVP)

- Editor pane variant (already documented in design §Non-goals).
- Session browser sidebar pane.
- Agent CRUD inside the extension.
- Per-agent toggle to lock `workingDir` to `agent.workingDir`.
- Multi-window `session.lock`.
- Promote `caretaker run` to interactive RPC mode for multi-consumer scenarios.

## Conventions for this iteration

- One commit per logical step, even if the step is small. No "WIP" commits.
- Each step must leave typecheck + tests green for all packages.
- pnpm only (no `npm install` mixed in — would corrupt the lockfile).
- After every step: update this doc's "Done" / "Next up" sections in the same commit.
