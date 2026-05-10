import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { multieditTool } from './multiedit.js';

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test('multiedit: applies a sequence of edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-m-'));
  await writeFile(join(dir, 'doc.txt'), 'alpha beta gamma');
  const out = await multieditTool.execute(
    {
      path: 'doc.txt',
      edits: [
        { oldString: 'alpha', newString: 'AAA' },
        { oldString: 'gamma', newString: 'GGG' },
      ],
    },
    ctx(dir),
  );
  assert.match(out.content, /Applied 2 edits/);
  assert.equal(await readFile(join(dir, 'doc.txt'), 'utf-8'), 'AAA beta GGG');
});

test('multiedit: is atomic — failure leaves the file unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-m-'));
  const path = join(dir, 'doc.txt');
  await writeFile(path, 'alpha beta gamma');
  const out = await multieditTool.execute(
    {
      path: 'doc.txt',
      edits: [
        { oldString: 'alpha', newString: 'AAA' },
        { oldString: 'DOES_NOT_EXIST', newString: 'X' },
      ],
    },
    ctx(dir),
  );
  assert.match(out.content, /EOLDSTRING_NOT_FOUND/);
  // File unchanged because the second edit failed.
  assert.equal(await readFile(path, 'utf-8'), 'alpha beta gamma');
});

test('multiedit: rejects empty edits array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-m-'));
  await writeFile(join(dir, 'doc.txt'), 'x');
  const out = await multieditTool.execute({ path: 'doc.txt', edits: [] }, ctx(dir));
  assert.match(out.content, /edits must be a non-empty array/);
});
