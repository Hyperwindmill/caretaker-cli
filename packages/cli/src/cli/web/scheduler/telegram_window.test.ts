import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
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
  pendingStatePath,
  loadPendingState,
  savePendingState,
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

test('isAtCapacity is true at MAX_ENTRIES entries, whatever arrives', () => {
  const entries = Array.from({ length: MAX_ENTRIES }, () => entry({ text: 'x' }));
  assert.equal(isAtCapacity(chat({ entries }), false), true);
  assert.equal(isAtCapacity(chat({ entries }), true), true);
  assert.equal(isAtCapacity(chat({ entries: entries.slice(0, -1) }), false), false);
});

test('isAtCapacity stops an incoming image at MAX_IMAGES but still lets text in', () => {
  // The image cap must not refuse the very message that would flush the
  // window — a question typed under a full album is the common case.
  const entries = Array.from({ length: MAX_IMAGES }, () => entry({ attachments: [image] }));
  assert.equal(isAtCapacity(chat({ entries }), true), true);
  assert.equal(isAtCapacity(chat({ entries }), false), false);
  assert.equal(isAtCapacity(chat({ entries: entries.slice(0, -1) }), true), false);
});

test('MAX_IMAGES covers a full Telegram album', () => {
  assert.ok(MAX_IMAGES >= 10, 'a media group holds up to 10 items');
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

// --- persistence (Task 2) ---
// Declaration order matters: the scheduler-logs test below asserts the
// directory is still absent, so no earlier test may write to disk.

test('loadPendingState returns empty state when no file exists', async () => {
  assert.deepEqual(await loadPendingState('task_none'), { v: 1, chats: {} });
});

test('savePendingState creates scheduler-logs when missing', async () => {
  assert.equal(existsSync(join(process.env.CARETAKER_HOME!, 'scheduler-logs')), false);
  await savePendingState('task_mkdir', { v: 1, chats: {} });
  assert.equal(existsSync(join(process.env.CARETAKER_HOME!, 'scheduler-logs')), true);
});

test('savePendingState round-trips a buffered chat', async () => {
  const state = {
    v: 1 as const,
    chats: {
      '7': chat({ entries: [entry({ text: 'ciao', attachments: [image] })], lastFlushAt: 42 }),
    },
  };
  await savePendingState('task_rt', state);
  assert.deepEqual(await loadPendingState('task_rt'), state);
});

test('loadPendingState returns empty state on corrupt JSON', async () => {
  await mkdir(join(process.env.CARETAKER_HOME!, 'scheduler-logs'), { recursive: true });
  await writeFile(pendingStatePath('task_corrupt'), '{ not json', 'utf8');
  assert.deepEqual(await loadPendingState('task_corrupt'), { v: 1, chats: {} });
});

test('loadPendingState returns empty state on an unknown version', async () => {
  await writeFile(pendingStatePath('task_v2'), JSON.stringify({ v: 2, chats: {} }), 'utf8');
  assert.deepEqual(await loadPendingState('task_v2'), { v: 1, chats: {} });
});

test('loadPendingState drops a malformed chat record and keeps the good ones', async () => {
  // Structurally valid JSON with a broken record used to pass the guard and
  // then throw on chat.entries.length at every tick.
  const good = chat({ entries: [entry({ text: 'ok' })] });
  await writeFile(
    pendingStatePath('task_badchat'),
    JSON.stringify({
      v: 1,
      chats: { '7': good, '8': { chatId: 8, chatLabel: 'x', chatType: 'private', firstAt: 1 } },
    }),
    'utf8',
  );
  const state = await loadPendingState('task_badchat');
  assert.deepEqual(Object.keys(state.chats), ['7']);
  assert.deepEqual(state.chats['7'], good);
});
