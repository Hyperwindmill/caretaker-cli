import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPhase,
  toBcp47,
  stripMarkdownForSpeech,
  takeFinalizedBubbles,
  END_OF_TURN_MS,
  IDLE_WINDOW_MS,
  POST_PLAYBACK_MS,
  voiceSignature,
  type SpokenItem,
} from './voice_utils.js';

test('mic click starts recording from idle', () => {
  assert.equal(nextPhase('idle', { kind: 'micClick', mode: 'dictate' }), 'recording');
  assert.equal(nextPhase('idle', { kind: 'micClick', mode: 'conversation' }), 'recording');
});

test('dictation ends the turn on user click, not on VAD', () => {
  assert.equal(nextPhase('recording', { kind: 'micClick', mode: 'dictate' }), 'transcribing');
  // The VAD does not run in dictation; if an event leaks through it must not cut the turn.
  assert.equal(nextPhase('recording', { kind: 'speechEnded', mode: 'dictate' }), 'recording');
});

test('conversation ends the turn on VAD speech-end', () => {
  assert.equal(nextPhase('recording', { kind: 'speechEnded', mode: 'conversation' }), 'transcribing');
});

test('conversation returns to idle when nothing is spoken in the idle window', () => {
  assert.equal(nextPhase('recording', { kind: 'idleWindowElapsed', mode: 'conversation' }), 'idle');
});

test('user click always discards back to idle', () => {
  assert.equal(nextPhase('recording', { kind: 'userStop', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('awaiting', { kind: 'userStop', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('speaking', { kind: 'userStop', mode: 'conversation' }), 'idle');
});

test('dictation returns to idle after a successful transcription', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'dictate', empty: false }),
    'idle',
  );
});

test('conversation sends and awaits after a non-empty transcription', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'conversation', empty: false }),
    'awaiting',
  );
});

test('conversation keeps the mic alive when the transcription is empty', () => {
  assert.equal(
    nextPhase('transcribing', { kind: 'transcribed', mode: 'conversation', empty: true }),
    'recording',
  );
});

test('any error returns to idle', () => {
  assert.equal(nextPhase('transcribing', { kind: 'failed', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('awaiting', { kind: 'failed', mode: 'conversation' }), 'idle');
  assert.equal(nextPhase('speaking', { kind: 'failed', mode: 'conversation' }), 'idle');
});

// --- The three invariants from the spec. Each maps to a concrete failure. ---

test('INVARIANT 1: playback finishing is what reopens the mic — only when the turn is over', () => {
  // Turn over → mic reopens.
  assert.equal(
    nextPhase('speaking', { kind: 'playbackEnded', mode: 'conversation', turnComplete: true }),
    'recording',
  );
  // Turn still going (queue drained mid-turn) → back to awaiting, NOT recording.
  assert.equal(
    nextPhase('speaking', { kind: 'playbackEnded', mode: 'conversation', turnComplete: false }),
    'awaiting',
  );
  // The harness turn completing must NOT reopen the mic — that is what makes the
  // agent transcribe itself. From 'speaking' a turnFinished event is inert.
  assert.equal(
    nextPhase('speaking', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: false, pendingSpeech: 0 }),
    'speaking',
  );
});

test('INVARIANT 2: a pending confirmation holds the loop in awaiting', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: true, pendingSpeech: 0 }),
    'awaiting',
  );
});

test('INVARIANT 3: awaiting will not advance until streaming has been observed', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: false, confirmPending: false, pendingSpeech: 0 }),
    'awaiting',
  );
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: false, pendingSpeech: 0 }),
    'speaking',
  );
});

test('without a synthesis model the loop skips speaking and relistens', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: false, turnComplete: true, sawStreaming: true, confirmPending: false, pendingSpeech: 0 }),
    'recording',
  );
});

// --- speechQueued: a finalized bubble closed mid-turn drives awaiting → speaking. ---

test('speechQueued drives awaiting to speaking when a TTS model is configured', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'speechQueued', mode: 'conversation', canSpeak: true }),
    'speaking',
  );
});

test('speechQueued is inert without a synthesis model', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'speechQueued', mode: 'conversation', canSpeak: false }),
    'awaiting',
  );
});

test('pending speech drives awaiting to speaking regardless of turnComplete', () => {
  // A bubble closed in the same commit as the turn ending must not be lost to
  // effect ordering. pendingSpeech > 0 wins even if turnComplete is false.
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: false, sawStreaming: true, confirmPending: false, pendingSpeech: 1 }),
    'speaking',
  );
  // With nothing pending, the existing guards apply (here: turn not over → stay).
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: false, sawStreaming: true, confirmPending: false, pendingSpeech: 0 }),
    'awaiting',
  );
});

// --- Helpers ---

test('toBcp47 passes through a full tag and expands a bare code', () => {
  assert.equal(toBcp47('it-IT', 'en-US'), 'it-IT');
  assert.equal(toBcp47('it', 'en-US'), 'it-IT');
  assert.equal(toBcp47('en', 'en-US'), 'en-EN');
  assert.equal(toBcp47(undefined, 'it-IT'), 'it-IT');
  assert.equal(toBcp47('', 'it-IT'), 'it-IT');
});

test('stripMarkdownForSpeech removes syntax that should not be pronounced', () => {
  assert.equal(stripMarkdownForSpeech('**bold** and _italic_'), 'bold and italic');
  assert.equal(stripMarkdownForSpeech('# Heading\n\ntext'), 'Heading\n\ntext');
  assert.equal(stripMarkdownForSpeech('see [the docs](https://example.com)'), 'see the docs');
  assert.equal(stripMarkdownForSpeech('run `npm test` now'), 'run npm test now');
  assert.equal(stripMarkdownForSpeech('a\n```js\ncode()\n```\nb'), 'a\nb');
  assert.equal(stripMarkdownForSpeech('- one\n- two'), 'one\ntwo');
});

// --- takeFinalizedBubbles: speak every finalized assistant bubble, in order. ---

test('takeFinalizedBubbles returns every finalized assistant bubble in order', () => {
  // A turn with two tool calls renders three assistant bubbles. The old
  // lastSpokenText would return only 'third reply'. The cursor starts at 0
  // (set at send time to items.length, here 0 for a fresh list).
  const items: SpokenItem[] = [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'first reply', streaming: false },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool' },
    { kind: 'assistant', text: 'second reply', streaming: false },
    { kind: 'tool' },
    { kind: 'assistant', text: 'third reply', streaming: false },
  ];
  const { texts, cursor } = takeFinalizedBubbles(items, 0);
  assert.deepEqual(texts, ['first reply', 'second reply', 'third reply']);
  assert.equal(cursor, items.length);
});

test('takeFinalizedBubbles stops at a still-streaming last item', () => {
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'done', streaming: false },
    { kind: 'assistant', text: 'partial', streaming: true },
  ];
  const { texts, cursor } = takeFinalizedBubbles(items, 0);
  assert.deepEqual(texts, ['done']);
  assert.equal(cursor, 1); // stops before the open item
});

test('takeFinalizedBubbles includes a non-last item with streaming: true (orphan)', () => {
  // append-thinking can push a thinking item without closing the assistant
  // span, leaving a bubble with streaming: true behind. A non-last bubble is
  // frozen by construction (append-chunk only appends to the last item), so it
  // is included regardless of the stale streaming flag.
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'orphaned', streaming: true },
    { kind: 'thinking', text: 'hmm' },
  ];
  const { texts, cursor } = takeFinalizedBubbles(items, 0);
  assert.deepEqual(texts, ['orphaned']);
  assert.equal(cursor, items.length);
});

test('takeFinalizedBubbles skips blank/whitespace bubbles and non-assistant items', () => {
  const items: SpokenItem[] = [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: '   ', streaming: false },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool' },
    { kind: 'assistant', text: 'real reply', streaming: false },
  ];
  const { texts, cursor } = takeFinalizedBubbles(items, 0);
  assert.deepEqual(texts, ['real reply']);
  assert.equal(cursor, items.length); // non-assistant items advance the cursor
});

test('takeFinalizedBubbles is idempotent: a second call yields nothing new', () => {
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'one', streaming: false },
    { kind: 'assistant', text: 'two', streaming: false },
  ];
  const first = takeFinalizedBubbles(items, 0);
  const second = takeFinalizedBubbles(items, first.cursor);
  assert.deepEqual(second.texts, []);
  assert.equal(second.cursor, first.cursor);
});

test('takeFinalizedBubbles clamps an out-of-range cursor', () => {
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'one', streaming: false },
  ];
  const { texts, cursor } = takeFinalizedBubbles(items, 99);
  assert.deepEqual(texts, []);
  assert.equal(cursor, 1);
});

test('takeFinalizedBubbles handles an empty list', () => {
  const { texts, cursor } = takeFinalizedBubbles([], 0);
  assert.deepEqual(texts, []);
  assert.equal(cursor, 0);
});

test('timing constants match the spec', () => {
  assert.equal(END_OF_TURN_MS, 1200);
  assert.equal(IDLE_WINDOW_MS, 10_000);
  assert.equal(POST_PLAYBACK_MS, 250);
});

// --- Regression: the off-by-one that read the previous reply, one turn late. ---
// The reducer sets status 'streaming' in the same batch as the send, so reaching
// 'awaiting' says nothing about the turn being over. Advancing there speaks the
// last COMPLETED assistant item — the previous turn's answer, and nothing at all
// on the first turn. Reported after the same bug appeared in sp1next.

test('REGRESSION: awaiting does not advance while the turn is still streaming', () => {
  assert.equal(
    nextPhase('awaiting', {
      kind: 'turnFinished',
      mode: 'conversation',
      canSpeak: true,
      turnComplete: false, // status === 'streaming'
      sawStreaming: true, // already true: set in the same batch as the send
      confirmPending: false,
      pendingSpeech: 0,
    }),
    'awaiting',
  );
});

test('REGRESSION: awaiting advances only once the turn is complete', () => {
  assert.equal(
    nextPhase('awaiting', {
      kind: 'turnFinished',
      mode: 'conversation',
      canSpeak: true,
      turnComplete: true,
      sawStreaming: true,
      confirmPending: false,
      pendingSpeech: 0,
    }),
    'speaking',
  );
});

test('REGRESSION: turnComplete does not override the other awaiting guards', () => {
  const base = { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, pendingSpeech: 0 } as const;
  // A pending confirmation still holds the loop.
  assert.equal(nextPhase('awaiting', { ...base, sawStreaming: true, confirmPending: true }), 'awaiting');
  // Never having streamed still holds it.
  assert.equal(nextPhase('awaiting', { ...base, sawStreaming: false, confirmPending: false }), 'awaiting');
});

test('voiceSignature ignores the api key so an encrypted round-trip still matches', () => {
  const typed = { enabled: true, endpoint: 'http://x/v1', sttModel: 'w', apiKey: 'sk-plaintext' };
  const fromDisk = { enabled: true, endpoint: 'http://x/v1', sttModel: 'w', apiKey: 'enc:blob' };
  assert.equal(voiceSignature(typed), voiceSignature(fromDisk));
});

test('voiceSignature distinguishes every field that is actually persisted', () => {
  const base = { enabled: true, endpoint: 'http://x/v1', sttModel: 'w' };
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, enabled: false }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, endpoint: 'http://y/v1' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, sttModel: 'w2' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsModel: 'k' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsEndpoint: 'http://tts/v1' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsVoice: 'if_sara' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsSpeed: 1.5 }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, lang: 'it-IT' }));
  // Omitted at first: the checkbox is the one field a user can change alone, so
  // leaving it out made "Saved ✓" appear instantly without any round-trip.
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, autoStartBackend: true }));
  assert.equal(voiceSignature(undefined), '');
});
