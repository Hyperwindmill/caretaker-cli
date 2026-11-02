import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope isolation: dataDir() reads CARETAKER_HOME at call time.
process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-tgwindow-'));

const {
  HOLD_MS,
  WARM_MS,
  MAX_ENTRIES,
  MAX_IMAGES,
  decideFlush,
  isAtCapacity,
  noTextLine,
  buildMergedPrompt,
  telegramSessionId,
} = await import('./telegram_window.js');

type Entry = Parameters<typeof isAtCapacity>[0]['entries'][number];

function entry(over: Partial<Entry> = {}): Entry {
  return { updateId: 1, fromLabel: '@ada', attachments: [], ...over };
}

function chat(over: Partial<Parameters<typeof decideFlush>[0]> = {}) {
  return {
    chatId: 7,
    chatLabel: 'Lab',
    chatType: 'group',
    entries: [],
    firstAt: 1_000_000,
    ...over,
  };
}

const image = { mime: 'image/png', id: 'abc.png' };

test('decideFlush returns flush when any entry has text', () => {
  const c = chat({ entries: [entry({ attachments: [image] }), entry({ text: 'guarda' })] });
  assert.equal(decideFlush(c, c.firstAt), 'flush');
});

test('decideFlush holds an attachment-only buffer in a cold chat', () => {
  const c = chat({ entries: [entry({ attachments: [image] })] });
  assert.equal(decideFlush(c, c.firstAt), 'hold');
});

test('decideFlush flushes an attachment-only buffer once HOLD_MS elapsed', () => {
  const c = chat({ entries: [entry({ attachments: [image] })] });
  assert.equal(decideFlush(c, c.firstAt + HOLD_MS), 'flush');
});

test('decideFlush flushes an attachment-only buffer in a warm chat', () => {
  const c = chat({ entries: [entry({ attachments: [image] })], lastFlushAt: 1_000_000 });
  assert.equal(decideFlush(c, c.lastFlushAt! + 1000), 'flush');
});

test('decideFlush holds an attachment-only buffer once the chat goes cold', () => {
  const c = chat({ entries: [entry({ attachments: [image] })], lastFlushAt: 1_000_000 });
  assert.equal(decideFlush(c, c.lastFlushAt! + WARM_MS), 'hold');
});

test('decideFlush returns idle for an empty buffer', () => {
  assert.equal(decideFlush(chat(), 9_999_999), 'idle');
});

test('isAtCapacity is true at MAX_ENTRIES entries', () => {
  const entries = Array.from({ length: MAX_ENTRIES }, () => entry({ text: 'x' }));
  assert.equal(isAtCapacity(chat({ entries })), true);
  assert.equal(isAtCapacity(chat({ entries: entries.slice(0, -1) })), false);
});

test('isAtCapacity is true at MAX_IMAGES attachments spread over entries', () => {
  const entries = Array.from({ length: MAX_IMAGES }, () => entry({ attachments: [image] }));
  assert.equal(isAtCapacity(chat({ entries })), true);
  assert.equal(isAtCapacity(chat({ entries: entries.slice(0, -1) })), false);
});

test('noTextLine is singular for one image and plural above', () => {
  assert.match(noTextLine(1), /un'immagine/);
  assert.match(noTextLine(3), /3 immagini/);
});

test('buildMergedPrompt reproduces the legacy format for one text entry', () => {
  const c = chat({ entries: [entry({ text: 'ciao' })] });
  assert.equal(buildMergedPrompt(c, false), 'From: @ada\n\nciao');
});

test('buildMergedPrompt includes the Chat block on a new session', () => {
  const c = chat({ entries: [entry({ text: 'ciao' })] });
  assert.equal(buildMergedPrompt(c, true), 'From: @ada\nChat: Lab (id: 7, type: group)\n\nciao');
});

test('buildMergedPrompt joins several entries from one sender under one header', () => {
  const c = chat({ entries: [entry({ text: 'uno' }), entry({ text: 'due' })] });
  assert.equal(buildMergedPrompt(c, false), 'From: @ada\n\nuno\n\ndue');
});

test('buildMergedPrompt uses noTextLine when no entry has text', () => {
  const c = chat({ entries: [entry({ attachments: [image] }), entry({ attachments: [image] })] });
  assert.equal(buildMergedPrompt(c, false), `From: @ada\n\n${noTextLine(2)}`);
});

test('buildMergedPrompt gives each entry its own From line when senders differ', () => {
  const c = chat({
    entries: [entry({ text: 'uno' }), entry({ fromLabel: '@bob', text: 'due' })],
  });
  assert.equal(buildMergedPrompt(c, false), 'From: @ada\n\nuno\n\nFrom: @bob\n\ndue');
});

test('telegramSessionId is the stable telegram_<chatId> form', () => {
  assert.equal(telegramSessionId(7), 'telegram_7');
  assert.equal(telegramSessionId(-100123), 'telegram_-100123');
});
