import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fetchPath, validatePathInput } from './path.js';

test('validatePathInput rejects relative paths', () => {
  assert.throws(() => validatePathInput('./relative'), /absolute/i);
  assert.throws(() => validatePathInput('relative/path'), /absolute/i);
});

test('validatePathInput accepts absolute paths', () => {
  assert.doesNotThrow(() => validatePathInput('/abs/path'));
});

test('fetchPath returns root and null sha for an existing directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-path-'));
  try {
    const result = await fetchPath(dir);
    assert.equal(result.root, dir);
    assert.equal(result.sha, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchPath throws when directory does not exist', async () => {
  await assert.rejects(fetchPath('/nonexistent/path/xyz/123'), /not found|ENOENT/i);
});

test('fetchPath throws when path is a file, not a directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-path-'));
  const file = path.join(dir, 'somefile');
  writeFileSync(file, 'x');
  try {
    await assert.rejects(fetchPath(file), /not a directory/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
