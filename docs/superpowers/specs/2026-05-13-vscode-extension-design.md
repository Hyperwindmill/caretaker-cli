# VSCode extension — MVP design

**Date:** 2026-05-13
**Status:** design approved, awaiting implementation plan

## Goal

Ship a VSCode extension that exposes Caretaker as a chat sidebar inside the IDE, sharing the same global state (`~/.caretaker/`) and agent harness as the TUI. MVP is **chat-only**: a single interactive conversation with an existing agent. CRUD of agents/plugins/MCP stays in the TUI for this iteration.

## Non-goals (this iteration)

- Agents / plugins / MCP CRUD UI inside the extension.
- Session browser (history list, reopen, delete).
- Multi-window contention handling (lockfiles on session JSONL).
- Subprocess + JSON-RPC stdio mode (kept as a future evolution path; see `docs/roadmap.md` §IDE extensions).
- Editor pane variant of the chat (sidebar only).
- Chat Participants API (`@caretaker` in Copilot Chat).

## Architectural choice: embedded vs subprocess

The extension loads `caretaker-cli` **embedded** as an ESM library in the VSCode extension host (same Node process).

The roadmap (§IDE extensions, lines 93–161) previously leaned toward child-process + JSON-RPC over stdio. That recommendation was written assuming a headless mode of the CLI did not exist yet. It does now: `caretaker run` ([packages/cli/src/cli/run.ts](packages/cli/src/cli/run.ts)) calls `run()` from `harness/loop.ts` directly with callbacks, proving the harness is already cleanly factored from Ink. The extension consumes the same surface.

The roadmap's lifecycle concerns (MCP children adopted by the extension host, plugin-cache writes coupled to extension lifecycle, session JSONL contention) remain valid but are addressed by explicit plumbing (see §Lifecycle below), not by a different architecture.

The subprocess + JSON-RPC path is preserved as a documented future evolution: when a second consumer materializes (desktop app, JetBrains plugin) or when isolation becomes load-bearing, we promote the existing `caretaker run` into `caretaker run --rpc` and the extension becomes a thin client. Wire format already sketched in the roadmap.

## Repository layout

Monorepo using **pnpm workspaces**.

```
caretaker-cli/                          (repo root)
├── pnpm-workspace.yaml                 # packages: ['packages/*']
├── package.json                        # root, devDeps shared, scripts as aliases
├── packages/
│   ├── cli/                            # the current src/ moved here
│   │   ├── package.json                # name: caretaker-cli, exports: ./harness, ./store, ./session
│   │   ├── src/
│   │   └── tsconfig.json
│   └── vscode-extension/
│       ├── package.json                # depends on "caretaker-cli": "workspace:*"
│       ├── src/
│       │   ├── extension.ts            # activate / deactivate
│       │   ├── sidebar.ts              # WebviewViewProvider
│       │   ├── session.ts              # ChatSessionController
│       │   └── webview/                # React bundle for the sidebar
│       ├── esbuild.config.js           # bundles extension.ts for vsce
│       └── tsconfig.json
└── docs/
```

Bundling: the extension is bundled with `esbuild --bundle --platform=node --external:vscode` before `vsce package`. This sidesteps pnpm's symlinked `node_modules` (vsce historically chokes on them) and is best practice regardless.

Lockfile: `pnpm-lock.yaml`. `package-lock.json` removed. README updated to require pnpm.

## Public API of `caretaker-cli`

The CLI package gains explicit `exports` in its `package.json`. Barrel files are added at `src/harness/index.ts` and `src/session/index.ts` to define the public surface (the `store/` and `types` entries already point at single files):

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./harness": "./dist/harness/index.js",
    "./store": "./dist/store/json.js",
    "./session": "./dist/session/index.js",
    "./types": "./dist/types.js"
  }
}
```

`./harness/index.ts` re-exports `run` (from `loop.ts`), `resolveAgentTools` and the tool registry instance (from `tools/`), and relevant types. `./session/index.ts` re-exports the JSONL session store helpers from `session/store.ts`. Internal modules outside this map remain private. No refactor of existing code is required — only new re-export files.

## Components

### Extension entry (`extension.ts`)

`activate(context)`:
1. Resolve `CARETAKER_HOME`: precedence is **env var > VSCode setting `caretaker.home` > default `~/.caretaker`**. The resolved value is set on `process.env.CARETAKER_HOME` for the lifetime of the extension host so the embedded harness picks it up via its normal paths.
2. Load `config` and `agents` via the public API.
3. Register `SidebarWebviewProvider` for view id `caretaker.chatView` (contributed to the Activity Bar under a Caretaker container).
4. Register commands: `caretaker.openChat`, `caretaker.abort`, `caretaker.reload`.
5. Watch `agents.json` for changes and notify the active webview so the agent picker stays fresh.

`deactivate()`:
1. Abort any in-flight `ChatSessionController.run`.
2. Shut down MCP children spawned by the harness in an ordered fashion (the harness owns the registry; the extension calls its `shutdown()` if exposed, or relies on `AbortController` cancellation propagating to MCP transports).

### `ChatSessionController`

Owns a single conversation for the lifetime of the sidebar (recreated on agent switch or explicit reset).

Responsibilities:
- Holds the in-memory message list and the resolved `AgentConfig` + `Provider`.
- Calls `harness.run({ agent, provider, tools, prompt, workingDir, confirmTool }, { onChunk, onToolCall, onToolResult })` for each user turn.
- Bridges harness callbacks to the webview via `postMessage`.
- Tracks pending confirm requests by id, resolves their promises when `confirmResponse` arrives from the webview.
- Appends session records to the JSONL session file using the existing `session/` helpers — same on-disk format as the TUI.
- Exposes `abort()` (wires an `AbortController` into the harness call).

### `SidebarWebviewProvider`

Implements `vscode.WebviewViewProvider`. Resolves a single webview that hosts the React bundle. Forwards messages to the active `ChatSessionController`. Survives view hide/show; the controller is owned by the provider, not the webview.

### Webview bundle

React app, single page. States: `idle | streaming | awaiting-confirm | error`. Components:
- Agent picker (dropdown sourced from `agentsLoaded`).
- Message list (user / assistant chunks, tool calls collapsible, tool results inline).
- Confirm bubble: rendered inline when a `confirmRequest` is pending; `Allow` / `Deny` buttons send `confirmResponse`.
- Composer (textarea + Send + Abort).

Bundled with `esbuild` separately from the extension host code; loaded by the webview HTML via a `webview.asWebviewUri`.

## Bridge protocol (extension host ↔ webview)

JSON messages via `postMessage`. Keep these as **separate notifications**; never fold tool calls into the chunk stream (roadmap §Open questions).

Host → webview:
- `agentsLoaded { agents: AgentSummary[] }`
- `chunk { text }`
- `toolCall { id, name, args }`
- `toolResult { id, content }`
- `confirmRequest { id, toolName, args }`
- `done { stop, usage, toolCalls }`
- `error { message }`

Webview → host:
- `start { agentName, prompt }`
- `abort`
- `confirmResponse { id, allow }`
- `selectAgent { agentName }`

## Working directory

For every `harness.run` call, `workingDir = workspace.workspaceFolders[0].uri.fsPath`. The agent's stored `workingDir` is **ignored** when running inside the extension.

If no workspace folder is open, the sidebar displays "Open a folder to use Caretaker" and disables the composer.

**Documented consequence**: `@file` refs in the agent's `systemPrompt` are resolved by `prelude.ts` from the current `workingDir`. In the extension that means they resolve from the VSCode workspace, not from the path saved on the agent. This is intentional for MVP. Out-of-scope follow-up: a per-agent toggle to lock to `agent.workingDir`.

## Configuration

VSCode contributes:

| Setting | Type | Default | Effect |
|---|---|---|---|
| `caretaker.home` | string | `""` | Override `CARETAKER_HOME` path. Env var `CARETAKER_HOME` takes precedence. |
| `caretaker.defaultAgent` | string | `""` | Name of the agent selected on activation. If empty, picks the first available; if none, shows empty state. |

## Confirm gate

Plumbing:

```ts
const confirmTool = (name: string, args: unknown) => new Promise<boolean>((resolve) => {
  const id = randomUUID();
  pendingConfirms.set(id, resolve);
  webview.postMessage({ type: 'confirmRequest', id, toolName: name, args });
});
```

The webview renders the bubble inline in the chat stream. No timeout; the turn blocks until the user decides. `abort` cancels any pending confirm by rejecting the promise (the harness must treat `confirmTool` rejection as deny + abort).

## Lifecycle plumbing (roadmap concerns, addressed)

- **MCP children**: tied to the harness, not the extension. On `deactivate`, the extension aborts the active run; the harness's MCP shutdown path is invoked. If today the harness lacks an explicit shutdown for managed MCP children, the implementation plan adds one (small change; existing MCP server registry already tracks active transports).
- **Plugin cache writes**: only happen on plugin source refresh, which is user-triggered (not automatic on activate in the MVP). No concurrent-writer risk in this iteration.
- **Session JSONL contention**: documented limit. Two VSCode windows + same workspace + same agent active → interleaved appends possible. Out of scope to fix; if it bites, follow-up adds a `session.lock` file with "second open is read-only".

## Testing

- **Unit** (`packages/vscode-extension/src/*.test.ts` via `tsx --test`): `ChatSessionController` with a fake harness module; bridge protocol serialization; `CARETAKER_HOME` precedence resolution.
- **Integration** (`@vscode/test-electron`): launch a clean VSCode window with a temp `CARETAKER_HOME` containing a stub agent + a stub OpenAI-compatible provider (local HTTP mock). Drive a prompt that triggers a tool with confirm policy `[!]`, assert the `confirmRequest` round-trip, assert streaming chunks arrive, assert session JSONL is appended.
- **Manual checklist** (in the PR description):
  1. Open a folder; sidebar shows the agent picker.
  2. Send a prompt; chunks stream in.
  3. Trigger a tool with `[!]` policy; confirm bubble appears; Allow runs the tool, Deny aborts.
  4. Reload window mid-turn; no orphaned MCP children (verify with `ps`).
  5. Open same workspace in two windows; both can start chats (interleave acknowledged).

## Migration steps (sketch — implementation plan will detail)

1. Create `packages/cli/`, move existing `src/`, `tsconfig.json`, `package.json`, `dist/` config there. Rename the package entry references accordingly.
2. Root `package.json`: drop dependencies, keep `devDependencies` only if shared, add `"private": true`. Add `pnpm-workspace.yaml` with `packages: ['packages/*']`.
3. Replace `package-lock.json` with a fresh `pnpm install` → `pnpm-lock.yaml`.
4. Root scripts become workspace-aware: `pnpm -F caretaker-cli dev`, `pnpm -F caretaker-cli build`, etc. Top-level aliases optional.
5. Add barrel files `packages/cli/src/harness/index.ts` and `packages/cli/src/session/index.ts`, then add `exports` map to `packages/cli/package.json` (see §Public API). Verify with a smoke test that imports `caretaker-cli/harness` from a sibling test.
6. Update `bin` path: `"caretaker-cli": "dist/index.js"` inside `packages/cli/package.json`. Rewrite `link:global` script to `pnpm -F caretaker-cli build && pnpm -F caretaker-cli link --global`.
7. Scaffold `packages/vscode-extension/` with `package.json` (engines.vscode, contributes.{views, viewsContainers, commands, configuration}), `tsconfig.json`, `esbuild.config.js`, `src/extension.ts`.
8. Implement components in dependency order: bridge types → `ChatSessionController` → `SidebarWebviewProvider` → webview React bundle → wiring in `extension.ts`.
9. Tests: unit first, integration once the wiring is connected end-to-end.
10. Update `README.md` (pnpm requirement, extension usage), `docs/roadmap.md` (mark IDE extension MVP shipped path, note subprocess deferred).

## Open follow-ups (not blocking this spec)

- Per-agent toggle: lock `workingDir` to `agent.workingDir` instead of workspace.
- Session browser sidebar pane.
- Agent CRUD inside the extension.
- Promote `caretaker run` into an interactive RPC mode for multi-consumer.
- Multi-window session lock.
