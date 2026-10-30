import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTool } from './delete.js';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

test('delete: removes a file and forgets it was read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  const file = join(dir, 'a.txt');
  await writeFile(file, 'x');
  const c = ctx(dir);
  c.readPaths.add(resolve(file));
  const out = await deleteTool.execute({ path: 'a.txt' }, c);
  assert.equal(out.content, 'Deleted file a.txt');
  assert.equal(await exists(file), false);
  assert.equal(c.readPaths.has(resolve(file)), false);
});

test('delete: removes an empty directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  await mkdir(join(dir, 'empty'));
  const out = await deleteTool.execute({ path: 'empty' }, ctx(dir));
  assert.equal(out.content, 'Deleted empty directory empty');
  assert.equal(await exists(join(dir, 'empty')), false);
});

test('delete: refuses a non-empty directory and leaves it intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  await mkdir(join(dir, 'full'));
  await writeFile(join(dir, 'full', 'keep.txt'), 'x');
  const out = await deleteTool.execute({ path: 'full' }, ctx(dir));
  assert.match(out.content, /^Error: directory full is not empty/);
  assert.equal(await exists(join(dir, 'full', 'keep.txt')), true);
});

test('delete: refuses the working directory itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  const out = await deleteTool.execute({ path: '.' }, ctx(dir));
  assert.match(out.content, /^Error: refusing to delete the working directory/);
  assert.equal(await exists(dir), true);
});

test('delete: refuses paths outside the working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  const out = await deleteTool.execute({ path: '../elsewhere.txt' }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test('delete: reports a missing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-del-'));
  const out = await deleteTool.execute({ path: 'nope.txt' }, ctx(dir));
  assert.equal(out.content, 'Error: nope.txt does not exist');
});
