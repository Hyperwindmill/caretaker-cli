# Desktop assistant: global shortcut + session workspace switch

**Date:** 2026-11-07
**Status:** design, approved for planning
**Surfaces:** Electron desktop (`packages/desktop`), web GUI (`packages/cli/src/cli/web`), shared webview (`packages/webview-ui`)

## Intent

Daniele often has his hands busy and wants to talk to caretaker without
reaching for the mouse: press a global shortcut, the desktop app comes to the
front on a fresh conversation with a pre-chosen agent, the mic is already
open (when voice is configured), and he dictates a prompt. Because the thing
he wants to do depends on the project, the agent needs a way to move the
conversation into one of the known projects on request ("switch to the backend project,
then…").

The usual outcome is an ordinary chat in that project. Whether the agent then
answers questions, edits code, or creates an autonomous task is up to the
agent's existing tools; none of that is new here.

## Goals

- One global shortcut, registered by the desktop app, that opens caretaker on
  a new conversation with the configured "assistant" agent.
- If voice is available in the renderer, the conversation starts in voice
  conversation mode with the mic open; otherwise the composer is focused.
- A builtin tool that switches the current chat session's working directory
  to one of the configured projects, for the rest of that session.
- Everything is opt-in configuration. No agent configured = no shortcut
  registered, zero cost.

## Non-goals (this iteration)

- Wake word / keyword activation. Noted as the future trigger; the activation
  path is designed so a second trigger only has to call the same function.
- A compact widget / separate assistant window. First cut uses the main
  window. Widget work can come later on top of the same activation message.
- Shortcut support in the TUI or the VSCode sidebar.
- Remembering the last chosen workspace across activations. A new session
  always starts from the agent's own `workingDir` (Daniele's decision).
- Workspace switch for claude-code / ACP assistant agents (see "Native
  agents only").
- Honouring the session workspace override in the TUI or VSCode controllers.
  The override is persisted on the session record, so those surfaces could
  read it later; this iteration wires only the web server (which the desktop
  app runs).

## Anti-goals

- A shortcut that opens caretaker but lands on the previous session, a stale
  agent, or with the mic closed when voice is configured. The whole point is
  "press, speak".
- A workspace switch that silently edits the agent's stored `workingDir`.
  The switch is per session.
- An always-on tool. `set_workspace` is gated by `allowedTools` like every
  capability tool (see CLAUDE.md layer 2: no silent always-on list).

## Part 1: activation

### Configuration

New optional key in `caretaker.json` (`CaretakerConfig` in
`packages/types/src/index.ts`):

```ts
desktopAssistant?: {
  /** Agent that answers the shortcut. Empty/unset = feature off. */
  agentId: string;
  /** Electron accelerator string, e.g. "CommandOrControl+Shift+Space". */
  shortcut: string;
};
```

Default shortcut when the block is created from the UI:
`CommandOrControl+Shift+Space` (builder's call if a platform conflict shows
up; keep it one accelerator, cross-platform).

Settings UI: a new **Desktop** tab in `SettingsPanel.tsx`, gated
`layout === 'sidebar'` like Voice/Memory/Services (the shortcut only does
something under the desktop app; the tab says so in one line). Contents: an
agent picker (same pattern as `MemoryTab.tsx`) and a text field for the
accelerator. Saves through the ordinary `saveConfig` message, no dedicated
endpoint. Validation: the accelerator is validated host-side by Electron when
registering (see below); the form only requires non-empty when an agent is
set.

### Desktop main process (`packages/desktop/src/main.ts`)

- Read `desktopAssistant` from `<DATA_DIR>/caretaker.json` after the window
  is created. Parse defensively (missing file / bad JSON = feature off).
- If `agentId` and `shortcut` are both non-empty, `globalShortcut.register`.
  On failure (`register` returns false or throws on a bad accelerator) log a
  warning and continue; the app must never fail to boot because of this.
- Watch `caretaker.json` (`fs.watch` on the file, debounced ~300 ms; the
  store writes via tmp + rename so the watcher may fire for rename events —
  re-attach the watcher if the handle dies). On change: `unregisterAll`
  for the assistant shortcut, re-read, re-register. One accelerator is ever
  registered, so `globalShortcut.unregisterAll()` is acceptable.
- Unregister on `will-quit`.
- Handler: `activateAssistant()`:
  1. `mainWindow.show()`, `mainWindow.focus()` (restore if minimized).
  2. `mainWindow.webContents.executeJavaScript(` dispatch a `MessageEvent`
     on `window` with `{ type: 'assistantActivate', agentId }` `)`.
  The webview already receives every host→view message as a window
  `message` event (`standalone.tsx` dispatches WebSocket frames the same
  way), so no preload, no IPC, no new server route. This function is the
  single entry point every trigger calls (shortcut, argv, future wake word).

#### Two triggers, same entry point (Wayland)

Electron's `globalShortcut` is an X11 key grab on Linux. Under a Wayland
session (Daniele's workstation: GNOME, `XDG_SESSION_TYPE=wayland`) it only
fires while an XWayland window is focused, so "press from whatever app I'm
in" silently does nothing there, and `focus()` from a grab callback is
refused by the compositor without an activation token. Two triggers, both
calling `activateAssistant()`:

1. **`globalShortcut`** as above. Works on macOS, Windows, X11.
2. **`--assistant` argv.** `main.ts` already holds
   `requestSingleInstanceLock` with a `second-instance` handler; that handler
   receives the second launch's argv. If it contains `--assistant`, call
   `activateAssistant()` (the first launch honours the flag too, after the
   window is ready). A desktop-environment keybinding (GNOME Settings →
   Keyboard → Custom shortcuts) bound to `<desktop executable> --assistant`
   then owns the key, and because the DE launched the process the window
   raise carries an activation token and works. The builder names the
   executable as electron-builder installs it (`.deb`/AppImage) and the dev
   loop equivalent.

The Desktop settings tab shows both: the accelerator field, and one line
with the command to bind in the desktop environment, noting that on Wayland
only the second works. `desktopAssistant.agentId` is the gate for both
triggers; `shortcut` only drives the first.

The desktop app's web server is a child process; the main process has no
other channel into the page, and this one costs nothing.

### Webview (`packages/webview-ui`)

- `bridge.ts`: add `{ type: 'assistantActivate'; agentId: string }` to
  `HostToView`. It is injected by the desktop main process only; the web
  server never sends it.
- `App.tsx` on `assistantActivate`:
  1. Navigate to the Chat screen if on Projects/Settings.
  2. If `agentId` differs from the selected agent: post `selectAgent` and
     **wait for the server to confirm the switch before going on.** The ws
     handlers in `server.ts` are not serialized and `selectAgentInternal`
     awaits `resolveAgentTools`, which connects the agent's MCP servers
     (seconds for a stdio server); a `start` posted before it completes
     runs under the *previous* agent — the stated anti-goal. The server
     ends every agent switch with `sessionsLoaded`; the builder gates on
     that (a pending-activation state resolved by the first
     `sessionsLoaded` after the post) or adds a tiny dedicated
     `agentSelected { agentId }` host message if that reads cleaner. Either
     is fine; the race is not.
  3. Post `createSession` and clear chat state (same as `onCreateSession`).
  4. If `voice.available`: `voice.setMode('conversation')` then
     `voice.toggle()` so the mic opens (phase `idle → recording`). Order
     matters: `setMode` applies `userStop` first, then the toggle must run
     after the mode is actually `conversation` — the builder makes this
     robust (effect keyed on the pending-activation state, not two
     synchronous calls that race React state).
  5. Else: focus the composer textarea (the existing autofocus-on-enable
     path in `Composer` already covers the common case once the agent is
     selected; a direct focus call after the agent is set is fine).
- A `desktopAssistant.agentId` pointing to a deleted agent: the webview
  ignores the activation beyond showing the window (no error card needed;
  the Desktop tab shows the dangling id on next visit).
- A second activation while a turn is streaming: still create a new session
  (the running turn belongs to the previous controller; the server already
  handles `createSession` by dropping the controller reference). Keep it
  simple; do not try to abort the previous turn.

### Behaviour matrix

| Voice configured in renderer | Result of shortcut |
|---|---|
| yes (`voice.available`) | new session, assistant agent, conversation mode, mic open |
| no | new session, assistant agent, composer focused |

## Part 2: session workspace switch

### Tool

New builtin `set_workspace` in `packages/cli/src/harness/tools/builtin/`
(registered in `builtin/index.ts` and the central registry; appears in all
three tool pickers; off by default like other capability tools).

```
set_workspace({ project_id: string })
```

- Resolves the project from `loadConfig().projects` by id; the effective
  directory is `projectWorkingDir(p)` (the same resolution `project_list`
  uses, so managed clones work).
- Unknown id → error listing nothing (the agent calls
  `mcp__task__project_list` first; the description says so).
- Requires `ctx.sessionId`; without one (the `caretaker-cli mcp` stdio
  server, headless `run` with no session) → error "no chat session to
  switch". This is why it lives outside the served `mcp__*` namespaces:
  it is session-bound, not context-free.
- Effect, in order:
  1. `ctx.workingDir = dir` — mutates the shared `ToolContext` in place, so
     `read_file`/`glob`/`grep`/`bash`/`write`/… in the *same* turn already
     resolve against the new directory (they read `ctx.workingDir` at call
     time). The read-before-write set stays as is.
  2. Persist: `updateSessionWorkspace(meta, { workingDir, projectId })` on
     the session store, a sibling of `updateClaudeSessionId` (append a new
     `session_meta` record). New optional fields
     `SessionMetaRecord.workingDir?: string` and the existing `projectId`
     reused. `projectId` is stored too because memory scoping
     (`resolveProjectIdForDir`, `lib/project_resolve.ts`) prefix-matches the
     raw `projects[].workingDir`, which is blank for a managed clone — the
     web server passes `memoryProjectId` explicitly from the meta instead of
     relying on the prefix match.
  3. Result text: the project name and directory, plus a one-line note
     that project context files (AGENTS.md etc.) and project-scoped
     memories apply from the next turn (the prelude is built once per
     run).
- Not a security boundary: the sandbox is still the chosen project dir;
  the user picked which projects exist.

### Web server honouring the override

`WebSessionController.start` (`cli/web/server.ts`): the controller caches
`metaRecord` after the first turn, so before each `harness.run` it re-reads
the latest `session_meta` line (`readSession(...).meta`, cheap) and passes
`meta.workingDir ?? this.opts.workingDir` as `workingDir` and
`meta.projectId` as `memoryProjectId`. The controller's `opts.workingDir`
stays the agent default; a switch made by the tool mid-session takes effect
on the next turn without recreating the controller.

### Native agents only

`set_workspace` is a native builtin. External runners (`claude-code`, `acp`)
have no caretaker tool picker and use their own tools, so for them the
workspace switch does not exist and `meta.workingDir` is never written (the
tool is the only writer); their runs are unaffected. Supporting them would
need a different delivery (a served `mcp__*` tool cannot be session-bound)
and, for claude-code, a verified `--resume` across a changed `cwd`. Out of
scope; the Desktop tab's agent picker lists every agent but notes that the
workspace switch needs a native agent.

Session history reloads (`selectSession`) read the latest `session_meta`
record, so reopening the session later keeps the override.

### Why not `invoke_agent` with a project parameter

Dispatching a sub-agent into the project would give a one-shot answer in a
child run, not a conversation living in that project. Daniele's usual outcome
is a normal chat there, so the session itself moves.

## Documentation

CLAUDE.md: layer 1 (desktop surface gains the shortcut), layer 2 (new
session-bound builtin, outside served namespaces), State on disk
(`desktopAssistant` in `caretaker.json`, `workingDir` on
`SessionMetaRecord`). README: a short "Desktop assistant" section (how to
enable, what the shortcut does, how to ask for a workspace switch).
Changeset: `minor` (new user-facing feature across cli, types, webview-ui,
desktop).

## Left to the builder

- Exact React mechanics for the activate sequence in `App.tsx`.
- `fs.watch` vs polling on platforms where watching a renamed-over file is
  flaky (Windows): polling the file mtime every few seconds is acceptable.
- Tests: `set_workspace` (unknown project, no session, in-place ctx mutation,
  meta persisted); `bridge.ts` parse of `assistantActivate`; controller
  picks `meta.workingDir` over the agent default; activation waits for the
  agent-switch confirmation before opening the mic (pure helper). Desktop main has no test
  harness today; keep its new code small and pure where possible.
- Commit split: (1) types + Desktop settings tab + desktop shortcut,
  (2) `set_workspace` + session meta + web server override, (3) docs +
  changeset — or fold docs into each.
