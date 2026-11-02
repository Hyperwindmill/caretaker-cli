import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope isolation: dataDir() reads CARETAKER_HOME at call time.
process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-tgpoll-'));

const { accumulateAndFlush } = await import('./telegram.js');
const { loadPendingState, HOLD_MS, MAX_ENTRIES } = await import('./telegram_window.js');
const { FileTooLargeError } = await import('./telegram_media.js');

const T0 = 1_700_000_000_000;
let updateSeq = 0;

function text(body: string, chatId = 7) {
  return {
    update_id: ++updateSeq,
    message: {
      message_id: updateSeq,
      date: 1,
      chat: { id: chatId, type: 'private' as const },
      from: { id: 1, first_name: 'Ada', username: 'ada' },
      text: body,
    },
  };
}

function photo(caption?: string, chatId = 7) {
  const m = text(caption ?? '', chatId);
  delete (m.message as any).text;
  (m.message as any).photo = [{ file_id: `f${updateSeq}`, file_size: 100 }];
  if (caption) (m.message as any).caption = caption;
  return m;
}

function bare(chatId = 7) {
  return {
    update_id: ++updateSeq,
    message: { message_id: updateSeq, date: 1, chat: { id: chatId, type: 'group' as const } },
  };
}

function pdf(chatId = 7) {
  const m = text('', chatId);
  delete (m.message as any).text;
  (m.message as any).document = { file_id: 'doc', mime_type: 'application/pdf' };
  return m;
}

interface Recorder {
  runs: any[];
  notices: Array<{ chatId: number; text: string }>;
  downloads: string[];
  deps: any;
}

function recorder(over: { locked?: boolean; now?: number; failDownload?: Error } = {}): Recorder {
  const r: Recorder = { runs: [], notices: [], downloads: [], deps: null };
  r.deps = {
    downloadImage: async (sessionId: string, media: any) => {
      if (over.failDownload) throw over.failDownload;
      r.downloads.push(`${sessionId}:${media.fileId}`);
      return { mime: 'image/jpeg', id: `${media.fileId}.jpg`, name: 'x.jpg' };
    },
    notify: async (chatId: number, t: string) => {
      r.notices.push({ chatId, text: t });
    },
    isLocked: () => over.locked === true,
    runChat: async (chat: any) => {
      r.runs.push(chat);
    },
    now: () => over.now ?? T0,
  };
  return r;
}

const ALL = new Set<string>();

test('a text message flushes on the same tick', async () => {
  const r = recorder();
  await accumulateAndFlush('t_text', [text('ciao')], ALL, r.deps);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].entries.length, 1);
  assert.equal(r.runs[0].entries[0].text, 'ciao');
  assert.deepEqual((await loadPendingState('t_text')).chats['7']!.entries, []);
});

test('two messages in one tick produce a single run with both texts', async () => {
  const r = recorder();
  await accumulateAndFlush('t_two', [text('uno'), text('due')], ALL, r.deps);
  assert.equal(r.runs.length, 1);
  assert.deepEqual(
    r.runs[0].entries.map((e: any) => e.text),
    ['uno', 'due'],
  );
});

test('a photo with no caption is held, then flushes after HOLD_MS', async () => {
  const held = recorder();
  await accumulateAndFlush('t_hold', [photo()], ALL, held.deps);
  assert.equal(held.runs.length, 0);
  assert.equal((await loadPendingState('t_hold')).chats['7']!.entries.length, 1);

  const later = recorder({ now: T0 + HOLD_MS });
  await accumulateAndFlush('t_hold', [], ALL, later.deps);
  assert.equal(later.runs.length, 1);
  assert.equal(later.runs[0].entries[0].attachments.length, 1);
});

test('an empty tick still flushes an expired buffer', async () => {
  const held = recorder();
  await accumulateAndFlush('t_empty', [photo()], ALL, held.deps);
  assert.equal(held.runs.length, 0);

  const later = recorder({ now: T0 + HOLD_MS + 1 });
  await accumulateAndFlush('t_empty', [], ALL, later.deps);
  assert.equal(later.runs.length, 1);
});

test('a photo arriving in a warm chat flushes on the next tick', async () => {
  const first = recorder();
  await accumulateAndFlush('t_warm', [text('guarda questo')], ALL, first.deps);
  assert.equal(first.runs.length, 1);

  const second = recorder({ now: T0 + 2000 });
  await accumulateAndFlush('t_warm', [photo()], ALL, second.deps);
  assert.equal(second.runs.length, 1);
  assert.equal(second.runs[0].entries[0].attachments.length, 1);
});

test('a photo then a text in the same tick produce one run carrying the image', async () => {
  const r = recorder();
  await accumulateAndFlush('t_mix', [photo(), text('che ne pensi?')], ALL, r.deps);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].entries.length, 2);
  assert.equal(r.runs[0].entries.flatMap((e: any) => e.attachments).length, 1);
});

test('three photos in one tick produce one run carrying three images', async () => {
  const r = recorder();
  await accumulateAndFlush('t_group', [photo(), photo(), photo('eccole')], ALL, r.deps);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].entries.flatMap((e: any) => e.attachments).length, 3);
});

test('a photo from an unauthorized chat downloads nothing and replies nothing', async () => {
  const r = recorder();
  await accumulateAndFlush('t_auth', [photo(undefined, 999)], new Set(['7']), r.deps);
  assert.deepEqual(r.downloads, []);
  assert.deepEqual(r.notices, []);
  assert.equal(r.runs.length, 0);
  assert.deepEqual((await loadPendingState('t_auth')).chats, {});
});

test('a locked chat is not flushed and keeps its entries for the next tick', async () => {
  const locked = recorder({ locked: true });
  await accumulateAndFlush('t_lock', [text('ciao')], ALL, locked.deps);
  assert.equal(locked.runs.length, 0);
  assert.deepEqual(locked.notices, []);
  assert.equal((await loadPendingState('t_lock')).chats['7']!.entries.length, 1);

  const free = recorder();
  await accumulateAndFlush('t_lock', [], ALL, free.deps);
  assert.equal(free.runs.length, 1);
  assert.equal(free.runs[0].entries[0].text, 'ciao');
});

test('an unsupported document notifies the chat and buffers nothing', async () => {
  const r = recorder();
  await accumulateAndFlush('t_pdf', [pdf()], ALL, r.deps);
  assert.equal(r.notices.length, 1);
  assert.equal(r.runs.length, 0);
  assert.deepEqual((await loadPendingState('t_pdf')).chats, {});
});

test('a service message is ignored without a notify', async () => {
  const r = recorder();
  await accumulateAndFlush('t_svc', [bare()], ALL, r.deps);
  assert.deepEqual(r.notices, []);
  assert.equal(r.runs.length, 0);
});

test('a download failure notifies the chat and buffers no entry', async () => {
  const r = recorder({ failDownload: new FileTooLargeError(99_000_000) });
  await accumulateAndFlush('t_big', [photo()], ALL, r.deps);
  assert.equal(r.notices.length, 1);
  assert.equal(r.runs.length, 0);
  assert.equal((await loadPendingState('t_big')).chats['7']?.entries.length ?? 0, 0);
});

test('entries beyond MAX_ENTRIES are refused without losing the buffered ones', async () => {
  const r = recorder({ locked: true });
  const many = Array.from({ length: MAX_ENTRIES + 2 }, (_, i) => text(`m${i}`));
  await accumulateAndFlush('t_cap', many, ALL, r.deps);
  assert.equal((await loadPendingState('t_cap')).chats['7']!.entries.length, MAX_ENTRIES);
  assert.equal(r.notices.length, 2);
});
