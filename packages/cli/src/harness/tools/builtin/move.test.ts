import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { moveTool } from './move.js';

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

test('move: renames a file into a new directory and carries the read mark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  await writeFile(join(dir, 'a.txt'), 'hello');
  const c = ctx(dir);
  c.readPaths.add(resolve(dir, 'a.txt'));
  const out = await moveTool.execute({ from: 'a.txt', to: 'sub/b.txt' }, c);
  assert.equal(out.content, 'Moved a.txt to sub/b.txt');
  assert.equal(await exists(join(dir, 'a.txt')), false);
  assert.equal(await readFile(join(dir, 'sub', 'b.txt'), 'utf-8'), 'hello');
  assert.equal(c.readPaths.has(resolve(dir, 'a.txt')), false);
  assert.equal(c.readPaths.has(resolve(dir, 'sub', 'b.txt')), true);
});

test('move: renames a directory with its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  await mkdir(join(dir, 'old'));
  await writeFile(join(dir, 'old', 'f.txt'), 'x');
  const out = await moveTool.execute({ from: 'old', to: 'new' }, ctx(dir));
  assert.equal(out.content, 'Moved old to new');
  assert.equal(await readFile(join(dir, 'new', 'f.txt'), 'utf-8'), 'x');
});

test('move: never overwrites an existing destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  await writeFile(join(dir, 'a.txt'), 'src');
  await writeFile(join(dir, 'b.txt'), 'dst');
  const out = await moveTool.execute({ from: 'a.txt', to: 'b.txt' }, ctx(dir));
  assert.match(out.content, /^Error: b\.txt already exists/);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf-8'), 'src');
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf-8'), 'dst');
});

test('move: refuses either path outside the working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  await writeFile(join(dir, 'a.txt'), 'x');
  const out1 = await moveTool.execute({ from: 'a.txt', to: '../out.txt' }, ctx(dir));
  assert.match(out1.content, /outside the working directory/);
  const out2 = await moveTool.execute({ from: '../x.txt', to: 'b.txt' }, ctx(dir));
  assert.match(out2.content, /outside the working directory/);
  assert.equal(await exists(join(dir, 'a.txt')), true);
});

test('move: refuses to move the working directory itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  const out = await moveTool.execute({ from: '.', to: 'elsewhere' }, ctx(dir));
  assert.match(out.content, /^Error: refusing to move the working directory/);
});

test('move: reports a missing source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mv-'));
  const out = await moveTool.execute({ from: 'nope.txt', to: 'b.txt' }, ctx(dir));
  assert.equal(out.content, 'Error: nope.txt does not exist');
});
