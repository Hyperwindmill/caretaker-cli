# Task Cycles as Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every autonomous task cycle (developer, planner, review) is recorded as a chat session, viewed live with the chat renderer, and agents get handoff notes instead of full transcripts.

**Architecture:** A cycle recorder (`scheduler/task_cycle.ts`) creates a session per cycle and persists the run's `onMessage` records into it; the task gets a `cycle` timeline message pointing at it. An in-process emitter (`scheduler/cycle_events.ts`) buffers the running cycle's events so a WebSocket watcher can replay and follow it. The webview shares the chat reducer between the chat and a new cycle viewer.

**Tech Stack:** TypeScript (ESM, strict, `noImplicitAny: false`), Node test runner via `tsx --test`, Hono + `ws`, React (webview-ui, esbuild), `@morphql/store` folder DB.

**Spec:** `docs/superpowers/specs/2026-10-24-task-cycle-sessions-design.md`

## Global Constraints

- Tests co-located as `*.test.ts`; `process.env.CARETAKER_HOME` set at **file scope** (one `before` per file, temp dir via `mkdtemp`), never per-`describe`.
- `pnpm test` does not type-check: every task ends with `pnpm -F @hyperwindmill/caretaker-cli typecheck` (and `pnpm -F webview-ui exec tsc --noEmit -p .` for webview tasks).
- Every commit touching package code must stage a changeset (husky hook). Task 1 creates `.changeset/task-cycle-sessions.md` (`'@hyperwindmill/caretaker-cli': minor`, `'webview-ui': minor`); later tasks edit and re-stage it.
- `sessionId` is **never** passed into `harness.run` for task cycles (claude-code `--resume` lookup, ACP 10-minute pooling). Persistence is caller-side via `onMessage`.
- Recap fallback text is exactly: `Cycle ended without a handoff note (<outcome>). Last output: <text>` with `<text>` capped at 2000 chars (`(none)` when empty).
- Legacy `heartbeat` / `heartbeat_live` / `tool_call` messages are never converted; they render through the existing mapper.
- Never commit with `--amend`; one commit per task.

## Review Focus

1. **Pause or wall-clock abort mid-turn** — the cycle must still close: outcome `aborted`, fallback handoff, recap record, `done` event. (Task 3, Task 5)
2. **Run throws before any assistant output** (provider down, bad key) — session holds only the prompt, outcome `failed`, recap is the fallback; the heartbeat's existing error message is still written. (Task 3)
3. **Watching a cycle that finished a moment ago** — no running stream → load from disk, never hang waiting for events. (Task 5)
4. **Two browser tabs watching one cycle** — both receive every event; one tab unwatching or closing does not stop the other. (Task 5)
5. **Missing session file** (deleted agent dir, hand-cleaned store) — deleting the task does not throw; opening the cycle shows an error notice instead of crashing the view. (Task 2, Task 5)

---

### Task 1: Session layer — task meta, recap flag, chat-list filter

**Files:**
- Modify: `packages/cli/src/session/types.ts` (`SessionMetaRecord`, `MessageRecord`)
- Modify: `packages/cli/src/session/store.ts` (`CreateSessionInput`, `createSession`, `listForAgent`)
- Test: `packages/cli/src/session/store.test.ts`
- Create: `.changeset/task-cycle-sessions.md`

**Interfaces:**
- Produces:
  - `SessionMetaRecord` optional fields `taskId?: string; projectId?: string; taskRole?: 'developer' | 'planner' | 'reviewer'`.
  - `MessageRecord.recap?: true`.
  - `CreateSessionInput` accepts the same three optional fields; `createSession` writes them into the meta line only when set.
  - `listForAgent(agentId)` omits entries whose `meta.taskId` is set.

- [ ] **Step 1: Write the failing tests** in `store.test.ts`

```ts
it('createSession persists task meta fields', async () => {
  const meta = await createSession({ agentId: 'a1', title: 't', taskId: 'p-1', projectId: 'p', taskRole: 'developer' });
  const s = await readSession('a1', meta.id);
  assert.equal(s.meta.taskId, 'p-1');
  assert.equal(s.meta.projectId, 'p');
  assert.equal(s.meta.taskRole, 'developer');
});

it('listForAgent hides task cycle sessions', async () => {
  const chat = await createSession({ agentId: 'a2', title: 'chat' });
  await createSession({ agentId: 'a2', title: 'cycle', taskId: 'p-2', projectId: 'p', taskRole: 'planner' });
  const ids = (await listForAgent('a2')).map((e) => e.meta.id);
  assert.deepEqual(ids, [chat.id]);
});

it('recap flag round-trips', async () => {
  const meta = await createSession({ agentId: 'a3', title: 't' });
  await appendMessage(meta, { ...assistantMessage([{ type: 'text', text: 'r' }]), recap: true });
  const s = await readSession('a3', meta.id);
  assert.equal(s.messages[0]!.recap, true);
});
```

- [ ] **Step 2: Run, expect FAIL** (type errors / `undefined`): `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test packages/cli/src/session/store.test.ts`
- [ ] **Step 3: Implement** the fields and the `listForAgent` filter (skip after `readFirstMeta`).
- [ ] **Step 4: Run, expect PASS**; then `pnpm -F @hyperwindmill/caretaker-cli typecheck`.
- [ ] **Step 5: Write `.changeset/task-cycle-sessions.md`** — one paragraph: "Autonomous task cycles are recorded as sessions and viewed live with the chat renderer; agents receive handoff notes instead of full transcripts." (expanded in Task 7).
- [ ] **Step 6: Commit** `feat(session): task cycle meta, recap flag, hide cycle sessions from chat lists`

---

### Task 2: Task store — cycle messages and delete cascade

**Files:**
- Modify: `packages/cli/src/store/db.ts` (`TaskMessage`, new helpers, `deleteTask`)
- Modify: `packages/cli/src/cli/web/server.ts:~366` (project deletion path)
- Test: `packages/cli/src/store/db_cycle.test.ts` (new)

**Interfaces:**
- Consumes: `deleteSession(agentId, sessionId)` from `session/store.ts`.
- Produces:
  - `TaskMessage.messageType` gains `'cycle'`; `TaskMessage` gains optional `sessionId?: string | null; sessionAgentId?: string | null; cycleRole?: 'developer' | 'planner' | 'reviewer' | null; cycleOutcome?: CycleOutcome | null`.
  - `export type CycleOutcome = 'running' | 'handoff' | 'completed' | 'blocked' | 'plan' | 'review-pass' | 'review-changes' | 'aborted' | 'failed'` (in `db.ts`).
  - `setCycleOutcome(messageId: number, outcome: CycleOutcome): Promise<void>`.
  - `deleteTaskSessions(taskId: string): Promise<void>` — deletes the session file of every `cycle` message of the task; a missing file or agent dir is ignored (warn, no throw).
  - `deleteTask` calls `deleteTaskSessions` first.

- [ ] **Step 1: Write the failing tests** (`db_cycle.test.ts`, file-scope `CARETAKER_HOME`)

```ts
it('setCycleOutcome updates only the outcome', async () => {
  const m = await addTaskMessage({ taskId: 'p-1', role: 'assistant', messageType: 'cycle', content: '', sessionId: 's1', sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'running' });
  await setCycleOutcome(m.id, 'handoff');
  const [row] = (await runQuery(`SELECT * FROM task_messages WHERE taskId = 'p-1'`)) as TaskMessage[];
  assert.equal(row.cycleOutcome, 'handoff');
  assert.equal(row.sessionId, 's1');
});

it('deleteTask removes cycle sessions and tolerates missing files', async () => {
  const meta = await createSession({ agentId: 'a', title: 'c', taskId: 'p-2', projectId: 'p', taskRole: 'developer' });
  await addTaskMessage({ taskId: 'p-2', role: 'assistant', messageType: 'cycle', content: '', sessionId: meta.id, sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'handoff' });
  await addTaskMessage({ taskId: 'p-2', role: 'assistant', messageType: 'cycle', content: '', sessionId: 'gone', sessionAgentId: 'nobody', cycleRole: 'developer', cycleOutcome: 'handoff' });
  await deleteTask('p-2');
  await assert.rejects(readSession('a', meta.id));
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `setCycleOutcome` follows `updateTaskMessageContent`'s `UPDATE … WHERE id = ${id}` form (outcome is from the closed union, no escaping needed). In `server.ts` project deletion, call `deleteTaskSessions(t.id)` for each task before the raw `DELETE FROM task_messages`.
- [ ] **Step 4: Run, expect PASS**; typecheck.
- [ ] **Step 5: Commit** `feat(store): cycle task messages and session cascade on task/project delete` (stage the changeset).

---

### Task 3: Cycle recorder and lighter agent context

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/task_cycle.ts`
- Modify: `packages/cli/src/cli/web/scheduler/task_strategy.ts` (dev/planner run, history, error path; `runReviewCycle`)
- Modify: `packages/cli/src/cli/web/scheduler/task_review.ts` (`runDoneReview` opts)
- Modify: `packages/cli/src/harness/tools/builtin/task_tools.ts` (`task_get_state.recentMessages`)
- Test: `packages/cli/src/cli/web/scheduler/task_cycle.test.ts`

**Interfaces:**
- Consumes: Task 1 session fields, Task 2 `CycleOutcome`/`setCycleOutcome`; `RunCallbacks` from `harness/loop.ts`.
- Produces (all exported from `task_cycle.ts`):
  - `HISTORY_TYPES = ['chat', 'review', 'plan'] as const` and `filterHandoffMessages(msgs: TaskMessage[]): TaskMessage[]` — keeps only those types, preserves order. Used by the history replay **and** `task_get_state.recentMessages` (`filterHandoffMessages(messages).slice(-20)`).
  - `resolveCycleOutcome(i: { role: CycleRole; statusAfter: Task['status'] | null; aborted: boolean; failed: boolean; verdict?: 'pass' | 'changes' }): CycleOutcome` — `failed` → `'failed'`; `aborted` → `'aborted'`; reviewer → `review-pass`/`review-changes`; `statusAfter` `reviewing`/`done` → `completed`; `blocked` → `blocked`; planner with `statusAfter === 'active'` → `plan`; otherwise `handoff`.
  - `buildRecap(sinceCycle: TaskMessage[], fallback: string | null): string` — joins, in order, the content of assistant `chat`, `system` messages starting with `Yield:`, `block`, `plan`, `review` messages created during the cycle, separated by `\n\n`; appends `fallback` when non-null.
  - `type CycleRole = 'developer' | 'planner' | 'reviewer'`.
  - `openCycle(i: { task: Task; agent: AgentConfig; role: CycleRole; agentLabel: string; prompt: string }): Promise<CycleRecorder>` — creates the session (title `<taskId> · <role>`, meta `taskId`/`projectId`/`taskRole`), appends `userMessage(prompt)`, adds the `cycle` task message with `cycleOutcome: 'running'` and `agentLabel`.
  - `interface CycleRecorder { sessionId: string; agentId: string; callbacks: Pick<RunCallbacks, 'onChunk' | 'onThinking' | 'onToolCall' | 'onToolResult' | 'onMessage'>; close(i: { outcome: CycleOutcome }): Promise<void> }`.
    - `callbacks.onMessage` appends the record to the session and remembers the last non-empty assistant `content` as `lastText`.
    - `close`: `setCycleOutcome`; for developer/planner, if no assistant `chat` task message was created since cycle start, adds one with the fallback text (Global Constraints) and the cycle's `agentLabel`; then appends the recap record (`assistantMessage([{type:'text', text: buildRecap(...)}])` with `recap: true`). Errors inside `close` are logged, never thrown (it runs in `finally`).
    - In this task the stream callbacks (`onChunk`…`onToolResult`) are no-ops; Task 5 makes them emit.

- [ ] **Step 1: Write the failing tests** (`task_cycle.test.ts`, file-scope `CARETAKER_HOME`)

```ts
it('filterHandoffMessages drops transcripts', () => {
  const kept = filterHandoffMessages([
    msg('heartbeat'), msg('tool_call'), msg('chat'), msg('cycle'), msg('plan'), msg('review'), msg('system'),
  ]).map((m) => m.messageType);
  assert.deepEqual(kept, ['chat', 'plan', 'review']);
});

it('resolveCycleOutcome', () => {
  const base = { role: 'developer' as const, statusAfter: 'active' as const, aborted: false, failed: false };
  assert.equal(resolveCycleOutcome(base), 'handoff');
  assert.equal(resolveCycleOutcome({ ...base, aborted: true, statusAfter: 'paused' }), 'aborted');
  assert.equal(resolveCycleOutcome({ ...base, failed: true }), 'failed');
  assert.equal(resolveCycleOutcome({ ...base, statusAfter: 'reviewing' }), 'completed');
  assert.equal(resolveCycleOutcome({ ...base, statusAfter: 'blocked' }), 'blocked');
  assert.equal(resolveCycleOutcome({ ...base, role: 'planner' }), 'plan');
  assert.equal(resolveCycleOutcome({ ...base, role: 'planner', statusAfter: 'planning' }), 'handoff');
  assert.equal(resolveCycleOutcome({ ...base, role: 'reviewer', verdict: 'changes' }), 'review-changes');
});

it('close without handoff writes the fallback and a recap record', async () => {
  const rec = await openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'do it' });
  await rec.callbacks.onMessage!(assistantMessage([{ type: 'text', text: 'halfway there' }]));
  await rec.close({ outcome: 'aborted' });
  const s = await readSession(agent.id, rec.sessionId);
  assert.equal(s.meta.taskRole, 'developer');
  assert.equal(s.messages[0]!.role, 'user');
  const recap = s.messages.at(-1)!;
  assert.equal(recap.recap, true);
  assert.match(recap.content, /^Cycle ended without a handoff note \(aborted\)\. Last output: halfway there$/);
  const cycle = (await taskRows(task.id)).find((m) => m.messageType === 'cycle')!;
  assert.equal(cycle.cycleOutcome, 'aborted');
});

it('close with a handoff recaps it and adds no fallback', async () => {
  const rec = await openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'p' });
  await addTaskMessage({ taskId: task.id, role: 'assistant', messageType: 'chat', content: 'did X, next Y' });
  await rec.close({ outcome: 'handoff' });
  const recap = (await readSession(agent.id, rec.sessionId)).messages.at(-1)!;
  assert.equal(recap.content, 'did X, next Y');
});

it('close on a run that failed before any output', async () => {
  const rec = await openCycle({ task, agent, role: 'developer', agentLabel: 'A · m', prompt: 'p' });
  await rec.close({ outcome: 'failed' });
  const recap = (await readSession(agent.id, rec.sessionId)).messages.at(-1)!;
  assert.match(recap.content, /\(failed\)\. Last output: \(none\)$/);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `task_cycle.ts`.**
- [ ] **Step 4: Wire the developer/planner cycle in `task_strategy.ts`.**
  - Remove the `heartbeat_live` message, `buffer`, `updateLiveContent` and the finalize/`⚠️ Heartbeat cycle failed` updates.
  - History: `filterHandoffMessages(historyMessages)` replaces the inline type filter.
  - Before `harness.run`: `const cycle = await openCycle({ task, agent, role: planning ? 'planner' : 'developer', agentLabel: \`${agent.name} · ${agent.model}\`, prompt: effectivePrompt })`. Pass `...cycle.callbacks` into the run callbacks; drop the `tool_call` `addTaskMessage`.
  - Close in a `finally` around the run: `outcome = resolveCycleOutcome({ role, statusAfter: (await getTaskById(task.id))?.status ?? null, aborted: signal.aborted, failed: <caught non-abort error> })`. The existing outer `catch` (system "Heartbeat error" message) stays.
- [ ] **Step 5: Wire the review.** Prompt building stays in `runDoneReview`. Its opts gain `openCycle?: (prompt: string) => Promise<CycleRecorder>`; when set, `runDoneReview` calls it with the final prompt, spreads `cycle.callbacks` into its run callbacks, and returns `{ verdict, text, cycle?: CycleRecorder }`. `runReviewCycle` passes `(prompt) => openCycle({ task, agent, role: 'reviewer', agentLabel: \`${agent.name} · ${agent.model}\`, prompt })` and closes the recorder **after** writing the `review` message with `resolveCycleOutcome({ role: 'reviewer', verdict, statusAfter: null, aborted: signal?.aborted ?? false, failed: false })`. If the review throws after the cycle opened, the recorder is closed with `failed` in the existing catch (the error carries no recorder, so `runDoneReview` closes it itself in its own `catch` before rethrowing).
- [ ] **Step 6: `task_get_state`**: `recentMessages: filterHandoffMessages(messages).slice(-20)`.
- [ ] **Step 7: Run** `task_cycle.test.ts`, `task_review.test.ts`, `lib/task_git_e2e.test.ts` → PASS; typecheck.
- [ ] **Step 8: Commit** `feat(tasks): record each cycle as a session; agents get handoffs, not transcripts`.

---

### Task 4: Memory sweep reads cycle recaps only

**Files:**
- Modify: `packages/cli/src/cli/web/scheduler/memory_sweep.ts` (`sweepMemory`, ~lines 222-262)
- Test: `packages/cli/src/cli/web/scheduler/memory_sweep.test.ts`

**Interfaces:**
- Consumes: `meta.taskId`, `meta.projectId`, `MessageRecord.recap` (Task 1).
- Produces: for a session with `meta.taskId`: messages fed to the model are `session.messages.filter((m) => m.recap)`; the `minNewMessages` debounce threshold is `1`; the project scope is `meta.projectId` (fallback to the existing `resolveProjectId`). Non-task sessions unchanged.

- [ ] **Step 1: Write the failing tests.** Use the file's existing pattern for calling `sweepMemory` with an injected summarizer; the stub records every text it is given in `calls: string[]` and returns one memory `{ level: 'project', … }`.

```ts
it('task session: only the recap reaches the model, scoped to meta.projectId', async () => {
  const meta = await createSession({ agentId: memAgent.id, title: 'c', taskId: 'p1-1', projectId: 'p1', taskRole: 'developer' });
  await appendMessage(meta, userMessage('PROMPT-TEXT'));
  await appendMessage(meta, toolMessage('t1', 'TOOL-OUTPUT'));
  await appendMessage(meta, { ...assistantMessage([{ type: 'text', text: 'RECAP-TEXT' }]), recap: true });
  await runSweep(); // file's existing helper/args
  const sent = calls.join('\n');
  assert.match(sent, /RECAP-TEXT/);
  assert.doesNotMatch(sent, /PROMPT-TEXT|TOOL-OUTPUT/);
  const mine = (await listMemories()).filter((m) => m.sourceSessionId === meta.id);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((m) => m.projectId === 'p1'));
});

it('task session with no recap yet is not swept', async () => {
  const meta = await createSession({ agentId: memAgent.id, title: 'c', taskId: 'p1-2', projectId: 'p1', taskRole: 'developer' });
  await appendMessage(meta, userMessage('PROMPT-ONLY'));
  await runSweep();
  assert.doesNotMatch(calls.join('\n'), /PROMPT-ONLY/);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — a `const messages = …` before `locateCursor`, used everywhere `session.messages` was; the threshold and scope as above.
- [ ] **Step 4: Run the whole file, expect PASS**; typecheck.
- [ ] **Step 5: Commit** `feat(memory): sweep task cycle sessions through their recap only`.

---

### Task 5: Live cycle stream over the WebSocket

**Files:**
- Create: `packages/cli/src/cli/web/scheduler/cycle_events.ts`
- Modify: `packages/cli/src/cli/web/scheduler/task_cycle.ts` (stream callbacks emit; `close` ends the stream)
- Modify: `packages/webview-ui/src/bridge.ts` (types + `parseViewToHost`)
- Modify: `packages/cli/src/cli/web/server.ts` (WS handlers; extract `toChatMessage`)
- Test: `packages/cli/src/cli/web/scheduler/cycle_events.test.ts`, `packages/webview-ui/src/bridge.test.ts` (create if absent)

**Interfaces:**
- Produces (`cycle_events.ts`):
  - `type CycleEvent = { type: 'chunk'; text: string } | { type: 'thinking'; text: string } | { type: 'tool_call'; id: string; name: string; args: unknown } | { type: 'tool_result'; id: string; content: string } | { type: 'done' } | { type: 'error'; message: string }` — same shapes as the chat `HostToView` events.
  - `beginCycleStream(sessionId: string, prompt: MessageRecord): void`
  - `emitCycleEvent(sessionId: string, ev: CycleEvent): void` — appends to the session's buffer (consecutive `chunk`s, and consecutive `thinking`s, coalesce into one event), notifies listeners; `done`/`error` notify and then drop the stream.
  - `watchCycleStream(sessionId: string, listener: (ev: CycleEvent) => void): { prompt: MessageRecord; events: CycleEvent[]; unwatch: () => void } | null` — `null` when not running. Attaching and snapshotting happen synchronously, so no event can fall between snapshot and listener.
  - The recorder: `openCycle` calls `beginCycleStream`; the four stream callbacks emit; `close` emits `done` (or `error` with the outcome when `failed`) **after** the recap is persisted.
- Produces (bridge):
  - ViewToHost `{ type: 'watchCycle'; agentId: string; sessionId: string }`, `{ type: 'unwatchCycle'; sessionId: string }` — parser requires both ids to match `/^[A-Za-z0-9_-]+$/`, else `null`.
  - HostToView `{ type: 'cycleLoaded'; sessionId: string; messages: ChatMessage[]; running: boolean }`, `{ type: 'cycleEvent'; sessionId: string; event: CycleEvent }` (declare the `CycleEvent` union in `bridge.ts` too; the server's must stay assignable to it).
  - `ChatMessage` (bridge) gains `recap?: true`; the server's `toChatMessage(m: MessageRecord): ChatMessage` (extracted from `loadSessionMessagesAndSend`, which then uses it) copies it.
- Server: on `watchCycle` → `watchCycleStream`; if live, post `cycleLoaded{messages:[toChatMessage(prompt)], running:true}` then each snapshot event as `cycleEvent`, live ones as they come; else `readSession` → `cycleLoaded{running:false}`, and on read failure post `cycleEvent{event:{type:'error', message:'Cycle session not found'}}`. Per-socket `Map<sessionId, unwatch>`, cleared on `unwatchCycle` and on socket close.

- [ ] **Step 1: Write the failing tests** (`cycle_events.test.ts`)

```ts
it('late watcher sees the same events as an early one', () => {
  const early: CycleEvent[] = [];
  beginCycleStream('s1', prompt);
  watchCycleStream('s1', (e) => early.push(e));
  emitCycleEvent('s1', { type: 'chunk', text: 'he' });
  emitCycleEvent('s1', { type: 'chunk', text: 'llo' });
  emitCycleEvent('s1', { type: 'tool_call', id: 't', name: 'read_file', args: {} });
  const late = watchCycleStream('s1', () => {})!;
  emitCycleEvent('s1', { type: 'tool_result', id: 't', content: 'x' });
  assert.deepEqual(late.events, [{ type: 'chunk', text: 'hello' }, { type: 'tool_call', id: 't', name: 'read_file', args: {} }]);
  assert.equal(early.length, 4); // listeners get raw events, the buffer coalesces
});

it('finished stream is gone: watcher gets null', () => {
  beginCycleStream('s2', prompt);
  emitCycleEvent('s2', { type: 'done' });
  assert.equal(watchCycleStream('s2', () => {}), null);
});

it('two watchers, one unwatches', () => {
  beginCycleStream('s3', prompt);
  const a: CycleEvent[] = []; const b: CycleEvent[] = [];
  const wa = watchCycleStream('s3', (e) => a.push(e))!;
  watchCycleStream('s3', (e) => b.push(e));
  wa.unwatch();
  emitCycleEvent('s3', { type: 'chunk', text: 'x' });
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
});
```

`bridge.test.ts`: `parseViewToHost({type:'watchCycle', agentId:'a', sessionId:'../x'})` → `null`; valid ids → the typed message; `unwatchCycle` likewise.

Add to `task_cycle.test.ts`: after `close({ outcome: 'aborted' })` a watcher attached before close received `{ type: 'done' }` last.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `cycle_events.ts`, the recorder emits, the bridge types/parser, the server handlers.
- [ ] **Step 4: Run tests, expect PASS**; typecheck cli + webview-ui.
- [ ] **Step 5: Commit** `feat(tasks): live cycle stream over the web socket`.

---

### Task 6: Shared chat state and the task timeline mapper

**Files:**
- Create: `packages/webview-ui/src/chat_state.ts` (moved from `App.tsx`: item interfaces, `ChatItem`, `PendingConfirm`, `State`, `Action`, `closeStreamingAssistant`, `reconstructChatItems`, `reducer` → exported as `chatReducer`, plus `initialChatState`)
- Create: `packages/webview-ui/src/task_timeline.ts` (moved `taskMessagesToChatItems` from `ProjectsTab.tsx`, extended)
- Modify: `packages/webview-ui/src/App.tsx` (import from `chat_state.ts`; re-export the item types so `MessageList`'s `import type { ChatItem } from './App.js'` keeps working)
- Modify: `packages/webview-ui/src/MessageList.tsx` (render `CycleItem`)
- Test: `packages/webview-ui/src/chat_state.test.ts`, `packages/webview-ui/src/task_timeline.test.ts`

**Interfaces:**
- Produces:
  - `chatReducer(state: State, action: Action): State`, `initialChatState: State` — behaviour identical to today's `reducer`, plus two additions:
    - the `load-history` action gains `streaming?: boolean`; when true the resulting `status` is `'streaming'` (a cycle opened mid-run), else `'idle'` as today;
    - `reconstructChatItems` maps a message with `recap: true` to `{ kind: 'notice', text: <content>, variant: 'system' }` instead of an assistant bubble.
  - `interface CycleItem { kind: 'cycle'; sessionId: string; agentId: string; role: 'developer' | 'planner' | 'reviewer'; outcome: string; label?: string; createdAt: string }`, added to the `ChatItem` union.
  - `taskMessagesToChatItems(msgs, labels)` maps `messageType === 'cycle'` to a `CycleItem` (role from `cycleRole`, `agentId` from `sessionAgentId`), everything else as today.
  - `MessageList` prop `onOpenCycle?: (item: CycleItem) => void`; a `CycleItem` renders as a card (role · label · outcome · time; `running` pulses with the existing `agent-status-dot--pulsing`), clickable when `onOpenCycle` is set.

- [ ] **Step 1: Write the failing tests**

```ts
// task_timeline.test.ts
it('maps a mixed legacy + cycle thread in order without throwing', () => {
  const items = taskMessagesToChatItems([
    m({ messageType: 'heartbeat', content: 'old text' }),
    m({ messageType: 'tool_call', content: 'read_file {"path":"a"}' }),
    m({ messageType: 'cycle', sessionId: 's', sessionAgentId: 'a', cycleRole: 'developer', cycleOutcome: 'running' }),
    m({ messageType: 'chat', role: 'assistant', content: 'handoff' }),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['assistant', 'tool', 'cycle', 'assistant']);
});

// chat_state.test.ts
it('tool call closes the streaming assistant span', () => {
  let s = chatReducer(initialChatState, { kind: 'append-chunk', text: 'a' });
  s = chatReducer(s, { kind: 'tool-call', id: 't', name: 'x', args: {} });
  s = chatReducer(s, { kind: 'append-chunk', text: 'b' });
  assert.deepEqual(s.items.map((i) => i.kind), ['assistant', 'tool', 'assistant']);
  assert.equal((s.items[0] as any).streaming, false);
});

it('load-history: recap becomes a notice, streaming flag sets status', () => {
  const s = chatReducer(initialChatState, {
    kind: 'load-history',
    streaming: true,
    messages: [
      { id: '1', role: 'user', content: 'p', createdAt: '' },
      { id: '2', role: 'assistant', content: 'R', recap: true, createdAt: '' },
    ],
  });
  assert.equal(s.status, 'streaming');
  assert.deepEqual(s.items.at(-1), { kind: 'notice', text: 'R', variant: 'system' });
});
```

- [ ] **Step 2: Run, expect FAIL** (`pnpm -F webview-ui test`).
- [ ] **Step 3: Implement** the moves (no behaviour change for the chat) and the `CycleItem` card.
- [ ] **Step 4: Run** `pnpm -F webview-ui test` → PASS; `pnpm -F webview-ui exec tsc --noEmit -p .`; `pnpm -F webview-ui build`.
- [ ] **Step 5: Commit** `refactor(webview-ui): shared chat state; task timeline maps cycle cards`.

---

### Task 7: Cycle viewer, task composer, docs

**Files:**
- Create: `packages/webview-ui/src/TaskCycleView.tsx`
- Modify: `packages/webview-ui/src/ProjectsTab.tsx` (`TaskLogView`, props, send handler)
- Modify: `packages/webview-ui/src/Composer.tsx` (`allowAttachments`)
- Modify: `packages/webview-ui/src/App.tsx` (pass `postMessage` to `ProjectsTab`)
- Modify: `CLAUDE.md`, `README.md`, `.changeset/task-cycle-sessions.md`

**Interfaces:**
- Consumes: `chatReducer`/`initialChatState` (Task 6), `CycleItem` + `onOpenCycle` (Task 6), `watchCycle`/`unwatchCycle`/`cycleLoaded`/`cycleEvent` (Task 5).
- Produces:
  - `ComposerProps.allowAttachments?: boolean` (default `true`; `false` hides the attach control and never passes attachments).
  - `TaskCycleView({ item, postMessage, onBack }: { item: CycleItem; postMessage: (m: ViewToHost) => void; onBack: () => void })` — on mount posts `watchCycle`, on unmount `unwatchCycle`; listens to window `message` events filtered by `sessionId`; `cycleLoaded` → `load-history` with `streaming: running`; each `cycleEvent` maps 1:1 to `append-chunk` / `append-thinking` / `tool-call` / `tool-result` / `done` / `error`. Renders a header (role · label · outcome, back button) and `MessageList` (not compact) with `isStreaming` from state.
  - `ProjectsTab` prop `postMessage`; `TaskLogView` holds `openCycle: CycleItem | null`. Opening a task whose last `cycle` message has outcome `running` sets it automatically (once per task open). The thread uses `MessageList compact` with `onOpenCycle`.
  - Task composer: `<Composer disabled={isSending} canAbort={isActiveLike} onAbort={() => onToggleStatus(task)} onSend={(text) => onSend(text)} contextUsage={null} allowAttachments={false} />` in both thread and cycle view; `TaskLogView.onSend` becomes `(text: string) => void` (the old form/textarea and `composerText` state go away).

- [ ] **Step 1: Implement** the components above.
- [ ] **Step 2: Verify manually** with an isolated home (`CARETAKER_HOME=<scratch>/ct pnpm -F @hyperwindmill/caretaker-cli dev web -p 3917`) and a configured provider: create a project + task, activate, open the task while the cycle runs → lands on the live cycle; text and tool blocks interleave and stream; back → timeline shows the card and the handoff; Pause mid-cycle → card `aborted`, fallback handoff visible; reopen the finished cycle → loads from disk with the recap notice. Screenshot each with Playwright.
- [ ] **Step 3: Run** `pnpm test`, cli typecheck, webview `tsc`, `pnpm build` → all green.
- [ ] **Step 4: Docs.** `CLAUDE.md`: layer 5 (task heartbeat — cycle sessions, handoff-only history, `cycle` messages, live stream web-only), layer 5 memory sweep (task sessions → recap only, `meta.projectId` scope), State on disk (session meta fields, `recap`, `TaskMessages.messageType` `cycle`, delete cascade), layer 7 (shared `chat_state.ts`, cycle viewer, compact timeline). `README.md`: the task view paragraph, if it describes the thread. Expand the changeset to list: cycle sessions, live view, handoff-only context (existing tasks included), memory sweep recap, hidden from chat lists.
- [ ] **Step 5: Commit** `feat(webview-ui): live cycle viewer and task composer` (stage docs + changeset).
