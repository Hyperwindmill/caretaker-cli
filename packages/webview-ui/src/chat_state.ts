// Chat state shared by the main chat (App) and the task cycle viewer. One
// reducer, so a cycle replayed from disk and a cycle streamed live fold into
// the same ChatItem[] the chat renders. Pure TypeScript: no React imports.

import type { ChatMessage, ContextUsage, ToolAttachmentRecord } from './bridge.js';

export interface UserItem {
  kind: 'user';
  text: string;
  attachments?: ToolAttachmentRecord[];
}
export interface AssistantItem {
  kind: 'assistant';
  text: string;
  /** false once a tool call closes this span or `done` arrives */
  streaming: boolean;
  /** Optional role label shown instead of "assistant" (e.g. the task agent name · model). */
  label?: string;
}
export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args: unknown;
  result: string | null;
}
export interface ThinkingItem {
  kind: 'thinking';
  text: string;
}
export interface NoticeItem {
  kind: 'notice';
  text: string;
  variant: 'system' | 'block';
}
/** A task cycle, shown as a card in the task timeline. Opening it loads the
 *  cycle's chat session (see TaskCycleView). */
export interface CycleItem {
  kind: 'cycle';
  sessionId: string;
  agentId: string;
  role: 'developer' | 'planner' | 'reviewer';
  outcome: string;
  label?: string;
  createdAt: string;
}
export type ChatItem = UserItem | AssistantItem | ToolItem | ThinkingItem | NoticeItem | CycleItem;

export interface PendingConfirm {
  id: string;
  toolName: string;
  args: unknown;
}

type Status = 'idle' | 'streaming' | 'error';

export interface State {
  items: ChatItem[];
  status: Status;
  errorText: string | null;
  pendingConfirms: PendingConfirm[];
  contextUsage: ContextUsage | null;
}

export type Action =
  | { kind: 'send-user'; text: string; attachments?: ToolAttachmentRecord[] }
  | { kind: 'append-chunk'; text: string }
  | { kind: 'append-thinking'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'tool-result'; id: string; content: string }
  | { kind: 'permission-request'; id: string; toolName: string; args: unknown }
  | { kind: 'permission-resolved'; id: string }
  | { kind: 'done' }
  | { kind: 'clear' }
  | { kind: 'error'; text: string }
  | { kind: 'load-history'; messages: ChatMessage[]; streaming?: boolean }
  | { kind: 'context-usage'; usage: ContextUsage | null };

function closeStreamingAssistant(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (!last || last.kind !== 'assistant' || !last.streaming) return items;
  return [...items.slice(0, -1), { ...last, streaming: false }];
}

function reconstructChatItems(messages: ChatMessage[]): ChatItem[] {
  let items: ChatItem[] = [];

  for (const msg of messages) {
    if (msg.recap) {
      // Closing notice of a task cycle (its handoff): a notice, never a bubble.
      items = closeStreamingAssistant(items);
      items.push({ kind: 'notice', text: msg.content, variant: 'system' });
    } else if (msg.role === 'user') {
      items = closeStreamingAssistant(items);
      items.push({ kind: 'user', text: msg.content, attachments: msg.attachments });
    } else if (msg.role === 'assistant') {
      items = closeStreamingAssistant(items);
      
      if (msg.parts && msg.parts.length > 0) {
        for (const part of msg.parts) {
          if (part.type === 'text') {
            items.push({ kind: 'assistant', text: part.text, streaming: false });
          } else if (part.type === 'thinking' && part.text.trim().length > 0) {
            items.push({ kind: 'thinking', text: part.text });
          } else if (part.type === 'tool_use') {
            items.push({
              kind: 'tool',
              id: part.id,
              name: part.name,
              args: part.args,
              result: null,
            });
          }
        }
      } else {
        items.push({ kind: 'assistant', text: msg.content, streaming: false });
      }
    } else if (msg.role === 'tool') {
      const toolCallId = msg.toolCallId;
      if (toolCallId) {
        const idx = items.findIndex(
          (it) => it.kind === 'tool' && it.id === toolCallId && it.result === null,
        );
        if (idx !== -1) {
          const toolItem = items[idx] as ToolItem;
          items[idx] = { ...toolItem, result: msg.content };
        } else {
          items.push({
            kind: 'tool',
            id: toolCallId,
            name: 'unknown_tool',
            args: {},
            result: msg.content,
          });
        }
      }
    }
  }

  return closeStreamingAssistant(items);
}

export function chatReducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'send-user':
      return {
        ...state,
        status: 'streaming',
        errorText: null,
        items: [...state.items, { kind: 'user', text: action.text, attachments: action.attachments }],
      };

    case 'append-chunk': {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const updated: AssistantItem = { ...last, text: last.text + action.text };
        return { ...state, items: [...state.items.slice(0, -1), updated] };
      }
      return {
        ...state,
        items: [...state.items, { kind: 'assistant', text: action.text, streaming: true }],
      };
    }

    case 'append-thinking': {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === 'thinking') {
        const updated: ThinkingItem = { ...last, text: last.text + action.text };
        return { ...state, items: [...state.items.slice(0, -1), updated] };
      }
      return {
        ...state,
        items: [...state.items, { kind: 'thinking', text: action.text }],
      };
    }

    case 'tool-call':
      return {
        ...state,
        items: [
          ...closeStreamingAssistant(state.items),
          { kind: 'tool', id: action.id, name: action.name, args: action.args, result: null },
        ],
      };

    case 'tool-result': {
      const idx = state.items.findIndex(
        (it) => it.kind === 'tool' && it.id === action.id && it.result === null,
      );
      if (idx < 0) return state;
      const tool = state.items[idx] as ToolItem;
      const updated: ToolItem = { ...tool, result: action.content };
      return {
        ...state,
        items: [...state.items.slice(0, idx), updated, ...state.items.slice(idx + 1)],
      };
    }

    case 'permission-request':
      return {
        ...state,
        pendingConfirms: [
          ...state.pendingConfirms,
          { id: action.id, toolName: action.toolName, args: action.args },
        ],
      };

    case 'permission-resolved':
      return {
        ...state,
        pendingConfirms: state.pendingConfirms.filter((p) => p.id !== action.id),
      };

    case 'done':
      return {
        ...state,
        status: 'idle',
        pendingConfirms: [],
        items: closeStreamingAssistant(state.items),
      };

    case 'clear':
      return {
        ...state,
        items: [],
        status: 'idle',
        errorText: null,
        pendingConfirms: [],
        contextUsage: null,
      };

    case 'error':
      return {
        ...state,
        status: 'error',
        errorText: action.text,
        pendingConfirms: [],
        items: closeStreamingAssistant(state.items),
      };

    case 'load-history': {
      const historyItems = reconstructChatItems(action.messages);
      return {
        ...state,
        items: historyItems,
        // A cycle opened mid-run keeps the stream indicator on until its `done`.
        status: action.streaming ? 'streaming' : 'idle',
        errorText: null,
        pendingConfirms: [],
      };
    }

    case 'context-usage':
      return {
        ...state,
        contextUsage: action.usage,
      };
  }
}

export const initialChatState: State = {
  items: [],
  status: 'idle',
  errorText: null,
  pendingConfirms: [],
  contextUsage: null,
};
