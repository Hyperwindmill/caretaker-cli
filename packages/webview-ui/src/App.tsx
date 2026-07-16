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
  McpServerConfig,
  ToolAttachmentRecord
} from './bridge.js';

import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { ConfirmCard } from './ConfirmCard.js';
import { SettingsPanel } from './SettingsPanel.js';
import { ProjectsTab } from './ProjectsTab.js';
import { ChatIcon, SettingsIcon, ChevronDownIcon, ChevronUpIcon, ProjectsIcon, WarningIcon, DeleteIcon } from './icons.js';
import logo from './caretaker_cli.png';

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
export type ChatItem = UserItem | AssistantItem | ToolItem | ThinkingItem | NoticeItem;

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
      items.push({ kind: 'user', text: msg.content, attachments: msg.attachments });
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
  const [pendingDelete, setPendingDelete] = useState<{ sessionId: string; title: string } | null>(null);

  const [activeScreen, setActiveScreen] = useState<'chat' | 'settings' | 'projects'>('chat');
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
  const [mcpAuthOutcome, setMcpAuthOutcome] = useState<{ serverId: string; ok: boolean; error?: string } | null>(null);
  const [taskRuns, setTaskRuns] = useState<Record<string, any[]>>({});

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
        case 'thinking':
          dispatch({ kind: 'append-thinking', text: msg.text });
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
        case 'mcpAuthOutcome':
          setMcpAuthOutcome({ serverId: msg.serverId, ok: msg.ok, error: msg.error });
          return;
        case 'taskRunsLoaded':
          setTaskRuns((prev) => ({ ...prev, [msg.taskId]: msg.runs }));
          return;
      }
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [selectedAgentId]);

  const onSend = (
    text: string,
    attachments?: Array<{ name: string; mime: string; base64: string }>,
  ): void => {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;
    if (chatState.status === 'streaming') return;

    const localAttachments: ToolAttachmentRecord[] = (attachments || []).map((att) => ({
      mime: att.mime,
      id: att.name,
      name: att.name,
      base64: att.base64,
    }));

    dispatch({ kind: 'send-user', text: trimmed, attachments: localAttachments });
    postMessage({ type: 'start', prompt: trimmed, attachments });
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

  const onDeleteSession = (sessionId: string, title: string): void => {
    // VSCode webviews disable window.confirm(); use an inline confirmation
    // card instead so the feature works in both the web app and the sidebar.
    setPendingDelete({ sessionId, title });
  };

  const confirmDeleteSession = (): void => {
    if (!pendingDelete) return;
    const { sessionId } = pendingDelete;
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
      dispatch({ kind: 'clear' });
    }
    postMessage({ type: 'deleteSession', sessionId });
    setPendingDelete(null);
  };

  const cancelDeleteSession = (): void => {
    setPendingDelete(null);
  };

  // Dismiss the delete confirmation dialog on Escape (parity with the old
  // window.confirm() behavior). Also dismiss on overlay click.
  useEffect(() => {
    if (!pendingDelete) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setPendingDelete(null);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingDelete]);

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

  if (activeScreen === 'projects') {
    return (
      <div className="app" style={{ height: '100%' }}>
        <header className="app__header">
          <div className="app__header-row">
            <div className="app__logo-title-wrapper" onClick={() => setActiveScreen('chat')} style={{ cursor: 'pointer' }}>
              <img src={logo} alt="Caretaker" className="app__logo" />
              <span>Caretaker</span>
            </div>
            <div className="app__controls">
              <button className="app__sessions-btn" onClick={() => setActiveScreen('chat')}>
                <ChatIcon size={13} /> Chat
              </button>
              <button
                className="app__settings-btn"
                onClick={() => {
                  setActiveScreen('settings');
                  postMessage({ type: 'getSettingsData' });
                }}
                title="Caretaker Settings"
              >
                <SettingsIcon size={13} /> Settings
              </button>
            </div>
          </div>
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ProjectsTab agents={agents} />
        </div>
      </div>
    );
  }

  if (activeScreen === 'settings') {
    return (
      <div className={`app ${layout === 'sidebar' ? 'app--settings-centered' : ''}`}>
        <SettingsPanel
          layout={layout}
          postMessage={postMessage}
          settingsData={settingsData}
          modelsResult={modelsResult}
          setModelsResult={setModelsResult}
          refreshingSourceId={refreshingSourceId}
          refreshOutcome={refreshOutcome}
          setRefreshOutcome={setRefreshOutcome}
          mcpAuthOutcome={mcpAuthOutcome}
          setMcpAuthOutcome={setMcpAuthOutcome}
          taskRuns={taskRuns}
          onClose={() => setActiveScreen('chat')}
        />

      </div>
    );
  }

  const deleteOverlay = pendingDelete && (
    <div className="app__confirm-overlay" onClick={cancelDeleteSession}>
      <div className="app__confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="app__confirm-title">Delete conversation</div>
        <p className="app__confirm-message">
          Delete conversation &ldquo;{pendingDelete.title}&rdquo;? This cannot be undone.
        </p>
        <div className="app__confirm-buttons">
          <button className="app__confirm-btn" onClick={cancelDeleteSession}>Cancel</button>
          <button className="app__confirm-btn app__confirm-btn--danger" onClick={confirmDeleteSession}>Delete</button>
        </div>
      </div>
    </div>
  );

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
                    <ChevronDownIcon className="app__sidebar-chevron" size={10} />
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
                              <ChevronUpIcon className="app__sidebar-chevron app__sidebar-chevron--up" size={10} />
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
                      <div
                        key={session.id}
                        className={`app__sidebar-session-item ${selectedSessionId === session.id ? 'app__sidebar-session-item--active' : ''}`}
                        onClick={() => onSelectSession(session.id)}
                      >
                        <span className="app__sidebar-session-icon"><ChatIcon size={13} /></span>
                        <span className="app__sidebar-session-title" title={session.title}>{session.title}</span>
                        <button
                          className="app__sidebar-session-delete"
                          title="Delete conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession(session.id, session.title);
                          }}
                        >
                          <DeleteIcon size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="app__sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <button
              className="app__sidebar-settings-btn"
              onClick={() => {
                setActiveScreen('projects');
              }}
              title="Projects & Autonomous Tasks"
            >
              <span><ProjectsIcon size={13} /> Projects</span>
            </button>
            <button
              className="app__sidebar-settings-btn"
              onClick={() => {
                setActiveScreen('settings');
                postMessage({ type: 'getSettingsData' });
              }}
              title="Caretaker Settings"
            >
              <SettingsIcon className="app__settings-icon" size={14} />
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
                sessionId={selectedSessionId}
                isStreaming={chatState.status === 'streaming'}
                agentName={selectedAgentName}
                trailing={chatState.pendingConfirms.map((p) => (
                  <ConfirmCard key={p.id} pending={p} onDecide={onConfirm} />
                ))}
              />
              {chatState.errorText && <div className="app__error"><WarningIcon size={14} /> {chatState.errorText}</div>}
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
        {deleteOverlay}
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
            {/* Projects (autonomous tasks) is scheduler-driven, so it's exposed only
                in the sidebar layout (web/desktop), never in the compact/VSCode surface
                — same gating as the Scheduler settings tab. */}
            <button
              className="app__sessions-btn"
              onClick={onToggleSessions}
              disabled={!selectedAgentId}
              title="View conversations"
            >
              <ChatIcon size={13} /> {sessions.length}
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
              <SettingsIcon className="app__settings-icon" size={14} />
            </button>
          </div>
        </div>
      </header>

      {showSessions && sessions.length > 0 && (
        <div className="app__sessions-dropdown">
          <div className="app__sessions-title">Conversations for {selectedAgentName}</div>
          <div className="app__sessions-list">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`app__session-item ${selectedSessionId === session.id ? 'app__session-item--active' : ''}`}
                onClick={() => onSelectSession(session.id)}
              >
                <span className="app__session-item-title">{session.title}</span>
                <button
                  className="app__session-item-delete"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id, session.title);
                  }}
                >
                  <DeleteIcon size={12} />
                </button>
              </div>
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
        sessionId={selectedSessionId}
        isStreaming={chatState.status === 'streaming'}
        agentName={selectedAgentName}
        trailing={chatState.pendingConfirms.map((p) => (
          <ConfirmCard key={p.id} pending={p} onDecide={onConfirm} />
        ))}
      />
      {chatState.errorText && <div className="app__error"><WarningIcon size={14} /> {chatState.errorText}</div>}
      <Composer
        disabled={composerDisabled}
        onSend={onSend}
        canAbort={chatState.status === 'streaming'}
        onAbort={onAbort}
        contextUsage={chatState.contextUsage}
      />
      {deleteOverlay}
    </div>
  );
}
