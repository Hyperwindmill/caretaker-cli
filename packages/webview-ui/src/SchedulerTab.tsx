import { useState } from 'react';
import type { CaretakerConfig, AgentConfig, ScheduledTaskConfig } from 'caretaker-cli/types';
import type { ViewToHost, ChatMessage } from './bridge.js';
import type { ChatItem } from './App.js';
import { MessageList } from './MessageList.js';

interface SchedulerTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
  taskRuns?: Record<string, any[]>;
}

// Helper types for ChatItem conversion
interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args: unknown;
  result: string | null;
}

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

export function SchedulerTab({ config, agents, postMessage, taskRuns = {} }: SchedulerTabProps) {
  // Ensure tasks array is initialized
  const tasks = config.scheduler?.tasks || [];

  const [editingTask, setEditingTask] = useState<ScheduledTaskConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Task log viewer states
  const [viewingTaskLogs, setViewingTaskLogs] = useState<ScheduledTaskConfig | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [type, setType] = useState<'heartbeat' | 'telegram'>('heartbeat');
  const [enabled, setEnabled] = useState(true);
  const [agentId, setAgentId] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('*/15 * * * *');
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramAllowedChats, setTelegramAllowedChats] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startEdit = (task: ScheduledTaskConfig) => {
    setEditingTask(task);
    setIsCreating(false);
    setName(task.name);
    setType(task.type);
    setEnabled(task.enabled);
    setAgentId(task.agentId);
    setWorkingDir(task.workingDir || '');
    setPrompt(task.prompt);
    setCron(task.cron);
    setTelegramBotToken(task.telegramBotToken || '');
    setTelegramAllowedChats(task.telegramAllowedChats || '');
    setErrorMsg(null);
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingTask(null);
    setName('');
    setType('heartbeat');
    setEnabled(true);
    setAgentId(agents[0]?.id || '');
    setWorkingDir('');
    setPrompt('');
    setCron('*/15 * * * *');
    setTelegramBotToken('');
    setTelegramAllowedChats('');
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingTask(null);
    setErrorMsg(null);
  };

  const validateAndSave = () => {
    setErrorMsg(null);
    const trimmedName = name.trim();
    const trimmedWorkingDir = workingDir.trim();
    const trimmedPrompt = prompt.trim();
    const trimmedCron = cron.trim();

    if (!trimmedName) {
      setErrorMsg('Task Name is required.');
      return;
    }
    if (!agentId) {
      setErrorMsg('Please select an agent for this task.');
      return;
    }

    let finalPrompt = trimmedPrompt;
    let finalCron = trimmedCron;

    if (type === 'heartbeat') {
      if (!trimmedPrompt) {
        setErrorMsg('Periodic Prompt is required.');
        return;
      }
      if (!trimmedCron) {
        setErrorMsg('Cron timing is required.');
        return;
      }

      const cronParts = trimmedCron.split(/\s+/);
      if (cronParts.length !== 5) {
        setErrorMsg('Invalid cron expression. It must contain exactly 5 space-separated fields (e.g. "*/15 * * * *").');
        return;
      }
    } else if (type === 'telegram') {
      if (!telegramBotToken.trim()) {
        setErrorMsg('Telegram Bot Token is required.');
        return;
      }
      // Populate defaults for cron and prompt
      finalPrompt = 'Telegram Poller';
      finalCron = '* * * * *';
    }

    const existing = tasks.find(t => t.name.toLowerCase() === trimmedName.toLowerCase());
    if (isCreating && existing) {
      setErrorMsg(`A task named "${trimmedName}" already exists.`);
      return;
    }
    if (editingTask && editingTask.name.toLowerCase() !== trimmedName.toLowerCase() && existing) {
      setErrorMsg(`A task named "${trimmedName}" already exists.`);
      return;
    }

    const taskData: ScheduledTaskConfig = {
      id: editingTask ? editingTask.id : 'task_' + Math.random().toString(36).substring(2, 9),
      name: trimmedName,
      type,
      enabled,
      agentId,
      cron: finalCron,
      prompt: finalPrompt,
      ...(trimmedWorkingDir ? { workingDir: trimmedWorkingDir } : {}),
      ...(type === 'telegram'
        ? {
            telegramBotToken: telegramBotToken.trim(),
            telegramAllowedChats: telegramAllowedChats.trim(),
          }
        : {}),
    };

    let updatedTasks = [...tasks];
    if (isCreating) {
      updatedTasks.push(taskData);
    } else if (editingTask) {
      const idx = updatedTasks.findIndex(t => t.id === editingTask.id);
      if (idx !== -1) {
        updatedTasks[idx] = taskData;
      }
    }

    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        scheduler: {
          tasks: updatedTasks,
        },
      },
    });

    setIsCreating(false);
    setEditingTask(null);
  };

  const deleteTask = (taskId: string) => {
    const updatedTasks = tasks.filter(t => t.id !== taskId);
    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        scheduler: {
          tasks: updatedTasks,
        },
      },
    });
  };

  const toggleTaskEnabled = (task: ScheduledTaskConfig) => {
    const updatedTasks = tasks.map(t => {
      if (t.id === task.id) {
        return { ...t, enabled: !t.enabled };
      }
      return t;
    });

    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        scheduler: {
          tasks: updatedTasks,
        },
      },
    });
  };

  const openLogViewer = (task: ScheduledTaskConfig) => {
    setViewingTaskLogs(task);
    setSelectedRunId(null);
    postMessage({ type: 'getTaskRuns', taskId: task.id });
  };

  const showForm = isCreating || editingTask !== null;

  // Filter current runs for viewing
  const runs = viewingTaskLogs ? taskRuns[viewingTaskLogs.id] || [] : [];
  const activeRunId = selectedRunId || runs[0]?.runId;
  const activeRun = runs.find(r => r.runId === activeRunId);
  const activeRunChatItems = activeRun ? reconstructChatItems(activeRun.messages || []) : [];
  const selectedAgentName = viewingTaskLogs ? agents.find(a => a.id === viewingTaskLogs.agentId)?.name : '';

  return (
    <div className="tab-pane scheduler-tab">
      <div className="tab-pane__header">
        <h3>Scheduled Tasks</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Add Task
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error">⚠ {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Add Scheduled Task' : `Edit Task: ${editingTask?.name}`}</h4>
          
          <div className="form-group">
            <label htmlFor="task-name">Task Name</label>
            <input
              id="task-name"
              type="text"
              placeholder="e.g. Daily Workspace Clean, Morning Report"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="task-type">Task Type</label>
            <select
              id="task-type"
              value={type}
              onChange={(e) => setType(e.target.value as 'heartbeat' | 'telegram')}
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--vscode-dropdown-background, #252526)',
                color: 'var(--vscode-dropdown-foreground, #cccccc)',
                border: '1px solid var(--vscode-dropdown-border, #3c3c3c)',
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              <option value="heartbeat">Heartbeat (Recurring Agent Execution)</option>
              <option value="telegram">Telegram Poller (Autonomous Telegram Agent)</option>
            </select>
          </div>

          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0' }}>
            <input
              id="task-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 'auto', cursor: 'pointer' }}
            />
            <label htmlFor="task-enabled" style={{ cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>
              Active (Run scheduler for this task)
            </label>
          </div>

          <div className="form-group">
            <label htmlFor="task-agent">Agent to Execute</label>
            <select
              id="task-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--vscode-dropdown-background, #252526)',
                color: 'var(--vscode-dropdown-foreground, #cccccc)',
                border: '1px solid var(--vscode-dropdown-border, #3c3c3c)',
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              <option value="" disabled>-- Select Agent --</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          {type === 'heartbeat' ? (
            <>
              <div className="form-group">
                <label htmlFor="task-cron">Cron Timing</label>
                <input
                  id="task-cron"
                  type="text"
                  placeholder="e.g. */15 * * * * (every 15m), 0 9 * * * (every morning at 9)"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="task-dir">Working Directory (Absolute path, optional)</label>
                <input
                  id="task-dir"
                  type="text"
                  placeholder="e.g. /home/user/project (default: process.cwd())"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="task-prompt">Periodic Prompt</label>
                <textarea
                  id="task-prompt"
                  placeholder="What instructions should the agent execute on each run?"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--vscode-input-background, #252526)',
                    color: 'var(--vscode-input-foreground, #cccccc)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    fontFamily: 'inherit',
                    fontSize: '12px',
                    resize: 'vertical'
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="tg-token">Telegram Bot Token</label>
                <input
                  id="tg-token"
                  type="password"
                  placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="tg-chats">Allowed Chat IDs (Comma-separated, optional)</label>
                <input
                  id="tg-chats"
                  type="text"
                  placeholder="e.g. 987654321, 555666777 (Leave empty to ignore whitelist security)"
                  value={telegramAllowedChats}
                  onChange={(e) => setTelegramAllowedChats(e.target.value)}
                />
              </div>

              <div className="glass-form__help-card" style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 12px',
                fontSize: '11px',
                marginTop: '12px',
                lineHeight: '1.4',
                color: 'var(--vscode-descriptionForeground)'
              }}>
                <strong>💡 Quick Setup Guide:</strong>
                <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  <li>Create a new bot via Telegram's <strong>@BotFather</strong> to obtain your HTTP API token.</li>
                  <li>Obtain your chat ID by messaging <strong>@userinfobot</strong> on Telegram.</li>
                  <li>Whitelist your chat ID above to prevent unauthorized users from using your local shell/tools!</li>
                </ol>
              </div>
            </>
          )}

          <div className="form-actions">
            <button className="btn btn--secondary" onClick={cancelForm}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={validateAndSave}>
              Save Task
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-list">
          {tasks.length === 0 ? (
            <p className="empty-message">
              No scheduled tasks configured. Add a heartbeat task to run agents periodically.
            </p>
          ) : (
            tasks.map((task) => {
              const agentName = agents.find(a => a.id === task.agentId)?.name || task.agentId;
              return (
                <div key={task.id} className="settings-card">
                  <div className="settings-card__body">
                    <div className="settings-card__title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{task.name}</span>
                      <span 
                        onClick={() => toggleTaskEnabled(task)}
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '10px',
                          cursor: 'pointer',
                          background: task.enabled ? 'oklch(0.72 0.18 140 / 0.12)' : 'oklch(1 0 0 / 0.08)',
                          color: task.enabled ? 'oklch(0.72 0.18 140)' : 'var(--vscode-descriptionForeground)',
                          border: `1px solid ${task.enabled ? 'oklch(0.72 0.18 140 / 0.3)' : 'oklch(1 0 0 / 0.08)'}`,
                          userSelect: 'none'
                        }}
                        title="Toggle task active state"
                      >
                        {task.enabled ? '● Active' : '○ Off'}
                      </span>
                    </div>
                    {task.type === 'telegram' ? (
                      <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                        <strong>Agent:</strong> {agentName} · <strong>Type:</strong> <code>Telegram Poller</code>
                      </div>
                    ) : (
                      <>
                        <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                          <strong>Agent:</strong> {agentName} · <strong>Schedule:</strong> <code>{task.cron}</code>
                        </div>
                        <div className="settings-card__subtitle" style={{ fontSize: '11px', fontStyle: 'italic', opacity: 0.85, marginTop: '2px' }}>
                          "{task.prompt.length > 60 ? task.prompt.substring(0, 57) + '...' : task.prompt}"
                        </div>
                      </>
                    )}
                  </div>
                  <div className="settings-card__actions">
                    <button
                      className="icon-btn"
                      onClick={() => openLogViewer(task)}
                      title="View execution logs"
                      style={{ fontSize: '12px', marginRight: '4px' }}
                    >
                      📋
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => startEdit(task)}
                      title="Edit task"
                    >
                      ✏️
                    </button>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => deleteTask(task.id)}
                      title="Delete task"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Execution Console Side Drawer */}
      {viewingTaskLogs && (
        <div className="execution-console">
          <div className="execution-console__panel">
            <header className="execution-console__header">
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>
                📋 Execution Logs: {viewingTaskLogs.name}
              </h3>
              <button 
                className="execution-console__close-btn"
                onClick={() => setViewingTaskLogs(null)}
                title="Close console"
              >
                ✕
              </button>
            </header>

            <div className="execution-console__body">
              {/* Left runs sidebar list */}
              <div className="execution-console__runs-list">
                <span className="app__sidebar-section-title" style={{ paddingLeft: '4px', marginBottom: '8px' }}>
                  Execution History
                </span>
                {runs.length === 0 ? (
                  <div className="app__sidebar-empty-text">No execution runs recorded yet.</div>
                ) : (
                  runs.map((run) => {
                    const isSelected = run.runId === activeRunId;
                    const date = new Date(run.timestamp);
                    const formattedDate = date.toLocaleString();
                    const isSuccess = run.status === 'success';

                    return (
                      <button
                        key={run.runId}
                        className={`execution-console__run-item ${isSelected ? 'execution-console__run-item--active' : ''}`}
                        onClick={() => setSelectedRunId(run.runId)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                          <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
                            {run.runId}
                          </span>
                          <span style={{
                            fontSize: '9px',
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: '10px',
                            background: isSuccess ? 'oklch(0.72 0.18 140 / 0.12)' : 'oklch(0.6 0.18 20 / 0.12)',
                            color: isSuccess ? 'oklch(0.72 0.18 140)' : 'oklch(0.6 0.18 20)',
                            border: `1px solid ${isSuccess ? 'oklch(0.72 0.18 140 / 0.3)' : 'oklch(0.6 0.18 20 / 0.3)'}`
                          }}>
                            {run.status.toUpperCase()}
                          </span>
                        </div>
                        <span style={{ fontSize: '11px', fontWeight: 600, marginTop: '2px' }}>
                          {formattedDate}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {/* Right main run trace log */}
              <div className="execution-console__run-details">
                {activeRun ? (
                  <>
                    <div className="execution-console__run-header">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700 }}>
                          Run: {activeRun.runId}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
                          Executed on: {new Date(activeRun.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                          Agent: <strong>{selectedAgentName}</strong>
                        </span>
                      </div>
                    </div>

                    <div className="messages" style={{ padding: '20px 24px', flex: 1, overflowY: 'auto' }}>
                      <MessageList
                        items={activeRunChatItems}
                        isStreaming={false}
                        agentName={selectedAgentName}
                      />
                    </div>
                  </>
                ) : (
                  <div className="app__empty-state" style={{ height: '100%', justifyContent: 'center' }}>
                    <p>Select an execution run from the left sidebar to view details</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
