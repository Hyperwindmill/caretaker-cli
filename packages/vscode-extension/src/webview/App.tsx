// Top-level component. Owns the message list and routes bridge events
// into UI state. Step 4 only handles the echo path (`ready`, `chunk`,
// `done`, `error`). Tool calls / permission requests are wired in
// steps 5–6.

import { useEffect, useReducer, useRef } from 'react';

import type { HostToView, ViewToHost } from '../bridge.js';

import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';

export interface AssistantMessage {
  role: 'assistant';
  text: string;
  /** false until the bridge sends `done` for this turn */
  streaming: boolean;
}
export interface UserMessage {
  role: 'user';
  text: string;
}
export type ChatMessage = UserMessage | AssistantMessage;

type Status = 'idle' | 'streaming' | 'error';

interface State {
  messages: ChatMessage[];
  status: Status;
  errorText: string | null;
}

type Action =
  | { kind: 'send-user'; text: string }
  | { kind: 'append-chunk'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; text: string };

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'send-user':
      return {
        ...state,
        status: 'streaming',
        errorText: null,
        messages: [
          ...state.messages,
          { role: 'user', text: action.text },
          { role: 'assistant', text: '', streaming: true },
        ],
      };
    case 'append-chunk': {
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.streaming) return state;
      const updated: AssistantMessage = { ...last, text: last.text + action.text };
      return { ...state, messages: [...state.messages.slice(0, -1), updated] };
    }
    case 'done': {
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant' || !last.streaming) {
        return { ...state, status: 'idle' };
      }
      const updated: AssistantMessage = { ...last, streaming: false };
      return { ...state, status: 'idle', messages: [...state.messages.slice(0, -1), updated] };
    }
    case 'error':
      return { ...state, status: 'error', errorText: action.text };
  }
}

export interface AppProps {
  postMessage: (msg: ViewToHost) => void;
}

export function App({ postMessage }: AppProps) {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    status: 'idle',
    errorText: null,
  });

  // Track whether the host has signaled `ready`. We don't *need* this
  // for step 4 but it's the first sign of life from the bridge, and a
  // future loading state will hook into it.
  const readyRef = useRef(false);

  useEffect(() => {
    function handle(event: MessageEvent<unknown>): void {
      const msg = event.data as HostToView;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      switch (msg.type) {
        case 'ready':
          readyRef.current = true;
          return;
        case 'chunk':
          dispatch({ kind: 'append-chunk', text: msg.text });
          return;
        case 'done':
          dispatch({ kind: 'done' });
          return;
        case 'error':
          dispatch({ kind: 'error', text: msg.message });
          return;
        case 'tool_call':
        case 'tool_result':
        case 'permission_request':
          // Wired in later steps; ignore for now.
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

  return (
    <div className="app">
      <header className="app__header">Caretaker</header>
      <MessageList messages={state.messages} />
      {state.errorText && <div className="app__error">⚠ {state.errorText}</div>}
      <Composer disabled={state.status === 'streaming'} onSend={onSend} />
    </div>
  );
}
