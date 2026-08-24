import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

  const msg = (
    id: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    parts?: import('../../../session/types.js').AssistantPart[]
  ): import('../../../session/types.js').MessageRecord => ({
    v: 1,
    type: 'message',
    id,
    role,
    content,
    ...(parts ? { parts } : {}),
    createdAt: '2026-08-24T10:00:00.000Z',
  });

  describe('formatMessage', () => {
    it('labels user and assistant messages by role', () => {
      assert.equal(sweep.formatMessage(msg('m1', 'user', 'hello')), 'user: hello');
      assert.equal(sweep.formatMessage(msg('m2', 'assistant', 'hi')), 'assistant: hi');
    });

    it('drops thinking parts, keeps text, names tool calls', () => {
      const out = sweep.formatMessage(
        msg('m3', 'assistant', 'ignored when parts exist', [
          { type: 'thinking', text: 'secret chain of thought' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', id: 't1', name: 'read_file', args: { path: 'x' } },
        ])
      );
      assert.ok(!out.includes('secret chain of thought'));
      assert.ok(out.includes('visible answer'));
      assert.ok(out.includes('read_file'));
    });

    it('hard-truncates tool results', () => {
      const out = sweep.formatMessage(msg('m4', 'tool', 'x'.repeat(10_000)));
      assert.ok(out.length < 600);
    });
  });

  describe('locateCursor', () => {
    const messages = [msg('a', 'user', '1'), msg('b', 'assistant', '2'), msg('c', 'user', '3')];
    it('finds the cursor index', () => {
      assert.equal(sweep.locateCursor(messages, 'b'), 1);
    });
    it('returns -1 for empty or unknown ids', () => {
      assert.equal(sweep.locateCursor(messages, ''), -1);
      assert.equal(sweep.locateCursor(messages, 'zzz'), -1);
    });
  });

  describe('chunkMessages', () => {
    it('keeps small conversations in one chunk, in order', () => {
      const chunks = sweep.chunkMessages([msg('a', 'user', 'one'), msg('b', 'assistant', 'two')]);
      assert.equal(chunks.length, 1);
      assert.deepEqual(chunks[0]!.messages.map((m) => m.id), ['a', 'b']);
      assert.ok(chunks[0]!.text.includes('user: one'));
      assert.ok(chunks[0]!.text.includes('assistant: two'));
    });

    it('splits when the char budget is exceeded, preserving message order', () => {
      const big = 'x'.repeat(9_000);
      const chunks = sweep.chunkMessages([
        msg('a', 'user', big),
        msg('b', 'user', big),
        msg('c', 'user', big),
      ]);
      assert.ok(chunks.length >= 2);
      assert.deepEqual(chunks.flatMap((c) => c.messages.map((m) => m.id)), ['a', 'b', 'c']);
    });

    it('an oversized single message becomes its own truncated chunk', () => {
      const chunks = sweep.chunkMessages([msg('a', 'user', 'x'.repeat(50_000))]);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]!.messages.length, 1);
      assert.ok(chunks[0]!.text.length <= sweep.MAX_CHUNK_CHARS + 1);
    });

    it('returns [] for no messages', () => {
      assert.deepEqual(sweep.chunkMessages([]), []);
    });
  });

  describe('buildSummarizePrompt', () => {
    it('embeds previous summary and chunk, marks a missing summary', () => {
      const p1 = sweep.buildSummarizePrompt('old facts', 'user: hi');
      assert.ok(p1.includes('old facts'));
      assert.ok(p1.includes('user: hi'));
      const p2 = sweep.buildSummarizePrompt('', 'user: hi');
      assert.ok(p2.includes('(none)'));
    });
  });

  describe('makeSummarizer', () => {
    const withServer = async (
      handler: (body: any) => { status: number; payload: unknown },
      fn: (endpoint: string) => Promise<void>
    ) => {
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const out = handler(JSON.parse(raw));
          res.writeHead(out.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out.payload));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address() as { port: number };
      try {
        await fn(`http://127.0.0.1:${addr.port}`);
      } finally {
        server.close();
      }
    };

    const resolved = (endpoint: string): import('./memory_sweep.js').ResolvedMemoryConfig => ({
      provider: { name: 'local', endpoint, apiKey: 'secret-key' },
      model: 'gpt-test',
      sweepMinutes: 5,
      minNewMessages: 4,
    });

    it('POSTs model + prompt and returns the trimmed content', async () => {
      let seen: any = null;
      await withServer(
        (body) => {
          seen = body;
          return { status: 200, payload: { choices: [{ message: { content: '  the summary  ' } }] } };
        },
        async (endpoint) => {
          const out = await sweep.makeSummarizer(resolved(endpoint))('prev', 'user: hi');
          assert.equal(out, 'the summary');
          assert.equal(seen.model, 'gpt-test');
          assert.equal(seen.stream, false);
          assert.ok(seen.messages[0].content.includes('prev'));
          assert.ok(seen.messages[0].content.includes('user: hi'));
        }
      );
    });

    it('returns null on non-OK and on malformed payloads', async () => {
      await withServer(
        () => ({ status: 500, payload: { error: 'boom' } }),
        async (endpoint) => {
          assert.equal(await sweep.makeSummarizer(resolved(endpoint))('', 'x'), null);
        }
      );
      await withServer(
        () => ({ status: 200, payload: { unexpected: true } }),
        async (endpoint) => {
          assert.equal(await sweep.makeSummarizer(resolved(endpoint))('', 'x'), null);
        }
      );
    });

    it('returns null when the endpoint is unreachable', async () => {
      const out = await sweep.makeSummarizer(resolved('http://127.0.0.1:1'))('', 'x');
      assert.equal(out, null);
    });

    it('hard-truncates an over-long summary', async () => {
      await withServer(
        () => ({ status: 200, payload: { choices: [{ message: { content: 'y'.repeat(10_000) } }] } }),
        async (endpoint) => {
          const out = await sweep.makeSummarizer(resolved(endpoint))('', 'x');
          assert.ok(out !== null && out.length <= sweep.MAX_SUMMARY_CHARS + 1);
        }
      );
    });
  });
});


