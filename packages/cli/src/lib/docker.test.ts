import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerName, containerRunArgs, containerExecArgs } from './docker.js';

test('containerName is deterministic', () => {
  assert.equal(containerName(3, 42), 'caretaker-task-3-42');
});

test('containerRunArgs: identical-path mount, --user, --name, sleep infinity', () => {
  const args = containerRunArgs('c1', 'node:22', '/wt', '/wt/app', 1000, 1000);
  assert.deepEqual(args, [
    'run', '-d',
    '--user', '1000:1000',
    '-v', '/wt:/wt',
    '-w', '/wt/app',
    '--name', 'c1',
    'node:22',
    'sleep', 'infinity',
  ]);
});

test('containerRunArgs: omits --user when uid/gid undefined', () => {
  const args = containerRunArgs('c1', 'node:22', '/wt', '/wt', undefined, undefined);
  assert.equal(args.includes('--user'), false);
});

test('containerExecArgs wraps in sh -lc', () => {
  assert.deepEqual(containerExecArgs('c1', '/wt/app', 'ls -a'), [
    'exec', '-w', '/wt/app', 'c1', 'sh', '-lc', 'ls -a',
  ]);
});

import { DOCKER_BASH_HOOK_SCRIPT, dockerClaudeSettings, dockerDevAllowlist } from './docker.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dockerClaudeSettings registers a PreToolUse Bash hook', () => {
  const s = dockerClaudeSettings('c1', '/wt/app', '/tmp/h.mjs') as any;
  const entry = s.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'node /tmp/h.mjs c1 /wt/app');
});

test('dockerDevAllowlist confines writers to workdir, allows Bash', () => {
  const a = dockerDevAllowlist('/wt/app');
  assert.ok(a.includes('Bash'));
  assert.ok(a.includes('mcp__task'));
  assert.ok(a.some((r) => r.startsWith('Edit(') && r.includes('/wt/app')));
  assert.ok(a.some((r) => r.startsWith('Write(') && r.includes('/wt/app')));
});

test('DOCKER_BASH_HOOK_SCRIPT wraps stdin command in docker exec (base64 round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-hook-test-'));
  const script = join(dir, 'hook.mjs');
  writeFileSync(script, DOCKER_BASH_HOOK_SCRIPT);
  const payload = JSON.stringify({ tool_input: { command: 'echo "hi there" && ls' } });
  const out = execFileSync('node', [script, 'c1', '/wt/app'], { input: payload }).toString();
  const parsed = JSON.parse(out);
  const wrapped = parsed.hookSpecificOutput.updatedInput.command;
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(wrapped.startsWith('docker exec -w /wt/app c1 sh -lc '));
  // the base64 payload decodes back to the original command
  const b64 = wrapped.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)![1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'echo "hi there" && ls');
});

