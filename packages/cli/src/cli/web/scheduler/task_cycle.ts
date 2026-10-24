// Task cycle recorder: every autonomous cycle (developer, planner, review) is a
// chat session under its agent, plus a `cycle` timeline message on the task
// that points at it. Persistence is caller-side via the run's `onMessage`
// records — the session is never passed to harness.run (claude-code --resume
// and ACP pooling would otherwise apply to every cycle).

import type { RunCallbacks } from '../../../harness/loop.js';
import type { AgentConfig } from '../../../types.js';
import {
  addTaskMessage,
  runQuery,
  setCycleOutcome,
  type CycleOutcome,
  type Task,
  type TaskMessage,
} from '../../../store/db.js';
import { appendMessage, assistantMessage, createSession, userMessage } from '../../../session/store.js';
import type { MessageRecord } from '../../../session/types.js';
import { beginCycleStream, emitCycleEvent } from './cycle_events.js';

export type CycleRole = 'developer' | 'planner' | 'reviewer';

/** Message types the agent sees as history: handoffs, never transcripts. */
export const HISTORY_TYPES = ['chat', 'review', 'plan'] as const;

export function filterHandoffMessages(msgs: TaskMessage[]): TaskMessage[] {
  return msgs.filter((m) => (HISTORY_TYPES as readonly string[]).includes(m.messageType));
}

export function resolveCycleOutcome(i: {
  role: CycleRole;
  statusAfter: Task['status'] | null;
  aborted: boolean;
  failed: boolean;
  verdict?: 'pass' | 'changes';
}): CycleOutcome {
  if (i.failed) return 'failed';
  if (i.aborted) return 'aborted';
  if (i.role === 'reviewer') return i.verdict === 'changes' ? 'review-changes' : 'review-pass';
  if (i.statusAfter === 'reviewing' || i.statusAfter === 'done') return 'completed';
  if (i.statusAfter === 'blocked') return 'blocked';
  if (i.role === 'planner' && i.statusAfter === 'active') return 'plan';
  return 'handoff';
}

/** Handoff text produced during a cycle: agent notes, yields, blocks, plans
 *  and reviews, in order. `fallback` (when non-null) closes it. */
export function buildRecap(sinceCycle: TaskMessage[], fallback: string | null): string {
  const parts = sinceCycle
    .filter(
      (m) =>
        (m.messageType === 'chat' && m.role === 'assistant') ||
        (m.messageType === 'system' && m.content.startsWith('Yield:')) ||
        m.messageType === 'block' ||
        m.messageType === 'plan' ||
        m.messageType === 'review',
    )
    .map((m) => m.content)
    .filter((c) => c.trim());
  if (fallback !== null) parts.push(fallback);
  return parts.join('\n\n');
}

function fallbackNote(outcome: CycleOutcome, lastText: string): string {
  const last = lastText.trim() ? lastText.slice(0, 2000) : '(none)';
  return `Cycle ended without a handoff note (${outcome}). Last output: ${last}`;
}

export interface CycleRecorder {
  sessionId: string;
  agentId: string;
  callbacks: Pick<RunCallbacks, 'onChunk' | 'onThinking' | 'onToolCall' | 'onToolResult' | 'onMessage'>;
  close(i: { outcome: CycleOutcome }): Promise<void>;
}

export async function openCycle(i: {
  task: Task;
  agent: AgentConfig;
  role: CycleRole;
  agentLabel: string;
  prompt: string;
}): Promise<CycleRecorder> {
  const { task, agent, role, agentLabel, prompt } = i;
  const meta = await createSession({
    agentId: agent.id,
    title: `${task.id} · ${role}`,
    taskId: task.id,
    projectId: task.projectId,
    taskRole: role,
  });
  // The live stream opens before the prompt is persisted, so a watcher that
  // attaches right now already sees the prompt.
  const promptMsg = userMessage(prompt);
  beginCycleStream(meta.id, promptMsg);
  let cycleMsg: TaskMessage;
  try {
    await appendMessage(meta, promptMsg);
    cycleMsg = await addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'cycle',
      content: '',
      sessionId: meta.id,
      sessionAgentId: agent.id,
      cycleRole: role,
      cycleOutcome: 'running',
      agentLabel,
    });
  } catch (err) {
    // Never leave a watcher waiting on a stream nobody will finish.
    emitCycleEvent(meta.id, { type: 'error', message: 'Cycle could not start' });
    throw err;
  }

  let lastText = '';
  // Text streamed since the last persisted assistant turn: an aborted turn never
  // reaches onMessage, so this is the only trace of what the agent was doing.
  let partialText = '';

  // Messages written by this cycle, in order: everything after its `cycle` row.
  const cycleSince = async (): Promise<TaskMessage[]> => {
    const rows = (await runQuery(`SELECT * FROM task_messages WHERE taskId = '${task.id}'`)) as TaskMessage[];
    return rows
      .filter((m) => Number(m.id) > Number(cycleMsg.id))
      .sort((a, b) => Number(a.id) - Number(b.id));
  };

  const close = async ({ outcome }: { outcome: CycleOutcome }): Promise<void> => {
    try {
      await setCycleOutcome(cycleMsg.id, outcome);
      const since = await cycleSince();
      let fallback: string | null = null;
      // Developer and planner cycles must leave a handoff the next cycle replays:
      // an agent note or a submitted plan. Without one (aborted, turn limit,
      // forgot), the host writes the fallback.
      const hasHandoff = since.some((m) => (m.messageType === 'chat' && m.role === 'assistant') || m.messageType === 'plan');
      if (role !== 'reviewer' && !hasHandoff) {
        fallback = fallbackNote(outcome, partialText.trim() ? partialText : lastText);
        await addTaskMessage({ taskId: task.id, role: 'assistant', messageType: 'chat', content: fallback, agentLabel });
      }
      const recap = buildRecap(since, fallback);
      if (recap) {
        await appendMessage(meta, { ...assistantMessage([{ type: 'text', text: recap }]), recap: true });
      }
    } catch (err) {
      console.error(`[task_cycle] Task #${task.id} cycle ${meta.id} close failed:`, err);
    } finally {
      // Terminal event only after the recap is on disk: a watcher that loads
      // from disk on `done` sees the complete session.
      emitCycleEvent(
        meta.id,
        outcome === 'failed' ? { type: 'error', message: 'Cycle failed' } : { type: 'done' },
      );
    }
  };

  const callbacks: CycleRecorder['callbacks'] = {
    onChunk: (text) => {
      partialText += text;
      emitCycleEvent(meta.id, { type: 'chunk', text });
    },
    onThinking: (text) => emitCycleEvent(meta.id, { type: 'thinking', text }),
    onToolCall: (id, name, args) => emitCycleEvent(meta.id, { type: 'tool_call', id, name, args }),
    onToolResult: (id, content) => emitCycleEvent(meta.id, { type: 'tool_result', id, content }),
    onMessage: async (msg: MessageRecord) => {
      await appendMessage(meta, msg);
      if (msg.role === 'assistant') {
        if (msg.content) lastText = msg.content;
        partialText = '';
      }
    },
  };

  return { sessionId: meta.id, agentId: agent.id, callbacks, close };
}
