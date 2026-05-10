import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
    readPaths: new Set(),
    activePlugins,
  };
}

describe('list_commands tool', () => {
  let listCommands: typeof import('./list_commands.js').listCommandsTool;
  let store: typeof import('../../../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-listcmd-'));
    process.env.CARETAKER_HOME = testHome;
    listCommands = (await import('./list_commands.js')).listCommandsTool;
    store = await import('../../../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  it("returns 'No commands available.' when no plugins are active", async () => {
    const out = await listCommands.execute({}, ctx([]));
    assert.equal(out.content, 'No commands available.');
  });

  it('returns JSON catalog of active commands with metadata', async () => {
    await store.savePlugins({
      sources: [],
      plugins: [
        {
          id: randomUUID(),
          sourceId: randomUUID(),
          name: 'alpha',
          description: null,
          manifestKind: 'cc-plugin',
          relPath: '.',
          rawManifest: {},
          commands: {
            foo: { description: 'do foo', argumentHint: '<arg>', body: 'do $1' },
          },
        },
      ],
    });

    const out = await listCommands.execute({}, ctx(['alpha']));
    const parsed = JSON.parse(out.content) as Array<{
      name: string;
      description?: string;
      argumentHint?: string;
    }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'foo');
    assert.equal(parsed[0].description, 'do foo');
    assert.equal(parsed[0].argumentHint, '<arg>');
  });
});
