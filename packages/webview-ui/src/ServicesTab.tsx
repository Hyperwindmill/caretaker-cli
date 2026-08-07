import { useState, useMemo } from 'react';
import type { CaretakerConfig, AgentConfig, ServiceConfig } from 'caretaker-types';
import type { ViewToHost, ChatMessage } from './bridge.js';
import type { ChatItem } from './App.js';
import { MessageList } from './MessageList.js';
import { WarningIcon, TipIcon, LogsIcon, EditIcon, DeleteIcon, CloseIcon, StatusIcon } from './icons.js';

interface ServicesTabProps {
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

export function ServicesTab({ config, agents, postMessage, taskRuns = {} }: ServicesTabProps) {
  // Ensure tasks array is initialized
  const tasks = config.scheduler?.tasks || [];

  const [editingTask, setEditingTask] = useState<ServiceConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Task log viewer states
  const [viewingTaskLogs, setViewingTaskLogs] = useState<ServiceConfig | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [type, setType] = useState<ServiceConfig['type']>('heartbeat');
  const [enabled, setEnabled] = useState(true);
  const [agentId, setAgentId] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('*/15 * * * *');
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramAllowedChats, setTelegramAllowedChats] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUser, setImapUser] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [allowedSenders, setAllowedSenders] = useState('');
  const [allowedRecipients, setAllowedRecipients] = useState('');
  const [allowedAgents, setAllowedAgents] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startEdit = (task: ServiceConfig) => {
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
    setImapHost(task.imapHost || '');
    setImapPort(task.imapPort ? String(task.imapPort) : '993');
    setImapUser(task.imapUser || '');
    setImapPassword(task.imapPassword || '');
    setImapSecure(task.imapSecure !== false);
    setSmtpHost(task.smtpHost || '');
    setSmtpPort(task.smtpPort ? String(task.smtpPort) : '587');
    setSmtpSecure(task.smtpSecure === true);
    setSmtpFrom(task.smtpFrom || '');
    setSmtpUser(task.smtpUser || '');
    setSmtpPassword(task.smtpPassword || '');
    setAllowedSenders(task.allowedSenders || '');
    setAllowedRecipients(task.allowedRecipients || '');
    setAllowedAgents(task.allowedAgents || []);
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
    setImapHost('');
    setImapPort('993');
    setImapUser('');
    setImapPassword('');
    setImapSecure(true);
    setSmtpHost('');
    setSmtpPort('587');
    setSmtpSecure(false);
    setSmtpFrom('');
    setSmtpUser('');
    setSmtpPassword('');
    setAllowedSenders('');
    setAllowedRecipients('');
    setAllowedAgents([]);
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
      setErrorMsg('Service Name is required.');
      return;
    }
    // An email service holds credentials only — there is nothing to run, so no agent.
    if (!agentId && type !== 'email') {
      setErrorMsg('Please select an agent for this service.');
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
    } else if (type === 'email') {
      if (!imapHost.trim() || !imapUser.trim() || !imapPassword.trim()) {
        setErrorMsg('IMAP host, user and password are required.');
        return;
      }
      const port = Number(imapPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setErrorMsg('IMAP port must be a whole number between 1 and 65535.');
        return;
      }
      // SMTP is optional: without a host the account simply cannot send, and
      // email_send skips it. With one, the port has to be usable.
      if (smtpHost.trim()) {
        const outPort = Number(smtpPort);
        if (!Number.isInteger(outPort) || outPort < 1 || outPort > 65535) {
          setErrorMsg('SMTP port must be a whole number between 1 and 65535.');
          return;
        }
      }
      // ponytail: cron/prompt are unused for email — they stay required on the
      // type so heartbeat/telegram keep reading them unconditionally.
      finalPrompt = 'Email (IMAP) credentials';
      finalCron = '';
    }

    const existing = tasks.find(t => t.name.toLowerCase() === trimmedName.toLowerCase());
    if (isCreating && existing) {
      setErrorMsg(`A service named "${trimmedName}" already exists.`);
      return;
    }
    if (editingTask && editingTask.name.toLowerCase() !== trimmedName.toLowerCase() && existing) {
      setErrorMsg(`A service named "${trimmedName}" already exists.`);
      return;
    }

    const taskData: ServiceConfig = {
      id: editingTask ? editingTask.id : 'task_' + Math.random().toString(36).substring(2, 9),
      name: trimmedName,
      type,
      enabled,
      agentId: type === 'email' ? '' : agentId,
      cron: finalCron,
      prompt: finalPrompt,
      ...(trimmedWorkingDir ? { workingDir: trimmedWorkingDir } : {}),
      ...(type === 'telegram'
        ? {
            telegramBotToken: telegramBotToken.trim(),
            telegramAllowedChats: telegramAllowedChats.trim(),
          }
        : {}),
      ...(type === 'email'
        ? {
            imapHost: imapHost.trim(),
            imapPort: Number(imapPort),
            imapUser: imapUser.trim(),
            imapPassword: imapPassword.trim(),
            imapSecure,
            smtpHost: smtpHost.trim(),
            smtpPort: Number(smtpPort),
            smtpSecure,
            smtpFrom: smtpFrom.trim(),
            smtpUser: smtpUser.trim(),
            smtpPassword: smtpPassword.trim(),
            allowedSenders: allowedSenders.trim(),
            allowedRecipients: allowedRecipients.trim(),
            allowedAgents,
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

  const toggleTaskEnabled = (task: ServiceConfig) => {
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

  const openLogViewer = (task: ServiceConfig) => {
    setViewingTaskLogs(task);
    setSelectedRunId(null);
    postMessage({ type: 'getTaskRuns', taskId: task.id });
  };

  const showForm = isCreating || editingTask !== null;

  // Filter current runs for viewing
  const runs = viewingTaskLogs ? taskRuns[viewingTaskLogs.id] || [] : [];
  const activeRunId = selectedRunId || runs[0]?.runId;
  const activeRun = runs.find(r => r.runId === activeRunId);
  const activeRunChatItems = useMemo(() => activeRun ? reconstructChatItems(activeRun.messages || []) : [], [activeRun]);
  const selectedAgentName = viewingTaskLogs ? agents.find(a => a.id === viewingTaskLogs.agentId)?.name : '';

  return (
    <div className="tab-pane services-tab">
      <div className="tab-pane__header">
        <h3>Services</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Add Service
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error"><WarningIcon size={14} /> {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Add Service' : `Edit Service: ${editingTask?.name}`}</h4>

          <div className="glass-form__body">
          <div className="form-group">
            <label htmlFor="task-name">Service Name</label>
            <input
              id="task-name"
              type="text"
              placeholder="e.g. Daily Workspace Clean, Morning Report"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="task-type">Service Type</label>
            <select
              id="task-type"
              value={type}
              onChange={(e) => setType(e.target.value as ServiceConfig['type'])}
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
              <option value="heartbeat">Heartbeat (Scheduled Agent Run)</option>
              <option value="telegram">Telegram Bot (Poller)</option>
              <option value="email">Email (IMAP credentials)</option>
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
              Active
            </label>
          </div>

          {type !== 'email' && (
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
          )}

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
          ) : type === 'telegram' ? (
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
                {telegramAllowedChats.trim() === '' && (
                  <div style={{
                    background: 'rgba(220, 150, 50, 0.10)',
                    border: '1px solid rgba(220, 150, 50, 0.35)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 10px',
                    fontSize: '11px',
                    marginTop: '6px',
                    lineHeight: '1.4',
                    color: 'var(--vscode-notificationsWarningIcon-foreground, #d49a32)',
                  }}>
                    <WarningIcon size={13} /> <strong>Security:</strong> with no whitelist, anyone who sends a message
                    to this bot can execute every tool this agent has enabled — including shell
                    commands and filesystem writes. Tool calls run with auto-approval; the
                    chat ID whitelist is the only access boundary.
                  </div>
                )}
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
                <strong><TipIcon size={14} /> Quick Setup Guide:</strong>
                <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  <li>Create a new bot via Telegram's <strong>@BotFather</strong> to obtain your HTTP API token.</li>
                  <li>Obtain your chat ID by messaging <strong>@userinfobot</strong> on Telegram.</li>
                  <li>Whitelist your chat ID above to prevent unauthorized users from using your local shell/tools!</li>
                </ol>
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="imap-host">IMAP Host</label>
                <input
                  id="imap-host"
                  type="text"
                  placeholder="e.g. imap.gmail.com"
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="imap-port">Port</label>
                <input
                  id="imap-port"
                  type="number"
                  value={imapPort}
                  onChange={(e) => setImapPort(e.target.value)}
                />
              </div>

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0' }}>
                <input
                  id="imap-secure"
                  type="checkbox"
                  checked={imapSecure}
                  onChange={(e) => setImapSecure(e.target.checked)}
                  style={{ width: 'auto', cursor: 'pointer' }}
                />
                <label htmlFor="imap-secure" style={{ cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>
                  Use TLS (implicit, port 993)
                </label>
              </div>

              <div className="form-group">
                <label htmlFor="imap-user">Username</label>
                <input
                  id="imap-user"
                  type="text"
                  placeholder="e.g. you@example.com"
                  value={imapUser}
                  onChange={(e) => setImapUser(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="imap-password">Password / App Password</label>
                <input
                  id="imap-password"
                  type="password"
                  value={imapPassword}
                  onChange={(e) => setImapPassword(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="smtp-host">SMTP Host <span style={{ opacity: 0.6, fontWeight: 400 }}>— sending</span></label>
                <input
                  id="smtp-host"
                  type="text"
                  placeholder="e.g. smtp.gmail.com — leave empty to disable sending"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="smtp-port">SMTP Port</label>
                <input
                  id="smtp-port"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                />
              </div>

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0' }}>
                <input
                  id="smtp-secure"
                  type="checkbox"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  style={{ width: 'auto', cursor: 'pointer' }}
                />
                <label htmlFor="smtp-secure" style={{ cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}>
                  Use TLS (implicit, port 465) — leave off for 587/STARTTLS
                </label>
              </div>

              <div className="form-group">
                <label htmlFor="smtp-from">From Address</label>
                <input
                  id="smtp-from"
                  type="text"
                  placeholder="defaults to the IMAP username"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="smtp-user">SMTP Username</label>
                <input
                  id="smtp-user"
                  type="text"
                  placeholder="defaults to the IMAP username"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="smtp-password">SMTP Password</label>
                <input
                  id="smtp-password"
                  type="password"
                  placeholder="defaults to the IMAP password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="allowed-recipients">Allowed Recipients</label>
                <input
                  id="allowed-recipients"
                  type="text"
                  placeholder="e.g. *@example.com, boss@corp.com — empty = anyone"
                  value={allowedRecipients}
                  onChange={(e) => setAllowedRecipients(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="allowed-senders">Allowed Senders</label>
                <input
                  id="allowed-senders"
                  type="text"
                  placeholder="e.g. *@example.com — inbound, not enforced yet"
                  value={allowedSenders}
                  onChange={(e) => setAllowedSenders(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Agents allowed to use this account</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                  {agents.length === 0 ? (
                    <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                      No agents configured yet.
                    </span>
                  ) : (
                    agents.map((a) => (
                      <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 400, fontSize: '12px' }}>
                        <input
                          type="checkbox"
                          checked={allowedAgents.includes(a.id)}
                          onChange={(e) =>
                            setAllowedAgents(
                              e.target.checked
                                ? [...allowedAgents, a.id]
                                : allowedAgents.filter((id) => id !== a.id),
                            )
                          }
                          style={{ width: 'auto', cursor: 'pointer' }}
                        />
                        {a.name}
                      </label>
                    ))
                  )}
                </div>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  None selected = every agent may use it.
                </span>
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
                <strong><TipIcon size={14} /> Note:</strong> credentials are AES-256-GCM
                encrypted at rest. Gmail/Outlook accounts need an <strong>app password</strong>,
                not the account password. With an SMTP host set, agents can send through this
                account (<code>mcp__email__*</code> tools), and with an IMAP host they can read it.
                <strong> Allowed Recipients</strong> is the limit on where mail may go, an empty list
                means anyone; <strong>Allowed Senders</strong> is
                what limits who <code>email_fetch</code> may read for the agent. Selecting no
                agent above leaves the account open to every one of them.
              </div>
            </>
          )}
          </div>

          <div className="form-actions">
            <button className="btn btn--secondary" onClick={cancelForm}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={validateAndSave}>
              Save Service
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-list">
          {tasks.length === 0 ? (
            <p className="empty-message">
              No services configured. Add a heartbeat to run an agent periodically, a Telegram bot, or email credentials.
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
                          userSelect: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                        title="Toggle service active state"
                      >
                        {task.enabled ? (
                          <>
                            <StatusIcon size={9} fill="currentColor" /> Active
                          </>
                        ) : (
                          <>
                            <StatusIcon size={9} /> Off
                          </>
                        )}
                      </span>
                    </div>
                    {task.type === 'telegram' ? (
                      <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                        <strong>Agent:</strong> {agentName} · <strong>Type:</strong> <code>Telegram Poller</code>
                      </div>
                    ) : task.type === 'email' ? (
                      <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                        <strong>Type:</strong> <code>Email</code> · {task.imapUser} · IMAP {task.imapHost}:{task.imapPort}
                        {task.smtpHost ? ` · SMTP ${task.smtpHost}:${task.smtpPort}` : ' · sending off'}
                        {task.allowedAgents?.length
                          ? ` · agents: ${task.allowedAgents.map(id => agents.find(a => a.id === id)?.name || id).join(', ')}`
                          : ' · any agent'}
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
                    {task.type === 'heartbeat' && (
                      <button
                        className="icon-btn"
                        onClick={() => openLogViewer(task)}
                        title="View execution logs"
                        aria-label="View execution logs"
                        style={{ fontSize: '12px', marginRight: '4px' }}
                      >
                        <LogsIcon size={13} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      onClick={() => startEdit(task)}
                      title="Edit service"
                      aria-label="Edit service"
                    >
                      <EditIcon size={14} />
                    </button>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => deleteTask(task.id)}
                      title="Delete service"
                      aria-label="Delete service"
                    >
                      <DeleteIcon size={14} />
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
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <LogsIcon size={14} /> Execution Logs: {viewingTaskLogs.name}
              </h3>
              <button 
                className="execution-console__close-btn"
                onClick={() => setViewingTaskLogs(null)}
                title="Close console"
                aria-label="Close console"
              >
                <CloseIcon size={16} />
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
