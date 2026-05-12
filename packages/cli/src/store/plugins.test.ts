import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store reads CARETAKER_HOME at import time, so we have to set it before
// importing the module under test. Each test resets the file but the dir
// path stays stable for the suite.
let testHome: string;

describe('plugins store', () => {
  let store: typeof import('./json.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-plugins-test-'));
    process.env.CARETAKER_HOME = testHome;
    store = await import('./json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    // Drop the file between tests so each starts from "first ever load".
    await rm(store.pluginsPath(), { force: true });
  });

  it('returns the default empty file when plugins.json does not exist', async () => {
    const file = await store.loadPlugins();
    assert.deepEqual(file, { sources: [], plugins: [] });
  });

  it('save then load round-trips', async () => {
    const file = {
      sources: [
        {
          id: 's1',
          kind: 'git' as const,
          url: 'https://example.com/repo.git',
          ref: 'main',
          authToken: null,
          refreshOnStart: true,
          lastFetchedAt: '2026-05-09T10:00:00Z',
          lastFetchError: null,
          lastFetchSha: 'abc123',
        },
      ],
      plugins: [
        {
          id: 'p1',
          sourceId: 's1',
          name: 'my-skill',
          description: 'demo',
          manifestKind: 'skill-glob' as const,
          relPath: 'my-skill',
          rawManifest: { frontmatter: {}, file: 'my-skill/SKILL.md' },
        },
      ],
    };
    await store.savePlugins(file);
    const loaded = await store.loadPlugins();
    assert.deepEqual(loaded, file);
  });

  it('write enforces 0600 perms on plugins.json (auth tokens are sensitive)', async () => {
    await store.savePlugins({ sources: [], plugins: [] });
    const st = await stat(store.pluginsPath());
    // Mask the perm bits; on most systems the executable bit is irrelevant for files.
    assert.equal(st.mode & 0o777, 0o600);
  });

  it('recovers from a hand-edited file with missing arrays', async () => {
    // Simulate a user accidentally removing one of the keys; loader fills in [].
    await chmod(testHome, 0o700).catch(() => {});
    await writeFile(store.pluginsPath(), JSON.stringify({ sources: null }), 'utf8');
    const loaded = await store.loadPlugins();
    assert.deepEqual(loaded, { sources: [], plugins: [] });
  });

  it('does not silently merge existing rows on save (overwrite semantics)', async () => {
    await store.savePlugins({
      sources: [{ id: 's1', kind: 'path', url: '/tmp/abc', refreshOnStart: false }],
      plugins: [],
    });
    await store.savePlugins({ sources: [], plugins: [] });
    const raw = JSON.parse(await readFile(store.pluginsPath(), 'utf8'));
    assert.deepEqual(raw, { sources: [], plugins: [] });
  });
});
