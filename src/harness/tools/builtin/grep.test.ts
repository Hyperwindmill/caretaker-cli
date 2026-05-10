import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { grepTool } from './grep.js';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test('grep: finds matches across files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-gr-'));
  await writeFile(join(dir, 'a.txt'), 'alpha\nbeta\ngamma');
  await writeFile(join(dir, 'b.txt'), 'delta\nbeta\nepsilon');
  const out = await grepTool.execute({ pattern: 'beta' }, ctx(dir));
  const lines = out.content.split('\n').sort();
  assert.deepEqual(lines, ['a.txt:2:beta', 'b.txt:2:beta']);
});

test('grep: type filter narrows by extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-gr-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'code.ts'), 'needle here');
  await writeFile(join(dir, 'src', 'doc.md'), 'needle here');
  const out = await grepTool.execute({ pattern: 'needle', type: 'ts' }, ctx(dir));
  assert.match(out.content, /^src\/code\.ts:1:needle here$/);
  assert.doesNotMatch(out.content, /\.md/);
});

test('grep: invalid regex returns error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-gr-'));
  await writeFile(join(dir, 'a.txt'), 'x');
  const out = await grepTool.execute({ pattern: '(unclosed' }, ctx(dir));
  assert.match(out.content, /Error: invalid regex/);
});

test('grep: skips binary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-gr-'));
  await writeFile(join(dir, 'ok.txt'), 'needle');
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 0, 0, 0xff, 0, 0, 0]));
  const out = await grepTool.execute({ pattern: 'needle' }, ctx(dir));
  assert.match(out.content, /^ok\.txt:1:needle$/);
});
