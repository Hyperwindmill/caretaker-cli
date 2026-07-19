// Claude Code runner: implements the same run() contract as loop.ts by
// spawning one `claude -p --output-format stream-json` process per turn.
// Claude Code owns the agentic loop, tools, and permissions; caretaker
// owns display persistence (via cb.onMessage) and session continuity
// (claudeSessionId on the session meta, resumed with --resume).

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunCallbacks, RunResult } from './loop.js';
import type { AssistantUsage } from './provider.js';
import { parseClaudeStreamLine } from './claude_code_stream.js';
import { loadContextFiles, formatContextBlock, resolveFileReferences } from './context_files.js';
import {
  readSession,
  updateClaudeSessionId,
  assistantMessage,
  toolMessage,
} from '../session/store.js';
import type { AssistantPart, MessageRecord } from '../session/types.js';
import { loadMcpServers } from '../store/json.js';
import { resolvedServerRuntime } from '../mcp/client.js';
import { DOCKER_BASH_HOOK_SCRIPT, dockerClaudeSettings } from '../lib/docker.js';

export type ClaudeCodeRunExtras = {
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  docker?: { container: string; workdir: string };
};

// ─── test hooks (same pattern as loop.ts __setFetch) ────────────────────
// `child_process.spawn` is a heavily overloaded function keyed off the
// `stdio` option's literal type; the runner always calls it the same way
// (3 args, stdio: ['pipe','pipe','pipe']), so we pin down a narrow
// structural shape here rather than fight the overload set — this is also
// exactly what a FakeChild test double needs to satisfy.
export type ClaudeChildProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};
type SpawnFn = (command: string, args: string[], opts: SpawnOptions) => ClaudeChildProcess;
let spawnImpl: SpawnFn = nodeSpawn as unknown as SpawnFn;
export function __setSpawn(fn: SpawnFn): void {
  spawnImpl = fn;
}
export function __resetSpawn(): void {
  spawnImpl = nodeSpawn as unknown as SpawnFn;
}

export function detectClaudeDefaultPermissionMode(
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): string | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const mode = raw?.permissions?.defaultMode;
    return typeof mode === 'string' && mode.length > 0 ? mode : null;
  } catch {
    return null;
  }
}

export interface ClaudeArgsInput {
  model?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfigPath?: string;
  settingsPath?: string;
  resumeId?: string;
  persistSession: boolean;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (i.model) args.push('--model', i.model);
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  if (i.appendSystemPrompt) args.push('--append-system-prompt', i.appendSystemPrompt);
  if (i.allowedTools?.length) args.push('--allowedTools', ...i.allowedTools);
  if (i.disallowedTools?.length) args.push('--disallowedTools', ...i.disallowedTools);
  if (i.mcpConfigPath) args.push('--mcp-config', i.mcpConfigPath, '--strict-mcp-config');
  if (i.settingsPath) args.push('--settings', i.settingsPath);
  if (i.resumeId) args.push('--resume', i.resumeId);
  else if (!i.persistSession) args.push('--no-session-persistence');
  return args;
}

/** Role restrictions + task-bridge wiring for autonomous task runs. */
export function claudeCodeTaskExtras(p: {
  planning: boolean;
  sdd: boolean;
  bridge?: { url: string; token: string };
}): ClaudeCodeRunExtras {
  const extraMcpServers = p.bridge
    ? {
        task: {
          type: 'http' as const,
          url: p.bridge.url,
          headers: { Authorization: `Bearer ${p.bridge.token}` },
        },
      }
    : undefined;
  if (!p.planning) return { permissionMode: 'bypassPermissions', extraMcpServers };
  // Planner: 'manual' mode + explicit allowlist. In -p mode unanswered
  // permission prompts are denied, so everything off-list is blocked.
  // (Not 'plan' mode: it could also block mcp task_submit_plan.)
  const allowedTools = ['Read', 'Glob', 'Grep', 'mcp__task'];
  if (p.sdd) allowedTools.push('Write(**/*.md)', 'Edit(**/*.md)', 'MultiEdit(**/*.md)');
  return { permissionMode: 'manual', allowedTools, disallowedTools: ['Bash'], extraMcpServers };
}

async function buildMcpConfigFile(
  serverIds: string[],
  extra: ClaudeCodeRunExtras['extraMcpServers'],
): Promise<{ configPath: string; cleanup: () => Promise<void> } | null> {
  const servers: Record<string, unknown> = {};
  if (serverIds.length > 0) {
    const file = await loadMcpServers();
    for (const id of serverIds) {
      const cfg = file.servers.find((s) => s.id === id);
      if (!cfg) continue;
      const resolved = await resolvedServerRuntime(cfg).catch(() => null);
      if (!resolved) {
        console.warn(
          `[claude-code] skipping MCP server "${id}" (disabled or no usable credentials)`,
        );
        continue;
      }
      servers[id] = resolved;
    }
  }
  for (const [name, def] of Object.entries(extra ?? {})) servers[name] = def;
  if (Object.keys(servers).length === 0) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caretaker-mcp-'));
  const configPath = path.join(dir, 'mcp-config.json');
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return { configPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function foldHistory(history: MessageRecord[] | undefined, prompt: string): string {
  if (!history?.length) return prompt;
  const lines = history.filter((m) => m.role !== 'tool').map((m) => `[${m.role}] ${m.content}`);
  return `<conversation-history>\n${lines.join('\n')}\n</conversation-history>\n\n${prompt}`;
}

const zeroUsage = (): AssistantUsage => ({ input: 0, output: 0 });
function addUsage(into: AssistantUsage, u: AssistantUsage): void {
  into.input += u.input;
  into.output += u.output;
  if (u.cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + u.cacheRead;
  if (u.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + u.cacheWrite;
}

type ResultEvent = { subtype: string; text: string; usage?: AssistantUsage; isError: boolean };

type AttemptResult = {
  exitCode: number | null;
  aborted: boolean;
  text: string;
  toolCalls: number;
  cumulative: AssistantUsage;
  claudeSessionId?: string;
  resultEvent?: ResultEvent;
  stderrTail: string;
};

/** One spawn-and-read cycle of the Claude Code CLI. Does not throw on a
 *  non-zero exit — the caller (runClaudeCode) decides whether to retry. */
async function attemptRun(
  command: string,
  args: string[],
  prompt: string,
  workingDir: string,
  signal: AbortSignal | undefined,
  cb: RunCallbacks,
): Promise<AttemptResult> {
  const safeEmit = async (fn: (() => void | Promise<void>) | undefined) => {
    try {
      await fn?.();
    } catch (err) {
      console.warn('[claude-code] callback error:', err);
    }
  };

  const cumulative = zeroUsage();
  let text = '';
  let toolCalls = 0;
  let claudeSessionId: string | undefined;
  let resultEvent: ResultEvent | undefined;
  let aborted = false;
  let stderrTail = '';

  // Assistant events arrive one block per event, sharing the message id;
  // merge them and flush one MessageRecord per anthropic message.
  let pending: { id: string; parts: AssistantPart[]; usage?: AssistantUsage } | null = null;
  const flushPending = async () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    for (const part of p.parts) if (part.type === 'text') text += part.text;
    if (p.usage) {
      addUsage(cumulative, p.usage);
      await safeEmit(() => cb.onUsage?.(p.usage!));
    }
    await safeEmit(() => cb.onMessage?.(assistantMessage(p.parts, p.usage)));
  };

  const child = spawnImpl(command, args, {
    cwd: workingDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const onAbort = () => {
    aborted = true;
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + String(d)).slice(-4096);
  });

  const spawnError: Promise<never> = new Promise((_, reject) =>
    child.on('error', (err) => {
      let message = `claude-code runner failed to start "${command}": ${err.message}`;
      if (process.platform === 'win32') {
        message +=
          ' On Windows, point the provider "command" at the Claude Code executable (e.g. claude.exe) — npm .cmd shims cannot be spawned directly.';
      }
      reject(new Error(message));
    }),
  );
  const closed: Promise<number | null> = new Promise((resolve) =>
    child.on('close', (code) => resolve(code)),
  );

  child.stdin?.write(prompt);
  child.stdin?.end();

  const rl = createInterface({ input: child.stdout! });
  const reading = (async () => {
    for await (const line of rl) {
      for (const evt of parseClaudeStreamLine(line)) {
        switch (evt.kind) {
          case 'init':
            claudeSessionId = evt.sessionId;
            break;
          case 'text':
            await safeEmit(() => cb.onChunk?.(evt.text));
            break;
          case 'thinking':
            await safeEmit(() => cb.onThinking?.(evt.text));
            break;
          case 'assistant_message': {
            if (pending && pending.id !== evt.id) await flushPending();
            if (!pending) pending = { id: evt.id, parts: [], usage: undefined };
            pending.parts.push(...evt.parts);
            if (evt.usage) pending.usage = evt.usage; // latest event wins per message
            for (const part of evt.parts) {
              if (part.type === 'tool_use') {
                toolCalls += 1;
                await safeEmit(() => cb.onToolCall?.(part.id, part.name, part.args));
              }
            }
            break;
          }
          case 'tool_result':
            await flushPending();
            await safeEmit(() => cb.onToolResult?.(evt.toolUseId, evt.content));
            await safeEmit(() => cb.onMessage?.(toolMessage(evt.toolUseId, evt.content)));
            break;
          case 'result':
            await flushPending();
            resultEvent = evt;
            break;
        }
      }
    }
  })();

  const exitCode = await Promise.race([
    Promise.all([reading, closed]).then(([, c]) => c),
    spawnError,
  ]);
  await flushPending();
  signal?.removeEventListener('abort', onAbort);

  return {
    exitCode,
    aborted,
    text,
    toolCalls,
    cumulative,
    claudeSessionId,
    resultEvent,
    stderrTail,
  };
}

export async function runClaudeCode(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  const { agent, provider } = opts;
  const workingDir = opts.workingDir ?? process.cwd();

  // 1. Resume id from session meta (chat surfaces pass sessionId).
  let resumeId: string | undefined;
  if (opts.sessionId) {
    try {
      resumeId = (await readSession(agent.id, opts.sessionId)).meta.claudeSessionId;
    } catch {
      /* new session */
    }
  }

  // 2. --append-system-prompt: agent identity + non-CLAUDE.md context files
  //    (Claude Code auto-loads CLAUDE.md itself; AGENTS.md/GEMINI.md and
  //    ~/.caretaker/AGENTS.md it does not — verified on CLI 2.1.207).
  const sys = await resolveFileReferences(agent.systemPrompt ?? '', workingDir);
  const ctxEntries = (await loadContextFiles(workingDir)).filter(
    (e) => path.basename(e.path) !== 'CLAUDE.md',
  );
  const appendSystemPrompt = [sys, ctxEntries.length ? formatContextBlock(ctxEntries) : '']
    .filter(Boolean)
    .join('\n\n');

  // 3. Per-run mcp-config temp file (agent's servers + injected bridge).
  const mcp = await buildMcpConfigFile(agent.mcpServers ?? [], opts.claudeCode?.extraMcpServers);

  // Per-run --settings temp file: registers the PreToolUse Bash-rewrite hook
  // so claude-code shell commands run inside the task's docker container.
  let settings: { settingsPath: string; cleanup: () => Promise<void> } | null = null;
  if (opts.claudeCode?.docker) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'caretaker-cc-settings-'));
    const hookPath = path.join(dir, 'docker-hook.mjs');
    await writeFile(hookPath, DOCKER_BASH_HOOK_SCRIPT, { mode: 0o700 });
    const settingsPath = path.join(dir, 'settings.json');
    const obj = dockerClaudeSettings(opts.claudeCode.docker.container, opts.claudeCode.docker.workdir, hookPath);
    await writeFile(settingsPath, JSON.stringify(obj), { mode: 0o600 });
    settings = { settingsPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  const permissionMode =
    opts.claudeCode?.permissionMode ??
    agent.permissionMode ??
    detectClaudeDefaultPermissionMode() ??
    'acceptEdits';

  const command = provider.command || 'claude';

  const runAttempt = (resume: string | undefined) => {
    const args = buildClaudeArgs({
      model: agent.model,
      permissionMode,
      appendSystemPrompt: appendSystemPrompt || undefined,
      allowedTools: opts.claudeCode?.allowedTools,
      disallowedTools: opts.claudeCode?.disallowedTools,
      mcpConfigPath: mcp?.configPath,
      settingsPath: settings?.settingsPath,
      resumeId: resume,
      persistSession: Boolean(opts.sessionId),
    });
    // History only folds into the prompt when there is no CC session to resume.
    const prompt = resume ? opts.prompt : foldHistory(opts.history, opts.prompt);
    return attemptRun(command, args, prompt, workingDir, opts.signal, cb);
  };

  try {
    let attempt = await runAttempt(resumeId);

    // A dead/GC'd --resume session id would otherwise wedge every future turn
    // (the CLI exits non-zero forever). Retry exactly once, folding history
    // into the prompt like a brand-new session; the post-run logic below then
    // persists whatever session id this attempt issues, overwriting the stale
    // one. If the retry also fails, we fall through to the normal error path.
    if (!attempt.aborted && attempt.exitCode !== 0 && resumeId) {
      console.warn(
        `[claude-code] resume with session "${resumeId}" failed (exit ${attempt.exitCode}); retrying once without --resume`,
      );
      attempt = await runAttempt(undefined);
    }

    const {
      exitCode,
      aborted,
      text,
      toolCalls,
      cumulative,
      claudeSessionId,
      resultEvent,
      stderrTail,
    } = attempt;

    if (aborted) return { text, toolCalls, usage: cumulative, stop: 'aborted' };
    if (exitCode !== 0) {
      throw new Error(
        `claude-code runner: "${command}" exited with code ${exitCode}` +
          (stderrTail
            ? `: ${stderrTail.trim()}`
            : ' (is Claude Code installed and authenticated?)'),
      );
    }
    if (resultEvent?.usage) {
      // The result event's usage is authoritative for the whole run.
      cumulative.input = resultEvent.usage.input;
      cumulative.output = resultEvent.usage.output;
      if (resultEvent.usage.cacheRead !== undefined)
        cumulative.cacheRead = resultEvent.usage.cacheRead;
      if (resultEvent.usage.cacheWrite !== undefined)
        cumulative.cacheWrite = resultEvent.usage.cacheWrite;
    }
    if (opts.sessionId && claudeSessionId && claudeSessionId !== resumeId) {
      try {
        await updateClaudeSessionId({ agentId: agent.id, id: opts.sessionId }, claudeSessionId);
      } catch (err) {
        console.warn('[claude-code] failed to persist session id:', err);
      }
    }
    if (resultEvent?.isError) {
      if (resultEvent.subtype === 'error_max_turns') {
        return { text, toolCalls, usage: cumulative, stop: 'max_turns' };
      }
      throw new Error(
        `claude-code runner: ${resultEvent.subtype || 'error'}${resultEvent.text ? `: ${resultEvent.text}` : ''}`,
      );
    }
    return { text, toolCalls, usage: cumulative, stop: 'done' };
  } finally {
    await mcp?.cleanup().catch(() => {});
    await settings?.cleanup().catch(() => {});
  }
}
