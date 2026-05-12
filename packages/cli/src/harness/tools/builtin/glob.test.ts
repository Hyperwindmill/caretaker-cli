import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { globTool } from './glob.js';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), 'ct-g-'));
  await mkdir(join(dir, 'src', 'nested'), { recursive: true });
  await writeFile(join(dir, 'a.ts'), '');
  await writeFile(join(dir, 'b.ts'), '');
  await writeFile(join(dir, 'c.md'), '');
  await writeFile(join(dir, 'src', 'x.ts'), '');
  await writeFile(join(dir, 'src', 'nested', 'y.ts'), '');
  return dir;
}

test('glob: matches a recursive pattern', async () => {
  const dir = await makeTree();
  const out = await globTool.execute({ pattern: '**/*.ts' }, ctx(dir));
  const lines = out.content.split('\n').sort();
  assert.deepEqual(lines, ['a.ts', 'b.ts', 'src/nested/y.ts', 'src/x.ts']);
});

test('glob: scopes to a sub-path', async () => {
  const dir = await makeTree();
  const out = await globTool.execute({ pattern: '**/*.ts', path: 'src' }, ctx(dir));
  const lines = out.content.split('\n').sort();
  assert.deepEqual(lines, ['nested/y.ts', 'x.ts']);
});

test('glob: sub-path outside workingDir is rejected', async () => {
  const dir = await makeTree();
  const out = await globTool.execute({ pattern: '**/*', path: '../escape' }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});
