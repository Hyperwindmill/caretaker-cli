// Task-agnostic Docker container primitives. The container NAME is always a
// parameter — this module knows nothing about tasks/projects, so a future
// agent-level isolation can reuse it with a different naming scheme + mount.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandEnv } from '../harness/tools/builtin/shell-env.js';

const exec = promisify(execFile);

/** Deterministic container name for a task — the caller's naming policy. */
export function containerName(projectId: number, taskId: number): string {
  return `caretaker-task-${projectId}-${taskId}`;
}

/** `docker run` argv. Mount is identical-path (`-v <root>:<root>`) so host and
 *  container agree on absolute paths. `--user` keeps written files owned by the
 *  host user (else root-owned files break the host WIP commit / review diff).
 *  ponytail: if an image lacks a matching /etc/passwd entry, set HOME=/tmp; tune when a real image needs it. */
export function containerRunArgs(
  name: string,
  image: string,
  mountRoot: string,
  workdir: string,
  uid?: number,
  gid?: number,
): string[] {
  const args = ['run', '-d'];
  if (typeof uid === 'number' && typeof gid === 'number') {
    args.push('--user', `${uid}:${gid}`);
  }
  args.push('-v', `${mountRoot}:${mountRoot}`, '-w', workdir, '--name', name, image, 'sleep', 'infinity');
  return args;
}

export function containerExecArgs(name: string, cwd: string, cmd: string): string[] {
  return ['exec', '-w', cwd, name, 'sh', '-lc', cmd];
}

/** Returns 'running' | 'stopped' | 'absent' for a container name. */
async function containerState(name: string): Promise<'running' | 'stopped' | 'absent'> {
  try {
    const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      env: commandEnv(),
    });
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

/** Idempotent: reuse a running container of this name; recreate a stopped/absent one. */
export async function ensureContainer(
  name: string,
  image: string,
  mountRoot: string,
  workdir: string,
): Promise<void> {
  const state = await containerState(name);
  if (state === 'running') return;
  if (state === 'stopped') await removeContainer(name);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  await exec('docker', containerRunArgs(name, image, mountRoot, workdir, uid, gid), {
    env: commandEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Run one command in the container. Never throws on a non-zero exit — returns
 *  the code + combined output, mirroring the bash tool's contract. */
export async function execInContainer(
  name: string,
  cwd: string,
  cmd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await exec('docker', containerExecArgs(name, cwd, cmd), {
      env: commandEnv(),
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { exitCode: code, output: (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '') };
  }
}

export async function removeContainer(name: string): Promise<void> {
  await exec('docker', ['rm', '-f', name], { env: commandEnv() }).catch(() => {});
}

// PreToolUse hook: rewrite every Bash command so it runs inside the container.
// Mechanical (not a prompt instruction) — the agent cannot forget. argv:
// [container, workdir]. base64 dodges nested-quote hell in the wrapped command.
export const DOCKER_BASH_HOOK_SCRIPT = `let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const [container, workdir] = process.argv.slice(2);
  let cmd = '';
  try { cmd = JSON.parse(raw)?.tool_input?.command ?? ''; } catch { cmd = ''; }
  const b64 = Buffer.from(cmd, 'utf8').toString('base64');
  const wrapped = \`docker exec -w \${workdir} \${container} sh -lc "echo \${b64} | base64 -d | sh"\`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: wrapped } },
  }));
});
`;

export function dockerClaudeSettings(
  container: string,
  workdir: string,
  hookScriptPath: string,
): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${hookScriptPath} ${container} ${workdir}` }],
        },
      ],
    },
  };
}

/** Confine claude-code file tools to the working dir. Bash is allowed (the docker
 *  hook contains it); writers are path-scoped to workdir; mcp__task stays open. */
export function dockerDevAllowlist(workdir: string): string[] {
  const scope = `${workdir}/**`;
  return [
    `Read(${scope})`,
    `Edit(${scope})`,
    `Write(${scope})`,
    `MultiEdit(${scope})`,
    'Glob',
    'Grep',
    'mcp__task',
    'Bash',
  ];
}

