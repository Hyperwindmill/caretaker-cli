# Desktop Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global shortcut (or `--assistant` launch) opens the desktop app on a fresh voice-ready conversation with a configured agent, and a builtin tool lets that agent move the session into one of the configured projects.

**Architecture:** The Electron main process owns the triggers (`globalShortcut` + `second-instance` argv) and injects one `assistantActivate` window message into the page; the shared webview drives agent select → session create → mic open through a small pure state helper. The workspace switch is a session-bound native builtin that mutates the run's `ToolContext.workingDir` in place and persists `workingDir`/`projectId` on the session meta record, which the web server's controller re-reads before every turn.

**Tech Stack:** TypeScript ESM, Electron 45 (`globalShortcut`, `second-instance`), React webview, node:test via tsx, Changesets.

**Spec:** `docs/superpowers/specs/2026-11-07-desktop-assistant-design.md`

## Global Constraints

- All code, comments, docs in English. Tests co-located as `*.test.ts`, node:test via tsx, no other runner.
- `process.env.CARETAKER_HOME` is set at **file** top before any store import in tests (see `packages/cli/src/session/claude_session_id.test.ts`).
- Persisted state follows the existing append-a-new-`session_meta`-record pattern (`updateClaudeSessionId`); never rewrite the JSONL.
- The husky pre-commit hook requires a staged `.changeset/*.md` for any commit touching package code: the changeset is created in Task 1 and travels with every commit.
- Never `--amend`/`rebase`/`reset`; one new commit per task.
- Default accelerator: `CommandOrControl+Shift+Space`. Config key: `desktopAssistant: { agentId, shortcut }`. Tool name: `set_workspace`. Host message: `assistantActivate`. New host ack: `agentSelected`.
- `set_workspace` is a plain builtin (no `mcp__` prefix), not `hidden`, so it appears in all three pickers automatically; it is never auto-injected.
- Desktop main (`packages/desktop`) has no test harness; its new code is small and guarded so a bad accelerator can never prevent boot.
- Settings tab gated `layout === 'sidebar'` like Voice/Memory.

## Review Focus

1. A project whose resolved directory does not exist on disk: `set_workspace` must refuse (error naming the dir), not switch the sandbox into nothing. Test in Task 2.
2. `assistantActivate` carrying an agent id no longer in `agents.json`: the window shows, nothing else happens, no error card. Test in Task 4 (helper returns `null`).
3. An invalid accelerator string in `caretaker.json`: `globalShortcut.register` throws or returns false; the app must boot and log a warning. Guarded in Task 6, verified by hand with `shortcut: "nope"`.
4. Shortcut pressed while a turn is streaming for the same agent: a new session is created, the old turn keeps running in the dropped controller, the view clears. Covered by the existing `createSession` server path; helper test in Task 4 (same agent → `open` immediately).
5. Voice configured but the mic cannot be captured (`voice.available` false): activation must fall through to the composer focus, never hang in a pending state. Task 4 effect clears pending state on both branches; test on the helper's `'open'` → done transition.

---

### Task 1: Types, changeset, session meta `workingDir`

**Files:**
- Create: `.changeset/desktop-assistant.md`
- Modify: `packages/types/src/index.ts` (`CaretakerConfig`, ~line 224)
- Modify: `packages/cli/src/session/types.ts` (`SessionMetaRecord`)
- Modify: `packages/cli/src/session/store.ts` (next to `updateAcpSessionId`, ~line 278)
- Test: `packages/cli/src/session/workspace_override.test.ts`

**Interfaces:**
- Produces: `CaretakerConfig.desktopAssistant?: DesktopAssistantConfig` where `export type DesktopAssistantConfig = { agentId: string; shortcut: string }`.
- Produces: `SessionMetaRecord.workingDir?: string` (the existing `projectId?: string` is reused).
- Produces: `updateSessionWorkspace(meta: Pick<SessionMetaRecord, 'agentId' | 'id'>, ws: { workingDir: string; projectId: string }): Promise<void>` in `session/store.ts`.

- [ ] **Step 1: Write the changeset**

`.changeset/desktop-assistant.md`:
```md
---
"@hyperwindmill/caretaker-cli": minor
"caretaker-types": minor
"webview-ui": minor
"caretaker-desktop": minor
---

Desktop assistant: a global shortcut (or `caretaker-desktop --assistant`) opens the desktop app on a fresh conversation with a configured agent, in voice conversation mode when voice is available. New `set_workspace` builtin moves the current chat session into one of the configured projects for the rest of the session.
```

- [ ] **Step 2: Write the failing test**

`packages/cli/src/session/workspace_override.test.ts`, same preamble as `claude_session_id.test.ts` (tmp `CARETAKER_HOME` at file top):
```ts
test('workspace override round-trips via appended meta (latest wins)', async () => {
  const meta = await createSession({ agentId: 'a1', title: 'hello' });
  assert.equal((await readSession('a1', meta.id)).meta.workingDir, undefined);
  await updateSessionWorkspace(meta, { workingDir: '/tmp/p1', projectId: 'p1' });
  const after = (await readSession('a1', meta.id)).meta;
  assert.equal(after.workingDir, '/tmp/p1');
  assert.equal(after.projectId, 'p1');
  await updateSessionWorkspace(meta, { workingDir: '/tmp/p2', projectId: 'p2' });
  assert.equal((await readSession('a1', meta.id)).meta.workingDir, '/tmp/p2');
  assert.equal((await listForAgent('a1')).length, 1);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/session/workspace_override.test.ts`
Expected: FAIL (`updateSessionWorkspace` is not exported).

- [ ] **Step 4: Add the types and `updateSessionWorkspace`**

`DesktopAssistantConfig` + `desktopAssistant?` on `CaretakerConfig` with a doc comment (unset = feature off). `workingDir?` on `SessionMetaRecord` with a comment: session-level override set by `set_workspace`, honoured by the web server. `updateSessionWorkspace` mirrors `updateClaudeSessionId`: read, spread `{ ...current.meta, workingDir, projectId }`, append.

- [ ] **Step 5: Run the test and typecheck**

Run: the command from Step 3, then `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add .changeset/desktop-assistant.md packages/types/src/index.ts packages/cli/src/session/types.ts packages/cli/src/session/store.ts packages/cli/src/session/workspace_override.test.ts
git commit -m "feat(session): workingDir override on session meta + desktopAssistant config type"
```

---

### Task 2: `set_workspace` builtin

**Files:**
- Create: `packages/cli/src/harness/tools/builtin/set_workspace.ts`
- Modify: `packages/cli/src/harness/tools/builtin/index.ts` (import + `registry.register(setWorkspaceTool)` next to `invokeAgentTool`)
- Test: `packages/cli/src/harness/tools/builtin/set_workspace.test.ts`

**Interfaces:**
- Consumes: `updateSessionWorkspace` (Task 1), `projectWorkingDir` from `lib/task_git.ts`, `loadConfig` from `store/json.ts`, `ToolContext` (`sessionId`, `callerAgent`, `workingDir`).
- Produces: `export const setWorkspaceTool: Tool` with `name: 'set_workspace'`, parameters `{ project_id: string }` (required).

- [ ] **Step 1: Write the failing tests**

File-top tmp `CARETAKER_HOME`; write a `caretaker.json` with two projects (`p1` with `workingDir` = a tmp dir that exists, `p-missing` with `workingDir` = a tmp path that does not exist) via `saveConfig`; create a session with `createSession({ agentId: 'a1', title: 't' })`. Build a `ToolContext` with `sessionId: meta.id`, `callerAgent: { id: 'a1', ... }`, `workingDir: '/elsewhere'`.

```ts
test('switches ctx.workingDir in place and persists on the session meta', async () => {
  const res = await setWorkspaceTool.execute({ project_id: 'p1' }, ctx);
  assert.equal(ctx.workingDir, p1Dir);
  const meta = (await readSession('a1', sessionId)).meta;
  assert.equal(meta.workingDir, p1Dir);
  assert.equal(meta.projectId, 'p1');
  assert.match(res.content, /next turn/);
});
test('unknown project id errors and leaves ctx untouched', ...);   // content starts with 'Error:'; ctx.workingDir === '/elsewhere'
test('project dir missing on disk errors', ...);                   // 'Error:' naming the dir; ctx untouched
test('no session errors', ...);                                    // ctx without sessionId → 'Error:' mentioning session; ctx untouched
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/harness/tools/builtin/set_workspace.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `setWorkspaceTool`**

Description text: "Switch this chat session's working directory to one of the configured projects for the rest of the session. Call mcp__task__project_list first to get the project_id." Execute: require `ctx.sessionId` and `ctx.callerAgent?.id` (else error); find project by id in `loadConfig().projects`; `dir = projectWorkingDir(p)`; `stat(dir)` must be a directory; then `ctx.workingDir = dir`; `updateSessionWorkspace({ agentId: ctx.callerAgent.id, id: ctx.sessionId }, { workingDir: dir, projectId: p.id })`; return `Switched to project "<name>" (<dir>). File and shell tools already use it; project context files (AGENTS.md) and project memories apply from the next turn.` Errors return `{ content: 'Error: …' }` like `invoke_agent`. Set `dangerous: true` (the `Tool` flag for mutating tools, informational today).

- [ ] **Step 4: Register in `builtin/index.ts`, run tests + typecheck**

Run: Step 2 command, then `pnpm -F @hyperwindmill/caretaker-cli typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness/tools/builtin/set_workspace.ts packages/cli/src/harness/tools/builtin/set_workspace.test.ts packages/cli/src/harness/tools/builtin/index.ts
git commit -m "feat(tools): set_workspace builtin switches the chat session into a project"
```

---

### Task 3: Web server honours the override + `agentSelected` ack

**Files:**
- Create: `packages/cli/src/cli/web/session_scope.ts`
- Test: `packages/cli/src/cli/web/session_scope.test.ts`
- Modify: `packages/cli/src/cli/web/server.ts` (`WebSessionController.start` ~line 128–180; `selectAgentInternal` ~line 965)
- Modify: `packages/webview-ui/src/bridge.ts` (`HostToView`, ~line 110)

**Interfaces:**
- Produces: `sessionRunScope(meta: Pick<SessionMetaRecord, 'workingDir' | 'projectId'> | undefined, agentWorkingDir: string): { workingDir: string; memoryProjectId?: string }` — `meta.workingDir` wins when non-empty, `memoryProjectId` is `meta.projectId` only when `meta.workingDir` is set (a task cycle session also carries `projectId`, but those never go through this controller; keep the rule simple and documented).
- Produces: host message `{ type: 'agentSelected'; agentId: string }` posted at the end of `selectAgentInternal`, after `loadSessionsAndSend`.

- [ ] **Step 1: Write the failing test**

```ts
test('agent default when no override', () => assert.deepEqual(sessionRunScope(undefined, '/a'), { workingDir: '/a' }));
test('override wins and carries the project scope', () =>
  assert.deepEqual(sessionRunScope({ workingDir: '/p', projectId: 'p' }, '/a'), { workingDir: '/p', memoryProjectId: 'p' }));
```

- [ ] **Step 2: Run to verify it fails, implement, run to verify it passes**

Run: `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/cli/web/session_scope.test.ts`

- [ ] **Step 3: Wire the controller**

In `start`: when `this.metaRecord` already exists (any turn but the first of a fresh session) re-read `readSession(agent.id, this.metaRecord.id).meta` **every turn** and store it back (the cached record is stale after `set_workspace` ran inside a previous turn); compute `const scope = sessionRunScope(meta, this.opts.workingDir)`; pass `workingDir: scope.workingDir` and `memoryProjectId: scope.memoryProjectId` to `harness.run`. The fresh-session branch keeps `this.opts.workingDir` for the first turn (no override can exist yet).

- [ ] **Step 4: Add the `agentSelected` ack**

`bridge.ts`: add `| { type: 'agentSelected'; agentId: string }` to `HostToView`. `server.ts` `selectAgentInternal`: `post({ type: 'agentSelected', agentId: agent.id })` as the last statement. The VSCode host does not send it (optional for the view).

- [ ] **Step 5: Typecheck both packages and run the cli suite**

Run: `pnpm -F @hyperwindmill/caretaker-cli typecheck && pnpm -F webview-ui build && pnpm -F @hyperwindmill/caretaker-cli test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli/web/session_scope.ts packages/cli/src/cli/web/session_scope.test.ts packages/cli/src/cli/web/server.ts packages/webview-ui/src/bridge.ts
git commit -m "feat(web): honour session workspace override per turn; agentSelected ack"
```

---

### Task 4: Webview activation flow

**Files:**
- Create: `packages/webview-ui/src/assistant_activation.ts`
- Test: `packages/webview-ui/src/assistant_activation.test.ts`
- Modify: `packages/webview-ui/src/bridge.ts` (`HostToView`: `| { type: 'assistantActivate'; agentId: string }`)
- Modify: `packages/webview-ui/src/Composer.tsx` (new optional prop `focusToken?: number`)
- Modify: `packages/webview-ui/src/App.tsx` (message handler ~line 118; new state + effects near `useVoice` ~line 215)

**Interfaces:**
- Produces (pure, in `assistant_activation.ts`):
  ```ts
  export type Activation = { agentId: string; step: 'awaiting-agent' | 'open' | 'mic' } | null;
  export function beginActivation(agentId: string, selectedAgentId: string | null, knownAgentIds: readonly string[]): Activation;
  export function onAgentSelected(a: Activation, agentId: string): Activation;
  ```
  `beginActivation` → `null` when `agentId` is not known; `{ step: 'open' }` when it is the selected agent; else `{ step: 'awaiting-agent' }`. `onAgentSelected` promotes `awaiting-agent` → `open` only for the matching id, otherwise returns `a` unchanged.
- Consumes: `agentSelected` (Task 3), `useVoice` (`available`, `mode`, `phase`, `setMode`, `toggle`), `onSelectAgent`, `onCreateSession`.

- [ ] **Step 1: Write the failing tests**

```ts
test('unknown agent → null', () => assert.equal(beginActivation('x', null, ['a']), null));
test('already selected → open', () => assert.deepEqual(beginActivation('a', 'a', ['a']), { agentId: 'a', step: 'open' }));
test('different agent → awaiting, promoted by matching agentSelected only', () => {
  const a = beginActivation('b', 'a', ['a', 'b']);
  assert.deepEqual(a, { agentId: 'b', step: 'awaiting-agent' });
  assert.deepEqual(onAgentSelected(a, 'a'), a);
  assert.deepEqual(onAgentSelected(a, 'b'), { agentId: 'b', step: 'open' });
});
test('onAgentSelected on null stays null', () => assert.equal(onAgentSelected(null, 'a'), null));
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

Run: `pnpm -F webview-ui test`

- [ ] **Step 3: `Composer` focus token**

Add `focusToken?: number` to `ComposerProps`; a `useEffect` on `[focusToken]` that focuses the textarea ref when the token is > 0 (skip the initial undefined/0).

- [ ] **Step 4: Wire `App.tsx`**

State: `const [activation, setActivation] = useState<Activation>(null)` and `const [composerFocusToken, setComposerFocusToken] = useState(0)`.
Handler cases:
- `assistantActivate`: `const a = beginActivation(msg.agentId, selectedAgentId, agents.map(x => x.id))`; if `a` is null return; `setActiveScreen('chat')`; if `a.step === 'awaiting-agent'` call `onSelectAgent(a.agentId)`; `setActivation(a)`.
  (The handler's effect deps include `selectedAgentId` already; add `agents` or read both through refs — builder's call, but the handler must see current values.)
- `agentSelected`: `setActivation((cur) => onAgentSelected(cur, msg.agentId))`.
Effect on `activation?.step === 'open'`: `onCreateSession()`; if `voice.available` → `voice.setMode('conversation')`, `setActivation({ ...activation, step: 'mic' })`; else `setComposerFocusToken(t => t + 1)`, `setActivation(null)`.
Effect on `activation?.step === 'mic' && voice.mode === 'conversation' && voice.phase === 'idle'` → `voice.toggle()`, `setActivation(null)`.
Pass `focusToken={composerFocusToken}` to the chat `Composer`.

- [ ] **Step 5: Build and run the webview tests; smoke in the browser**

Run: `pnpm -F webview-ui build && pnpm -F webview-ui test`, then `pnpm -F @hyperwindmill/caretaker-cli dev web`, open `http://127.0.0.1:3000`, and in the devtools console:
```js
window.dispatchEvent(new MessageEvent('message', { data: { type: 'assistantActivate', agentId: '<an agent id>' } }))
```
Expected: chat screen, that agent selected, a new empty session, composer focused (or mic recording when voice is configured).

- [ ] **Step 6: Commit**

```bash
git add packages/webview-ui/src/assistant_activation.ts packages/webview-ui/src/assistant_activation.test.ts packages/webview-ui/src/bridge.ts packages/webview-ui/src/Composer.tsx packages/webview-ui/src/App.tsx
git commit -m "feat(webview): assistantActivate flow — select agent, new session, mic open"
```

---

### Task 5: Desktop settings tab

**Files:**
- Create: `packages/webview-ui/src/desktop_tab_utils.ts`
- Test: `packages/webview-ui/src/desktop_tab_utils.test.ts`
- Create: `packages/webview-ui/src/DesktopTab.tsx`
- Modify: `packages/webview-ui/src/SettingsPanel.tsx` (`TabId` union, tab button gated `layout === 'sidebar'`, `case 'desktop'`)

**Interfaces:**
- Produces: `buildDesktopAssistantConfig(form: { enabled: boolean; agentId: string; shortcut: string }): DesktopAssistantConfig | undefined` — `undefined` when disabled or `agentId` blank; blank `shortcut` falls back to `DEFAULT_ASSISTANT_SHORTCUT = 'CommandOrControl+Shift+Space'` (exported).
- Produces: `desktopAssistantSignature(c: Record<string, unknown> | undefined | null): string` (Saved ✓ pattern, see `memorySignature`).
- Consumes: `CaretakerConfig.desktopAssistant` (Task 1).

- [ ] **Step 1: Write the failing tests**

```ts
test('disabled or no agent → undefined', ...);
test('blank shortcut → default', () => assert.deepEqual(buildDesktopAssistantConfig({ enabled: true, agentId: 'a', shortcut: '  ' }), { agentId: 'a', shortcut: DEFAULT_ASSISTANT_SHORTCUT }));
test('explicit shortcut kept trimmed', ...);
```

- [ ] **Step 2: Run to verify fail, implement, run to verify pass**

Run: `pnpm -F webview-ui test`

- [ ] **Step 3: `DesktopTab.tsx`**

Copy the `MemoryTab` structure (enabled checkbox, agent `<select>`, Save with pending-signature badge). Fields: agent picker (all agents; a one-line note under it: "The workspace switch (`set_workspace`) needs a native agent — claude-code and ACP agents have no caretaker tools."), shortcut text input with the default as placeholder. Static copy below the form:
- "Desktop app only. Press the shortcut from any app to open caretaker on a new conversation with this agent — in voice conversation mode when voice is configured."
- "On Linux under Wayland the global shortcut does not fire. Bind this command to a keyboard shortcut in your desktop environment instead: `caretaker-desktop --assistant`."
Save: `next.desktopAssistant = cfg` or `delete next.desktopAssistant`, then `onSave(next)`.

- [ ] **Step 4: Wire `SettingsPanel.tsx`**

`TabId` += `'desktop'`; a tab button "Desktop" after Memory, gated `layout === 'sidebar'`; `case 'desktop'` renders `<DesktopTab config agents onSave={(c) => postMessage({ type: 'saveConfig', config: c })} />`.

- [ ] **Step 5: Build, test, check by hand**

Run: `pnpm -F webview-ui build && pnpm -F webview-ui test && pnpm -F @hyperwindmill/caretaker-cli typecheck`, then the web GUI: Settings → Desktop, enable, pick an agent, Save → `caretaker.json` contains `desktopAssistant`.

- [ ] **Step 6: Commit**

```bash
git add packages/webview-ui/src/desktop_tab_utils.ts packages/webview-ui/src/desktop_tab_utils.test.ts packages/webview-ui/src/DesktopTab.tsx packages/webview-ui/src/SettingsPanel.tsx
git commit -m "feat(webview): Desktop settings tab for the assistant agent and shortcut"
```

---

### Task 6: Desktop main — shortcut, `--assistant`, activation injection

**Files:**
- Create: `packages/desktop/src/assistant.ts`
- Modify: `packages/desktop/src/main.ts` (`createWindow`, `second-instance` handler ~line 264, `whenReady`, `before-quit`)

**Interfaces:**
- Produces (in `assistant.ts`, no Electron imports so it stays plain Node):
  ```ts
  export function readAssistantConfig(dataDir: string): { agentId: string; shortcut: string } | null;  // reads <dataDir>/caretaker.json; null on missing file, bad JSON, or blank agentId
  export function activationScript(agentId: string): string;  // JS source dispatching the assistantActivate MessageEvent on window
  export function hasAssistantFlag(argv: readonly string[]): boolean;  // argv.includes('--assistant')
  ```
- Consumes: `assistantActivate` (Task 4), `desktopAssistant` config (Task 1).

- [ ] **Step 1: Implement `assistant.ts`**

`activationScript` returns
`window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ type: 'assistantActivate', agentId })} }))`.

- [ ] **Step 2: Wire `main.ts`**

- `activateAssistant()`: if no `mainWindow` return; `readAssistantConfig(DATA_DIR)`; if null return; restore if minimized, `show()`, `focus()`; `mainWindow.webContents.executeJavaScript(activationScript(cfg.agentId)).catch(() => {})`.
- `registerAssistantShortcut()`: `globalShortcut.unregisterAll()`; `cfg = readAssistantConfig(DATA_DIR)`; if cfg: `try { if (!globalShortcut.register(cfg.shortcut, activateAssistant)) console.warn(...) } catch (e) { console.warn(...) }`.
- In `whenReady` after `createWindow()`: `registerAssistantShortcut()`; `fs.watchFile(path.join(DATA_DIR, 'caretaker.json'), { interval: 2000 }, registerAssistantShortcut)` — `watchFile` polls, so it survives the store's tmp+rename and needs no re-attach (ponytail: 2 s poll on one file is nothing; `fs.watch` if it ever matters). If `hasAssistantFlag(process.argv)`: `mainWindow.webContents.once('did-finish-load', activateAssistant)`.
- `second-instance` handler gains `(_e, argv)`: after the existing show/focus, `if (hasAssistantFlag(argv)) activateAssistant()`. Note the page may still be loading on a very early second instance; acceptable.
- `before-quit` (or `will-quit`): `globalShortcut.unregisterAll()`.

- [ ] **Step 3: Build and verify by hand**

Run: `pnpm build && pnpm desktop:dev`. Checks:
1. With `desktopAssistant` configured (Task 5), press the accelerator (on X11/mac/win) → window up, new session, mic/composer.
2. From another terminal: `pnpm -F caretaker-desktop exec electron . --assistant` → same result via `second-instance` (this is the Wayland path).
3. Set `"shortcut": "nope"` in `caretaker.json` → within 2 s a warning in the console, app alive; fix it back → shortcut works again without restart.
4. Remove `desktopAssistant` → nothing registered.
Also confirm the packaged executable name for the README/tab copy: `pnpm desktop:dist` then `dpkg -c packages/desktop/release/*.deb | grep -i 'bin/'`; if it is not `caretaker-desktop`, fix the command string in `DesktopTab.tsx` and README.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/assistant.ts packages/desktop/src/main.ts
git commit -m "feat(desktop): global shortcut and --assistant launch open the assistant conversation"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (layer 1 desktop bullet; layer 2 after the `invoke_agent` paragraph; State on disk item 1 and the JSONL item 2)
- Modify: `README.md` (new `### Desktop assistant` after the Voice Mode section; `## Built-in tools` list gains `set_workspace`)

- [ ] **Step 1: CLAUDE.md**

- Layer 1, desktop bullet: the main process also owns the assistant triggers — `globalShortcut` (X11/mac/win) and the `--assistant` argv via `second-instance` (the Wayland path) — both calling `activateAssistant()`, which injects an `assistantActivate` window message with `executeJavaScript` (no preload/IPC); config `desktopAssistant` re-read by `fs.watchFile`.
- Layer 2: `set_workspace` — session-bound native builtin (needs `ctx.sessionId`, so it lives outside the served `mcp__*` namespaces), mutates `ctx.workingDir` in place and persists `workingDir`/`projectId` on the session meta; honoured per turn by the web server's controller (`sessionRunScope`), not by TUI/VSCode; never for external runners.
- State on disk: `desktopAssistant` in `caretaker.json`; `SessionMetaRecord.workingDir` override.
- Webview section (layer 7): `agentSelected` ack and the `assistant_activation.ts` helper, one sentence each.

- [ ] **Step 2: README**

"Desktop assistant" section: enable in Settings → Desktop (agent + shortcut), what pressing it does, voice behaviour, the Wayland note with the GNOME custom-shortcut command, and how to ask for a project switch (`set_workspace` must be enabled on the agent; "switch to <project>, then…").

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: desktop assistant and set_workspace"
```

---

## Final verification

Run: `pnpm build && pnpm test && pnpm -F @hyperwindmill/caretaker-cli lint`
Expected: every package builds, all suites green, no lint errors in touched files.
