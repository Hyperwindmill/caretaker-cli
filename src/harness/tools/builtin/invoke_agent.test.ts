import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { __setFetch, __resetFetch } from '../../loop.js';
import { invokeAgentTool } from './invoke_agent.js';
import type { ToolContext } from '../types.js';
import type { AgentConfig, CaretakerConfig } from '../../../types.js';

let testHome: string;

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: randomUUID(),
    name: 'caller',
    systemPrompt: 'I am the caller.',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    allowedTools: ['read_file', 'bash'],
    maxTurns: 5,
    ...over,
  };
}

function ctx(callerAgent: AgentConfig | undefined): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: process.cwd(),
    readPaths: new Set(),
    callerAgent,
    dispatchDepth: 0,
  };
}

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const single = (text: string) => [
  `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
  'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
];

describe('invoke_agent tool', () => {
  let store: typeof import('../../../store/json.js');

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), 'caretaker-invokeagent-'));
    process.env.CARETAKER_HOME = testHome;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    store = await import('../../../store/json.js');
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
    delete process.env.ENCRYPTION_KEY;
    __resetFetch();
  });

  beforeEach(async () => {
    await rm(store.configPath(), { force: true });
    await rm(store.agentsPath(), { force: true });
    const cfg: CaretakerConfig = {
      port: 17777,
      providers: [{ name: 'anthropic', endpoint: 'http://x' }],
    };
    await store.saveConfig(cfg);
  });

  it('rejects when task is missing or empty', async () => {
    const out1 = await invokeAgentTool.execute({}, ctx(agent()));
    assert.match(out1.content, /^Error: task/);
    const out2 = await invokeAgentTool.execute({ task: '   ' }, ctx(agent()));
    assert.match(out2.content, /^Error: task/);
  });

  it('rejects when name is provided but the agent does not exist', async () => {
    const out = await invokeAgentTool.execute(
      { name: 'nonexistent', task: 'hi' },
      ctx(agent()),
    );
    assert.match(out.content, /not found/);
  });

  it('runs an anonymous sub-agent when name is omitted', async () => {
    let capturedSystem: string | null = null;
    let capturedModel: string | undefined;
    __setFetch(async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        model?: string;
        messages?: Array<{ role: string; content: string | null }>;
      };
      capturedModel = body.model;
      capturedSystem = body.messages?.find((m) => m.role === 'system')?.content ?? null;
      return sseResponse(single('anon-result'));
    });

    const caller = agent({ provider: 'anthropic', model: 'claude-opus-4-7' });
    const out = await invokeAgentTool.execute({ task: 'analyze this' }, ctx(caller));
    assert.equal(out.content, 'anon-result');

    // Anonymous inherits the caller's model.
    assert.equal(capturedModel, 'claude-opus-4-7');
    // The caller's systemPrompt must NOT appear in the child's system
    // message — that was the whole point of the anonymous mode.
    const sys = capturedSystem as string | null;
    assert.ok(sys !== null);
    assert.ok(
      !sys.includes('I am the caller.'),
      "anonymous sub-agent must not carry the caller's identity",
    );
  });

  it('treats an empty-string name as anonymous (not a lookup error)', async () => {
    __setFetch(async () => sseResponse(single('ok')));
    const out = await invokeAgentTool.execute(
      { name: '', task: 'go' },
      ctx(agent({ provider: 'anthropic', model: 'm' })),
    );
    assert.equal(out.content, 'ok');
  });

  it('looks up by name when name is provided', async () => {
    const target: AgentConfig = {
      id: randomUUID(),
      name: 'specialist',
      systemPrompt: 'I am a specialist.',
      provider: '',
      model: '',
      allowedTools: [],
      maxTurns: 5,
    };
    await store.saveAgents([target]);

    let capturedSystem: string | null = null;
    __setFetch(async (_url, init) => {
      const body = JSON.parse(init.body as string) as {
        messages?: Array<{ role: string; content: string | null }>;
      };
      capturedSystem = body.messages?.find((m) => m.role === 'system')?.content ?? null;
      return sseResponse(single('specialist-said-this'));
    });

    const out = await invokeAgentTool.execute(
      { name: 'specialist', task: 'do the thing' },
      ctx(agent({ provider: 'anthropic', model: 'opus' })),
    );
    assert.equal(out.content, 'specialist-said-this');
    // Named target keeps its OWN systemPrompt (identity preserved).
    const sys = capturedSystem as string | null;
    assert.ok(sys !== null);
    assert.match(sys, /I am a specialist\./);
  });
});
