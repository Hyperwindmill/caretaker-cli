import { useState } from 'react';
import type { CaretakerConfig, AgentConfig, ScheduledTaskConfig } from 'caretaker-cli/types';
import type { ViewToHost } from './bridge.js';

interface SchedulerTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
}

export function SchedulerTab({ config, agents, postMessage }: SchedulerTabProps) {
  // Ensure tasks array is initialized
  const tasks = config.scheduler?.tasks || [];

  const [editingTask, setEditingTask] = useState<ScheduledTaskConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [type, setType] = useState<'heartbeat'>('heartbeat');
  const [enabled, setEnabled] = useState(true);
  const [agentId, setAgentId] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('*/15 * * * *');
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
    setErrorMsg(null);
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingTask(null);
    setName('');
    setType('heartbeat');
    setEnabled(true);
    // Pick the first agent if available as a convenient default
    setAgentId(agents[0]?.id || '');
    setWorkingDir('');
    setPrompt('');
    setCron('*/15 * * * *');
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
    if (!trimmedPrompt) {
      setErrorMsg('Periodic Prompt is required.');
      return;
    }
    if (!trimmedCron) {
      setErrorMsg('Cron timing is required.');
      return;
    }

    // Cron Timing validation (must be 5 space-separated parts)
    const cronParts = trimmedCron.split(/\s+/);
    if (cronParts.length !== 5) {
      setErrorMsg('Invalid cron expression. It must contain exactly 5 space-separated fields (e.g. "*/15 * * * *").');
      return;
    }

    // Unique task name validation
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
      cron: trimmedCron,
      prompt: trimmedPrompt,
      ...(trimmedWorkingDir ? { workingDir: trimmedWorkingDir } : {}),
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

  const showForm = isCreating || editingTask !== null;

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
              onChange={(e) => setType(e.target.value as 'heartbeat')}
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
                    <div className="settings-card__subtitle" style={{ fontSize: '11px', marginTop: '4px' }}>
                      <strong>Agent:</strong> {agentName} · <strong>Schedule:</strong> <code>{task.cron}</code>
                    </div>
                    <div className="settings-card__subtitle" style={{ fontSize: '11px', fontStyle: 'italic', opacity: 0.85, marginTop: '2px' }}>
                      "{task.prompt.length > 60 ? task.prompt.substring(0, 57) + '...' : task.prompt}"
                    </div>
                  </div>
                  <div className="settings-card__actions">
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
    </div>
  );
}
