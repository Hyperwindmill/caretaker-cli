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

import type { 
  AgentSummary, 
  ChatMessage, 
  ConfirmDecision, 
  HostToView, 
  SessionSummary, 
  ViewToHost, 
  ContextUsage, 
  ModelsResult, 
  RefreshOutcome,
  CaretakerConfig, 
  AgentConfig, 
  PluginsFile, 
  McpServerConfig 
} from './bridge.js';

import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { ConfirmCard } from './ConfirmCard.js';
import { SettingsPanel } from './SettingsPanel.js';
import logo from './caretaker_cli.png';

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
export interface ThinkingItem {
  kind: 'thinking';
  text: string;
}
export type ChatItem = UserItem | AssistantItem | ToolItem | ThinkingItem;

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
  contextUsage: ContextUsage | null;
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
  | { kind: 'clear' }
  | { kind: 'error'; text: string }
  | { kind: 'load-history'; messages: ChatMessage[] }
  | { kind: 'context-usage'; usage: ContextUsage | null };

function closeStreamingAssistant(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (!last || last.kind !== 'assistant' || !last.streaming) return items;
  return [...items.slice(0, -1), { ...last, streaming: false }];
}

function reconstructChatItems(messages: ChatMessage[]): ChatItem[] {
  let items: ChatItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      items = closeStreamingAssistant(items);
      items.push({ kind: 'user', text: msg.content });
    } else if (msg.role === 'assistant') {
      items = closeStreamingAssistant(items);
      
      if (msg.parts && msg.parts.length > 0) {
        for (const part of msg.parts) {
          if (part.type === 'text') {
            items.push({ kind: 'assistant', text: part.text, streaming: false });
          } else if (part.type === 'thinking') {
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
        status: 'idle',
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

export interface AppProps {
  postMessage: (msg: ViewToHost) => void;
  layout?: 'compact' | 'sidebar';
}

export function App({ postMessage, layout = 'compact' }: AppProps) {
  const [chatState, dispatch] = useReducer(reducer, {
    items: [],
    status: 'idle',
    errorText: null,
    pendingConfirms: [],
    contextUsage: null,
  });

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);

  const [activeScreen, setActiveScreen] = useState<'chat' | 'settings'>('chat');
  const [settingsData, setSettingsData] = useState<{
    config: CaretakerConfig;
    agents: AgentConfig[];
    pluginsFile: PluginsFile;
    mcpServersFile: { servers: McpServerConfig[] };
    availableTools: string[];
  } | null>(null);
  const [modelsResult, setModelsResult] = useState<ModelsResult | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(null);
  const [refreshOutcome, setRefreshOutcome] = useState<RefreshOutcome | null>(null);

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
        case 'contextUsage':
          dispatch({ kind: 'context-usage', usage: msg.usage });
          return;
        case 'settingsDataLoaded':
          setSettingsData({
            config: msg.config,
            agents: msg.agents,
            pluginsFile: msg.pluginsFile,
            mcpServersFile: msg.mcpServersFile,
            availableTools: msg.availableTools,
          });
          return;
        case 'modelsFetched':
          setModelsResult(msg.result);
          return;
        case 'refreshingPlugin':
          setRefreshingSourceId(msg.sourceId);
          setRefreshOutcome(null);
          return;
        case 'refreshPluginOutcome':
          setRefreshingSourceId(null);
          setRefreshOutcome(msg.outcome);
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
    setShowAllAgents(false);
    postMessage({ type: 'selectAgent', agentId });
    // Clear chat state when switching agent
    dispatch({ kind: 'clear' });
  };

  const onSelectSession = (sessionId: string): void => {
    setSelectedSessionId(sessionId);
    setShowSessions(false);
    postMessage({ type: 'selectSession', sessionId });
    // Clear chat state when switching session
    dispatch({ kind: 'clear' });
  };

  const onCreateSession = (): void => {
    setSelectedSessionId(null);
    setShowSessions(false);
    postMessage({ type: 'createSession' });
    // Clear chat state when creating new session
    dispatch({ kind: 'clear' });
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
  const activeAgent = agents.find((a) => a.id === selectedAgentId);

  if (activeScreen === 'settings') {
    return (
      <SettingsPanel
        layout={layout}
        postMessage={postMessage}
        settingsData={settingsData}
        modelsResult={modelsResult}
        setModelsResult={setModelsResult}
        refreshingSourceId={refreshingSourceId}
        refreshOutcome={refreshOutcome}
        setRefreshOutcome={setRefreshOutcome}
        onClose={() => setActiveScreen('chat')}
      />
    );
  }

  if (layout === 'sidebar') {
    return (
      <div className="app app--with-sidebar">
        <aside className="app__sidebar">
          <div className="app__sidebar-header">
            <div className="app__logo-title-wrapper">
              <img src={logo} alt="Caretaker" className="app__logo" />
              <span>Caretaker</span>
            </div>
          </div>
          
          <div className="app__sidebar-content">
            <div className="app__sidebar-section">
              <div className="app__sidebar-section-title">Agents</div>
              <div className="app__sidebar-agents-list">
                {selectedAgentId && !showAllAgents ? (
                  <button
                    className="app__sidebar-agent-item app__sidebar-agent-item--collapsed-active"
                    onClick={() => setShowAllAgents(true)}
                    title="Switch Agent"
                  >
                    <span className="agent-status-dot agent-status-dot--active" />
                    <span className="app__sidebar-agent-name">{activeAgent?.name || selectedAgentId}</span>
                    <svg className="app__sidebar-chevron" width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                      <path d="M1 3.5 L5 7.5 L9 3.5 Z" />
                    </svg>
                  </button>
                ) : (
                  <div className={`app__sidebar-agents-list-expanded ${selectedAgentId ? 'app__sidebar-agents-list-expanded--has-active' : ''}`}>
                    {agents.length === 0 ? (
                      <div className="app__sidebar-empty-text">No agents found</div>
                    ) : (
                      agents.map((agent) => {
                        const isSelected = selectedAgentId === agent.id;
                        return (
                          <button
                            key={agent.id}
                            className={`app__sidebar-agent-item ${isSelected ? 'app__sidebar-agent-item--active' : ''}`}
                            onClick={() => {
                              if (isSelected) {
                                setShowAllAgents(false);
                              } else {
                                onSelectAgent(agent.id);
                              }
                            }}
                          >
                            <span className={`agent-status-dot ${isSelected ? 'agent-status-dot--active' : ''}`} />
                            <span className="app__sidebar-agent-name">{agent.name}</span>
                            {isSelected && (
                              <svg className="app__sidebar-chevron app__sidebar-chevron--up" width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                                <path d="M1 6.5 L5 2.5 L9 6.5 Z" />
                              </svg>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>

            {selectedAgentId && (
              <div className="app__sidebar-section">
                <div className="app__sidebar-section-header">
                  <span className="app__sidebar-section-title">Conversations</span>
                  <button
                    className="app__sidebar-new-chat-btn"
                    onClick={onCreateSession}
                    title="New Chat"
                  >
                    + New
                  </button>
                </div>
                <div className="app__sidebar-sessions-list">
                  {sessions.length === 0 ? (
                    <div className="app__sidebar-empty-text">No conversations yet</div>
                  ) : (
                    sessions.map((session) => (
                      <button
                        key={session.id}
                        className={`app__sidebar-session-item ${selectedSessionId === session.id ? 'app__sidebar-session-item--active' : ''}`}
                        onClick={() => onSelectSession(session.id)}
                      >
                        <span className="app__sidebar-session-icon">💬</span>
                        <span className="app__sidebar-session-title" title={session.title}>{session.title}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="app__sidebar-footer">
            <button
              className="app__sidebar-settings-btn"
              onClick={() => {
                setActiveScreen('settings');
                postMessage({ type: 'getSettingsData' });
              }}
              title="Caretaker Settings"
            >
              <svg className="app__settings-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.17.311c.58.988.004 2.257-.872 2.105l-.34-.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.699 1.283.705 2.686 1.987 1.987l.311-.17a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.699 2.686-.705 1.987-1.987l-.17-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.699-1.283-.705-2.686-1.987-1.987l-.311.17a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <main className="app__chat-pane">
          {selectedAgentId ? (
            <>
              <header className="app__chat-header">
                <div className="app__chat-header-info">
                  <h2 className="app__chat-header-title">{selectedAgentName}</h2>
                  <span className="app__chat-header-status">
                    <span className={`agent-status-dot agent-status-dot--active ${chatState.status === 'streaming' ? 'agent-status-dot--pulsing' : ''}`} />
                    {chatState.status === 'streaming' ? 'Streaming response...' : 'Ready'}
                  </span>
                </div>
              </header>
              <MessageList
                items={chatState.items}
                isStreaming={chatState.status === 'streaming'}
                agentName={selectedAgentName}
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
                contextUsage={chatState.contextUsage}
              />
            </>
          ) : (
            <div className="app__empty-state">
              <p>Select an agent from the sidebar to start chatting</p>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-row">
          <div className="app__logo-title-wrapper">
            <img src={logo} alt="Caretaker" className="app__logo" />
            <span>Caretaker</span>
          </div>
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
            <button
              className="app__settings-btn"
              onClick={() => {
                setActiveScreen('settings');
                postMessage({ type: 'getSettingsData' });
              }}
              title="Caretaker Settings"
            >
              <svg className="app__settings-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.17.311c.58.988.004 2.257-.872 2.105l-.34-.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.699 1.283.705 2.686 1.987 1.987l.311-.17a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.699 2.686-.705 1.987-1.987l-.17-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.699-1.283-.705-2.686-1.987-1.987l-.311.17a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
              </svg>
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
        isStreaming={chatState.status === 'streaming'}
        agentName={selectedAgentName}
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
        contextUsage={chatState.contextUsage}
      />
    </div>
  );
}
