# caretaker-vscode

VSCode chat sidebar that drives the [caretaker-cli](../cli/) harness in-process. Same agents, same plugins, same skills, same `~/.caretaker/` state as the TUI — different surface.

> Status: MVP. Chat-only sidebar with confirm gate and tool rendering. Agent / plugin / MCP CRUD stays in the TUI for this iteration. See [`docs/superpowers/specs/2026-05-13-vscode-extension-design.md`](../../docs/superpowers/specs/2026-05-13-vscode-extension-design.md) for the scoped design.

## Running it from source

1. From the repo root, install once:

   ```bash
   pnpm install
   ```

2. Open this package as the VSCode workspace (the launch config is relative to it):

   ```bash
   code packages/vscode-extension
   ```

3. Press **F5**. The `preLaunchTask` runs the esbuild dual-bundle (`dist/extension.js` for the host, `dist/webview.js` + `dist/webview.css` for the sidebar) and VSCode opens a second window — the **Extension Development Host** — with this extension loaded.

4. In the EDH window: open any folder (the extension needs a workspace folder for `workingDir`), then click the Caretaker icon in the Activity Bar.

### Watch mode

```bash
pnpm -F caretaker-vscode dev
```

Runs esbuild in watch mode. After a rebuild, reload the EDH window with `Cmd/Ctrl+R` to pick up the changes.

### Debugging

- **Extension host code**: `console.log` lands in the "Extension Host" output channel of the EDH window. Breakpoints in `src/extension.ts`, `src/sidebar.ts`, `src/session.ts` work with the included launch config.
- **Webview code**: `Cmd/Ctrl+Shift+P` → "Developer: Open Webview Developer Tools" inside the EDH. Full DevTools (console, network, React state).

## What it shares with the TUI

The extension embeds `caretaker-cli` as an ESM library (no subprocess). Concretely:

- `CARETAKER_HOME` resolution: env var > VSCode setting `caretaker.home` > default `~/.caretaker`.
- Reads `agents.json` and `caretaker.json` from there — same files the TUI writes.
- Persists chat sessions as JSONL under `~/.caretaker/sessions/<agentId>/` — interleaves with TUI-created sessions for the same agent.
- Uses the same `harness.run` loop, same tool registry, same plugin/skill resolution, same MCP server registration.
- Confirm gate decisions (`once` / `always` / `reject`) match the TUI exactly. `'always'` is in-memory per VSCode session; it does not mutate the stored `agent.confirmTools`.

## What it does differently

- `workingDir` for the agent is always the open VSCode workspace folder, regardless of what's saved on the agent. `@file` refs in the system prompt resolve from there.
- No agent / plugin / MCP CRUD. Use the TUI to create or edit those.
- No session browser yet (chat history per webview, not persisted across reloads in the UI — the JSONL files are written though).
- Single-window safe; two VSCode windows on the same workspace + same agent will interleave JSONL appends. Documented limit, not a blocker for normal use.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `caretaker.home` | `""` | Override `CARETAKER_HOME`. Env var still wins. |
| `caretaker.defaultAgent` | `""` | Name of the agent selected on first chat. Empty → first available. |

## Building a `.vsix` for local install

```bash
pnpm -F caretaker-vscode package
```

Produces `caretaker-vscode-<version>.vsix` in the package root. Install with:

```bash
code --install-extension packages/vscode-extension/caretaker-vscode-0.0.1.vsix
```

`vsce` runs with `--no-dependencies` because all runtime code is already inlined in `dist/extension.js`; pnpm's symlinked `node_modules` is never walked.

## Where things live

```
src/
├── extension.ts          activate() — registers the sidebar provider + caretaker.openChat command
├── config.ts             pure helpers (CARETAKER_HOME precedence) — unit-tested
├── bridge.ts             host ↔ webview wire protocol (discriminated unions + runtime validator)
├── sidebar.ts            WebviewViewProvider — builds the controller, plumbs confirm round-trips
├── session.ts            ChatSessionController — lazy session, history, abortable runs
└── webview/              React 19 UI: App, MessageList, Composer, ConfirmCard, styles.css
```

Tests are co-located (`*.test.ts`) and run with the Node test runner via `tsx`:

```bash
pnpm -F caretaker-vscode test
```
