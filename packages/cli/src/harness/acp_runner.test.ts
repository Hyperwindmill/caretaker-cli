import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-acprun-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agent as acpAgent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { PromptRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { runAcp } from './acp_runner.js';
import { __setConnector, __resetConnector, __shutdownAcpPool } from './acp_pool.js';
import { createSession, readSession } from '../session/store.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

const provider: ProviderConfig = { name: 'acp', type: 'acp', endpoint: '', command: 'fake' };
const agentCfg: AgentConfig = {
  id: 'ag1',
  name: 'A',
  systemPrompt: 'You are A.',
  provider: 'acp',
  model: '',
  allowedTools: [],
  maxTurns: 30,
};

type PromptHandler = (ctx: any, params: PromptRequest) => Promise<any> | any;
function useFakeAgent(onPrompt: PromptHandler, caps: Record<string, unknown> = {}) {
  const prompts: PromptRequest[] = [];
  const app = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: caps }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }))
    .onRequest('session/prompt', async (ctx: any) => {
      prompts.push(ctx.params);
      return onPrompt(ctx, ctx.params);
    });
  __setConnector((_p, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => conn.close() };
  });
  return { prompts, app };
}

const textUpdate = (text: string) => ({
  sessionId: 'acp-1',
  update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } },
});

afterEach(() => {
  __shutdownAcpPool();
  __resetConnector();
});

test('streams text, returns done, first turn carries the fabricated context block', async () => {
  const { prompts } = useFakeAgent(async (ctx) => {
    await ctx.client.notify('session/update', textUpdate('hel'));
    await ctx.client.notify('session/update', textUpdate('lo'));
    return { stopReason: 'end_turn' };
  });
  const chunks: string[] = [];
  const res = await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'hi' },
    { onChunk: (c) => chunks.push(c) },
  );
  assert.equal(res.text, 'hello');
  assert.equal(res.stop, 'done');
  assert.deepEqual(chunks, ['hel', 'lo']);
  const blocks = prompts[0].prompt;
  const joined = blocks.map((b: any) => b.text).join('\n');
  assert.match(joined, /caretaker-context/);
  assert.match(joined, /You are A\./);
  assert.match(joined, /hi$/);
});

test('permission ask routes to confirmTool; deny-all mode denies without asking', async () => {
  const seen: string[] = [];
  const mkPrompt = (): PromptHandler => async (ctx) => {
    const resp = await ctx.client.request('session/request_permission', {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 't1', kind: 'execute', title: 'run x' },
      options: [
        { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
        { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      ],
    } satisfies RequestPermissionRequest);
    seen.push(JSON.stringify(resp.outcome));
    return { stopReason: 'end_turn' };
  };
  useFakeAgent(mkPrompt());
  await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'x' },
    { confirmTool: async () => 'reject' },
  );
  assert.match(seen[0], /"optionId":"r1"/);

  __shutdownAcpPool();
  useFakeAgent(mkPrompt());
  await runAcp({ agent: agentCfg, provider, tools: [], prompt: 'x', acp: { mode: 'deny-all' } }, {});
  assert.match(seen[1], /"optionId":"r1"/);
});

test('tool_call + tool_call_update emit callbacks and persistable records', async () => {
  useFakeAgent(async (ctx) => {
    await ctx.client.notify('session/update', {
      sessionId: 'acp-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read file', kind: 'read', rawInput: { path: '/a' } },
    });
    await ctx.client.notify('session/update', {
      sessionId: 'acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
    });
    return { stopReason: 'end_turn' };
  });
  const calls: string[] = [];
  const results: string[] = [];
  const res = await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'x' },
    { onToolCall: (_id, name) => calls.push(name), onToolResult: (_id, c) => results.push(c) },
  );
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(calls, ['Read file']);
  assert.deepEqual(results, ['file body']);
});

test('abort sends session/cancel and returns stop aborted', async () => {
  let cancelled = false;
  const app = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', () => ({ sessionId: 'acp-1' }))
    .onNotification('session/cancel', () => {
      cancelled = true;
    })
    .onRequest('session/prompt', async () => {
      while (!cancelled) await new Promise((r) => setTimeout(r, 5));
      return { stopReason: 'cancelled' };
    });
  __setConnector((_p, clientApp) => {
    const conn = clientApp.connect(app);
    return { conn, kill: () => conn.close() };
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const res = await runAcp({ agent: agentCfg, provider, tools: [], prompt: 'x', signal: ac.signal }, {});
  assert.equal(res.stop, 'aborted');
});

test('sessionId runs persist acpSessionId and reuse the pooled child; second turn has no context block', async () => {
  const { prompts } = useFakeAgent(async () => ({ stopReason: 'end_turn' }));
  const meta = await createSession({ agentId: agentCfg.id, title: 'chat' });
  const opts = { agent: agentCfg, provider, tools: [], sessionId: meta.id };
  await runAcp({ ...opts, prompt: 'one' }, {});
  const persisted = await readSession(agentCfg.id, meta.id);
  assert.equal(persisted.meta.acpSessionId, 'acp-1');
  await runAcp({ ...opts, prompt: 'two' }, {});
  assert.equal(prompts.length, 2);
  const secondJoined = prompts[1].prompt.map((b: any) => b.text).join('\n');
  assert.ok(!secondJoined.includes('caretaker-context'));
});

import { run } from './loop.js';

test('loop.run dispatches acp providers to runAcp', async () => {
  useFakeAgent(async () => ({ stopReason: 'end_turn' }));
  const res = await run({ agent: agentCfg, provider, tools: [], prompt: 'x' });
  assert.equal(res.stop, 'done');
});


test('adapter hook notices route to thinking, not the reply text (claude-agent-acp#1042 heuristic)', async () => {
  useFakeAgent(async (ctx) => {
    await ctx.client.notify(
      'session/update',
      textUpdate('**Notice:** UserPromptSubmit says: MEMORY REMINDER blah'),
    );
    await ctx.client.notify('session/update', textUpdate('real reply'));
    // A mid-prose bold label must NOT be demoted: only whole-chunk matches count.
    await ctx.client.notify('session/update', textUpdate(' — **Notice:** inline is fine'));
    return { stopReason: 'end_turn' };
  });
  const thinking: string[] = [];
  const chunks: string[] = [];
  const res = await runAcp(
    { agent: agentCfg, provider, tools: [], prompt: 'x' },
    { onThinking: (t) => thinking.push(t), onChunk: (c) => chunks.push(c) },
  );
  assert.equal(res.text, 'real reply — **Notice:** inline is fine');
  assert.deepEqual(thinking, ['**Notice:** UserPromptSubmit says: MEMORY REMINDER blah']);
  assert.deepEqual(chunks, ['real reply', ' — **Notice:** inline is fine']);
});
