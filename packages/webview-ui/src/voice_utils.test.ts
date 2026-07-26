import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPhase,
  toBcp47,
  stripMarkdownForSpeech,
  lastSpokenText,
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

test('INVARIANT 1: playback finishing is what reopens the mic', () => {
  assert.equal(
    nextPhase('speaking', { kind: 'playbackEnded', mode: 'conversation' }),
    'recording',
  );
  // The harness turn completing must NOT reopen the mic — that is what makes the
  // agent transcribe itself. From 'speaking' a turnFinished event is inert.
  assert.equal(
    nextPhase('speaking', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: false }),
    'speaking',
  );
});

test('INVARIANT 2: a pending confirmation holds the loop in awaiting', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: true }),
    'awaiting',
  );
});

test('INVARIANT 3: awaiting will not advance until streaming has been observed', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: false, confirmPending: false }),
    'awaiting',
  );
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true, sawStreaming: true, confirmPending: false }),
    'speaking',
  );
});

test('without a synthesis model the loop skips speaking and relistens', () => {
  assert.equal(
    nextPhase('awaiting', { kind: 'turnFinished', mode: 'conversation', canSpeak: false, turnComplete: true, sawStreaming: true, confirmPending: false }),
    'recording',
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

test('lastSpokenText picks the last completed assistant text', () => {
  const items: SpokenItem[] = [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'first reply', streaming: false },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool' },
    { kind: 'assistant', text: 'second reply', streaming: false },
  ];
  assert.equal(lastSpokenText(items), 'second reply');
});

test('lastSpokenText ignores a still-streaming assistant item', () => {
  const items: SpokenItem[] = [
    { kind: 'assistant', text: 'done', streaming: false },
    { kind: 'assistant', text: 'partial', streaming: true },
  ];
  assert.equal(lastSpokenText(items), 'done');
});

test('lastSpokenText returns null when there is nothing to say', () => {
  assert.equal(lastSpokenText([]), null);
  assert.equal(lastSpokenText([{ kind: 'user', text: 'hi' }]), null);
  assert.equal(lastSpokenText([{ kind: 'assistant', text: '   ', streaming: false }]), null);
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
    }),
    'speaking',
  );
});

test('REGRESSION: turnComplete does not override the other awaiting guards', () => {
  const base = { kind: 'turnFinished', mode: 'conversation', canSpeak: true, turnComplete: true } as const;
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
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsVoice: 'if_sara' }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, ttsSpeed: 1.5 }));
  assert.notEqual(voiceSignature(base), voiceSignature({ ...base, lang: 'it-IT' }));
  assert.equal(voiceSignature(undefined), '');
});
