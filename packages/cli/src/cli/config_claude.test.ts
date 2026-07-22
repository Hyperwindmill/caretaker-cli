import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureClaude, type Runner } from './config_claude.js';

/** Builds a runner whose responses are keyed by the first arg after `claude`
 *  (or the raw cmd for non-claude calls), recording every call. */
function mockRunner(
  responses: Record<string, { code: number; stdout?: string; stderr?: string }>,
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = cmd === 'claude' ? (args[0] === 'mcp' ? `mcp ${args[1]}` : args[0]) : cmd;
    const r = responses[key] ?? { code: 0 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code };
  };
  return { run, calls };
}

test('configureClaude: aborts when claude CLI is absent', async () => {
  const { run, calls } = mockRunner({ '--version': { code: 127 } });
  const code = await configureClaude(run, () => {});
  assert.equal(code, 1);
  // Never attempts to add when claude is missing.
  assert.ok(!calls.some((c) => c[1] === 'mcp' && c[2] === 'add'));
});

test('configureClaude: idempotent when already configured', async () => {
  const { run, calls } = mockRunner({
    '--version': { code: 0, stdout: '2.1.0' },
    which: { code: 0 },
    'mcp get': { code: 0 },
  });
  const code = await configureClaude(run, () => {});
  assert.equal(code, 0);
  assert.ok(!calls.some((c) => c[1] === 'mcp' && c[2] === 'add'));
});

test('configureClaude: adds the server when missing', async () => {
  const { run, calls } = mockRunner({
    '--version': { code: 0, stdout: '2.1.0' },
    which: { code: 0 },
    'mcp get': { code: 1 },
    'mcp add': { code: 0 },
  });
  const code = await configureClaude(run, () => {});
  assert.equal(code, 0);
  const addCall = calls.find((c) => c[1] === 'mcp' && c[2] === 'add');
  assert.deepEqual(addCall, [
    'claude',
    'mcp',
    'add',
    'caretaker',
    '-s',
    'user',
    '--',
    'caretaker-cli',
    'mcp',
  ]);
});

test('configureClaude: propagates a failed add', async () => {
  const { run } = mockRunner({
    '--version': { code: 0 },
    which: { code: 0 },
    'mcp get': { code: 1 },
    'mcp add': { code: 1, stderr: 'boom' },
  });
  const code = await configureClaude(run, () => {});
  assert.equal(code, 1);
});
