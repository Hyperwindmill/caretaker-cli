import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import { readAttachmentTool } from './read_attachment.js';
import { __setDocumentParsers, type DocumentParsers } from './read_document.js';

function ctx(sessionId: string) {
  return {
    signal: new AbortController().signal,
    workingDir: tmpdir(),
    readPaths: new Set<string>(),
    sessionId,
  };
}

afterEach(() => {
  __setDocumentParsers(null);
});

test('read_attachment: missing id argument returns error', async () => {
  const out = await readAttachmentTool.execute({}, ctx('sess-1'));
  assert.match(out.content, /Error: id must be/);
});

test('read_attachment: missing sessionId returns error', async () => {
  const out = await readAttachmentTool.execute({ id: 'some.pdf' }, {
    signal: new AbortController().signal,
    workingDir: tmpdir(),
    readPaths: new Set(),
  });
  assert.match(out.content, /Error: no active session context/);
});

test('read_attachment: ENOENT surfaces file-not-found error', async () => {
  const oldHome = process.env.CARETAKER_HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'ct-att-'));
  process.env.CARETAKER_HOME = tempHome;

  try {
    const out = await readAttachmentTool.execute({ id: 'missing.pdf' }, ctx('sess-1'));
    assert.match(out.content, /Error: attachment not found/);
  } finally {
    process.env.CARETAKER_HOME = oldHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('read_attachment: routes PDF to document parser and records read path', async () => {
  const oldHome = process.env.CARETAKER_HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'ct-att-'));
  process.env.CARETAKER_HOME = tempHome;

  try {
    const sessionId = 'sess-123';
    const attachmentId = 'test-id.pdf';
    const attDir = join(tempHome, 'attachments', sessionId);
    fs.mkdirSync(attDir, { recursive: true });
    
    const filePath = join(attDir, attachmentId);
    await writeFile(filePath, 'fake pdf data');

    let extractPdfCalled = false;
    const mockParsers: Partial<DocumentParsers> = {
      async extractPdf(buffer) {
        extractPdfCalled = true;
        assert.equal(buffer.toString(), 'fake pdf data');
        return 'Parsed PDF Content';
      },
    };
    __setDocumentParsers(mockParsers as DocumentParsers);

    const c = ctx(sessionId);
    const out = await readAttachmentTool.execute({ id: attachmentId }, c);
    assert.ok(extractPdfCalled);
    assert.equal(out.content, 'Parsed PDF Content');
    assert.ok(c.readPaths.has(filePath));
  } finally {
    process.env.CARETAKER_HOME = oldHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('read_attachment: routes image attachment', async () => {
  const oldHome = process.env.CARETAKER_HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'ct-att-'));
  process.env.CARETAKER_HOME = tempHome;

  try {
    const sessionId = 'sess-123';
    const attachmentId = 'photo.png';
    const attDir = join(tempHome, 'attachments', sessionId);
    fs.mkdirSync(attDir, { recursive: true });
    
    const filePath = join(attDir, attachmentId);
    await writeFile(filePath, 'fake image data');

    const c = ctx(sessionId);
    const out = await readAttachmentTool.execute({ id: attachmentId }, c);
    assert.match(out.content, /Loaded image attachment photo.png/);
    assert.equal(out.attachments?.length, 1);
    assert.equal(out.attachments[0].mime, 'image/png');
    assert.equal(out.attachments[0].data.toString(), 'fake image data');
    assert.ok(c.readPaths.has(filePath));
  } finally {
    process.env.CARETAKER_HOME = oldHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('read_attachment: reads text file directly', async () => {
  const oldHome = process.env.CARETAKER_HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'ct-att-'));
  process.env.CARETAKER_HOME = tempHome;

  try {
    const sessionId = 'sess-123';
    const attachmentId = 'report.txt';
    const attDir = join(tempHome, 'attachments', sessionId);
    fs.mkdirSync(attDir, { recursive: true });
    
    const filePath = join(attDir, attachmentId);
    await writeFile(filePath, 'Hello world text attachment');

    const c = ctx(sessionId);
    const out = await readAttachmentTool.execute({ id: attachmentId }, c);
    assert.equal(out.content, 'Hello world text attachment');
  } finally {
    process.env.CARETAKER_HOME = oldHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});
