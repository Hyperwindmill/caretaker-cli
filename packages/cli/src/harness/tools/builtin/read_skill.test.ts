import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../types.js';

let testHome: string;

function ctx(activePlugins: string[]): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: process.cwd(),
    readPaths: new Set<string>(),
    activePlugins,
  };
}

describe('read_skill tool', () => {
  let readSkill: typeof import('./read_skill.js').readSkillTool;
  let store: typeof import('../../../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-readskill-'));
    process.env.CARETAKER_HOME = testHome;
    readSkill = (await import('./read_skill.js')).readSkillTool;
    store = await import('../../../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  async function seedSkill(dir: string, name: string, body: string) {
    const skillDir = path.join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), body);
    const sourceId = randomUUID();
    await store.savePlugins({
      sources: [{ id: sourceId, kind: 'path', url: dir, refreshOnStart: false }],
      plugins: [
        {
          id: randomUUID(),
          sourceId,
          name,
          description: null,
          manifestKind: 'skill-glob',
          relPath: name,
          rawManifest: {},
          // Per-file granularity: the loader needs an explicit SkillSpec
          // map. For a skill-glob plugin the single SKILL.md sits at the
          // plugin root, exposed under the plugin's own name.
          skills: { [name]: { name, relPath: 'SKILL.md' } },
        },
      ],
    });
  }

  it('rejects empty name', async () => {
    const out = await readSkill.execute({ name: '' }, ctx(['alpha']));
    assert.match(out.content, /^Error:/);
  });

  it('returns SKILL.md content for an active skill', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
    try {
      await seedSkill(dir, 'alpha', 'Hello from alpha.\n');
      const out = await readSkill.execute({ name: 'alpha' }, ctx(['alpha']));
      assert.equal(out.content, 'Hello from alpha.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns Error when skill is not active', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
    try {
      await seedSkill(dir, 'alpha', 'x');
      const out = await readSkill.execute({ name: 'alpha' }, ctx([]));
      assert.match(out.content, /^Error: skill "alpha" is not available/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns Error when skill name is unknown', async () => {
    const out = await readSkill.execute({ name: 'nope' }, ctx(['nope']));
    assert.match(out.content, /^Error: skill "nope" is not available/);
  });
});
