import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-ccrun-'));

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runClaudeCode,
  buildClaudeArgs,
  detectClaudeDefaultPermissionMode,
  claudeCodeTaskExtras,
  __setSpawn,
  __resetSpawn,
} from './claude_code_runner.js';
import { createSession, readSession } from '../session/store.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const provider: ProviderConfig = { name: 'cc', type: 'claude-code', endpoint: '' };
const agent: AgentConfig = {
  id: 'ag1',
  name: 'A',
  systemPrompt: 'You are A.',
  provider: 'cc',
  model: 'sonnet',
  allowedTools: [],
  maxTurns: 30,
};

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

let lastSpawn: { command: string; args: string[]; opts: any } | null = null;
function useFixture(name: string, exitCode = 0): () => FakeChild {
  let child!: FakeChild;
  __setSpawn((command: string, args: string[], opts: any) => {
    lastSpawn = { command, args, opts };
    child = new FakeChild(fixtureLines(name), exitCode);
    return child as any;
  });
  return () => child;
}

afterEach(() => {
  __resetSpawn();
  lastSpawn = null;
});

test('buildClaudeArgs: full flag surface', () => {
  const args = buildClaudeArgs({
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    appendSystemPrompt: 'SYS',
    allowedTools: ['Read', 'mcp__task'],
    disallowedTools: ['Bash'],
    mcpConfigPath: '/tmp/x.json',
    strictMcp: true,
    resumeId: 'abc',
    persistSession: true,
  });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    'sonnet',
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    'SYS',
    '--allowedTools',
    'Read',
    'mcp__task',
    '--disallowedTools',
    'Bash',
    '--mcp-config',
    '/tmp/x.json',
    '--strict-mcp-config',
    '--resume',
    'abc',
  ]);
  const oneShot = buildClaudeArgs({ model: 'sonnet', persistSession: false });
  assert.ok(oneShot.includes('--no-session-persistence'));
  assert.ok(!oneShot.includes('--resume'));
});

test('buildClaudeArgs: --strict-mcp-config is gated on strictMcp (default merge)', () => {
  const merged = buildClaudeArgs({ mcpConfigPath: '/tmp/x.json', persistSession: false });
  assert.ok(merged.includes('--mcp-config'));
  assert.ok(!merged.includes('--strict-mcp-config'));
  const strict = buildClaudeArgs({
    mcpConfigPath: '/tmp/x.json',
    strictMcp: true,
    persistSession: false,
  });
  assert.ok(strict.includes('--strict-mcp-config'));
  // strictMcp without a config path emits nothing.
  const none = buildClaudeArgs({ strictMcp: true, persistSession: false });
  assert.ok(!none.includes('--strict-mcp-config'));
});

test('runClaudeCode maps stream to callbacks, messages, RunResult', async () => {
  useFixture('claude_code_stream_tooluse.jsonl');
  const chunks: string[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];
  const messages: any[] = [];
  const thinking: string[] = [];
  const result = await runClaudeCode(
    { agent, provider, tools: [], prompt: 'read package.json', workingDir: process.cwd() },
    {
      onChunk: (c) => chunks.push(c),
      onThinking: (t) => thinking.push(t),
      onToolCall: (id, name, args) => toolCalls.push({ id, name, args }),
      onToolResult: (id, content) => toolResults.push({ id, content }),
      onMessage: (m) => {
        messages.push(m);
      },
    },
  );
  assert.equal(result.stop, 'done');
  assert.equal(result.toolCalls, 2);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolResults.length, 2);
  assert.ok(result.text.length > 0);
  assert.ok(result.usage.output > 0);
  // one assistant record per anthropic message id + one tool record per tool_result
  const assistantRecords = messages.filter((m) => m.role === 'assistant');
  const toolRecords = messages.filter((m) => m.role === 'tool');
  assert.equal(toolRecords.length, 2);
  assert.ok(assistantRecords.length >= 2);
  assert.ok(assistantRecords.some((m) => m.parts?.some((p: any) => p.type === 'tool_use')));
  // prompt travels via stdin, not argv
  assert.ok(!lastSpawn!.args.includes('read package.json'));
});

test('session resume: persists claudeSessionId and passes --resume next turn', async () => {
  const meta = await createSession({ agentId: agent.id, title: 't' });
  useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode({ agent, provider, tools: [], prompt: 'hi', sessionId: meta.id }, {});
  const stored = (await readSession(agent.id, meta.id)).meta.claudeSessionId;
  assert.ok(stored && stored.length > 10);
  assert.ok(!lastSpawn!.args.includes('--resume'));
  useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode({ agent, provider, tools: [], prompt: 'again', sessionId: meta.id }, {});
  const i = lastSpawn!.args.indexOf('--resume');
  assert.ok(i >= 0);
  assert.equal(lastSpawn!.args[i + 1], stored);
});

test('no sessionId: history folded into prompt, --no-session-persistence set', async () => {
  const getChild = useFixture('claude_code_stream_text.jsonl');
  await runClaudeCode(
    {
      agent,
      provider,
      tools: [],
      prompt: 'continue',
      history: [
        {
          v: 1,
          type: 'message',
          id: 'm1',
          role: 'user',
          content: 'earlier question',
          createdAt: 'x',
        } as any,
        {
          v: 1,
          type: 'message',
          id: 'm2',
          role: 'assistant',
          content: 'earlier answer',
          createdAt: 'x',
        } as any,
      ],
    },
    {},
  );
  assert.ok(lastSpawn!.args.includes('--no-session-persistence'));
  assert.ok(getChild().stdinData.includes('earlier question'));
  assert.ok(getChild().stdinData.includes('continue'));
});

test('stale --resume retries once without --resume, then persists the new session id', async () => {
  const meta = await createSession({ agentId: agent.id, title: 't' });
  const { updateClaudeSessionId } = await import('../session/store.js');
  await updateClaudeSessionId({ agentId: agent.id, id: meta.id }, 'stale-session-id');

  const spawns: { command: string; args: string[] }[] = [];
  __setSpawn((command: string, args: string[]) => {
    spawns.push({ command, args });
    // First attempt: exits non-zero (fixture lines irrelevant). Second
    // attempt: succeeds with the text fixture.
    if (spawns.length === 1) return new FakeChild([], 1) as any;
    return new FakeChild(fixtureLines('claude_code_stream_text.jsonl'), 0) as any;
  });

  const result = await runClaudeCode(
    { agent, provider, tools: [], prompt: 'hi', sessionId: meta.id },
    {},
  );

  assert.equal(result.stop, 'done');
  assert.equal(spawns.length, 2);
  assert.ok(spawns[0]!.args.includes('--resume'));
  assert.ok(!spawns[1]!.args.includes('--resume'));

  const stored = (await readSession(agent.id, meta.id)).meta.claudeSessionId;
  assert.equal(stored, '12a7ded1-dabe-4d88-9262-a60a6869cf93'); // session id from the fixture's init event
});

test('non-zero exit throws with stderr tail', async () => {
  useFixture('claude_code_stream_text.jsonl', 1);
  await assert.rejects(
    () => runClaudeCode({ agent, provider, tools: [], prompt: 'x' }, {}),
    /claude.*exited/i,
  );
});

test('abort kills the child and returns stop=aborted', async () => {
  const ac = new AbortController();
  __setSpawn(() => {
    const child = new FakeChild([], 0);
    // never end stdin flow; abort must resolve the run
    (child.stdin as any).on('finish', () => {});
    setImmediate(() => ac.abort());
    return child as any;
  });
  // Note: FakeChild replays on stdin finish; here we rely on kill() emitting close.
  const result = await runClaudeCode(
    { agent, provider, tools: [], prompt: 'x', signal: ac.signal },
    {},
  );
  assert.equal(result.stop, 'aborted');
});

test('detectClaudeDefaultPermissionMode reads permissions.defaultMode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ct-ccset-'));
  const p = path.join(dir, 'settings.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.equal(detectClaudeDefaultPermissionMode(p), 'bypassPermissions');
  assert.equal(detectClaudeDefaultPermissionMode(path.join(dir, 'missing.json')), null);
});

test('claudeCodeTaskExtras: developer / planner / planner+sdd', () => {
  const bridge = { url: 'http://127.0.0.1:3000/api/mcp/task', token: 'tok' };
  const dev = claudeCodeTaskExtras({ planning: false, sdd: false, bridge });
  assert.equal(dev.permissionMode, 'bypassPermissions');
  assert.equal(dev.extraMcpServers?.task.url, bridge.url);
  assert.equal(dev.extraMcpServers?.task.headers?.Authorization, 'Bearer tok');
  const plan = claudeCodeTaskExtras({ planning: true, sdd: false, bridge });
  assert.equal(plan.permissionMode, 'dontAsk');
  assert.deepEqual(plan.allowedTools, ['Read', 'Glob', 'Grep', 'mcp__task']);
  assert.deepEqual(plan.disallowedTools, ['Bash']);
  const sdd = claudeCodeTaskExtras({ planning: true, sdd: true, bridge });
  assert.deepEqual(sdd.allowedTools, [
    'Read',
    'Glob',
    'Grep',
    'mcp__task',
    'Write(**/*.md)',
    'Edit(**/*.md)',
    'MultiEdit(**/*.md)',
  ]);
  const noBridge = claudeCodeTaskExtras({ planning: false, sdd: false });
  assert.equal(noBridge.extraMcpServers, undefined);
});

test('buildClaudeArgs emits --settings when settingsPath is set', () => {
  const args = buildClaudeArgs({ persistSession: false, settingsPath: '/tmp/s.json' });
  const i = args.indexOf('--settings');
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], '/tmp/s.json');
});

test('spawn env merges the probed interactive-shell PATH + version-manager vars', async () => {
  const { setShellEnvForTest } = await import('./tools/builtin/shell-env.js');
  setShellEnvForTest({ PATH: '/probed/nvm/bin', VOLTA_HOME: '/probed/volta' });
  try {
    useFixture('claude_code_stream_text.jsonl');
    await runClaudeCode({ agent, provider, tools: [], prompt: 'hi' }, {});
    const env = lastSpawn!.opts.env as NodeJS.ProcessEnv;
    // probed PATH is prepended so `claude` (and any stdio MCP it spawns) finds node
    assert.ok(env.PATH!.startsWith('/probed/nvm/bin:'));
    // version-manager var carried over
    assert.equal(env.VOLTA_HOME, '/probed/volta');
  } finally {
    setShellEnvForTest({});
  }
});

