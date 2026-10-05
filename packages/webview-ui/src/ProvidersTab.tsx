import { useState, useEffect } from 'react';
import type { CaretakerConfig, AgentConfig, ProviderConfig } from 'caretaker-types';
import type { ViewToHost, AcpRegistryResult } from './bridge.js';
import { WarningIcon, EditIcon, DeleteIcon } from './icons.js';

interface ProvidersTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
  acpRegistry?: AcpRegistryResult | null;
  acpInstall?: {
    agentId: string;
    lines: string[];
    result?: { ok: boolean; command?: string; args?: string[]; env?: Record<string, string>; error?: string };
  } | null;
  resetAcpInstall?: () => void;
}

export function ProvidersTab({
  config,
  agents,
  postMessage,
  acpRegistry = null,
  acpInstall = null,
  resetAcpInstall = () => {},
}: ProvidersTabProps) {
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'claude-code' | 'acp'>('openai');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [presetId, setPresetId] = useState('custom');
  const [selfLoaded, setSelfLoaded] = useState<string[]>([]);
  const [presetEnv, setPresetEnv] = useState<Record<string, string> | undefined>(undefined);
  const [installing, setInstalling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedPreset = acpRegistry?.ok ? acpRegistry.agents.find((a) => a.id === presetId) : null;

  useEffect(() => {
    if (type === 'acp' && acpRegistry === null) {
      postMessage({ type: 'fetchAcpRegistry' });
    }
  }, [type, acpRegistry, postMessage]);

  useEffect(() => {
    if (acpInstall?.agentId === presetId && acpInstall.result) {
      if (acpInstall.result.ok) {
        if (acpInstall.result.command) setCommand(acpInstall.result.command);
        setArgs((acpInstall.result.args ?? []).join(' '));
        if (acpInstall.result.env) setPresetEnv(acpInstall.result.env);
        setInstalling(false);
      } else {
        setErrorMsg(acpInstall.result.error || 'Installation failed');
        setInstalling(false);
      }
    }
  }, [acpInstall, presetId]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    if (id === 'custom') {
      setSelfLoaded([]);
      setPresetEnv(undefined);
      return;
    }
    const preset = acpRegistry?.ok ? acpRegistry.agents.find((a) => a.id === id) : null;
    if (!preset || !preset.dist) return;
    setSelfLoaded(preset.selfLoadedContextFiles);
    setPresetEnv(preset.dist.env);
    if (preset.dist.kind === 'binary') {
      setCommand('');
      setArgs('');
    } else {
      setCommand(preset.dist.command);
      setArgs(preset.dist.args.join(' '));
    }
  };

  const startEdit = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setIsCreating(false);
    setName(provider.name);
    setType(provider.type ?? 'openai');
    setEndpoint(provider.endpoint);
    setApiKey(provider.apiKey || '');
    setCommand(provider.command || '');
    setArgs((provider.args ?? []).join(' '));
    setPresetId('custom');
    setSelfLoaded(provider.selfLoadedContextFiles ?? []);
    setPresetEnv(provider.env);
    setInstalling(false);
    setErrorMsg(null);
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingProvider(null);
    setName('');
    setType('openai');
    setEndpoint('');
    setApiKey('');
    setCommand('');
    setArgs('');
    setPresetId('custom');
    setSelfLoaded([]);
    setPresetEnv(undefined);
    setInstalling(false);
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingProvider(null);
    setPresetId('custom');
    setSelfLoaded([]);
    setPresetEnv(undefined);
    setInstalling(false);
    setErrorMsg(null);
  };

  const validateAndSave = () => {
    const trimmedName = name.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedApiKey = apiKey.trim();
    const trimmedCommand = command.trim();
    const isClaudeCode = type === 'claude-code';
    const isAcp = type === 'acp';

    if (!trimmedName) {
      setErrorMsg('Name is required.');
      return;
    }
    if (isAcp) {
      if (!trimmedCommand) {
        setErrorMsg('Command is required for ACP agents (e.g. npx or binary path).');
        return;
      }
    } else if (!isClaudeCode) {
      if (!trimmedEndpoint) {
        setErrorMsg('Endpoint is required.');
        return;
      }
      try {
        new URL(trimmedEndpoint);
      } catch {
        setErrorMsg('Endpoint must be a valid URL (e.g. http://localhost:11434/v1).');
        return;
      }
    }

    // Name uniqueness check for creation, or if renaming
    const existing = config.providers.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (isCreating && existing) {
      setErrorMsg(`A provider named "${trimmedName}" already exists.`);
      return;
    }
    if (editingProvider && editingProvider.name !== trimmedName && existing) {
      setErrorMsg(`A provider named "${trimmedName}" already exists.`);
      return;
    }

    // Modify caretaker.json
    const updatedProviders = [...config.providers];
    let newProv: ProviderConfig;
    if (isAcp) {
      const p: ProviderConfig = {
        name: trimmedName,
        type: 'acp',
        endpoint: '',
        command: trimmedCommand,
      };
      const argList = args.trim() ? args.trim().split(/\s+/) : [];
      if (argList.length) p.args = argList;
      const envToSave = presetEnv ?? editingProvider?.env;
      if (envToSave) p.env = envToSave;
      const selfLoadedToSave = selfLoaded.length ? selfLoaded : editingProvider?.selfLoadedContextFiles;
      if (selfLoadedToSave && selfLoadedToSave.length) p.selfLoadedContextFiles = selfLoadedToSave;
      newProv = p;
    } else if (isClaudeCode) {
      newProv = {
        name: trimmedName,
        type: 'claude-code',
        endpoint: '',
        ...(trimmedCommand ? { command: trimmedCommand } : {}),
      };
    } else {
      newProv = {
        name: trimmedName,
        endpoint: trimmedEndpoint,
        ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
      };
    }

    if (isCreating) {
      updatedProviders.push(newProv);
    } else if (editingProvider) {
      const idx = updatedProviders.findIndex(p => p.name === editingProvider.name);
      if (idx !== -1) {
        updatedProviders[idx] = newProv;
      }
    }

    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        providers: updatedProviders,
      },
    });

    setIsCreating(false);
    setEditingProvider(null);
    setErrorMsg(null);
  };

  const deleteProvider = (provName: string) => {
    // Check if any agent depends on this provider
    const dependentAgents = agents.filter(a => a.provider === provName);
    if (dependentAgents.length > 0) {
      const agentNames = dependentAgents.map(a => `"${a.name}"`).join(', ');
      setErrorMsg(`Cannot delete provider: used by agent(s) ${agentNames}.`);
      return;
    }

    const updatedProviders = config.providers.filter(p => p.name !== provName);
    postMessage({
      type: 'saveConfig',
      config: {
        ...config,
        providers: updatedProviders,
      },
    });
  };

  const showForm = isCreating || editingProvider !== null;

  return (
    <div className="tab-pane providers-tab">
      <div className="tab-pane__header">
        <h3>API Providers</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Add Provider
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error"><WarningIcon size={13} /> {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Add Provider' : `Edit Provider: ${editingProvider?.name}`}</h4>
          <div className="glass-form__body">
          <div className="form-group">
            <label htmlFor="provider-type">Type</label>
            <select
              id="provider-type"
              value={type}
              onChange={(e) => setType(e.target.value as 'openai' | 'claude-code' | 'acp')}
              disabled={editingProvider !== null} // Changing an existing provider's type could break agents that reference it
            >
              <option value="openai">OpenAI-compatible endpoint</option>
              <option value="claude-code">Claude Code (local CLI)</option>
              <option value="acp">External agent (ACP)</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="provider-name">Name</label>
            <input
              id="provider-name"
              type="text"
              placeholder="e.g. Ollama, OpenRouter, ACP"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editingProvider !== null} // Don't allow changing name of existing to prevent cascading breakages
            />
          </div>
          {type === 'acp' ? (
            <>
              <div className="form-group">
                <label htmlFor="acp-preset">Agent</label>
                <select
                  id="acp-preset"
                  value={presetId}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  <option value="custom">Custom (manual command)</option>
                  {acpRegistry?.ok &&
                    acpRegistry.agents.map((a) => (
                      <option key={a.id} value={a.id} disabled={a.dist === null}>
                        {a.name}
                        {a.dist === null ? ' (not available on this platform)' : ''}
                      </option>
                    ))}
                </select>
                {acpRegistry && !acpRegistry.ok && (
                  <p className="form-error">Registry unavailable: {acpRegistry.error} — use Custom.</p>
                )}
              </div>
              {selectedPreset?.dist?.kind === 'binary' ? (
                <div className="form-group">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={installing}
                    onClick={() => {
                      resetAcpInstall();
                      setInstalling(true);
                      postMessage({ type: 'installAcpAgent', agentId: presetId });
                    }}
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </button>
                  {acpInstall?.agentId === presetId && (
                    <pre className="install-log">{acpInstall.lines.join('\n')}</pre>
                  )}
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label htmlFor="provider-command">Command</label>
                    <input
                      id="provider-command"
                      type="text"
                      placeholder="npx"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="provider-args">Arguments</label>
                    <input
                      id="provider-args"
                      type="text"
                      placeholder="@agentclientprotocol/claude-agent-acp"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                    />
                    <p style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.4', margin: '4px 0 0' }}>
                      Space-separated. Env vars can be added by editing caretaker.json.
                    </p>
                  </div>
                </>
              )}
            </>
          ) : type === 'claude-code' ? (
            <div className="form-group">
              <label htmlFor="provider-command">Command (Optional)</label>
              <input
                id="provider-command"
                type="text"
                placeholder="claude"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
              <p style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.4', margin: '4px 0 0' }}>
                Uses your local Claude Code session; Anthropic may bill programmatic use as extra usage.
              </p>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="provider-endpoint">Endpoint URL</label>
                <input
                  id="provider-endpoint"
                  type="text"
                  placeholder="e.g. http://localhost:11434/v1"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="provider-key">API Key (Optional)</label>
                <input
                  id="provider-key"
                  type="password"
                  placeholder={editingProvider?.apiKey ? '••••••••' : 'Optional credentials'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </>
          )}
          </div>
          <div className="form-actions">
            <button className="btn btn--secondary" onClick={cancelForm}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={validateAndSave}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-list">
          {config.providers.length === 0 ? (
            <p className="empty-message">No providers registered. Add one to connect your agents.</p>
          ) : (
            config.providers.map((prov) => (
              <div key={prov.name} className="settings-card">
                <div className="settings-card__body">
                  <div className="settings-card__title">{prov.name}</div>
                  <div className="settings-card__subtitle">
                    {prov.type === 'acp'
                      ? `External agent (ACP) — ${prov.command ?? ''} ${(prov.args ?? []).join(' ')}`.trim()
                      : prov.type === 'claude-code'
                        ? `Claude Code (local CLI)${prov.command ? ` — ${prov.command}` : ''}`
                        : prov.endpoint}
                  </div>
                  {prov.apiKey && <div className="settings-card__badge">Key Configured</div>}
                </div>
                <div className="settings-card__actions">
                  <button
                    className="icon-btn"
                    onClick={() => startEdit(prov)}
                    title="Edit provider"
                    aria-label="Edit provider"
                  >
                    <EditIcon size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => deleteProvider(prov.name)}
                    title="Delete provider"
                    aria-label="Delete provider"
                  >
                    <DeleteIcon size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
