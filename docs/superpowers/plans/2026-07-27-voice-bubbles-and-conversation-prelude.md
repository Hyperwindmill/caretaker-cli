# Voice: speak every finalized bubble + conversation prelude — Implementation Plan

> **For agentic workers:** use superpowers:executing-plans (or
> subagent-driven-development) and work task-by-task. Steps are checkboxes.

**Goal:** In conversation mode, speak **every** finalized assistant bubble in
order as it closes (today only the last one is spoken), and tell the agent it is
in a spoken conversation so it writes speakable, well-punctuated prose.

**Spec:** `docs/superpowers/specs/2026-07-27-voice-bubbles-and-conversation-prelude-design.md`

**Tech stack:** TypeScript ESM, React (webview-ui), Hono (cli web), Node
built-in test runner via tsx, pnpm workspaces, Changesets.

## Global constraints

- Pure logic goes in `voice_utils.ts` with tests; React components/hooks are not
  unit-tested (no DOM harness) — that split is the existing convention.
- Invariant 1 stays: the mic reopens **only** on playback ending, and now only
  when the harness turn is also over.
- Do not touch `closeStreamingAssistant` or the chat reducer.
- `pnpm -F webview-ui test`, `pnpm -F @hyperwindmill/caretaker-cli test`,
  `pnpm -F @hyperwindmill/caretaker-cli typecheck` must all pass
  (`pnpm test` does not type-check — run typecheck explicitly).
- Conventional commits, no AI attribution. Commit per task.
- One changeset (`minor`) at the end; `CLAUDE.md` + `README.md` in the same unit.

---

### Task 1 — `voice_utils.ts`: finality selector + phase-machine events

**Files:** modify `packages/webview-ui/src/voice_utils.ts`,
`packages/webview-ui/src/voice_utils.test.ts`.

- [ ] **Step 1 — failing tests** in `voice_utils.test.ts`. Replace the
  `lastSpokenText` block (~line 125-149) with `takeFinalizedBubbles` cases 1-5
  from the spec, and add the `nextPhase` cases (6).

- [ ] **Step 2 — implement.** Delete `lastSpokenText` (voice_utils.ts:113-128,
  keep `SpokenItem`) and add:

```ts
/** An assistant bubble can no longer change once it is not the last item
 *  (`append-chunk` only appends to the last one) or its span is closed. This
 *  also covers a bubble orphaned with `streaming: true` by a thinking item. */
function isFinal(items: readonly SpokenItem[], i: number): boolean {
  return i < items.length - 1 || items[i].streaming !== true;
}

/** Assistant texts that are safe to speak, from `cursor` on, plus the new
 *  cursor (stops at the first item still open). */
export function takeFinalizedBubbles(
  items: readonly SpokenItem[],
  cursor: number,
): { texts: string[]; cursor: number } {
  const texts: string[] = [];
  let i = Math.max(0, Math.min(cursor, items.length));
  for (; i < items.length && isFinal(items, i); i += 1) {
    if (items[i].kind !== 'assistant') continue;
    const text = (items[i].text ?? '').trim();
    if (text) texts.push(text);
  }
  return { texts, cursor: i };
}
```

- [ ] **Step 3 — events.** In `VoiceEvent`: add
  `| { kind: 'speechQueued'; mode: VoiceMode; canSpeak: boolean }`, add
  `pendingSpeech: number` to `turnFinished`, and `turnComplete: boolean` to
  `playbackEnded`. In `nextPhase`:
  - `awaiting` + `speechQueued` → `event.canSpeak ? 'speaking' : phase`.
  - `awaiting` + `turnFinished`: **before** the existing guards,
    `if (event.pendingSpeech > 0 && event.canSpeak) return 'speaking'` — with
    text pending, `turnComplete` is irrelevant and effect ordering cannot lose a
    bubble. Then the unchanged `turnComplete` / `sawStreaming` /
    `confirmPending` guards.
  - `speaking` + `playbackEnded` → `event.turnComplete ? 'recording' : 'awaiting'`.
    Comment why: draining mid-turn must not open the mic.

- [ ] **Step 4** — `pnpm -F webview-ui test` green. Commit:
  `feat(webview): select every finalized assistant bubble for speech`.

---

### Task 2 — `useVoice.ts`: cursor + speech queue

**Files:** modify `packages/webview-ui/src/useVoice.ts`. No tests (hook).

- [ ] **Step 1 — refs.** Replace `spokenBaselineRef` (line ~97) with:

```ts
/** Next item index not yet considered for speech. Set at send time, so the
 *  previous turn's reply is unreachable by construction. */
const cursorRef = useRef(0);
const queueRef = useRef<string[]>([]);
```

  Import `takeFinalizedBubbles` instead of `lastSpokenText`.

- [ ] **Step 2 — cursor at send.** In `finishRecording` (~line 160-167), in the
  `currentMode === 'conversation'` branch, replace the baseline line with
  `cursorRef.current = itemsRef.current.length; queueRef.current = [];`
  (the user item lands at that index and is skipped by the selector).

- [ ] **Step 3 — enqueue effect.** Declare it **before** the existing
  `turnFinished` effect (currently ~line 272):

```ts
// Bubbles become speakable as they close, mid-turn. Declared before the
// turnFinished effect so a bubble closed by `done` is queued in the same
// commit that reports the turn over.
useEffect(() => {
  if (modeRef.current !== 'conversation') return;
  if (phaseRef.current === 'idle') return;
  const { texts, cursor } = takeFinalizedBubbles(items, cursorRef.current);
  cursorRef.current = cursor;
  if (texts.length === 0) return;
  queueRef.current.push(...texts);
  apply({ kind: 'speechQueued', mode: 'conversation', canSpeak });
}, [items, canSpeak, apply]);
```

- [ ] **Step 4 — turnFinished / playbackEnded payloads.** Add
  `pendingSpeech: queueRef.current.length` to the `turnFinished` apply
  (~line 278) and `turnComplete` to every `playbackEnded` apply.

- [ ] **Step 5 — drain loop.** Rewrite `speakReply` (~line 230-262) to shift one
  text off `queueRef`, POST it (still through `stripMarkdownForSpeech`), play it,
  and on `onended` — after `POST_PLAYBACK_MS` — recurse if the queue is
  non-empty, otherwise
  `apply({ kind: 'playbackEnded', mode: 'conversation', turnComplete: chatStatusRef.current === 'idle' })`.
  Add a `chatStatusRef` (mirroring the existing latest-value ref pattern)
  because the callback must read the status at playback end, not at creation.
  An empty queue on entry emits `playbackEnded` immediately, as today.
  Keep the `speaking` phase effect firing `void speakReply()` unchanged — the
  chaining is inside the player, so no `speaking → speaking` transition is
  needed.

- [ ] **Step 6 — reset.** In the `phase === 'idle'` branch of the phase effect
  (~line 300), clear `queueRef.current = []` alongside teardown.

- [ ] **Step 7** — `pnpm -F webview-ui build` + typecheck clean. Commit:
  `feat(webview): speak each finalized bubble as it closes`.

---

### Task 3 — voice-conversation prelude, server side

**Files:** modify `packages/cli/src/harness/prelude.ts`,
`packages/cli/src/harness/loop.ts`,
`packages/cli/src/harness/claude_code_runner.ts`,
`packages/cli/src/harness/loop.test.ts`.

- [ ] **Step 1 — failing test** in `loop.test.ts`: with `__setFetch` capturing
  the request body, `run({ ..., voiceConversation: true })` puts
  `<voice-conversation>` in the system message; without the flag it does not
  (spec test 7).

- [ ] **Step 2 — the block.** Export from `prelude.ts` (append at end of file):

```ts
/** Appended per-turn when the turn arrived as speech and the reply will be
 *  read aloud. Per-turn on purpose: the same session mixes typed and spoken
 *  turns. */
export const VOICE_CONVERSATION_PRELUDE = [
  '<voice-conversation>',
  'This message arrived as speech, and your reply will be read aloud by a text-to-speech engine. Write for the ear:',
  '',
  '- Complete, well-punctuated sentences — punctuation is what gives the synthesized voice its rhythm.',
  '- Short and conversational: a couple of sentences per message, no headings, no bullet lists, no tables, no code fences, no emoji, no raw URLs.',
  '- Describe code, paths and long listings instead of dictating them; offer to show them on screen if the user needs the detail.',
  '- Write numbers, units and acronyms the way they should be heard when the written form would be mispronounced.',
  '- Each message of yours is spoken as soon as it is finalized, which happens when you make a tool call. A one-line "let me check that file" before a tool call is heard immediately, so it is worth saying.',
  '</voice-conversation>',
].join('\n');
```

- [ ] **Step 3 — native loop.** `RunOptions` (loop.ts:74-97): add
  `/** The turn came from voice conversation mode; append the spoken-reply
  block to the system prompt. */ voiceConversation?: boolean;`. After the
  runtime block is appended (loop.ts:166), add
  `if (opts.voiceConversation) effectiveSystemPrompt = \`${'${effectiveSystemPrompt}'}\n\n${'${VOICE_CONVERSATION_PRELUDE}'}\`.trim();`
  — last position, strongest recency. Import the const.

- [ ] **Step 4 — claude-code runner.** In `runClaudeCode`
  (claude_code_runner.ts:344-350), add `VOICE_CONVERSATION_PRELUDE` as a third
  `.filter(Boolean)` part when `opts.voiceConversation`.

- [ ] **Step 5** — cli tests + typecheck green. Commit:
  `feat(cli): tell the agent when a turn arrives from voice conversation`.

---

### Task 4 — wire the flag from the renderer

**Files:** modify `packages/webview-ui/src/bridge.ts`,
`packages/webview-ui/src/App.tsx`, `packages/cli/src/cli/web/server.ts`.

- [ ] **Step 1 — contract.** `bridge.ts`: `start` variant (line 124) gains
  `voice?: boolean`; in `parseViewToHost` `case 'start'` (line 157-174) set
  `res.voice = true` only when `value.voice === true` (strict, hostile-webview
  rule — anything else is simply absent, never a parse failure).

- [ ] **Step 2 — App.** `onSend` (App.tsx:430-447) gains a third param
  `voice?: boolean`, forwarded into the `postMessage({ type: 'start', … })`
  when true. In the `useVoice` `onTranscript` callback (line 423-426) call
  `onSend(text, undefined, true)` for `mode === 'conversation'`.

- [ ] **Step 3 — server.** `WebSessionController.start` (server.ts:106-110)
  gains a 4th param `voiceConversation?: boolean`, passed straight into
  `harness.run` (server.ts:152-163). `case 'start'` (server.ts:876-929) forwards
  `msg.voice`.

- [ ] **Step 4** — build both packages, typecheck, full `pnpm test`. Commit:
  `feat(web): flag voice-conversation turns end to end`.

- [ ] **Step 5 — manual smoke** (`CARETAKER_HOME=/tmp/ct pnpm -F @hyperwindmill/caretaker-cli dev web`,
  a voice-configured agent): ask something that forces two tool calls. Expect
  the pre-tool-call remark spoken first, then the later bubbles in order, the
  mic reopening only after the last one, and no self-transcription.

---

### Task 5 — docs + changeset

- [ ] `CLAUDE.md` §6 Voice Mode: renderer-loop bullet → every finalized bubble
  is spoken in order as it closes; state the finality rule (not-last ⇒ frozen)
  and amend invariant 1 (mic reopens on playback end **and** turn over; a queue
  drained mid-turn returns to `awaiting`). Add the per-turn conversation prelude
  to the surface description.
- [ ] `README.md` voice section: conversation mode now reads the agent's whole
  reply, including what it says before tool calls, and the agent is told it is
  being heard.
- [ ] `pnpm changeset` → `minor`, one entry covering the fixed group.
- [ ] Final gate: `pnpm build`, `pnpm test`,
  `pnpm -F @hyperwindmill/caretaker-cli typecheck`. Commit:
  `docs: voice reads every finalized bubble`.
