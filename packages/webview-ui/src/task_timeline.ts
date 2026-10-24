// Task thread → chat items. Legacy messages (heartbeat, heartbeat_live,
// tool_call) keep their compact rendering; `cycle` messages become cards that
// open the cycle's session. Pure TypeScript, shared by the task log and tests.

import type { ChatItem } from './chat_state.js';

export interface TaskMessage {
  id: number;
  taskId: string;
  role: 'user' | 'assistant' | 'tool';
  messageType: 'chat' | 'heartbeat' | 'heartbeat_live' | 'system' | 'block' | 'tool_call' | 'yield' | 'review' | 'plan' | 'cycle';
  content: string;
  toolCallId?: string | null;
  agentLabel?: string | null;
  /** `cycle` messages only. */
  sessionId?: string | null;
  sessionAgentId?: string | null;
  cycleRole?: 'developer' | 'planner' | 'reviewer' | null;
  cycleOutcome?: string | null;
  createdAt: string;
}

// Adapt stored TaskMessages to the shared ChatItem shape so the task thread
// reuses the normal chat renderer (MessageList) instead of bespoke inline JSX.
export function taskMessagesToChatItems(
  msgs: TaskMessage[],
  labels?: { developer?: string; planner?: string; reviewer?: string },
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of msgs) {
    if (msg.messageType === 'cycle') {
      // A task cycle: a card that opens the cycle's own chat session. Its role
      // and outcome are fixed at cycle start/end; the label is captured per run.
      const role = msg.cycleRole ?? 'developer';
      items.push({
        kind: 'cycle',
        sessionId: msg.sessionId ?? '',
        agentId: msg.sessionAgentId ?? '',
        role,
        outcome: msg.cycleOutcome ?? 'running',
        label: msg.agentLabel || labels?.[role],
        createdAt: msg.createdAt,
      });
      continue;
    }
    if (msg.messageType === 'system' || msg.messageType === 'block') {
      items.push({ kind: 'notice', text: msg.content, variant: msg.messageType });
      continue;
    }
    if (msg.messageType === 'tool_call') {
      // Stored as `${name} ${JSON.stringify(args)}`; results are not persisted.
      const sp = msg.content.indexOf(' ');
      const name = sp === -1 ? msg.content : msg.content.slice(0, sp);
      let args: unknown = {};
      if (sp !== -1) {
        try {
          args = JSON.parse(msg.content.slice(sp + 1));
        } catch {
          args = msg.content.slice(sp + 1);
        }
      }
      items.push({ kind: 'tool', id: msg.toolCallId || String(msg.id), name, args, result: '' });
      continue;
    }
    if (msg.messageType === 'plan') {
      // Stored per-message identity wins; plan is structurally always the planner.
      items.push({ kind: 'assistant', text: `**📋 Plan submitted**\n\n${msg.content}`, streaming: false, label: msg.agentLabel || labels?.planner });
      continue;
    }
    if (msg.messageType === 'review') {
      // Stored role is 'user' (replayed as agent feedback), but the reviewer agent
      // produced it — render as a labeled bubble so it's clear who reviewed.
      items.push({ kind: 'assistant', text: `**🔎 Code review**\n\n${msg.content}`, streaming: false, label: msg.agentLabel || labels?.reviewer });
      continue;
    }
    if (msg.role === 'user') {
      items.push({ kind: 'user', text: msg.content });
      continue;
    }
    // assistant (chat / heartbeat / heartbeat_live / review / yield)
    let text = msg.content;
    let thinking = '';
    if (msg.content.startsWith('[')) {
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          const t = parsed.find((b: { type?: string; content?: string }) => b.type === 'thinking');
          const x = parsed.find((b: { type?: string; content?: string }) => b.type === 'text');
          if (t?.content) thinking = t.content;
          if (x?.content) text = x.content;
        }
      } catch {
        // keep raw content
      }
    }
    if (thinking) items.push({ kind: 'thinking', text: thinking });
    // Stored per-message identity (captured at run time — accurate for the phase
    // that produced it) wins; fall back to the developer heuristic for older
    // messages and for chat bubbles the agent wrote via task_add_message.
    items.push({ kind: 'assistant', text, streaming: false, label: msg.agentLabel || labels?.developer });
  }
  return items;
}
