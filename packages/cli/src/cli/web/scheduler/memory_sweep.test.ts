import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaretakerConfig } from '../../../types.js';

let testHome: string;

describe('memory sweep', () => {
  let sweep: typeof import('./memory_sweep.js');

  before(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'caretaker-memsweep-test-'));
    process.env.CARETAKER_HOME = testHome;
    sweep = await import('./memory_sweep.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  const baseConfig = (memory?: CaretakerConfig['memory']): CaretakerConfig => ({
    port: 3000,
    providers: [
      { name: 'local', endpoint: 'http://127.0.0.1:1234', apiKey: 'k' },
      { name: 'cc', type: 'claude-code', endpoint: '' },
    ],
    memory,
  });

  describe('resolveMemoryConfig', () => {
    it('returns null when memory is unset or incomplete', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig()), null);
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: '', model: 'm' })), null);
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'local', model: '' })), null);
    });

    it('returns null for an unknown provider name', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'nope', model: 'm' })), null);
    });

    it('rejects claude-code providers', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ provider: 'cc', model: 'm' })), null);
    });

    it('resolves with defaults applied', () => {
      const r = sweep.resolveMemoryConfig(baseConfig({ provider: 'local', model: 'gpt-test' }));
      assert.ok(r);
      assert.equal(r.provider.name, 'local');
      assert.equal(r.model, 'gpt-test');
      assert.equal(r.sweepMinutes, sweep.DEFAULT_SWEEP_MINUTES);
      assert.equal(r.minNewMessages, sweep.DEFAULT_MIN_NEW_MESSAGES);
    });

    it('honours explicit overrides', () => {
      const r = sweep.resolveMemoryConfig(
        baseConfig({ provider: 'local', model: 'gpt-test', sweepMinutes: 30, minNewMessages: 1 })
      );
      assert.equal(r?.sweepMinutes, 30);
      assert.equal(r?.minNewMessages, 1);
    });
  });
});
