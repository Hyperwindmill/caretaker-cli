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

import { useEffect, useReducer, useState } from 'react';

import type { AgentSummary, ChatMessage, ConfirmDecision, HostToView, SessionSummary, ViewToHost } from '../bridge.js';

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

interface AppState {
  agents: AgentSummary[];
  sessions: SessionSummary[];
  selectedAgentId: string | null;
  selectedSessionId: string | null;
  chatState: State;
}

type Action =
  | { kind: 'send-user'; text: string }
  | { kind: 'append-chunk'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'tool-result'; id: string; content: string }
  | { kind: 'permission-request'; id: string; toolName: string; args: unknown }
  | { kind: 'permission-resolved'; id: string }
  | { kind: 'done' }
  | { kind: 'error'; text: string }
  | { kind: 'load-history'; messages: ChatMessage[] };

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

    case 'load-history': {
      const historyItems: ChatItem[] = action.messages.map((msg) => {
        if (msg.role === 'user') {
          return { kind: 'user', text: msg.content };
        }
        return { kind: 'assistant', text: msg.content, streaming: false };
      });
      return {
        ...state,
        items: historyItems,
        status: 'idle',
        errorText: null,
        pendingConfirms: [],
      };
    }
  }
}

export interface AppProps {
  postMessage: (msg: ViewToHost) => void;
}

export function App({ postMessage }: AppProps) {
  const [chatState, dispatch] = useReducer(reducer, {
    items: [],
    status: 'idle',
    errorText: null,
    pendingConfirms: [],
  });

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);

  useEffect(() => {
    postMessage({ type: 'webviewReady' });
  }, []);

  useEffect(() => {
    function handle(event: MessageEvent<unknown>): void {
      const msg = event.data as HostToView;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      switch (msg.type) {
        case 'ready':
          return;
        case 'agentsLoaded':
          setAgents(msg.agents);
          // Don't auto-select - let user choose
          return;
        case 'sessionsLoaded':
          setSessions(msg.sessions);
          return;
        case 'sessionLoaded':
          dispatch({ kind: 'load-history', messages: msg.messages });
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
  }, [selectedAgentId]);

  const onSend = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || chatState.status === 'streaming') return;
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

  const onSelectAgent = (agentId: string): void => {
    if (!agentId) return; // Ignore empty selection
    setSelectedAgentId(agentId);
    setSelectedSessionId(null);
    setShowSessions(false);
    postMessage({ type: 'selectAgent', agentId });
    // Reset chat state when switching agent
    dispatch({ kind: 'done' });
  };

  const onSelectSession = (sessionId: string): void => {
    setSelectedSessionId(sessionId);
    setShowSessions(false);
    postMessage({ type: 'selectSession', sessionId });
    // Reset chat state when switching session
    dispatch({ kind: 'done' });
  };

  const onCreateSession = (): void => {
    setSelectedSessionId(null);
    setShowSessions(false);
    postMessage({ type: 'createSession' });
    // Reset chat state when creating new session
    dispatch({ kind: 'done' });
  };

  const onToggleSessions = (): void => {
    if (selectedAgentId) {
      setShowSessions(!showSessions);
    }
  };

  // Close sessions dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (showSessions && !target.closest('.app__sessions-dropdown')) {
        setShowSessions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSessions]);

  const composerDisabled =
    chatState.status === 'streaming' || chatState.pendingConfirms.length > 0 || !selectedAgentId;

  const selectedAgentName = agents.find((a) => a.id === selectedAgentId)?.name;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-row">
          <span>Caretaker</span>
          <div className="app__controls">
            <div className="app__agent-select-wrapper">
              <select
                className="app__agent-select"
                value={selectedAgentId ?? ''}
                onChange={(e) => onSelectAgent(e.target.value)}
              >
                <option value="" disabled>-- Select Agent --</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="app__sessions-btn"
              onClick={onToggleSessions}
              disabled={!selectedAgentId}
              title="View conversations"
            >
              💬 {sessions.length}
            </button>
            <button
              className="app__new-chat-btn"
              onClick={onCreateSession}
              disabled={!selectedAgentId}
              title="New Chat"
            >
              + New
            </button>
          </div>
        </div>
      </header>

      {showSessions && sessions.length > 0 && (
        <div className="app__sessions-dropdown">
          <div className="app__sessions-title">Conversations for {selectedAgentName}</div>
          <div className="app__sessions-list">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`app__session-item ${selectedSessionId === session.id ? 'app__session-item--active' : ''}`}
                onClick={() => onSelectSession(session.id)}
              >
                {session.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {showSessions && sessions.length === 0 && selectedAgentId && (
        <div className="app__sessions-dropdown app__sessions-dropdown--empty">
          <div className="app__sessions-title">No conversations yet</div>
          <p className="app__sessions-empty">Start a new chat to create a conversation</p>
        </div>
      )}

      {!selectedAgentId && (
        <div className="app__empty-state">
          <p>Select an agent to start chatting</p>
        </div>
      )}

      <MessageList
        items={chatState.items}
        trailing={chatState.pendingConfirms.map((p) => (
          <ConfirmCard key={p.id} pending={p} onDecide={onConfirm} />
        ))}
      />
      {chatState.errorText && <div className="app__error">⚠ {chatState.errorText}</div>}
      <Composer
        disabled={composerDisabled}
        onSend={onSend}
        canAbort={chatState.status === 'streaming'}
        onAbort={onAbort}
      />
    </div>
  );
}
