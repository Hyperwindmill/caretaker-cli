// Per-task shell tool for ACP runs under Docker confinement: the ACP policy
// denies every kind:'execute' tool call, and this bridge-injected tool is the
// only shell path — confined to the task's container by construction. Built
// per token (bound container), so it is never part of the registry and never
// served by the stdio `caretaker-cli mcp` server (no container to bind there).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../harness/tools/index.js';
import { containerExecArgs } from '../lib/docker.js';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';

const TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 30_000;

type ExecFn = (cmd: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>;
const realExec: ExecFn = promisify(execFile) as unknown as ExecFn;
let execImpl: ExecFn = realExec;
export function __setExec(fn: ExecFn): void {
  execImpl = fn;
}
export function __resetExec(): void {
  execImpl = realExec;
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]' : s;
}

export function makeRunCommandTool(bind: { container: string; workdir: string }): Tool {
  return {
    name: 'mcp__task__run_command',
    description:
      "Run a shell command inside this task's Docker container (the only way to execute " +
      'commands in this run — direct shell tool calls are denied). Runs from the task ' +
      `working directory. 5-minute timeout, output capped at ${MAX_OUTPUT_CHARS} chars.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run (sh -c syntax).' },
      },
      required: ['command'],
    },
    execute: async (args) => {
      const command = String((args as { command?: unknown })?.command ?? '').trim();
      if (!command) return { content: 'Error: command is required' };
      try {
        const { stdout, stderr } = await execImpl(
          'docker',
          containerExecArgs(bind.container, bind.workdir, command),
          { env: commandEnv(), timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        );
        return { content: cap([stdout, stderr].filter(Boolean).join('\n')) || '(no output)' };
      } catch (err: any) {
        const out = [err?.stdout, err?.stderr].filter(Boolean).join('\n');
        const code = err?.code ?? 'unknown';
        return { content: cap(`Error: exit code ${code}\n${out || err?.message || ''}`) };
      }
    },
  };
}
