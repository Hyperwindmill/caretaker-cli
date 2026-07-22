// `caretaker-cli config claude` — one-shot setup that registers caretaker's
// stdio MCP server (`caretaker-cli mcp`) in the user's Claude Code config, so
// an external Claude Code session can drive caretaker's task/project tools.
//
// This lives in the CLI (not the web/TUI settings) on purpose: the whole
// feature depends on `caretaker-cli` being installed, and if you can run this
// command then `caretaker-cli` is on your PATH — so the `caretaker-cli mcp`
// command we register is guaranteed to resolve when Claude Code spawns it.
//
// Writing the config is delegated to `claude mcp add` rather than editing
// ~/.claude.json ourselves, so we stay forward-compatible with their format.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Runs a command and normalizes the result to a plain exit code + output,
 *  so a non-zero exit is data (not a throw). Injectable for tests. */
export type Runner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunner: Runner = async (cmd, args) => {
  try {
    const { stdout, stderr } = await pexec(cmd, args);
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
};

export async function configureClaude(
  run: Runner = defaultRunner,
  log: (msg: string) => void = console.log,
): Promise<number> {
  // 1. Is Claude Code installed?
  const version = await run('claude', ['--version']);
  if (version.code !== 0) {
    log('✗ Claude Code CLI not found on PATH.');
    log('  Install it first: https://claude.com/product/claude-code');
    return 1;
  }
  log(`✓ Claude Code CLI found (${version.stdout.trim() || 'unknown version'})`);

  // Best-effort: warn if the command we're about to register won't resolve for
  // Claude Code (e.g. desktop-only users who never installed the CLI globally).
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const resolved = await run(whichCmd, ['caretaker-cli']);
  if (resolved.code !== 0) {
    log('  ⚠ caretaker-cli is not on your PATH — Claude Code may fail to launch the server.');
    log('    Install the CLI globally: npm i -g @hyperwindmill/caretaker-cli');
  }

  // 2. Already configured?
  const existing = await run('claude', ['mcp', 'get', 'caretaker']);
  if (existing.code === 0) {
    log('✓ caretaker MCP server already configured in Claude Code (user scope). Nothing to do.');
    return 0;
  }

  // 3. Add it (user scope = the standard per-user config).
  const add = await run('claude', ['mcp', 'add', 'caretaker', '-s', 'user', '--', 'caretaker-cli', 'mcp']);
  if (add.code !== 0) {
    log('✗ Failed to add the caretaker MCP server:');
    log(`  ${add.stderr.trim() || add.stdout.trim() || `exit ${add.code}`}`);
    return 1;
  }
  log('✓ Added caretaker MCP server to Claude Code (user scope).');
  log('  Restart your Claude Code sessions to pick it up, then the task/project tools are available.');
  return 0;
}
