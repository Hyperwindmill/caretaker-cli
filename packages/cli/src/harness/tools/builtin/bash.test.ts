import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { bashTool } from './bash.js';

function ctx(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    workingDir: tmpdir(),
    readPaths: new Set<string>(),
  };
}

test('bash: echo returns stdout with exit 0', async () => {
  const out = await bashTool.execute({ command: 'echo hi' }, ctx());
  assert.match(out.content, /^\[exit 0\]/);
  assert.match(out.content, /hi/);
});

test('bash: missing command returns error', async () => {
  const out = await bashTool.execute({}, ctx());
  assert.match(out.content, /Error: command must be/);
});

test('bash: non-zero exit is reported', async () => {
  const out = await bashTool.execute({ command: 'exit 3' }, ctx());
  assert.match(out.content, /^\[exit 3\]/);
});

test('bash: timeout kills the command', async () => {
  const out = await bashTool.execute({ command: 'sleep 5', timeoutMs: 100 }, ctx());
  assert.match(out.content, /\[killed after 100ms timeout\]/);
});

test('bash: external abort kills the command', async () => {
  const ac = new AbortController();
  const p = bashTool.execute({ command: 'sleep 5' }, ctx(ac.signal));
  setTimeout(() => ac.abort(), 50);
  const out = await p;
  assert.match(out.content, /\[aborted\]/);
});

test('bash: chatty output is truncated', async () => {
  // 60 KB of 'x' — over the 50 KB cap. Using node ensures portability across
  // /bin/sh variants (dash lacks bash brace expansion).
  const out = await bashTool.execute(
    { command: `node -e "process.stdout.write('x'.repeat(60000))"` },
    ctx(),
  );
  assert.match(out.content, /\[\.\.\.output truncated at 50000 bytes\]$/);
});

test('bash: secret env vars are scrubbed from the child env', async () => {
  process.env.MY_SUPER_TOKEN = 'shh';
  process.env.SOME_KEY = 'shh';
  process.env.CLAUDE_FOO = 'shh';
  process.env.PUBLIC_VAR = 'ok';
  try {
    const out = await bashTool.execute(
      {
        command:
          'node -e "console.log(process.env.MY_SUPER_TOKEN || \\"missing\\", process.env.SOME_KEY || \\"missing\\", process.env.CLAUDE_FOO || \\"missing\\", process.env.PUBLIC_VAR || \\"missing\\")"',
      },
      ctx(),
    );
    // Three secrets should be scrubbed; the public var should pass through.
    assert.match(out.content, /missing missing missing ok/);
  } finally {
    delete process.env.MY_SUPER_TOKEN;
    delete process.env.SOME_KEY;
    delete process.env.CLAUDE_FOO;
    delete process.env.PUBLIC_VAR;
  }
});

test('bash redirects into docker exec when ctx.dockerContainer is set', async () => {
  const res = await bashTool.execute(
    { command: 'echo docker-redirect-marker' },
    {
      signal: new AbortController().signal,
      workingDir: '/tmp',
      readPaths: new Set(),
      dockerContainer: '__caretaker_no_such_container__',
    } as any,
  );
  // No such container → docker exec fails fast; the point is the command was
  // routed to `docker`, not run on the host (host `echo` would have succeeded).
  assert.match(res.content, /docker|No such container|Cannot connect|not found/i);
  assert.doesNotMatch(res.content, /docker-redirect-marker/);
});

