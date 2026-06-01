import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '../types.js';
import { mergeShellEnv } from './shell-env.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on stdout+stderr we echo back to the model. The harness applies a
 *  separate global cap on tool results; this keeps memory bounded inside
 *  the bash tool itself for very chatty commands. */
const MAX_OUTPUT_BYTES = 50_000;

// Env var patterns scrubbed from the spawned child env. Mirrors caretaker
// server's policy in src/mcp/shell.ts: keep tokens/keys/secrets out of
// command-line tools the agent runs.
const SECRET_ENV_PATTERNS = [/^OPENCODE_/, /^CLAUDE_/, /_TOKEN$/, /_KEY$/, /_SECRET$/];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the environment for bash subprocesses.
 * On Linux, merges the probed interactive shell environment to capture
 * PATH and version manager variables (NVM, volta, fnm, etc.) that
 * .bashrc sets but which are missing in non-interactive shells.
 */
function bashEnv(): NodeJS.ProcessEnv {
  const base = scrubbedEnv();
  if (process.platform === 'linux') {
    return mergeShellEnv(base);
  }
  return base;
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command in the working directory. Returns the exit code, ' +
    'stdout and stderr concatenated. Output is capped at ~50 KB; the command ' +
    'is killed after the timeout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { command?: unknown; timeoutMs?: unknown };
    if (typeof a.command !== 'string' || !a.command.trim()) {
      return { content: 'Error: command must be a non-empty string' };
    }
    const timeout =
      typeof a.timeoutMs === 'number' && Number.isFinite(a.timeoutMs) && a.timeoutMs > 0
        ? a.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    return await new Promise((resolve) => {
      // On Linux, use bash -c with the probed interactive shell environment
      // to capture PATH and version manager variables (NVM, volta, fnm, etc.).
      // On Windows, fall back to cmd.exe via shell:true. On macOS, login
      // shells source profiles correctly so we use the default env.
      const isWindows = process.platform === 'win32';
      const child = isWindows
        ? spawn(a.command as string, [], {
            cwd: ctx.workingDir,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: bashEnv(),
          })
        : spawn('bash', ['-c', a.command as string], {
            cwd: ctx.workingDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: bashEnv(),
          });

      const decoder = new StringDecoder('utf8');
      let out = '';
      let truncated = false;
      const append = (chunk: Buffer) => {
        if (truncated) return;
        const room = MAX_OUTPUT_BYTES - out.length;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const s = decoder.write(chunk);
        if (s.length > room) {
          out += s.slice(0, room);
          truncated = true;
        } else {
          out += s;
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      let killReason: 'timeout' | 'abort' | null = null;
      const timer = setTimeout(() => {
        killReason = 'timeout';
        child.kill('SIGTERM');
      }, timeout);

      const onAbort = () => {
        killReason = 'abort';
        child.kill('SIGTERM');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ content: `Error: failed to spawn shell: ${err.message}` });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const flushed = decoder.end();
        if (flushed && !truncated) {
          const room = MAX_OUTPUT_BYTES - out.length;
          if (room > 0) out += flushed.slice(0, room);
        }
        const status =
          killReason === 'timeout'
            ? `[killed after ${timeout}ms timeout]`
            : killReason === 'abort'
              ? `[aborted]`
              : signal
                ? `[exit signal: ${signal}]`
                : `[exit ${code}]`;
        const tail = truncated ? `\n[...output truncated at ${MAX_OUTPUT_BYTES} bytes]` : '';
        resolve({ content: `${status}\n${out}${tail}` });
      });
    });
  },
};
