import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginRecord, SkillSpec } from '../types.js';

let testHome: string;

describe('plugin skill loader (per-file granularity)', () => {
  let loader: typeof import('./loader.js');
  let store: typeof import('../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-loader-'));
    process.env.CARETAKER_HOME = testHome;
    loader = await import('./loader.js');
    store = await import('../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  function pluginRecord(
    over: Partial<PluginRecord> & {
      sourceUrl: string;
      name: string;
      relPath?: string;
      skills?: Record<string, SkillSpec>;
    },
  ): { plugin: PluginRecord; sourceId: string } {
    const sourceId = randomUUID();
    const plugin: PluginRecord = {
      id: randomUUID(),
      sourceId,
      name: over.name,
      description: null,
      manifestKind: over.manifestKind ?? 'cc-plugin',
      relPath: over.relPath ?? '.',
      rawManifest: {},
      ...(over.skills ? { skills: over.skills } : {}),
    };
    return { plugin, sourceId };
  }

  async function seedPath(opts: {
    sourceUrl: string;
    name: string;
    relPath?: string;
    manifestKind?: 'skill-glob' | 'cc-plugin' | 'cc-marketplace';
    skills?: Record<string, SkillSpec>;
  }) {
    const { plugin, sourceId } = pluginRecord(opts);
    await store.savePlugins({
      sources: [{ id: sourceId, kind: 'path', url: opts.sourceUrl, refreshOnStart: false }],
      plugins: [plugin],
    });
    return plugin;
  }

  describe('listActiveSkills', () => {
    it('returns empty when activeNames is empty', async () => {
      assert.deepEqual(await loader.listActiveSkills([]), []);
    });

    it('returns empty when no plugin matches', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'real',
          skills: { x: { name: 'x', relPath: 'SKILL.md' } },
        });
        assert.deepEqual(await loader.listActiveSkills(['nonexistent']), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exposes EACH SkillSpec as an entry — N skills per cc-plugin pack', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'superpowers',
          manifestKind: 'cc-plugin',
          skills: {
            brainstorming: {
              name: 'brainstorming',
              description: 'b',
              relPath: 'skills/brainstorming/SKILL.md',
            },
            'requesting-code-review': {
              name: 'requesting-code-review',
              description: 'rcr',
              relPath: 'skills/requesting-code-review/SKILL.md',
            },
          },
        });
        const out = await loader.listActiveSkills(['superpowers']);
        const names = out.map((s) => s.name).sort();
        assert.deepEqual(names, ['brainstorming', 'requesting-code-review']);
        // Plugin name surfaces on each summary entry.
        assert.ok(out.every((s) => s.plugin === 'superpowers'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('first-plugin-wins on collision (mirrors commands)', async () => {
      const dir1 = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      const dir2 = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      try {
        const a = pluginRecord({
          sourceUrl: dir1,
          name: 'alpha',
          skills: { foo: { name: 'foo', description: 'from-alpha', relPath: 'SKILL.md' } },
        });
        const b = pluginRecord({
          sourceUrl: dir2,
          name: 'beta',
          skills: { foo: { name: 'foo', description: 'from-beta', relPath: 'SKILL.md' } },
        });
        await store.savePlugins({
          sources: [
            { id: a.sourceId, kind: 'path', url: dir1, refreshOnStart: false },
            { id: b.sourceId, kind: 'path', url: dir2, refreshOnStart: false },
          ],
          plugins: [a.plugin, b.plugin],
        });
        // alpha first → alpha's foo wins
        const r1 = await loader.listActiveSkills(['alpha', 'beta']);
        assert.equal(r1.length, 1);
        assert.equal(r1[0].description, 'from-alpha');
        // beta first → beta's foo wins
        const r2 = await loader.listActiveSkills(['beta', 'alpha']);
        assert.equal(r2[0].description, 'from-beta');
      } finally {
        rmSync(dir1, { recursive: true, force: true });
        rmSync(dir2, { recursive: true, force: true });
      }
    });
  });

  describe('readActiveSkill', () => {
    it('returns content of one specific SKILL.md by scoped name', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      mkdirSync(path.join(dir, 'skills', 'brainstorming'), { recursive: true });
      mkdirSync(path.join(dir, 'skills', 'rcr'), { recursive: true });
      writeFileSync(path.join(dir, 'skills', 'brainstorming', 'SKILL.md'), 'BRAINSTORM\n');
      writeFileSync(path.join(dir, 'skills', 'rcr', 'SKILL.md'), 'CODE REVIEW\n');
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'superpowers',
          manifestKind: 'cc-plugin',
          skills: {
            brainstorming: {
              name: 'brainstorming',
              relPath: 'skills/brainstorming/SKILL.md',
            },
            rcr: { name: 'rcr', relPath: 'skills/rcr/SKILL.md' },
          },
        });
        assert.equal(
          await loader.readActiveSkill('brainstorming', ['superpowers']),
          'BRAINSTORM\n',
        );
        assert.equal(await loader.readActiveSkill('rcr', ['superpowers']), 'CODE REVIEW\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when the skill is not in any active plugin', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      writeFileSync(path.join(dir, 'SKILL.md'), 'x');
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'p',
          manifestKind: 'skill-glob',
          skills: { p: { name: 'p', relPath: 'SKILL.md' } },
        });
        // Active list does NOT include p — skill is hidden.
        assert.equal(await loader.readActiveSkill('p', []), null);
        assert.equal(await loader.readActiveSkill('p', ['some-other']), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when SKILL.md is missing on disk', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'p',
          skills: { p: { name: 'p', relPath: 'missing/SKILL.md' } },
        });
        assert.equal(await loader.readActiveSkill('p', ['p']), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a SkillSpec.relPath that escapes the plugin root', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'evil',
          skills: { evil: { name: 'evil', relPath: '../../outside' } },
        });
        const origWarn = console.warn;
        console.warn = () => {};
        try {
          assert.equal(await loader.readActiveSkill('evil', ['evil']), null);
        } finally {
          console.warn = origWarn;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when SKILL.md exceeds the size cap', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'plug-loader-'));
      writeFileSync(path.join(dir, 'SKILL.md'), 'x'.repeat(100_001));
      try {
        await seedPath({
          sourceUrl: dir,
          name: 'huge',
          manifestKind: 'skill-glob',
          skills: { huge: { name: 'huge', relPath: 'SKILL.md' } },
        });
        const origWarn = console.warn;
        console.warn = () => {};
        try {
          assert.equal(await loader.readActiveSkill('huge', ['huge']), null);
        } finally {
          console.warn = origWarn;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
