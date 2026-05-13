import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentConfig, ProviderConfig } from 'caretaker-cli/types';
import type { MessageRecord, SessionMetaRecord } from 'caretaker-cli/session';

import { ChatSessionController, type ChatCallbacks, type ChatDeps } from './session.js';

const fakeAgent: AgentConfig = {
  id: 'agent-1',
  name: 'tester',
  provider: 'fake',
  model: 'm1',
  systemPrompt: '',
  allowedTools: [],
  maxTurns: 10,
};

const fakeProvider: ProviderConfig = {
  name: 'fake',
  endpoint: 'http://localhost:0',
};

function nowIso(): string {
  return new Date().toISOString();
}

function fakeUserMessage(text: string): MessageRecord {
  return { v: 1, type: 'message', id: `u-${Math.random()}`, role: 'user', content: text, createdAt: nowIso() };
}

function fakeAssistantMessage(text: string): MessageRecord {
  return {
    v: 1,
    type: 'message',
    id: `a-${Math.random()}`,
    role: 'assistant',
    content: text,
    parts: [{ type: 'text', text }],
    createdAt: nowIso(),
  };
}

function fakeToolMessage(toolCallId: string, content: string): MessageRecord {
  return {
    v: 1,
    type: 'message',
    id: `t-${Math.random()}`,
    role: 'tool',
    toolCallId,
    content,
    createdAt: nowIso(),
  };
}

interface AppendCall {
  meta: Pick<SessionMetaRecord, 'agentId' | 'id'>;
  msg: MessageRecord;
}

function makeDeps(overrides: Partial<ChatDeps> = {}): {
  deps: ChatDeps;
  appendCalls: AppendCall[];
  created: SessionMetaRecord[];
} {
  const appendCalls: AppendCall[] = [];
  const created: SessionMetaRecord[] = [];
  const deps: ChatDeps = {
    createSession: async (input) => {
      const meta: SessionMetaRecord = {
        v: 1,
        type: 'session_meta',
        id: `session-${created.length + 1}`,
        agentId: input.agentId,
        title: input.title,
        createdAt: nowIso(),
      };
      created.push(meta);
      return meta;
    },
    appendMessage: async (meta, msg) => {
      appendCalls.push({ meta, msg });
    },
    userMessage: fakeUserMessage,
    run: async () => ({
      text: '',
      toolCalls: 0,
      usage: { input: 0, output: 0 },
      stop: 'done',
    }),
    ...overrides,
  };
  return { deps, appendCalls, created };
}

function makeCallbacks(): { cb: ChatCallbacks; events: string[] } {
  const events: string[] = [];
  const cb: ChatCallbacks = {
    onChunk: (text) => events.push(`chunk:${text}`),
    onToolCall: (id, name) => events.push(`tool_call:${id}:${name}`),
    onToolResult: (id) => events.push(`tool_result:${id}`),
    onError: (msg) => events.push(`error:${msg}`),
    onDone: () => events.push('done'),
  };
  return { cb, events };
}

test('creates the session lazily on the first start, with a truncated title', async () => {
  const { deps, created } = makeDeps();
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks();

  const longPrompt = 'a'.repeat(80);
  await ctl.start(longPrompt, cb);

  assert.equal(created.length, 1);
  assert.equal(created[0]!.title.length, 51); // 50 chars + ellipsis
  assert.ok(created[0]!.title.endsWith('…'));
});

test('reuses the session across subsequent starts', async () => {
  const { deps, created } = makeDeps();
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks();

  await ctl.start('first', cb);
  await ctl.start('second', cb);

  assert.equal(created.length, 1);
});

test('forwards onChunk and onToolCall events from the harness', async () => {
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      cbs.onChunk?.('hello');
      cbs.onToolCall?.('t1', 'read_file', { path: 'a' });
      cbs.onToolResult?.('t1', 'OK');
      cbs.onChunk?.(' world');
      return { text: 'hello world', toolCalls: 1, usage: { input: 1, output: 1 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb, events } = makeCallbacks();

  await ctl.start('hi', cb);

  assert.deepEqual(events, [
    'chunk:hello',
    'tool_call:t1:read_file',
    'tool_result:t1',
    'chunk: world',
    'done',
  ]);
});

test('persists user + assistant + tool messages via appendMessage', async () => {
  const toolMsg = fakeToolMessage('t1', 'OK');
  const assistantMsg = fakeAssistantMessage('reply');

  const { deps, appendCalls } = makeDeps({
    run: async (_opts, cbs = {}) => {
      await cbs.onMessage?.(toolMsg);
      await cbs.onMessage?.(assistantMsg);
      return { text: 'reply', toolCalls: 1, usage: { input: 1, output: 1 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks();

  await ctl.start('hi', cb);

  // user is appended first, then tool, then assistant.
  assert.equal(appendCalls.length, 3);
  assert.equal(appendCalls[0]!.msg.role, 'user');
  assert.equal(appendCalls[1]!.msg.role, 'tool');
  assert.equal(appendCalls[2]!.msg.role, 'assistant');
});

test('passes accumulated history into the harness on the second turn', async () => {
  const received: number[] = [];
  const { deps } = makeDeps({
    run: async (opts, cbs = {}) => {
      received.push(opts.history?.length ?? -1);
      await cbs.onMessage?.(fakeAssistantMessage('ok'));
      return { text: 'ok', toolCalls: 0, usage: { input: 1, output: 1 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks();

  await ctl.start('first', cb);
  await ctl.start('second', cb);

  // First call: empty history. Second call: prior user + prior assistant.
  assert.deepEqual(received, [0, 2]);
});

test('translates harness errors into onError', async () => {
  const { deps } = makeDeps({
    run: async () => {
      throw new Error('boom');
    },
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb, events } = makeCallbacks();

  await ctl.start('hi', cb);

  assert.deepEqual(events, ['error:boom']);
});

test('refuses concurrent starts', async () => {
  let release!: () => void;
  let signalRunCalled!: () => void;
  const runCalled = new Promise<void>((resolve) => {
    signalRunCalled = resolve;
  });
  const { deps } = makeDeps({
    run: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' });
        signalRunCalled();
      }),
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb: cb1 } = makeCallbacks();
  const { cb: cb2, events: events2 } = makeCallbacks();

  const first = ctl.start('hi', cb1);
  await runCalled; // first is now blocked inside deps.run
  const second = ctl.start('hi again', cb2);
  await second;
  release();
  await first;

  assert.deepEqual(events2, ['error:A turn is already in progress.']);
});

test('abort triggers AbortController.abort on the in-flight run', async () => {
  let signal: AbortSignal | undefined;
  const { deps } = makeDeps({
    run: (opts) =>
      new Promise((resolve) => {
        signal = opts.signal;
        opts.signal?.addEventListener('abort', () =>
          resolve({ text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'aborted' }),
        );
      }),
  });
  const ctl = new ChatSessionController({
    agent: fakeAgent,
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks();

  const runPromise = ctl.start('hi', cb);
  // Yield once so the run starts.
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  await runPromise;

  assert.equal(signal?.aborted, true);
});
