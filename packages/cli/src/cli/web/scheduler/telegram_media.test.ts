import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope isolation: dataDir() reads CARETAKER_HOME at call time.
process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-tgmedia-'));

const {
  classifyMessage,
  selectImage,
  messageText,
  senderLabel,
  downloadImage,
  FileTooLargeError,
  MAX_FILE_BYTES,
} = await import('./telegram_media.js');
const { attachmentsDir } = await import('../../../session/store.js');

type Msg = Parameters<typeof classifyMessage>[0];

function msg(over: Partial<Msg> = {}): Msg {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 7, type: 'private' },
    ...over,
  };
}

test('classifyMessage accepts plain text', () => {
  assert.equal(classifyMessage(msg({ text: 'ciao' })), 'content');
});

test('classifyMessage accepts a photo with a caption', () => {
  assert.equal(
    classifyMessage(msg({ photo: [{ file_id: 's' }, { file_id: 'l' }], caption: 'guarda' })),
    'content',
  );
});

test('classifyMessage accepts a photo with no caption', () => {
  assert.equal(classifyMessage(msg({ photo: [{ file_id: 'l' }] })), 'content');
});

test('classifyMessage accepts an image document', () => {
  assert.equal(
    classifyMessage(msg({ document: { file_id: 'd', mime_type: 'image/png' } })),
    'content',
  );
});

test('classifyMessage marks a PDF document unsupported', () => {
  assert.equal(
    classifyMessage(msg({ document: { file_id: 'd', mime_type: 'application/pdf' } })),
    'unsupported',
  );
});

test('classifyMessage marks voice and sticker unsupported', () => {
  assert.equal(classifyMessage(msg({ voice: {} })), 'unsupported');
  assert.equal(classifyMessage(msg({ sticker: {} })), 'unsupported');
});

test('classifyMessage marks a captioned video unsupported, not content', () => {
  // The caption alone would make the agent answer about something it cannot
  // see; telling the user we do not handle video is the honest outcome.
  assert.equal(classifyMessage(msg({ video: {}, caption: 'guarda questo' })), 'unsupported');
});

test('classifyMessage marks a bare service message as service', () => {
  assert.equal(classifyMessage(msg()), 'service');
});

test('selectImage picks the largest photo size', () => {
  const picked = selectImage(
    msg({ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'large', file_size: 900 }] }),
  );
  assert.deepEqual(picked, { fileId: 'large', fileSize: 900 });
});

test('selectImage returns the image document when there is no photo', () => {
  const picked = selectImage(
    msg({ document: { file_id: 'd', mime_type: 'image/webp', file_size: 55 } }),
  );
  assert.deepEqual(picked, { fileId: 'd', fileSize: 55 });
});

test('selectImage returns null for a text-only message', () => {
  assert.equal(selectImage(msg({ text: 'ciao' })), null);
});

test('selectImage returns null for a non-image document', () => {
  assert.equal(selectImage(msg({ document: { file_id: 'd', mime_type: 'application/pdf' } })), null);
});

test('messageText prefers text and falls back to caption', () => {
  assert.equal(messageText(msg({ text: 'uno', caption: 'due' })), 'uno');
  assert.equal(messageText(msg({ caption: 'due' })), 'due');
  assert.equal(messageText(msg({ text: '   ' })), undefined);
  assert.equal(messageText(msg()), undefined);
});

test('senderLabel prefers username over first_name', () => {
  assert.equal(senderLabel(msg({ from: { id: 1, first_name: 'Ada', username: 'ada' } })), '@ada');
  assert.equal(senderLabel(msg({ from: { id: 1, first_name: 'Ada' } })), 'Ada');
  assert.equal(senderLabel(msg()), 'unknown');
});

// --- download (Task 4) ---

/** A fetch stub that answers getFile once, then the file bytes. */
function stubFetch(filePath: string | null, bytes = Buffer.from('PNGDATA')) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    calls.push(String(url));
    if (String(url).includes('/getFile')) {
      return {
        json: async () =>
          filePath === null
            ? { ok: false, description: 'file not found' }
            : { ok: true, result: { file_path: filePath } },
      } as any;
    }
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('downloadImage refuses an oversized file before any request', async () => {
  const fetchImpl = (() => {
    throw new Error('network must not be touched');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      downloadImage('tok', 'telegram_7', { fileId: 'f', fileSize: MAX_FILE_BYTES + 1 }, { fetchImpl }),
    FileTooLargeError,
  );
});

test('downloadImage stores the bytes and returns an attachment record', async () => {
  const { impl, calls } = stubFetch('photos/x.png');
  const rec = await downloadImage('tok', 'telegram_7', { fileId: 'f' }, { fetchImpl: impl });
  assert.equal(rec.mime, 'image/png');
  assert.match(rec.id, /\.png$/);
  assert.equal(existsSync(join(attachmentsDir('telegram_7'), rec.id)), true);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /\/file\/bottok\/photos\/x\.png$/);
});

test('downloadImage falls back to .jpg when file_path has no extension', async () => {
  const { impl } = stubFetch('photos/noext');
  const rec = await downloadImage('tok', 'telegram_7', { fileId: 'f' }, { fetchImpl: impl });
  assert.equal(rec.mime, 'image/jpeg');
  assert.match(rec.id, /\.jpg$/);
});

test('downloadImage propagates a failed getFile', async () => {
  const { impl } = stubFetch(null);
  await assert.rejects(
    () => downloadImage('tok', 'telegram_7', { fileId: 'f' }, { fetchImpl: impl }),
    /file not found/,
  );
});
