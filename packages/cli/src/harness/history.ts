// Map persisted MessageRecord[] (the canonical session-store shape) to
// OpenAI-compatible ChatMessage[] for replay against the provider.
//
// Ported from caretaker server's src/runner/chat_messages.ts
// (mapRowsToChatMessages). Behavior preserved 1:1:
//  - user → {role:"user", content}
//  - assistant with parts → {role:"assistant", content: text-only or null,
//                            tool_calls?: [...]}
//  - assistant without parts (legacy) → {role:"assistant", content}
//  - tool → {role:"tool", tool_call_id, content}; orphan tool rows (no
//    matching tool_use id in any prior assistant row) are dropped.

import type { AssistantPart, MessageRecord } from '../session/types.js';
import type { ChatMessage } from './provider.js';

function textConcat(parts: AssistantPart[]): string {
  return parts
    .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export function mapMessagesToChat(messages: MessageRecord[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const knownToolCallIds = new Set<string>();

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (Array.isArray(m.parts)) {
        const text = textConcat(m.parts);
        const toolCalls = m.parts
          .filter((p): p is Extract<AssistantPart, { type: 'tool_use' }> => p.type === 'tool_use')
          .map((p) => ({
            id: p.id,
            type: 'function' as const,
            function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
          }));
        for (const tc of toolCalls) knownToolCallIds.add(tc.id);
        out.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }
    if (m.role === 'tool') {
      const id = m.toolCallId ?? '';
      if (!id || !knownToolCallIds.has(id)) continue;
      out.push({ role: 'tool', tool_call_id: id, content: m.content });
    }
  }

  return out;
}
