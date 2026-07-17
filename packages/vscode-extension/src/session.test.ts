import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentConfig, ProviderConfig } from '@hyperwindmill/caretaker-cli/types';
import type { MessageRecord, SessionMetaRecord } from '@hyperwindmill/caretaker-cli/session';

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
  return {
    v: 1,
    type: 'message',
    id: `u-${Math.random()}`,
    role: 'user',
    content: text,
    createdAt: nowIso(),
  };
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
    saveAttachment: async () => 'att-unused',
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

function makeCallbacks(overrides: Partial<ChatCallbacks> = {}): {
  cb: ChatCallbacks;
  events: string[];
} {
  const events: string[] = [];
  const cb: ChatCallbacks = {
    onChunk: (text) => events.push(`chunk:${text}`),
    onThinking: (text) => events.push(`thinking:${text}`),
    onToolCall: (id, name) => events.push(`tool_call:${id}:${name}`),
    onToolResult: (id) => events.push(`tool_result:${id}`),
    askConfirm: async () => 'once',
    onError: (msg) => events.push(`error:${msg}`),
    onDone: () => events.push('done'),
    ...overrides,
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

test('persists attachments and passes them to the harness run', async () => {
  const saved: Array<{ sessionId: string; data: Buffer; extension: string }> = [];
  const runCalls: Array<Parameters<ChatDeps['run']>[0]> = [];
  const { deps, appendCalls } = makeDeps({
    saveAttachment: async (sessionId, data, extension) => {
      saved.push({ sessionId, data, extension });
      return `att-${saved.length}${extension}`;
    },
    userMessage: (text, opts) => ({
      ...fakeUserMessage(text),
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    }),
    run: async (opts) => {
      runCalls.push(opts);
      return { text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' };
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

  await ctl.start('read this pdf', cb, [
    {
      name: 'resume.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-fake').toString('base64'),
    },
  ]);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.sessionId, 'session-1');
  assert.equal(saved[0]!.extension, '.pdf');
  assert.equal(saved[0]!.data.toString(), '%PDF-fake');

  const expected = [{ mime: 'application/pdf', id: 'att-1.pdf', name: 'resume.pdf' }];
  assert.equal(runCalls.length, 1, 'harness run should be invoked');
  assert.equal(runCalls[0]!.sessionId, 'session-1');
  assert.deepEqual(runCalls[0]!.promptAttachments, expected);
  assert.deepEqual(appendCalls[0]!.msg.attachments, expected);
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

test('forwards onThinking events from the harness', async () => {
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      cbs.onThinking?.('let me think');
      cbs.onChunk?.('answer');
      return { text: 'answer', toolCalls: 0, usage: { input: 1, output: 1 }, stop: 'done' };
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

  assert.deepEqual(events, ['thinking:let me think', 'chunk:answer', 'done']);
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

test('confirmTool auto-resolves once for tools NOT in confirmTools', async () => {
  const asks: string[] = [];
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      const decision = await cbs.confirmTool!('id-1', 'read_file', { path: 'a' });
      asks.push(`decided:${decision}`);
      return { text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: { ...fakeAgent, confirmTools: ['write'] }, // read_file is NOT gated
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks({
    askConfirm: async () => {
      asks.push('asked');
      return 'reject';
    },
  });

  await ctl.start('hi', cb);

  // askConfirm must NOT be called; decision must be 'once'.
  assert.deepEqual(asks, ['decided:once']);
});

test('confirmTool calls askConfirm for tools in confirmTools', async () => {
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      const decision = await cbs.confirmTool!('id-1', 'write', { path: 'a' });
      return {
        text: `dec:${decision}`,
        toolCalls: 0,
        usage: { input: 0, output: 0 },
        stop: 'done',
      };
    },
  });
  const ctl = new ChatSessionController({
    agent: { ...fakeAgent, confirmTools: ['write'] },
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const asked: Array<{ id: string; name: string }> = [];
  const { cb } = makeCallbacks({
    askConfirm: async (id, name) => {
      asked.push({ id, name });
      return 'once';
    },
  });

  await ctl.start('hi', cb);
  assert.deepEqual(asked, [{ id: 'id-1', name: 'write' }]);
});

test('"always" decision removes the tool from the confirm set for this session', async () => {
  const callCount = { count: 0 };
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      // Two calls to the same tool in one turn.
      await cbs.confirmTool!('1', 'write', {});
      await cbs.confirmTool!('2', 'write', {});
      return { text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: { ...fakeAgent, confirmTools: ['write'] },
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks({
    askConfirm: async () => {
      callCount.count += 1;
      return 'always';
    },
  });

  await ctl.start('hi', cb);
  // First call asks the user (gets "always"); second call bypasses since
  // the tool has been removed from the in-memory confirm set.
  assert.equal(callCount.count, 1);
});

test('"always" persists across turns within the same controller', async () => {
  let runCount = 0;
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      runCount += 1;
      await cbs.confirmTool!(`call-${runCount}`, 'write', {});
      return { text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: { ...fakeAgent, confirmTools: ['write'] },
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  let asksThisSession = 0;
  const { cb } = makeCallbacks({
    askConfirm: async () => {
      asksThisSession += 1;
      return 'always';
    },
  });

  await ctl.start('first', cb);
  await ctl.start('second', cb);

  // Only the first turn asks; the second turn finds 'write' no longer in the set.
  assert.equal(asksThisSession, 1);
});

test('"reject" decision does NOT remove the tool from the confirm set', async () => {
  let asks = 0;
  const { deps } = makeDeps({
    run: async (_opts, cbs = {}) => {
      await cbs.confirmTool!('1', 'write', {});
      await cbs.confirmTool!('2', 'write', {});
      return { text: '', toolCalls: 0, usage: { input: 0, output: 0 }, stop: 'done' };
    },
  });
  const ctl = new ChatSessionController({
    agent: { ...fakeAgent, confirmTools: ['write'] },
    provider: fakeProvider,
    tools: [],
    workingDir: '/tmp',
    deps,
  });
  const { cb } = makeCallbacks({
    askConfirm: async () => {
      asks += 1;
      return 'reject';
    },
  });

  await ctl.start('hi', cb);
  assert.equal(asks, 2);
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
