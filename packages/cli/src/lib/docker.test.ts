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
