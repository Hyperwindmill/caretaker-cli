// Top-level webview component. Owns the chat state (messages + pending
// permission requests) and translates bridge events into UI updates.
//
// Message stream model: a single `assistant` turn from the harness may
// alternate between text chunks and tool calls. We flatten that into a
// linear list of items — assistant-text spans, tool entries (with their
// later-arriving result), and so on — closing the current text span
// every time a tool call comes through so the next chunk starts a fresh
// span. Pending confirms live outside the message list and render as
// ConfirmCard rows at the tail until the user resolves them.

import { useEffect, useReducer } from 'react';

import type { ConfirmDecision, HostToView, ViewToHost } from '../bridge.js';

import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { ConfirmCard } from './ConfirmCard.js';

export interface UserItem {
  kind: 'user';
  text: string;
}
export interface AssistantItem {
  kind: 'assistant';
  text: string;
  /** false once a tool call closes this span or `done` arrives */
  streaming: boolean;
}
export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args: unknown;
  result: string | null;
}
export type ChatItem = UserItem | AssistantItem | ToolItem;

export interface PendingConfirm {
  id: string;
  toolName: string;
  args: unknown;
}

type Status = 'idle' | 'streaming' | 'error';

interface State {
  items: ChatItem[];
  status: Status;
  errorText: string | null;
  pendingConfirms: PendingConfirm[];
}

type Action =
  | { kind: 'send-user'; text: string }
  | { kind: 'append-chunk'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'tool-result'; id: string; content: string }
  | { kind: 'permission-request'; id: string; toolName: string; args: unknown }
  | { kind: 'permission-resolved'; id: string }
  | { kind: 'done' }
  | { kind: 'error'; text: string };

function closeStreamingAssistant(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (!last || last.kind !== 'assistant' || !last.streaming) return items;
  return [...items.slice(0, -1), { ...last, streaming: false }];
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'send-user':
      return {
        ...state,
        status: 'streaming',
        errorText: null,
        items: [...state.items, { kind: 'user', text: action.text }],
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

    case 'error':
      return {
        ...state,
        status: 'error',
        errorText: action.text,
        pendingConfirms: [],
        items: closeStreamingAssistant(state.items),
      };
  }
}

export interface AppProps {
  postMessage: (msg: ViewToHost) => void;
}

export function App({ postMessage }: AppProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    status: 'idle',
    errorText: null,
    pendingConfirms: [],
  });

  useEffect(() => {
    function handle(event: MessageEvent<unknown>): void {
      const msg = event.data as HostToView;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      switch (msg.type) {
        case 'ready':
          return;
        case 'chunk':
          dispatch({ kind: 'append-chunk', text: msg.text });
          return;
        case 'tool_call':
          dispatch({ kind: 'tool-call', id: msg.id, name: msg.name, args: msg.args });
          return;
        case 'tool_result':
          dispatch({ kind: 'tool-result', id: msg.id, content: msg.content });
          return;
        case 'permission_request':
          dispatch({
            kind: 'permission-request',
            id: msg.id,
            toolName: msg.toolName,
            args: msg.args,
          });
          return;
        case 'done':
          dispatch({ kind: 'done' });
          return;
        case 'error':
          dispatch({ kind: 'error', text: msg.message });
          return;
      }
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, []);

  const onSend = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || state.status === 'streaming') return;
    dispatch({ kind: 'send-user', text: trimmed });
    postMessage({ type: 'start', prompt: trimmed });
  };

  const onConfirm = (id: string, decision: ConfirmDecision): void => {
    dispatch({ kind: 'permission-resolved', id });
    postMessage({ type: 'permission_response', id, decision });
  };

  const onAbort = (): void => {
    postMessage({ type: 'abort' });
  };

  const composerDisabled =
    state.status === 'streaming' || state.pendingConfirms.length > 0;

  return (
    <div className="app">
      <header className="app__header">Caretaker</header>
      <MessageList
        items={state.items}
        trailing={state.pendingConfirms.map((p) => (
          <ConfirmCard key={p.id} pending={p} onDecide={onConfirm} />
        ))}
      />
      {state.errorText && <div className="app__error">⚠ {state.errorText}</div>}
      <Composer
        disabled={composerDisabled}
        onSend={onSend}
        canAbort={state.status === 'streaming'}
        onAbort={onAbort}
      />
    </div>
  );
}
