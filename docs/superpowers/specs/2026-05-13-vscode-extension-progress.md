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

### Step 4 — chat sidebar webview + bridge protocol echo (commit `aff2994`)
- `src/bridge.ts` — shared discriminated unions `HostToView` / `ViewToHost` (`ready`, `chunk`, `tool_call`, `tool_result`, `permission_request`, `done`, `error` ↔ `start`, `abort`, `permission_response`). Event names mirror the sister repo's SSE protocol for the concepts that overlap. Runtime validator `parseViewToHost` because the webview is not trusted.
- `src/sidebar.ts` — `SidebarWebviewProvider implements vscode.WebviewViewProvider` with CSP (nonce'd `script-src`, `style-src ${webview.cspSource} 'unsafe-inline'`), `enableScripts: true`, `localResourceRoots: [dist]`. Echo handler: `start { prompt }` → `chunk "echo: …"` + `done`.
- `src/webview/` — React 19 app: `index.tsx` (acquireVsCodeApi + createRoot StrictMode), `App.tsx` (reducer with `idle | streaming | error`), `MessageList.tsx`, `Composer.tsx` (textarea + Enter-to-send), `styles.css` (full theming via `--vscode-*` vars).
- `esbuild.config.mjs` — dual bundle: extension (Node CJS, vscode external) + webview (browser IIFE, React inlined, CSS emitted as side file). Both build in parallel.
- After this step the chat is visually live in the Activity Bar; the wire round-trip is proven end-to-end with a fixed echo response. No harness yet.
- Verified: typecheck green, 10 tests green (6 bridge + 4 config), both bundles produced (extension 1.5MB, webview.js 616KB, webview.css 3KB).

### Step 5 — live harness in the sidebar (commit `017076f`)
- `src/session.ts` — `ChatSessionController` owns agent + provider + tools + workingDir + in-memory history; lazy session-on-disk creation on first prompt; accumulates history across turns; abortable via `AbortController`; injectable deps (`run`, `createSession`, `appendMessage`, `userMessage`) so unit tests run without touching CARETAKER_HOME or the network.
- Sidebar lazy-builds the controller on first `start`: loads `agents.json` + `caretaker.json` via `caretaker-cli/store`, picks agent by `caretaker.defaultAgent` setting (or first), looks up provider, resolves tools via `harness.resolveAgentTools`, derives `workingDir` from `workspace.workspaceFolders[0]`. Each precondition failure becomes an inline `error` bridge event.
- Confirm gate is *not* wired yet — `permission_response` from the webview is still dropped.
- Webview already streams the harness output correctly because the bridge protocol didn't change.
- 8 unit tests on `ChatSessionController` (fake deps): lazy session creation, title truncation, session reuse, callback forwarding, message persistence ordering, history accumulation across turns, harness-error translation, concurrent-start refusal, abort propagation.
- Total tests at this point: 18 in the extension package (10 + 8). Typecheck green. Bundles unchanged in size.

## Next up

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
