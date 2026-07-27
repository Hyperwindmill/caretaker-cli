# Voice conversation: speak every finalized bubble + conversation prelude

**Date:** 2026-07-27
**Status:** Approved
**Task:** caretaker task 24 ("Various issues")

## Problem

Two defects in conversation-mode voice, both about the same thing: the spoken
channel is not the same conversation the user sees.

**1. Only the last bubble is spoken.** `lastSpokenText()`
(`packages/webview-ui/src/voice_utils.ts`) walks the item list backwards and
returns the *first* completed `assistant` item it finds — i.e. the last one.
A turn is not one assistant message: `tool-call` closes the streaming assistant
item (`closeStreamingAssistant` in `App.tsx`), so a turn with three tool calls
renders four assistant bubbles. The user reads all four and hears only the last.
Everything the agent said before its first tool call is silently dropped.

Related: an assistant item can be left with `streaming: true` forever.
`append-thinking` pushes a `thinking` item without closing the assistant span,
and `closeStreamingAssistant` only ever inspects the **last** item. Such an
orphan is invisible to any `streaming === false` filter.

**2. The agent doesn't know it is being listened to.** Nothing in the system
prompt says the reply will be read aloud, so the model answers in its normal
register: headings, bullet lists, code fences, bare URLs — all of which
`stripMarkdownForSpeech` can only mangle, never repair. Punctuation is what
drives TTS prosody, and the model has no reason to care about it.

## Decision 1 — speak bubbles as they finalize, in order

Not "concatenate everything at end of turn". The bubble boundary is a real
event: when a bubble closes, the agent has finished saying that thing, and a
tool call is about to run. Speaking it then is what makes a tool-heavy turn
audible instead of a minute of silence followed by a monologue.

### Finality rule

An `assistant` item can no longer change if **it is not the last item in the
list, or its `streaming` flag is false**. `append-chunk` only ever appends to
the last item, so a non-last bubble is frozen by construction — which also
fixes the orphaned-`streaming: true` case above without touching the reducer.

### Pure selector (`voice_utils.ts`)

```ts
/** Bubbles that can no longer change, from `cursor` on. Returns the texts to
 *  speak and the new cursor (stops at the first item still open). */
export function takeFinalizedBubbles(
  items: readonly SpokenItem[],
  cursor: number,
): { texts: string[]; cursor: number }
```

- Advances while the item at `cursor` is final; stops at the first open one.
- Collects trimmed, non-empty `assistant` texts; skips `tool` / `thinking` /
  `user` / `notice` items (they only move the cursor).
- `lastSpokenText()` is **deleted**; the cursor makes it redundant. The
  `spokenBaselineRef` guard ("did this turn add new text?") goes with it: a
  cursor set at send time cannot reach the previous turn's reply, which is the
  same off-by-one invariant 3 was protecting, expressed once instead of twice.

### Queue in `useVoice.ts`

- `cursorRef` — set to `itemsRef.current.length` in `finishRecording`, at the
  moment the transcript is handed to `onTranscript` (conversation mode only).
- `queueRef: string[]` — appended by an effect on `items` that calls
  `takeFinalizedBubbles`. **This effect is declared before the `turnFinished`
  effect**, so within one commit new bubbles are queued first.
- `speakReply` becomes a drain loop: shift one text, POST `/api/voice/speak`,
  play; on `onended` (+ `POST_PLAYBACK_MS`) shift the next if any, and only
  emit `playbackEnded` when the queue is empty. Chaining inside the player
  keeps `speaking → speaking` off the phase machine, where the
  "side effect per phase transition" effect would not re-fire.

### Phase machine changes (`nextPhase`)

- New event `{ kind: 'speechQueued' }`: in `awaiting`, → `speaking` when
  `canSpeak`, otherwise phase unchanged. This is the mid-turn entry point.
- `turnFinished` gains `pendingSpeech: number`. In `awaiting`, a non-zero
  `pendingSpeech` → `speaking` **regardless of `turnComplete`**; that makes the
  behaviour independent of effect ordering. With nothing pending, the existing
  guards are unchanged: `turnComplete`, `sawStreaming`, `confirmPending`.
- `playbackEnded` gains `turnComplete: boolean`. In `speaking`:
  `turnComplete ? 'recording' : 'awaiting'` — the queue drained mid-turn must
  **not** open the mic.

**Invariant 1 survives and is the reason for that last line**: the mic reopens
only from `playbackEnded`, and now only when the turn is also over. Invariants 2
and 3 are unchanged for the mic-reopen path; content selection no longer relies
on them.

## Decision 2 — a voice-conversation system-prompt block

Per-turn, not per-session: the flag rides the `start` message, and the system
prompt is assembled on every run anyway (`harness/loop.ts`), so a voice turn and
a typed turn in the same session each get the right prompt.

- `prelude.ts`: new exported `VOICE_CONVERSATION_PRELUDE` — a
  `<voice-conversation>` block: complete well-punctuated sentences (punctuation
  is the prosody); short and conversational; no headings / bullets / tables /
  code fences / emoji / raw URLs; describe code instead of dictating it; and
  **each finalized message is spoken as it closes, so a one-line "checking that
  file now" before a tool call is heard immediately**. That last line is what
  makes Decision 1 usable rather than merely correct.
- `RunOptions.voiceConversation?: boolean`. In the native loop the block is
  appended **after** the runtime-info block (last position, strongest recency);
  in `claude_code_runner.ts` it joins the `--append-system-prompt` parts.
- Wire: `ViewToHost.start` gains `voice?: boolean` (validated in
  `parseViewToHost`) → `App.onSend(text, attachments, voice)` sets it for
  `mode === 'conversation'` transcripts → `server.ts` `case 'start'` passes it
  to `WebSessionController.start` → `harness.run`.
- The VSCode host needs no change: voice is unavailable in the sidebar, and the
  field is optional, so ignoring it is correct rather than lossy.

## Tests

`packages/webview-ui/src/voice_utils.test.ts` (pure, existing pattern — the
hook itself stays untested, there is no DOM harness):

1. Three bubbles split by `tool` items → all three texts, in order, cursor at
   the end.
2. Last item `streaming: true` → excluded, cursor stops before it.
3. Non-last item with `streaming: true` (the thinking orphan) → included.
4. Blank / whitespace bubbles skipped; `user`/`thinking`/`tool` items skipped
   but still advance the cursor.
5. Second call with the returned cursor yields nothing new (idempotence).
6. `nextPhase`: `awaiting` + `speechQueued` → `speaking` (and unchanged when
   `canSpeak` is false); `awaiting` + `turnFinished` with `pendingSpeech: 1` and
   `turnComplete: false` → `speaking`; `speaking` + `playbackEnded` →
   `recording` when `turnComplete`, `awaiting` when not.

`packages/cli/src/harness/loop.test.ts` (capture the request body via
`__setFetch`):

7. `run({ voiceConversation: true })` → system message contains
   `<voice-conversation>`; without the flag it does not.

Existing `lastSpokenText` tests are removed with the function.

## Docs + versioning

- `CLAUDE.md` §6 Voice Mode: renderer-loop bullet becomes "every finalized
  bubble is spoken, in order, as it closes" with the finality rule and the
  amended invariant 1; note the conversation prelude and that it is per-turn.
- `README.md`: voice section — conversation mode reads the whole reply
  including pre-tool-call remarks, and the agent is told it is being heard.
- Changeset: `minor` (behaviour change + new prompt block), fixed group.

## Out of scope (YAGNI)

- Barge-in / interrupting playback by talking over it.
- Speaking `thinking` or tool results.
- Per-agent or per-session toggle for the prelude — it follows the mode.
- Any change to `closeStreamingAssistant` or the chat reducer: the finality
  rule makes the orphan case moot without touching shared chat rendering.
