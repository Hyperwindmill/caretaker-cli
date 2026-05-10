import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContextFiles, formatContextBlock, resolveFileReferences } from './context_files.js';

test('loadContextFiles: walks up, finds AGENTS.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-cf-'));
  await mkdir(join(root, 'deep', 'nested'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'ROOT INSTRUCTIONS');
  const entries = await loadContextFiles(join(root, 'deep', 'nested'));
  const paths = entries.map((e) => e.path);
  // Should include the AGENTS.md from the upper dir.
  assert.ok(
    paths.some((p) => p.endsWith('AGENTS.md')),
    `expected AGENTS.md, got ${paths.join(', ')}`,
  );
  await rm(root, { recursive: true, force: true });
});

test('loadContextFiles: skips files larger than PER_FILE_MAX', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-cf-'));
  // 200 KB file (over 100 KB cap)
  await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(200 * 1024));
  const entries = await loadContextFiles(root);
  assert.equal(
    entries.filter((e) => e.path.endsWith('AGENTS.md') && e.path.startsWith(root)).length,
    0,
  );
  await rm(root, { recursive: true, force: true });
});

test('formatContextBlock: empty input returns empty string', () => {
  assert.equal(formatContextBlock([]), '');
});

test('formatContextBlock: includes path header per entry', () => {
  const out = formatContextBlock([
    { path: '/tmp/foo/AGENTS.md', content: 'rule one' },
    { path: '/tmp/bar/CLAUDE.md', content: 'rule two' },
  ]);
  assert.match(out, /\/tmp\/foo\/AGENTS\.md/);
  assert.match(out, /\/tmp\/bar\/CLAUDE\.md/);
  assert.match(out, /rule one/);
  assert.match(out, /rule two/);
});

test('resolveFileReferences: relative @<file> is inlined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-rf-'));
  await writeFile(join(root, 'snippet.md'), 'INLINED CONTENT');
  const out = await resolveFileReferences('Read this: @./snippet.md please', root);
  assert.match(out, /<context-file path="[^"]*snippet\.md">/);
  assert.match(out, /INLINED CONTENT/);
  await rm(root, { recursive: true, force: true });
});

test('resolveFileReferences: missing file produces a placeholder comment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-rf-'));
  const out = await resolveFileReferences('Reference: @./missing.md', root);
  assert.match(out, /<!--.*missing.*-->/);
  await rm(root, { recursive: true, force: true });
});

test('resolveFileReferences: absolute @<file> works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-rf-'));
  const abs = join(root, 'abs.md');
  await writeFile(abs, 'ABSOLUTE');
  const out = await resolveFileReferences(`See @${abs}`, '/some/other/dir');
  assert.match(out, /ABSOLUTE/);
  await rm(root, { recursive: true, force: true });
});

test('resolveFileReferences: single pass, no recursive expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-rf-'));
  await writeFile(join(root, 'outer.md'), 'outer with @./inner.md ref');
  await writeFile(join(root, 'inner.md'), 'inner content');
  const out = await resolveFileReferences('@./outer.md', root);
  assert.match(
    out,
    /outer with @\.\/inner\.md ref/,
    'the @./inner.md inside outer.md must NOT be expanded',
  );
  await rm(root, { recursive: true, force: true });
});
