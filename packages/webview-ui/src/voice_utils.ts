/** Where the voice loop is. See the phase machine in the design spec. */
export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'awaiting' | 'speaking';

export type VoiceMode = 'dictate' | 'conversation';

/** 1200 ms of continuous silence after speech ends the turn (conversation only). */
export const END_OF_TURN_MS = 1200;
/** 10 s in `recording` with no speech at all ends the loop. */
export const IDLE_WINDOW_MS = 10_000;
/** Delay after playback before reopening the mic, so reverb tail on speakers
 *  does not open the next turn. */
export const POST_PLAYBACK_MS = 250;

export type VoiceEvent =
  | { kind: 'micClick'; mode: VoiceMode }
  | { kind: 'userStop'; mode: VoiceMode }
  | { kind: 'speechEnded'; mode: VoiceMode }
  | { kind: 'idleWindowElapsed'; mode: VoiceMode }
  | { kind: 'transcribed'; mode: VoiceMode; empty: boolean }
  | {
      kind: 'speechQueued';
      mode: VoiceMode;
      /** A synthesis model is configured. */
      canSpeak: boolean;
    }
  | {
      kind: 'turnFinished';
      mode: VoiceMode;
      /** A synthesis model is configured. */
      canSpeak: boolean;
      /** The harness turn is actually over (`status === 'idle'`). */
      turnComplete: boolean;
      /** `status === 'streaming'` has been observed since the send. */
      sawStreaming: boolean;
      /** A tool confirmation is currently pending. */
      confirmPending: boolean;
      /** Text queued for speech but not yet played. Non-zero drives `awaiting`
       *  to `speaking` regardless of `turnComplete`, so effect ordering can never
       *  lose a bubble that closed in the same commit as the turn ending. */
      pendingSpeech: number;
    }
  | { kind: 'playbackEnded'; mode: VoiceMode; /** The harness turn is actually
      *  over (`status === 'idle'`). When false (queue drained mid-turn) the mic
      *  must NOT reopen — invariant 1: the mic reopens only on playback end
      *  AND turn over. */ turnComplete: boolean }
  | { kind: 'failed'; mode: VoiceMode };

/**
 * The whole loop's decision table. Pure on purpose: this repo has no DOM test
 * harness, so keeping every branch here is what makes the behaviour testable.
 * Unhandled (phase, event) pairs return the phase unchanged — the loop must never
 * advance on an event it does not understand.
 */
export function nextPhase(phase: VoicePhase, event: VoiceEvent): VoicePhase {
  // A user stop is honoured from anywhere.
  if (event.kind === 'userStop') return 'idle';
  // Any failure returns to idle; the caller surfaces the message.
  if (event.kind === 'failed') return 'idle';

  switch (phase) {
    case 'idle':
      return event.kind === 'micClick' ? 'recording' : phase;

    case 'recording':
      // Dictation ends only when the user says so: dictating involves pauses, and
      // an automatic cut mid-pause is the worst way for dictation to fail.
      if (event.mode === 'dictate') {
        return event.kind === 'micClick' ? 'transcribing' : phase;
      }
      if (event.kind === 'speechEnded') return 'transcribing';
      if (event.kind === 'idleWindowElapsed') return 'idle';
      return phase;

    case 'transcribing':
      if (event.kind !== 'transcribed') return phase;
      if (event.mode === 'dictate') return 'idle';
      // Nothing intelligible: keep the mic alive rather than ending the loop.
      return event.empty ? 'recording' : 'awaiting';

    case 'awaiting':
      // A finalized bubble closed mid-turn (before the harness turn is over):
      // speak it now, so the user hears pre-tool-call remarks as they happen.
      // This entry point is independent of the turn-finished path below.
      if (event.kind === 'speechQueued') return event.canSpeak ? 'speaking' : phase;
      if (event.kind !== 'turnFinished') return phase;
      // Text queued but not yet played wins over completion: a bubble closed in
      // the same commit as the turn ending must be spoken, and effect ordering
      // (enqueue vs turnFinished) must not be able to lose it. `turnComplete`
      // is irrelevant while there is something to say.
      if (event.pendingSpeech > 0 && event.canSpeak) return 'speaking';
      // INVARIANT 3: the turn must actually be over. The reducer sets
      // status 'streaming' in the same batch as the send, so "awaiting" alone
      // says nothing about completion — advancing here speaks the *previous*
      // reply (and on the very first turn, nothing at all). This is the
      // off-by-one that shows up as "reads the last message, one turn late".
      if (!event.turnComplete) return phase;
      // Belt to that brace: if a surface ever sends without flipping to
      // 'streaming', completion would read as true immediately.
      if (!event.sawStreaming) return phase;
      // INVARIANT 2: with a confirmation pending the turn never completes; a loop
      // keyed on completion alone would die silently here.
      if (event.confirmPending) return phase;
      return event.canSpeak ? 'speaking' : 'recording';

    case 'speaking':
      // INVARIANT 1: only playback finishing reopens the mic, and only when the
      // harness turn is also over. Reacting to the harness turn completing here
      // is what makes the agent transcribe itself. A queue drained mid-turn
      // (turnComplete false) returns to awaiting, NOT recording — the mic must
      // not open while the agent is still working.
      if (event.kind === 'playbackEnded') return event.turnComplete ? 'recording' : 'awaiting';
      return phase;
  }
}

/** Expand a bare language code to a BCP-47 tag; pass through anything already tagged. */
export function toBcp47(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  if (lang.includes('-')) return lang;
  return `${lang}-${lang.toUpperCase()}`;
}

/** Strip markdown that should not be pronounced. Not a parser — a reader's filter. */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```\n?/g, '')      // fenced code blocks: skip entirely
    .replace(/`([^`]+)`/g, '$1')            // inline code: keep the text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // images: drop
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')// links: keep the label
    .replace(/^#{1,6}\s+/gm, '')            // headings
    .replace(/^\s*[-*+]\s+/gm, '')          // list bullets
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // bold
    .replace(/\*([^*]+)\*/g, '$1')          // italic
    .replace(/_([^_]+)_/g, '$1')            // underscore italic
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Structural subset of App's `ChatItem` — just enough to pick the reply. Declared
 *  here rather than imported so this module stays a leaf. */
export type SpokenItem = { kind: string; text?: string; streaming?: boolean };

/** An assistant bubble can no longer change once it is not the last item
 *  (`append-chunk` only ever appends to the last item) or its span is closed.
 *  This also covers a bubble orphaned with `streaming: true` by a thinking item
 *  pushed without closing the assistant span: non-last ⇒ frozen. */
function isFinal(items: readonly SpokenItem[], i: number): boolean {
  return i < items.length - 1 || items[i].streaming !== true;
}

/** Assistant texts that are safe to speak, from `cursor` on, plus the new
 *  cursor (stops at the first item still open). `thinking`, `tool`, `user` and
 *  `notice` items are skipped for text but still advance the cursor — a closed
 *  bubble stays closed regardless of what follows it. Replaces `lastSpokenText`,
 *  which returned only the last completed reply and dropped everything the
 *  agent said before its first tool call. */
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

/** Fields of a saved voice config that a settings round-trip can be compared on.
 *  `apiKey` is deliberately excluded: it comes back from disk encrypted, so
 *  including it would make a save with a freshly typed key never look confirmed. */
export function voiceSignature(v: Record<string, unknown> | undefined | null): string {
  if (!v) return '';
  return JSON.stringify([
    v.enabled === true,
    v.endpoint ?? '',
    v.sttModel ?? '',
    v.ttsModel ?? '',
    v.ttsVoice ?? '',
    v.ttsSpeed ?? '',
    v.lang ?? '',
    v.autoStartBackend === true,
  ]);
}
