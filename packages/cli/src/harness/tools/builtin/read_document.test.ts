import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDocumentTool,
  __setDocumentParsers,
  ensureWritableNavigator,
  type DocumentParsers,
} from './read_document.js';
import { write as writeXlsx, utils as xlsxUtils } from 'xlsx/xlsx.mjs';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

afterEach(() => {
  __setDocumentParsers(null);
});

test('read_document: sandbox rejects outside workingDir path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'ct-rd-other-'));
  await writeFile(join(elsewhere, 'secret.pdf'), 'secret');
  const out = await readDocumentTool.execute({ path: join(elsewhere, 'secret.pdf') }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test("read_document: '..' traversal is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const out = await readDocumentTool.execute({ path: '../escape.docx' }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test('read_document: missing path argument returns error', async () => {
  const out = await readDocumentTool.execute({}, ctx(tmpdir()));
  assert.match(out.content, /Error: path must be/);
});

test('read_document: ENOENT surfaces file-not-found error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const out = await readDocumentTool.execute({ path: 'missing.pdf' }, ctx(dir));
  assert.match(out.content, /Error: file not found/);
});

test('read_document: directory path returns directory error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const out = await readDocumentTool.execute({ path: '.' }, ctx(dir));
  assert.match(out.content, /Error: path is a directory/);
});

test('read_document: routes PDF to mock parser and records path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'test.pdf');
  await writeFile(filePath, 'fake pdf binary data');

  let extractPdfCalled = false;
  const mockParsers: Partial<DocumentParsers> = {
    async extractPdf(buffer) {
      extractPdfCalled = true;
      assert.equal(buffer.toString(), 'fake pdf binary data');
      return 'Parsed PDF Content';
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const c = ctx(dir);
  const out = await readDocumentTool.execute({ path: 'test.pdf' }, c);
  assert.ok(extractPdfCalled);
  assert.equal(out.content, 'Parsed PDF Content');
  assert.ok(c.readPaths.has(resolve(dir, 'test.pdf')));
});

test('read_document: routes DOCX to mock parser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'test.docx');
  await writeFile(filePath, 'fake docx data');

  let extractDocxCalled = false;
  const mockParsers: Partial<DocumentParsers> = {
    async extractDocx(buffer) {
      extractDocxCalled = true;
      assert.equal(buffer.toString(), 'fake docx data');
      return 'Parsed DOCX Content';
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'test.docx' }, ctx(dir));
  assert.ok(extractDocxCalled);
  assert.equal(out.content, 'Parsed DOCX Content');
});

test('read_document: formats XLSX via mock parser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'test.xlsx');
  await writeFile(filePath, 'fake xlsx data');

  let extractXlsxCalled = false;
  const mockParsers: Partial<DocumentParsers> = {
    async extractXlsx(buffer) {
      extractXlsxCalled = true;
      assert.equal(buffer.toString(), 'fake xlsx data');
      return 'Parsed XLSX Content';
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'test.xlsx' }, ctx(dir));
  assert.ok(extractXlsxCalled);
  assert.equal(out.content, 'Parsed XLSX Content');
});

test('read_document: unsupported format triggers pandoc check and fails if not installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'document.epub');
  await writeFile(filePath, 'epub data');

  const mockParsers: Partial<DocumentParsers> = {
    async checkPandoc() {
      return false;
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'document.epub' }, ctx(dir));
  assert.match(out.content, /pandoc is not installed on this system/);
});

test('read_document: unsupported format uses pandoc if installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'document.epub');
  await writeFile(filePath, 'epub data');

  let runPandocCalled = false;
  const mockParsers: Partial<DocumentParsers> = {
    async checkPandoc() {
      return true;
    },
    async runPandoc(fp) {
      runPandocCalled = true;
      assert.equal(fp, filePath);
      return { content: '# epub markdown converted title' };
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'document.epub' }, ctx(dir));
  assert.ok(runPandocCalled);
  assert.equal(out.content, '# epub markdown converted title');
});

test('read_document: performs real XLSX parsing correctly (integrates SheetJS)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'real.xlsx');

  // Create a real worksheet using SheetJS
  const ws = xlsxUtils.aoa_to_sheet([
    ['Header1', 'Header2'],
    ['Cell1A', 'Cell1B'],
    ['Cell2A', 'Cell2B'],
  ]);
  const wb = xlsxUtils.book_new();
  xlsxUtils.book_append_sheet(wb, ws, 'TestSheet');

  // Write workbook to buffer
  const buf = writeXlsx(wb, { type: 'buffer', bookType: 'xlsx' });
  await writeFile(filePath, buf);

  // Restore real parser to execute the SheetJS logic
  __setDocumentParsers(null);

  const out = await readDocumentTool.execute({ path: 'real.xlsx' }, ctx(dir));
  assert.match(out.content, /## Sheet: TestSheet/);
  assert.match(out.content, /\| Header1 \| Header2 \|/);
  assert.match(out.content, /\| Cell1A \| Cell1B \|/);
  assert.match(out.content, /\| Cell2A \| Cell2B \|/);
});

test('read_document: PDF falls back to pdftotext when unpdf fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'tricky.pdf');
  await writeFile(filePath, 'fake pdf');

  let extractPdfCalled = false;
  let runPdftotextCalled = false;

  const mockParsers: Partial<DocumentParsers> = {
    async extractPdf() {
      extractPdfCalled = true;
      throw new Error('unpdf worker failed');
    },
    async runPdftotext(fp) {
      runPdftotextCalled = true;
      assert.equal(fp, filePath);
      return { content: 'PDF text via pdftotext' };
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'tricky.pdf' }, ctx(dir));
  assert.ok(extractPdfCalled, 'unpdf should be tried first');
  assert.ok(runPdftotextCalled, 'pdftotext should be invoked as fallback');
  assert.equal(out.content, 'PDF text via pdftotext');
});

test('read_document: PDF surfaces combined error when both unpdf and pdftotext fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'broken.pdf');
  await writeFile(filePath, 'fake pdf');

  const mockParsers: Partial<DocumentParsers> = {
    async extractPdf() {
      throw new Error('unpdf crashed');
    },
    async runPdftotext() {
      return { content: '', error: 'pdftotext: damaged file' };
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'broken.pdf' }, ctx(dir));
  assert.match(out.content, /unpdf crashed/);
  assert.match(out.content, /pdftotext.*damaged file/);
});

test('read_document: PDF surfaces unpdf error when pdftotext not installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-rd-'));
  const filePath = join(dir, 'no-poppler.pdf');
  await writeFile(filePath, 'fake pdf');

  const mockParsers: Partial<DocumentParsers> = {
    async extractPdf() {
      throw new Error('unpdf original error');
    },
    async runPdftotext() {
      return { content: '', error: 'spawn pdftotext ENOENT', notInstalled: true };
    },
  };
  __setDocumentParsers(mockParsers as DocumentParsers);

  const out = await readDocumentTool.execute({ path: 'no-poppler.pdf' }, ctx(dir));
  assert.match(out.content, /unpdf original error/);
  assert.doesNotMatch(out.content, /pdftotext/);
});

test('ensureWritableNavigator: repairs a getter-only nullish navigator (VSCode extension host)', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { get: () => undefined, configurable: true });
  try {
    ensureWritableNavigator();
    // exactly what unpdf's serverless pdfjs shim executes at import time:
    (globalThis as { navigator?: { platform?: string } }).navigator ??= {};
    (globalThis as { navigator: { platform?: string } }).navigator.platform ??= '';
    assert.equal((globalThis as { navigator: { platform?: string } }).navigator.platform, '');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('ensureWritableNavigator: leaves a real navigator untouched', () => {
  const before = globalThis.navigator;
  ensureWritableNavigator();
  assert.equal(globalThis.navigator, before);
});
