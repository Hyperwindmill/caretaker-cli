# Task cycles as sessions

Date: 2026-10-24
Status: draft — awaiting approval

## Goal

Every autonomous task cycle — developer, planner, and the DONE review — becomes
an ordinary chat session. Opening a cycle in the task view is opening a chat:
same loader, same reducer, same `MessageList`, live while it runs. The task
itself becomes a timeline of cycles plus the human/plan/review messages, and
agents stop receiving full cycle transcripts as history — they get the handoff
notes, which they already write.

## Why (current state)

- **Unreadable thread.** A cycle stores all its text in one `heartbeat_live`
  message created at cycle start (chunks of every turn concatenated), and each
  tool call as a separate `tool_call` message after it. The view shows one big
  text block on top and the tool chips below, with no interleaving. Thinking
  and tool results are not stored (`onThinking`/`onToolResult` are not wired).
- **Not live.** The live message is flushed to the DB every 2.5 s and the view
  re-fetches the whole thread every 3 s.
- **Heavy, duplicated context.** History replay is every `chat`, `heartbeat`,
  `tool_call`, `review`, `plan` message of the task — every transcript of every
  cycle — and `task_get_state` returns the last 20 raw messages on top of it.
- **The handoff already exists.** The developer prompt mandates a closing
  `task_add_message` with a detailed summary (stored as an assistant `chat`
  message); `task_yield(notes)`, `task_block(reason)`, `task_complete(summary)`
  and `task_submit_plan(plan)` carry the rest.

## Design

### 1. A cycle writes a session

`SessionMetaRecord` gains three optional fields: `taskId`, `projectId`,
`taskRole: 'developer' | 'planner' | 'reviewer'`. The cycle runner
(`task_strategy.ts` for developer/planner, `task_review.ts` for review):

1. `createSession({ agentId, title: '<taskId> · <role>', taskId, projectId, taskRole })`
   under the resolved agent, i.e. `sessions/<agentId>/` like any chat.
2. Appends the cycle prompt as the first user message — opening a cycle shows
   exactly what the agent was told.
3. Appends every record the run emits through `onMessage` (assistant turns with
   text/thinking/tool_use parts, tool results). All three runners already emit
   it (native loop, `claude_code_runner.ts`, `acp_runner.ts`).
4. At cycle end, appends the **recap record** (§4).

`sessionId` is **not** passed into `harness.run`: persistence is the caller's
job via `onMessage`, and passing it would make claude-code look for a
`--resume` id and keep the ACP child pooled for 10 minutes per cycle. Each
cycle stays a fresh conversation, as today.

`listForAgent` skips sessions whose meta has `taskId`, so cycle sessions never
appear in the chat lists (web, VSCode, TUI all go through it). Task deletion
(`DELETE /api/tasks/:id`, `task_delete`) also deletes the task's cycle
sessions; archive leaves them.

### 2. The task becomes a timeline

New `messageType: 'cycle'` on `TaskMessage`, with fields `sessionId`,
`sessionAgentId`, `cycleRole`, `cycleOutcome`. Written at cycle start
(`cycleOutcome: 'running'`), updated at the end to one of `handoff` (yielded /
stopped with a note), `completed`, `blocked`, `plan`, `review-pass`,
`review-changes`, `aborted` (Pause or wall-clock), `failed`. It replaces
`heartbeat_live` / `heartbeat` / `tool_call` for new cycles; those types stay
readable for existing tasks (no migration).

`system`, `block`, `plan`, `review` and human `chat` messages are unchanged.

**Legacy cycles are shown raw, not converted.** A legacy cycle stored its text
as one blob and its tool calls as separate name+args records — the
interleaving, the tool results and the thinking were never persisted, so a
converted session would show the same mess in a new container. There is no
separate detection step: the renderer dispatches on `messageType`, so
`heartbeat` / `heartbeat_live` / `tool_call` go through today's
`taskMessagesToChatItems` path (compact), `cycle` becomes a card. A task that
spans the upgrade shows its legacy messages followed by cycle cards, in
chronological order. Required test: a mixed legacy + `cycle` message list maps
without throwing and in order.

### 3. Agent context = handoffs, not transcripts

- History replay keeps `chat`, `review`, `plan` and drops `heartbeat`,
  `tool_call` and `cycle` — for legacy tasks too (one rule; their cycles also
  wrote `task_add_message` handoffs).
- `task_get_state.recentMessages` applies the same filter.
- **Missing handoff fallback**: if a developer/planner cycle ends without
  creating any assistant `chat` message (aborted, turn limit, agent forgot),
  the host adds one: `Cycle ended without a handoff note (<outcome>). Last
  output: <last assistant text, capped 2000 chars>`.
- The prompt wording stays; "your only memory is in the task messages" becomes
  literally true.

### 4. Memory sweep reads cycle recaps only

`MessageRecord` gains optional `recap?: true`. At cycle end the host appends
one assistant record with `recap: true` whose content is the handoff produced
during the cycle: the `task_add_message` notes, yield/block/complete notes, the
submitted plan, or the review text (plus the fallback of §3 when present).
Built from task messages, so it is runner-independent.

In `sweepMemory`, for sessions with `meta.taskId`:
- only `recap` records are fed to the model (tool output and retries never
  reach it);
- `minNewMessages` is bypassed (one recap per session — the debounce would
  never fire);
- project scope comes from `meta.projectId` instead of the `workingDir` prefix
  match (worktrees never match it).

The cycle viewer renders the recap as a closing notice.

### 5. Live channel (web server only)

New `scheduler/cycle_events.ts`: an in-process emitter keyed by `sessionId`
carrying the chat's own `HostToView` events — `chunk`, `thinking`,
`tool_call`, `tool_result`, `done`, `error`. The cycle runner wires the
matching harness callbacks into it.

WebSocket: view→host `watchCycle { agentId, sessionId }` / `unwatchCycle`;
host→view `cycleLoaded { sessionId, messages }` (from disk, same mapping as
`sessionLoaded`) and `cycleEvent { sessionId, event }`. Tagged by `sessionId`
so they never mix with the chat's own stream on the same socket.

**Opening a cycle mid-run** is the delicate part: disk holds the completed
records; the in-flight turn lives only in events. The emitter keeps, per
running session, the events since the last persisted assistant record and
replays them right after `cycleLoaded`. Required test: for a recorded event
sequence, subscribing at any point yields the same final `ChatItem[]` as
watching from the start.

### 6. UI

- The chat reducer moves out of `App.tsx` into `chat_state.ts`; App and the
  cycle viewer share it.
- Task view = timeline. Legacy messages render as today
  (`taskMessagesToChatItems`, compact). `cycle` messages render as cards: role,
  agent label, outcome, time, handoff excerpt; a running card pulses.
- Clicking a card opens the cycle full-pane: `MessageList` (not compact) fed
  by the reducer from `cycleLoaded` + `cycleEvent`, with a back button. Opening
  a task whose cycle is running lands directly on that cycle — like opening a
  chat.
- Composer: the shared `Composer` in both views, with a task variant — stays
  enabled while a cycle runs (messages queue for the next cycle, as today),
  Stop = Pause, no attachments, no voice. Sending posts to the task
  (`POST /api/tasks/:id/messages`, unchanged).
- `ProjectsTab` gets a `watchCycle` subscription from `App` (it fetches over
  REST today and has no socket).

## Out of scope

- Converting legacy `heartbeat`/`tool_call` messages into sessions (the data to rebuild them was never stored — see §2).
- Voice and attachments in the task composer.
- Replacing the 3 s polling of task list / status / checklist (small payloads;
  the thread itself no longer polls).

## Delivery

Three commits, each with its tests:
1. Server: cycle sessions + meta + `listForAgent` filter + delete cascade,
   `cycle` messages, history/`recentMessages` filter + handoff fallback, recap
   record + sweep filter.
2. Live: `cycle_events.ts`, WS `watchCycle`/`cycleLoaded`/`cycleEvent`, replay
   buffer + equivalence test.
3. UI: `chat_state.ts`, timeline + cycle viewer, composer variant;
   `CLAUDE.md` (layer 5, state on disk, layer 7), README, changeset.
