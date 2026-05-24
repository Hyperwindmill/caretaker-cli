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

describe('list_skills tool', () => {
  let listSkills: typeof import('./list_skills.js').listSkillsTool;
  let store: typeof import('../../../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-listskills-'));
    process.env.CARETAKER_HOME = testHome;
    listSkills = (await import('./list_skills.js')).listSkillsTool;
    store = await import('../../../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  it("returns 'No skills available.' when no active plugins", async () => {
    const out = await listSkills.execute({}, ctx([]));
    assert.equal(out.content, 'No skills available.');
  });

  it('returns JSON catalog of active skills', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ls-'));
    const skillDir = path.join(dir, 'alpha');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), 'x');
    try {
      const sourceId = randomUUID();
      await store.savePlugins({
        sources: [{ id: sourceId, kind: 'path', url: dir, refreshOnStart: false }],
        plugins: [
          {
            id: randomUUID(),
            sourceId,
            name: 'alpha',
            description: 'alpha desc',
            manifestKind: 'skill-glob',
            relPath: 'alpha',
            rawManifest: {},
            skills: {
              alpha: { name: 'alpha', description: 'alpha desc', relPath: 'SKILL.md' },
            },
          },
        ],
      });
      const out = await listSkills.execute({}, ctx(['alpha']));
      const parsed = JSON.parse(out.content);
      assert.deepEqual(parsed, [{ name: 'alpha', description: 'alpha desc', plugin: 'alpha' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
