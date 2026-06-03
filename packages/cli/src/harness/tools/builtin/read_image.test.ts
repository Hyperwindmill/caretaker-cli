import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readImageTool } from './read_image.js';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test('read_image: sandbox rejects outside workingDir path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'ct-ri-other-'));
  await writeFile(join(elsewhere, 'secret.png'), 'secret');
  const out = await readImageTool.execute({ path: join(elsewhere, 'secret.png') }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test("read_image: '..' traversal is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const out = await readImageTool.execute({ path: '../escape.png' }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test('read_image: missing path argument returns error', async () => {
  const out = await readImageTool.execute({}, ctx(tmpdir()));
  assert.match(out.content, /Error: path must be/);
});

test('read_image: ENOENT surfaces file-not-found error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const out = await readImageTool.execute({ path: 'missing.png' }, ctx(dir));
  assert.match(out.content, /Error: file not found/);
});

test('read_image: directory path returns directory error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const out = await readImageTool.execute({ path: '.' }, ctx(dir));
  assert.match(out.content, /Error: path is a directory/);
});

test('read_image: successfully reads PNG image and populates attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const filePath = join(dir, 'test.png');
  const fakeData = Buffer.from('fake png bytes');
  await writeFile(filePath, fakeData);

  const c = ctx(dir);
  const out = await readImageTool.execute({ path: 'test.png' }, c);
  assert.match(out.content, /Loaded image test.png/);
  assert.ok(out.attachments);
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].mime, 'image/png');
  assert.equal(out.attachments[0].data.toString(), 'fake png bytes');
  assert.ok(c.readPaths.has(filePath));
});

test('read_image: successfully reads JPEG image and populates attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const filePath = join(dir, 'test.jpg');
  const fakeData = Buffer.from('fake jpeg bytes');
  await writeFile(filePath, fakeData);

  const out = await readImageTool.execute({ path: 'test.jpg' }, ctx(dir));
  assert.match(out.content, /Loaded image/);
  assert.ok(out.attachments);
  assert.equal(out.attachments[0].mime, 'image/jpeg');
});

test('read_image: rejects unsupported format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ri-'));
  const filePath = join(dir, 'test.txt');
  await writeFile(filePath, 'some text');

  const out = await readImageTool.execute({ path: 'test.txt' }, ctx(dir));
  assert.match(out.content, /Error: unsupported image extension/);
});
