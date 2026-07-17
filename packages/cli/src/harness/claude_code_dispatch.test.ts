import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccdisp-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './loop.js';
import { __setSpawn, __resetSpawn } from './claude_code_runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  stdinData = '';
  constructor(
    private fixtureLines: string[],
    private exitCode = 0,
  ) {
    super();
    this.stdin.on('data', (d) => (this.stdinData += String(d)));
    this.stdin.on('finish', () => {
      setImmediate(() => {
        for (const l of this.fixtureLines) this.stdout.write(l + '\n');
        this.stdout.end();
        this.emit('close', this.exitCode);
      });
    });
  }
  kill() {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
}

const fixtureLines = (name: string) =>
  readFileSync(path.join(here, 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean);

afterEach(() => __resetSpawn());

test('run() dispatches claude-code providers to the runner', async () => {
  let spawnedArgs: string[] | null = null;
  __setSpawn(((cmd: string, args: string[]) => {
    spawnedArgs = args;
    return new FakeChild(fixtureLines('claude_code_stream_text.jsonl')) as any;
  }) as any);
  const result = await run(
    {
      agent: { id: 'a', name: 'a', systemPrompt: '', provider: 'cc', model: 'sonnet', allowedTools: [], maxTurns: 30 },
      provider: { name: 'cc', type: 'claude-code', endpoint: '' },
      tools: [],
      prompt: 'hi',
    },
    {},
  );
  assert.equal(result.stop, 'done');
  assert.ok(spawnedArgs && spawnedArgs[0] === '-p');
});
