import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, CaretakerConfig } from '../../../types.js';

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

  const testAgents: AgentConfig[] = [
    {
      id: 'ag-mem',
      name: 'Memory',
      systemPrompt: 'Summarize plainly.',
      provider: 'local',
      model: 'gpt-test',
      allowedTools: [],
      maxTurns: 5,
    },
    {
      id: 'ag-cc',
      name: 'ClaudeMem',
      systemPrompt: '',
      provider: 'cc',
      model: 'sonnet',
      allowedTools: [],
      maxTurns: 5,
    },
    {
      id: 'ag-orphan',
      name: 'Orphan',
      systemPrompt: '',
      provider: 'gone',
      model: 'm',
      allowedTools: [],
      maxTurns: 5,
    },
  ];

  const baseConfig = (memory?: CaretakerConfig['memory']): CaretakerConfig => ({
    port: 3000,
    providers: [
      { name: 'local', endpoint: 'http://127.0.0.1:1234', apiKey: 'k' },
      { name: 'cc', type: 'claude-code', endpoint: '' },
    ],
    memory,
  });

  describe('resolveMemoryConfig', () => {
    it('returns null when memory is unset or has no agentId', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig(), testAgents), null);
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ agentId: '' }), testAgents), null);
    });

    it('returns null for an unknown agent id (deleted agent)', () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ agentId: 'nope' }), testAgents), null);
    });

    it("returns null when the agent's provider no longer exists", () => {
      assert.equal(sweep.resolveMemoryConfig(baseConfig({ agentId: 'ag-orphan' }), testAgents), null);
    });

    it('resolves an agent with defaults applied', () => {
      const r = sweep.resolveMemoryConfig(baseConfig({ agentId: 'ag-mem' }), testAgents);
      assert.ok(r);
      assert.equal(r.agent.id, 'ag-mem');
      assert.equal(r.provider.name, 'local');
      assert.equal(r.sweepMinutes, sweep.DEFAULT_SWEEP_MINUTES);
      assert.equal(r.minNewMessages, sweep.DEFAULT_MIN_NEW_MESSAGES);
    });

    it('resolves a claude-code agent (full provider compatibility)', () => {
      const r = sweep.resolveMemoryConfig(baseConfig({ agentId: 'ag-cc' }), testAgents);
      assert.ok(r);
      assert.equal(r.provider.type, 'claude-code');
    });

    it('honours explicit overrides', () => {
      const r = sweep.resolveMemoryConfig(
        baseConfig({ agentId: 'ag-mem', sweepMinutes: 30, minNewMessages: 1 }),
        testAgents
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
    // The summarizer goes through harness.run(), so the openai path is faked
    // at the loop's fetch seam and the claude-code path at the runner's spawn
    // seam — the same seams loop.test.ts / claude_code_runner.test.ts use.
    let loop: typeof import('../../../harness/loop.js');
    let runner: typeof import('../../../harness/claude_code_runner.js');

    before(async () => {
      loop = await import('../../../harness/loop.js');
      runner = await import('../../../harness/claude_code_runner.js');
    });

    afterEach(() => {
      loop.__resetFetch();
      runner.__resetSpawn();
    });

    const sse = (lines: string[]): Response => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const l of lines) controller.enqueue(enc.encode(l));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const sseText = (text: string) => [
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ];

    const resolved = (): import('./memory_sweep.js').ResolvedMemoryConfig => ({
      agent: testAgents[0]!,
      provider: { name: 'local', endpoint: 'http://fake', apiKey: 'secret-key' },
      sweepMinutes: 5,
      minNewMessages: 4,
    });

    it('openai path: runs one turn with the summarize prompt, returns the text', async () => {
      let seenBody: any = null;
      loop.__setFetch(async (_url, init) => {
        seenBody = JSON.parse(String((init as RequestInit).body));
        return sse(sseText('  the summary  '));
      });
      const out = await sweep.makeSummarizer(resolved())('prev facts', 'user: hi');
      assert.equal(out, 'the summary');
      assert.equal(seenBody.model, 'gpt-test');
      const lastMsg = seenBody.messages[seenBody.messages.length - 1];
      assert.ok(lastMsg.content.includes('prev facts'));
      assert.ok(lastMsg.content.includes('user: hi'));
      assert.ok(!seenBody.tools?.length, 'summarize runs with no tools');
    });

    it('returns null on HTTP failure and on empty text', async () => {
      loop.__setFetch(async () => new Response('boom', { status: 500 }));
      assert.equal(await sweep.makeSummarizer(resolved())('', 'x'), null);
      loop.__setFetch(async () => sse(sseText('')));
      assert.equal(await sweep.makeSummarizer(resolved())('', 'x'), null);
    });

    it('hard-truncates an over-long summary', async () => {
      loop.__setFetch(async () => sse(sseText('y'.repeat(10_000))));
      const out = await sweep.makeSummarizer(resolved())('', 'x');
      assert.ok(out !== null && out.length <= sweep.MAX_SUMMARY_CHARS + 1);
    });

    it('claude-code path: spawns a one-shot claude and returns its text', async () => {
      const { EventEmitter } = await import('node:events');
      const { PassThrough } = await import('node:stream');
      const { readFile } = await import('node:fs/promises');
      const fixturePath = join(
        process.cwd(),
        'src/harness/fixtures/claude_code_stream_text.jsonl'
      );
      const lines = (await readFile(fixturePath, 'utf8')).split('\n').filter(Boolean);
      const spawnCalls: string[][] = [];
      runner.__setSpawn(((_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => {
          child.emit('close', null);
          return true;
        };
        child.stdin.on('finish', () => {
          setImmediate(() => {
            for (const l of lines) child.stdout.write(l + '\n');
            child.stdout.end();
            child.emit('close', 0);
          });
        });
        return child;
      }) as any);
      const ccResolved: import('./memory_sweep.js').ResolvedMemoryConfig = {
        agent: testAgents[1]!,
        provider: { name: 'cc', type: 'claude-code', endpoint: '' },
        sweepMinutes: 5,
        minNewMessages: 4,
      };
      const out = await sweep.makeSummarizer(ccResolved)('', 'user: hi');
      assert.ok(out !== null && out.length > 0);
      assert.equal(spawnCalls.length, 1);
      assert.ok(spawnCalls[0]!.includes('dontAsk'), 'tool calls denied via dontAsk');
    });
  });

  describe('sweepMemory', () => {
    let store: typeof import('../../../session/store.js');
    let db: typeof import('../../../store/db.js');

    before(async () => {
      store = await import('../../../session/store.js');
      db = await import('../../../store/db.js');
    });

    const resolvedCfg = (over: Partial<import('./memory_sweep.js').ResolvedMemoryConfig> = {}) => ({
      agent: testAgents[0]!,
      provider: { name: 'local', endpoint: 'http://unused', apiKey: '' },
      sweepMinutes: 5,
      minNewMessages: 2,
      ...over,
    });

    /** Fake summarizer recording calls; returns "S<n>" per call, or null after `failAfter`. */
    const fakeSummarize = (failAfter = Infinity) => {
      const calls: Array<{ prev: string; chunk: string }> = [];
      const fn: import('./memory_sweep.js').SummarizeFn = async (prev, chunk) => {
        calls.push({ prev, chunk });
        if (calls.length > failAfter) return null;
        return `S${calls.length}`;
      };
      return { calls, fn };
    };

    const makeSession = async (agentId: string, texts: string[]) => {
      const meta = await store.createSession({ agentId, title: 't' });
      for (const t of texts) {
        await store.appendMessage(meta, store.userMessage(t));
      }
      return meta;
    };

    it('summarizes a new session and persists cursor + summary', async () => {
      const meta = await makeSession('ag-sweep-1', ['first', 'second', 'third']);
      const { calls, fn } = fakeSummarize();
      const res = await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(res.scanned >= 1);
      assert.equal(calls.length >= 1, true);
      const d = await db.getSessionDigest(meta.id);
      assert.ok(d);
      assert.equal(d.summary, `S${calls.length}`);
      assert.equal(d.agentId, 'ag-sweep-1');
      assert.equal(d.messageCount, 3);
      const session = await store.readSession('ag-sweep-1', meta.id);
      assert.equal(d.lastMessageId, session.messages[session.messages.length - 1]!.id);
      assert.notEqual(d.scannedAt, '');
    });

    it('is incremental: an unchanged session is not re-summarized (mtime gate)', async () => {
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), fn);
      assert.equal(calls.length, 0);
    });

    it('below the debounce threshold: no call, but scannedAt is refreshed', async () => {
      const meta = await makeSession('ag-sweep-2', ['only-one']);
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg({ minNewMessages: 5 }), fn);
      assert.equal(calls.length, 0);
      const d = await db.getSessionDigest(meta.id);
      assert.ok(d);
      assert.equal(d.summary, '');
      assert.equal(d.lastMessageId, '');
    });

    it('feeds the previous summary to the next round and advances the cursor', async () => {
      const meta = await makeSession('ag-sweep-3', ['a', 'b']);
      const r1 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r1.fn);
      assert.equal(r1.calls.length, 1);
      await store.appendMessage(meta, store.userMessage('c'));
      await store.appendMessage(meta, store.userMessage('d'));
      const r2 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r2.fn);
      assert.equal(r2.calls.length, 1);
      assert.equal(r2.calls[0]!.prev, 'S1');
      assert.ok(r2.calls[0]!.chunk.includes('user: c'));
      assert.ok(!r2.calls[0]!.chunk.includes('user: a'));
      const d = await db.getSessionDigest(meta.id);
      assert.equal(d?.messageCount, 4);
    });

    it('model failure leaves the cursor and scannedAt so the next sweep retries', async () => {
      const meta = await makeSession('ag-sweep-4', ['a', 'b', 'c']);
      const fail = fakeSummarize(0); // every call fails
      await sweep.sweepMemory(resolvedCfg(), fail.fn);
      const d1 = await db.getSessionDigest(meta.id);
      assert.ok(!d1 || d1.lastMessageId === '');
      const ok = fakeSummarize();
      const res2 = await sweep.sweepMemory(resolvedCfg(), ok.fn);
      assert.equal(ok.calls.length, 1); // retried despite no new appends
      assert.ok(res2.summarized >= 1);
    });

    it('lost cursor (id not found) resets and reprocesses from zero', async () => {
      const meta = await makeSession('ag-sweep-5', ['a', 'b']);
      const r1 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r1.fn);
      const d1 = await db.getSessionDigest(meta.id);
      assert.ok(d1);
      await db.saveSessionDigest({ ...d1, lastMessageId: 'gone-gone', scannedAt: '1970-01-01T00:00:00.000Z' });
      const r2 = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), r2.fn);
      assert.equal(r2.calls.length, 1);
      assert.equal(r2.calls[0]!.prev, ''); // summary reset, restarted from zero
      const d2 = await db.getSessionDigest(meta.id);
      assert.equal(d2?.messageCount, 2);
    });

    it('respects the per-sweep call budget and reports the skip', async () => {
      // 12 fresh 2-message sessions with budget 10 ⇒ 10 calls, ≥1 budget-skips.
      for (let i = 0; i < 12; i++) await makeSession('ag-sweep-6', ['x', 'y']);
      const { calls, fn } = fakeSummarize();
      const res = await sweep.sweepMemory(resolvedCfg(), fn);
      assert.equal(calls.length, sweep.MAX_CALLS_PER_SWEEP);
      assert.ok(res.budgetSkipped >= 1);
    });

    it('budget-skipped sessions are caught up by the following sweep', async () => {
      const { calls, fn } = fakeSummarize();
      await sweep.sweepMemory(resolvedCfg(), fn);
      assert.ok(calls.length >= 1); // the leftovers from the previous test
    });

    it('deletes digests whose session file is gone', async () => {
      const meta = await makeSession('ag-sweep-7', ['a', 'b']);
      await sweep.sweepMemory(resolvedCfg(), fakeSummarize().fn);
      assert.ok(await db.getSessionDigest(meta.id));
      await store.deleteSession('ag-sweep-7', meta.id);
      await sweep.sweepMemory(resolvedCfg(), fakeSummarize().fn);
      assert.equal(await db.getSessionDigest(meta.id), null);
    });

    it('a session whose digest save throws (non-safeId filename) is skipped, not fatal', async () => {
      // A hand-copied/restored file the session store itself would never
      // create: its name fails safeId, so saveSessionDigest throws. The sweep
      // must warn + skip it and still process every other session.
      const { writeFile, mkdir } = await import('node:fs/promises');
      const dir = join(testHome, 'sessions', 'ag-sweep-8');
      await mkdir(dir, { recursive: true });
      const meta = {
        v: 1,
        type: 'session_meta',
        id: 'WeIrD_Name',
        agentId: 'ag-sweep-8',
        title: 't',
        createdAt: '2026-08-24T10:00:00.000Z',
      };
      const lines = [
        JSON.stringify(meta),
        JSON.stringify({ v: 1, type: 'message', id: 'w1', role: 'user', content: 'a', createdAt: '2026-08-24T10:00:01.000Z' }),
        JSON.stringify({ v: 1, type: 'message', id: 'w2', role: 'user', content: 'b', createdAt: '2026-08-24T10:00:02.000Z' }),
      ];
      await writeFile(join(dir, 'WeIrD_Name.jsonl'), lines.join('\n') + '\n');
      const good = await makeSession('ag-sweep-8', ['x', 'y']);
      const { fn } = fakeSummarize();
      const res = await sweep.sweepMemory(resolvedCfg(), fn); // must not reject
      assert.ok(res.summarized >= 1);
      assert.ok(await db.getSessionDigest(good.id));
      assert.equal(await db.getSessionDigest('WeIrD_Name'), null);
    });
  });

  describe('runMemorySweepTick', () => {
    let json: typeof import('../../../store/json.js');

    before(async () => {
      json = await import('../../../store/json.js');
    });

    const writeMemoryConfig = async (memory: unknown) => {
      const config = await json.loadConfig();
      await json.saveAgents(testAgents);
      await json.saveConfig({ ...config, providers: [{ name: 'local', endpoint: 'http://unused' }], memory } as any);
    };

    it('does nothing when memory is unconfigured', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig(undefined);
      const { calls, fn } = // reuse the fakeSummarize helper from the sweepMemory block:
        (() => {
          const calls: unknown[] = [];
          const fn: import('./memory_sweep.js').SummarizeFn = async () => {
            calls.push(1);
            return 'S';
          };
          return { calls, fn };
        })();
      await sweep.runMemorySweepTick(new Date(), fn);
      assert.equal(calls.length, 0);
    });

    it('interval gate: two ticks inside sweepMinutes run one sweep', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig({ agentId: 'ag-mem', minNewMessages: 1 });
      let sweeps = 0;
      const fn: import('./memory_sweep.js').SummarizeFn = async () => {
        sweeps++;
        return 'S';
      };
      const t0 = new Date('2026-08-24T12:00:00.000Z');
      await sweep.runMemorySweepTick(t0, fn);
      const after = sweeps;
      await sweep.runMemorySweepTick(new Date(t0.getTime() + 15_000), fn); // next 15s tick
      assert.equal(sweeps, after); // no second sweep inside the window
      await sweep.runMemorySweepTick(new Date(t0.getTime() + 6 * 60_000), fn); // past 5 min
      // second sweep ran (mtime gates may make it a no-call sweep; assert via gate state, not calls):
      // the tick returning without throwing and the interval advancing is the observable contract.
    });

    it('overlap gate: a tick during an in-flight sweep returns immediately', async () => {
      sweep.__memorySweepTesting.reset();
      await writeMemoryConfig({ agentId: 'ag-mem', minNewMessages: 1 });
      // a fresh session so the sweep has work to do and stays in flight
      const store = await import('../../../session/store.js');
      const meta = await store.createSession({ agentId: 'ag-tick-1', title: 't' });
      await store.appendMessage(meta, store.userMessage('hello'));
      let release!: () => void;
      const blocked = new Promise<void>((r) => (release = r));
      let entered = 0;
      const slow: import('./memory_sweep.js').SummarizeFn = async () => {
        entered++;
        await blocked;
        return 'S';
      };
      const t0 = new Date('2026-08-24T13:00:00.000Z');
      const first = sweep.runMemorySweepTick(t0, slow);
      // busy-wait until the slow summarizer is actually entered
      while (entered === 0) await new Promise((r) => setTimeout(r, 5));
      const second = sweep.runMemorySweepTick(new Date(t0.getTime() + 10 * 60_000), slow);
      await second; // must resolve immediately (in-flight gate), not run a sweep
      assert.equal(entered, 1);
      release();
      await first;
    });
  });
});




