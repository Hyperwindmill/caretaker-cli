import { useState, useEffect } from 'react';
import type { CaretakerConfig, AgentConfig } from 'caretaker-cli/types';
import type { ViewToHost } from './bridge.js';

interface SchedulerTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
}

export function SchedulerTab({ config, agents, postMessage }: SchedulerTabProps) {
  // Extract existing scheduler config or fallback to defaults
  const scheduler = config.scheduler || {
    enabled: false,
    agentId: '',
    workingDir: '',
    prompt: 'Hello! Run a health check on this workspace and report any issues.',
    cron: '*/15 * * * *', // every 15 minutes by default
  };

  const [enabled, setEnabled] = useState(scheduler.enabled);
  const [agentId, setAgentId] = useState(scheduler.agentId);
  const [workingDir, setWorkingDir] = useState(scheduler.workingDir || '');
  const [prompt, setPrompt] = useState(scheduler.prompt || '');
  const [cron, setCron] = useState(scheduler.cron || '*/15 * * * *');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Sync state if config prop changes (e.g. loaded from host)
  useEffect(() => {
    if (config.scheduler) {
      setEnabled(config.scheduler.enabled);
      setAgentId(config.scheduler.agentId);
      setWorkingDir(config.scheduler.workingDir || '');
      setPrompt(config.scheduler.prompt || '');
      setCron(config.scheduler.cron || '*/15 * * * *');
    }
  }, [config.scheduler]);

  const handleSave = () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedWorkingDir = workingDir.trim();
    const trimmedPrompt = prompt.trim();
    const trimmedCron = cron.trim();

    if (enabled) {
      if (!agentId) {
        setErrorMsg('Please select an agent to run.');
        return;
      }
      if (!trimmedPrompt) {
        setErrorMsg('Prompt is required when the scheduler is enabled.');
        return;
      }
      if (!trimmedCron) {
        setErrorMsg('Cron expression is required when the scheduler is enabled.');
        return;
      }
      // Simple validation for cron expression layout (must have 5 fields)
      const parts = trimmedCron.split(/\s+/);
      if (parts.length !== 5) {
        setErrorMsg('Invalid cron expression. It must contain exactly 5 space-separated fields (e.g. "*/15 * * * *").');
        return;
      }
    }

    const updatedConfig = {
      ...config,
      scheduler: {
        enabled,
        agentId,
        workingDir: trimmedWorkingDir,
        prompt: trimmedPrompt,
        cron: trimmedCron,
      },
    };

    postMessage({
      type: 'saveConfig',
      config: updatedConfig,
    });

    setSuccessMsg('Scheduler configurations saved successfully!');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  return (
    <div className="tab-pane scheduler-tab">
      <div className="tab-pane__header">
        <h3>Heartbeat Scheduler</h3>
        <span className={`status-badge ${enabled ? 'status-badge--active' : 'status-badge--inactive'}`}>
          {enabled ? '● Active' : '○ Disabled'}
        </span>
      </div>

      {errorMsg && <div className="validation-error">⚠ {errorMsg}</div>}
      {successMsg && <div className="validation-success" style={{
        background: 'oklch(0.72 0.18 140 / 0.15)',
        border: '1px solid oklch(0.72 0.18 140 / 0.3)',
        color: 'oklch(0.72 0.18 140)',
        padding: '8px 12px',
        borderRadius: 'var(--radius-sm)',
        fontSize: '12px',
        marginBottom: '12px'
      }}>✓ {successMsg}</div>}

      <div className="glass-form">
        <h4>Heartbeat Configuration</h4>
        <p className="description" style={{
          fontSize: '12px',
          color: 'var(--vscode-descriptionForeground, oklch(1 0 0 / 0.45))',
          lineHeight: '1.4',
          marginBottom: '16px'
        }}>
          Set up a recurring autonomous run ("heartbeat") to execute an agent periodically with a specific prompt.
          This scheduler runs in-process inside the Hono web server process.
        </p>

        <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <input
            id="scheduler-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ width: 'auto', cursor: 'pointer' }}
          />
          <label htmlFor="scheduler-enabled" style={{ cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
            Enable Heartbeat Scheduler
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="scheduler-agent">Agent to Execute</label>
          <select
            id="scheduler-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={!enabled}
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--vscode-dropdown-background, #252526)',
              color: 'var(--vscode-dropdown-foreground, #cccccc)',
              border: '1px solid var(--vscode-dropdown-border, #3c3c3c)',
              fontSize: '12px',
              cursor: enabled ? 'pointer' : 'not-allowed',
              opacity: enabled ? 1 : 0.6
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
          <label htmlFor="scheduler-cron">Cron Schedule</label>
          <input
            id="scheduler-cron"
            type="text"
            placeholder="e.g. */15 * * * * (every 15m) or 0 * * * * (every hour)"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            disabled={!enabled}
            style={{ opacity: enabled ? 1 : 0.6 }}
          />
        </div>

        <div className="form-group">
          <label htmlFor="scheduler-dir">Working Directory (Absolute path, optional)</label>
          <input
            id="scheduler-dir"
            type="text"
            placeholder="e.g. /home/user/project (defaults to process.cwd())"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            disabled={!enabled}
            style={{ opacity: enabled ? 1 : 0.6 }}
          />
        </div>

        <div className="form-group">
          <label htmlFor="scheduler-prompt">Periodic Prompt</label>
          <textarea
            id="scheduler-prompt"
            placeholder="What should the agent check or do periodically?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!enabled}
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
              resize: 'vertical',
              opacity: enabled ? 1 : 0.6
            }}
          />
        </div>

        <div className="form-actions" style={{ marginTop: '16px' }}>
          <button className="btn btn--primary" onClick={handleSave}>
            Save Scheduler Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
