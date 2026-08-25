import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunCommandTool, __setExec, __resetExec } from './run_command_tool.js';
import type { ToolContext } from '../harness/tools/index.js';

const ctx: ToolContext = { workingDir: '/w', signal: new AbortController().signal, readPaths: new Set() };

afterEach(__resetExec);

test('run_command execs docker with containerExecArgs and returns output', async () => {
  let seen: { cmd: string; args: string[] } | null = null;
  __setExec(async (cmd, args) => {
    seen = { cmd, args };
    return { stdout: 'ok\n', stderr: '' };
  });
  const tool = makeRunCommandTool({ container: 'caretaker-task-t1', workdir: '/w' });
  assert.equal(tool.name, 'mcp__task__run_command');
  const res = await tool.execute({ command: 'ls -la' }, ctx);
  assert.match(res.content, /ok/);
  assert.deepEqual(seen!.args, ['exec', '-w', '/w', 'caretaker-task-t1', 'sh', '-lc', 'ls -la']);
});

test('missing command arg errors without exec', async () => {
  __setExec(async () => {
    throw new Error('should not run');
  });
  const tool = makeRunCommandTool({ container: 'c', workdir: '/w' });
  const res = await tool.execute({}, ctx);
  assert.match(res.content, /Error: command is required/);
});

test('non-zero exit reports code and output', async () => {
  __setExec(async () => {
    const err: any = new Error('failed');
    err.code = 2;
    err.stdout = '';
    err.stderr = 'boom';
    throw err;
  });
  const tool = makeRunCommandTool({ container: 'c', workdir: '/w' });
  const res = await tool.execute({ command: 'false' }, ctx);
  assert.match(res.content, /exit code 2/);
  assert.match(res.content, /boom/);
});
