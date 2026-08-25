// ACP runner: implements the same run() contract as loop.ts by driving an
// Agent Client Protocol agent (claude-agent-acp, codex-acp, agy_acp_server, …)
// over JSON-RPC/stdio. The agent owns the loop and its tools; caretaker owns
// the permission policy (acp_policy.ts), display persistence (cb.onMessage),
// and session continuity (acpSessionId + session/load when supported).
//
// System prompt is fabricated client-side (ACP has no system-prompt field):
// the stable context block (agent systemPrompt + context files minus the
// runner's self-loaded ones — the mirror of claude-code's
// --append-system-prompt) rides the FIRST turn of each ACP session; volatile
// parts (<memories>, voice block) ride every turn. Under ACP the prompt enters
// history and accumulates, hence the split.

import path from 'node:path';
import type {
  ContentBlock,
  PromptResponse,
  SessionNotification,
  McpServer,
  Usage,
} from '@agentclientprotocol/sdk';
import type { RunOptions, RunCallbacks, RunResult } from './loop.js';
import type { AssistantUsage } from './provider.js';
import type { AssistantPart } from '../session/types.js';
import { loadContextFiles, formatContextBlock, resolveFileReferences } from './context_files.js';
import { buildMemoriesBlock } from './memory_recall.js';
import { VOICE_CONVERSATION_PRELUDE } from './prelude.js';
import { foldHistory } from './claude_code_runner.js';
import { decidePermission, buildPermissionResponse, type AcpRunExtras } from './acp_policy.js';
import { acquireAcpAgent, releaseAcpAgent, type AcpAgentHandle } from './acp_pool.js';
import { readSession, updateAcpSessionId, assistantMessage, toolMessage } from '../session/store.js';
import { loadMcpServers } from '../store/json.js';
import { resolvedServerRuntime } from '../mcp/client.js';

const CANCEL_GRACE_MS = 5_000;

/** Agent's configured MCP servers + per-run extras (task bridge) as ACP shapes. */
async function resolveAcpMcpServers(
  serverIds: string[],
  extra: AcpRunExtras['extraMcpServers'],
): Promise<McpServer[]> {
  const out: McpServer[] = [];
  if (serverIds.length > 0) {
    const file = await loadMcpServers();
    for (const id of serverIds) {
      const cfg = file.servers.find((s) => s.id === id);
      if (!cfg) continue;
      const r = await resolvedServerRuntime(cfg).catch(() => null);
      if (!r) {
        console.warn(`[acp] skipping MCP server "${id}" (disabled or no usable credentials)`);
        continue;
      }
      if (r.type === 'stdio') {
        out.push({
          name: id,
          command: r.command,
          args: r.args ?? [],
          env: Object.entries(r.env ?? {}).map(([name, value]) => ({ name, value })),
        });
      } else {
        out.push({
          type: 'http',
          name: id,
          url: r.url,
          headers: Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      }
    }
  }
  for (const [name, def] of Object.entries(extra ?? {})) {
    out.push({
      type: 'http',
      name,
      url: def.url,
      headers: Object.entries(def.headers ?? {}).map(([n, v]) => ({ name: n, value: v })),
    });
  }
  return out;
}

/** Session-cumulative → per-turn usage (clamped; unknown baseline = full total). */
function diffUsage(prev: Usage | undefined, cur: Usage): AssistantUsage {
  const d = (a: number, b: number | undefined) => Math.max(0, a - (b ?? 0));
  const usage: AssistantUsage = {
    input: d(cur.inputTokens, prev?.inputTokens),
    output: d(cur.outputTokens, prev?.outputTokens),
  };
  if (cur.cachedReadTokens != null)
    usage.cacheRead = d(cur.cachedReadTokens, prev?.cachedReadTokens ?? undefined);
  if (cur.cachedWriteTokens != null)
    usage.cacheWrite = d(cur.cachedWriteTokens, prev?.cachedWriteTokens ?? undefined);
  return usage;
}

/** Heuristic for claude-agent-acp harness notices (hook output, warnings):
 *  the adapter folds SDK "informational" messages into plain
 *  agent_message_chunk text as `**Notice:** …` / `**Warning:** …` /
 *  `**Error:** …`, indistinguishable from model prose on the wire — see
 *  https://github.com/agentclientprotocol/claude-agent-acp/issues/1042
 *  (asks for a _meta marker; drop this heuristic when it lands). A notice
 *  arrives as ONE complete chunk, so only a whole-chunk prefix match counts —
 *  model deltas that merely contain a bold label mid-stream stay untouched.
 *  Matches route to the thinking channel: visible but collapsed, out of the
 *  persisted reply text and out of TTS. 'info'-level messages carry no
 *  prefix at all and cannot be detected. */
const ADAPTER_NOTICE_RE = /^\*\*(Notice|Warning|Error):\*\* /;
export function isAdapterNotice(text: string): boolean {
  return ADAPTER_NOTICE_RE.test(text);
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) =>
      c?.type === 'content' && c.content?.type === 'text' ? String(c.content.text) : '',
    )
    .filter(Boolean)
    .join('\n');
}

export async function runAcp(opts: RunOptions, cb: RunCallbacks = {}): Promise<RunResult> {
  const { agent, provider } = opts;
  const extras: AcpRunExtras = opts.acp ?? {};
  const workingDir = opts.workingDir ?? process.cwd();
  const safeEmit = async (fn: (() => void | Promise<void>) | undefined) => {
    try {
      await fn?.();
    } catch (err) {
      console.warn('[acp] callback error:', err);
    }
  };

  // 1. Stable context block (mirror of claude-code's --append-system-prompt,
  //    minus files this runner self-loads).
  const selfLoaded = new Set(provider.selfLoadedContextFiles ?? []);
  const sys = await resolveFileReferences(agent.systemPrompt ?? '', workingDir);
  const ctxEntries = (await loadContextFiles(workingDir)).filter(
    (e) => !selfLoaded.has(path.basename(e.path)),
  );
  const stableBlock = [sys, ctxEntries.length ? formatContextBlock(ctxEntries) : '']
    .filter(Boolean)
    .join('\n\n');

  // 2. Volatile per-turn block.
  const memoriesBlock = opts.skipMemoryRecall
    ? ''
    : await buildMemoriesBlock(opts.prompt, workingDir, opts.memoryProjectId);
  const volatileBlock = [memoriesBlock, opts.voiceConversation ? VOICE_CONVERSATION_PRELUDE : '']
    .filter(Boolean)
    .join('\n\n');

  const mcpServers = await resolveAcpMcpServers(agent.mcpServers ?? [], extras.extraMcpServers);

  // 3. Acquire child (pooled per caretaker session; ephemeral otherwise).
  const poolKey = opts.sessionId ? `${agent.id}:${opts.sessionId}` : null;
  let handle: AcpAgentHandle;
  try {
    handle = await acquireAcpAgent(provider, poolKey);
  } catch (err: any) {
    throw new Error(
      `acp runner failed to start the agent for provider "${provider.name}": ${err?.message ?? err} ` +
        `(is it installed and authenticated? Log in with the agent's own CLI first.)`,
    );
  }

  // 4. Turn accumulation state.
  const parts: AssistantPart[] = [];
  let text = '';
  let toolCalls = 0;
  const pushText = (t: string) => {
    text += t;
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text += t;
    else parts.push({ type: 'text', text: t });
  };

  const onUpdate = async (n: SessionNotification) => {
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') {
          if (isAdapterNotice(u.content.text)) {
            // Adapter harness notice (see isAdapterNotice / issue #1042):
            // demote to thinking instead of polluting the reply.
            await safeEmit(() => cb.onThinking?.((u.content as any).text));
            break;
          }
          pushText(u.content.text);
          await safeEmit(() => cb.onChunk?.((u.content as any).text));
        }
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') await safeEmit(() => cb.onThinking?.((u.content as any).text));
        break;
      case 'tool_call': {
        toolCalls += 1;
        const name = u.name ?? u.title;
        parts.push({ type: 'tool_use', id: u.toolCallId, name, args: u.rawInput ?? {} });
        await safeEmit(() => cb.onToolCall?.(u.toolCallId, name, u.rawInput ?? {}));
        break;
      }
      case 'tool_call_update': {
        if (u.status === 'completed' || u.status === 'failed') {
          const resultText = extractToolResultText(u.content);
          await safeEmit(() => cb.onToolResult?.(u.toolCallId, resultText));
          await safeEmit(() => cb.onMessage?.(toolMessage(u.toolCallId, resultText)));
        }
        break;
      }
      default:
        break; // plan / usage_update / mode updates: not rendered in v1
    }
  };

  const onPermission = async (req: Parameters<typeof decidePermission>[0]) => {
    const decision = decidePermission(req, extras);
    if (decision === 'allow') return buildPermissionResponse(req.options, 'once');
    if (decision === 'deny') return buildPermissionResponse(req.options, 'deny');
    // 'ask' → the ordinary confirm gate; no gate wired means allow (the caller
    // decides which surfaces gate, same contract as the native loop).
    if (!cb.confirmTool) return buildPermissionResponse(req.options, 'once');
    const name = req.toolCall.name ?? req.toolCall.title ?? 'tool';
    const answer = await cb.confirmTool(req.toolCall.toolCallId, String(name), req.toolCall.rawInput ?? {});
    return buildPermissionResponse(req.options, answer);
  };

  let stopReason: PromptResponse['stopReason'] | 'error' = 'error';
  let usage: AssistantUsage = { input: 0, output: 0 };
  let aborted = false;
  let graceTimer: NodeJS.Timeout | undefined;

  try {
    // 5. Resolve the ACP session: pooled live id → persisted id via
    //    session/load (capability-gated) → session/new (+ folded history).
    let acpSessionId = handle.acpSessionId;
    let isNewSession = false;
    if (!acpSessionId) {
      let persisted: string | undefined;
      if (opts.sessionId) {
        try {
          persisted = (await readSession(agent.id, opts.sessionId)).meta.acpSessionId;
        } catch {
          /* new session */
        }
      }
      if (persisted && handle.init.agentCapabilities?.loadSession) {
        // Load BEFORE arming the binding: the replayed history streams as
        // session/update notifications we deliberately drop (our own store
        // already has the conversation).
        try {
          await handle.conn.agent.request('session/load', {
            sessionId: persisted,
            cwd: workingDir,
            mcpServers,
          });
          acpSessionId = persisted;
        } catch (err) {
          console.warn(`[acp] session/load "${persisted}" failed; starting fresh:`, err);
        }
      }
      if (!acpSessionId) {
        const res = await handle.conn.agent.request('session/new', { cwd: workingDir, mcpServers });
        acpSessionId = res.sessionId;
        isNewSession = true;
      }
      handle.acpSessionId = acpSessionId;
      if (opts.sessionId && acpSessionId !== persisted) {
        try {
          await updateAcpSessionId({ agentId: agent.id, id: opts.sessionId }, acpSessionId);
        } catch (err) {
          console.warn('[acp] failed to persist session id:', err);
        }
      }
    }

    // 6. Prompt blocks: stable context on the session's first turn; volatile
    //    every turn; history folded only into a brand-new session.
    const blocks: ContentBlock[] = [];
    if (isNewSession && stableBlock) {
      blocks.push({ type: 'text', text: `<caretaker-context>\n${stableBlock}\n</caretaker-context>` });
    }
    if (volatileBlock) blocks.push({ type: 'text', text: volatileBlock });
    blocks.push({
      type: 'text',
      text: isNewSession ? foldHistory(opts.history, opts.prompt) : opts.prompt,
    });

    // 7. Arm the binding, wire abort, send the prompt.
    handle.binding.current = { acpSessionId, onUpdate, onPermission };
    const onAbort = () => {
      aborted = true;
      void handle.conn.agent.notify('session/cancel', { sessionId: acpSessionId! }).catch(() => {});
      graceTimer = setTimeout(() => handle.kill(), CANCEL_GRACE_MS);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await handle.conn.agent.request('session/prompt', {
        sessionId: acpSessionId,
        prompt: blocks,
      });
      stopReason = res.stopReason;
      if (res.usage) {
        usage = diffUsage(handle.lastUsage, res.usage);
        handle.lastUsage = res.usage;
        await safeEmit(() => cb.onUsage?.(usage));
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      handle.binding.current = null;
    }

    if (parts.length > 0) await safeEmit(() => cb.onMessage?.(assistantMessage(parts, usage)));

    if (aborted || stopReason === 'cancelled') return { text, toolCalls, usage, stop: 'aborted' };
    if (stopReason === 'max_turn_requests') return { text, toolCalls, usage, stop: 'max_turns' };
    return { text, toolCalls, usage, stop: 'done' };
  } catch (err: any) {
    if (aborted) return { text, toolCalls, usage, stop: 'aborted' };
    throw new Error(`acp runner: ${err?.message ?? String(err)}`);
  } finally {
    releaseAcpAgent(poolKey, handle);
  }
}
