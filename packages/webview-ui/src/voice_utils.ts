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
      kind: 'turnFinished';
      mode: VoiceMode;
      /** A synthesis model is configured. */
      canSpeak: boolean;
      /** `status === 'streaming'` has been observed since the send. */
      sawStreaming: boolean;
      /** A tool confirmation is currently pending. */
      confirmPending: boolean;
    }
  | { kind: 'playbackEnded'; mode: VoiceMode }
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
      if (event.kind !== 'turnFinished') return phase;
      // INVARIANT 3: `status` is still 'idle' between onSend and the socket
      // round-trip, so advancing without having seen 'streaming' would speak the
      // *previous* reply.
      if (!event.sawStreaming) return phase;
      // INVARIANT 2: with a confirmation pending the turn never completes; a loop
      // keyed on completion alone would die silently here.
      if (event.confirmPending) return phase;
      return event.canSpeak ? 'speaking' : 'recording';

    case 'speaking':
      // INVARIANT 1: only playback finishing reopens the mic. Reacting to the
      // harness turn completing here is what makes the agent transcribe itself.
      return event.kind === 'playbackEnded' ? 'recording' : phase;
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

/** The text to speak: the last completed assistant reply. `thinking` and `tool` are
 *  separate item kinds, so they are excluded by construction. */
export function lastSpokenText(items: readonly SpokenItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'assistant') continue;
    if (item.streaming) continue;
    const text = (item.text ?? '').trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
