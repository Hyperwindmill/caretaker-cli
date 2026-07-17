import { useState, useEffect } from 'react';
import type { CaretakerConfig, AgentConfig, PluginsFile, McpServerConfig } from 'caretaker-types';
import type { ViewToHost, ModelsResult } from './bridge.js';
import FolderPicker from './FolderPicker.js';
import { WarningIcon, EditIcon, DeleteIcon } from './icons.js';

interface AgentsTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  pluginsFile: PluginsFile;
  mcpServersFile: { servers: McpServerConfig[] };
  availableTools: string[];
  modelsResult: ModelsResult | null;
  setModelsResult: (res: ModelsResult | null) => void;
  postMessage: (msg: ViewToHost) => void;
}

export function AgentsTab({
  config,
  agents,
  pluginsFile,
  mcpServersFile,
  availableTools,
  modelsResult,
  setModelsResult,
  postMessage,
}: AgentsTabProps) {
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [maxTurns, setMaxTurns] = useState(30);
  const [workingDir, setWorkingDir] = useState('');
  const [permissionMode, setPermissionMode] = useState('');

  // Selected tool states: record toolName -> true/false
  const [selectedTools, setSelectedTools] = useState<Record<string, boolean>>({});
  const [confirmTools, setConfirmTools] = useState<Record<string, boolean>>({});

  // Selected plugins: record pluginName -> true/false
  const [selectedPlugins, setSelectedPlugins] = useState<Record<string, boolean>>({});

  // Selected MCP servers: record serverId -> true/false
  const [selectedMcpServers, setSelectedMcpServers] = useState<Record<string, boolean>>({});

  const [fetchingModels, setFetchingModels] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const providerType = config.providers.find(p => p.name === provider)?.type ?? 'openai';
  const isClaudeCode = providerType === 'claude-code';

  // When model fetch returns, stop loading
  useEffect(() => {
    if (modelsResult) {
      setFetchingModels(false);
      if (!modelsResult.ok) {
        setErrorMsg(`Failed to fetch models: ${modelsResult.error}`);
      }
    }
  }, [modelsResult]);

  const startCreate = () => {
    setIsCreating(true);
    setEditingAgent(null);
    setName('');
    setSystemPrompt('');
    const defaultProvider = config.providers[0]?.name || '';
    setProvider(defaultProvider);
    setModel('');
    setMaxTurns(30);
    setWorkingDir('');
    setPermissionMode('');

    // Pre-check some standard tools by default (e.g. read_file, grep_search)
    const initialTools: Record<string, boolean> = {};
    availableTools.forEach(t => {
      initialTools[t] = t === 'read_file' || t === 'grep_search';
    });
    setSelectedTools(initialTools);
    setConfirmTools({});
    setSelectedPlugins({});
    setSelectedMcpServers({});
    setModelsResult(null);
    setErrorMsg(null);
  };

  const startEdit = (agent: AgentConfig) => {
    setEditingAgent(agent);
    setIsCreating(false);
    setName(agent.name);
    setSystemPrompt(agent.systemPrompt);
    setProvider(agent.provider);
    setModel(agent.model);
    setMaxTurns(agent.maxTurns || 30);
    setWorkingDir(agent.workingDir || '');
    setPermissionMode(agent.permissionMode ?? '');

    const initialTools: Record<string, boolean> = {};
    const initialConfirm: Record<string, boolean> = {};
    availableTools.forEach(t => {
      if (t === 'mcp__task__*') {
        initialTools[t] = agent.allowedTools.includes(t) || agent.allowedTools.some(x => x.startsWith('mcp__task__'));
        initialConfirm[t] = agent.confirmTools?.includes(t) || agent.confirmTools?.some(x => x.startsWith('mcp__task__')) || false;
      } else {
        initialTools[t] = agent.allowedTools.includes(t);
        initialConfirm[t] = agent.confirmTools?.includes(t) || false;
      }
    });
    setSelectedTools(initialTools);
    setConfirmTools(initialConfirm);

    const initialPlugins: Record<string, boolean> = {};
    pluginsFile.plugins.forEach(p => {
      initialPlugins[p.name] = agent.plugins?.includes(p.name) || false;
    });
    setSelectedPlugins(initialPlugins);

    const initialMcp: Record<string, boolean> = {};
    mcpServersFile.servers.forEach(s => {
      initialMcp[s.id] = agent.mcpServers?.includes(s.id) || false;
    });
    setSelectedMcpServers(initialMcp);

    setModelsResult(null);
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingAgent(null);
    setModelsResult(null);
    setErrorMsg(null);
  };

  const fetchModelsList = () => {
    const selectedProv = config.providers.find(p => p.name === provider);
    if (!selectedProv) {
      setErrorMsg('Please select a valid provider first.');
      return;
    }
    setFetchingModels(true);
    setModelsResult(null);
    setErrorMsg(null);
    postMessage({
      type: 'fetchModels',
      endpoint: selectedProv.endpoint,
      apiKey: selectedProv.apiKey,
    });
  };

  const validateAndSave = () => {
    const trimmedName = name.trim();
    const trimmedModel = model.trim();
    const trimmedSystemPrompt = systemPrompt.trim();
    const trimmedWorkingDir = workingDir.trim();

    if (!trimmedName) {
      setErrorMsg('Name is required.');
      return;
    }
    if (!provider) {
      setErrorMsg('Provider is required.');
      return;
    }
    if (!trimmedModel) {
      setErrorMsg('Model is required.');
      return;
    }
    if (trimmedWorkingDir) {
      // Basic check for absolute path style (starts with / or [A-Z]:\)
      if (!trimmedWorkingDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmedWorkingDir)) {
        setErrorMsg('Working Directory must be an absolute path.');
        return;
      }
    }

    const duplicate = agents.find(a => a.name.toLowerCase() === trimmedName.toLowerCase());
    if (isCreating && duplicate) {
      setErrorMsg(`An agent named "${trimmedName}" already exists.`);
      return;
    }
    if (editingAgent && editingAgent.name !== trimmedName && duplicate) {
      setErrorMsg(`An agent named "${trimmedName}" already exists.`);
      return;
    }

    // Assemble allowedTools, confirmTools and plugins. Claude Code agents ignore these at
    // runtime (they use the CLI's own tool/permission system) — for an existing agent being
    // edited, preserve its previously stored values verbatim instead of wiping them from the
    // (hidden) picker state; a brand-new claude-code agent just gets empty arrays.
    const allowedToolsList = isClaudeCode
      ? editingAgent?.allowedTools ?? []
      : Object.keys(selectedTools).filter(t => selectedTools[t]);
    const confirmToolsList = isClaudeCode
      ? editingAgent?.confirmTools ?? []
      : Object.keys(confirmTools).filter(t => selectedTools[t] && confirmTools[t]);
    const pluginsList = isClaudeCode
      ? editingAgent?.plugins ?? []
      : Object.keys(selectedPlugins).filter(p => selectedPlugins[p]);

    // MCP servers stay user-editable regardless of provider type.
    const mcpServersList = Object.keys(selectedMcpServers).filter(s => selectedMcpServers[s]);

    const finalAgent: AgentConfig = {
      id: editingAgent ? editingAgent.id : `agent-${Math.random().toString(36).substring(2, 10)}`,
      name: trimmedName,
      systemPrompt: trimmedSystemPrompt,
      provider,
      model: trimmedModel,
      allowedTools: allowedToolsList,
      confirmTools: confirmToolsList,
      plugins: pluginsList,
      mcpServers: mcpServersList,
      maxTurns,
      ...(trimmedWorkingDir ? { workingDir: trimmedWorkingDir } : {}),
      ...(isClaudeCode && permissionMode ? { permissionMode } : {}),
      // Preserve plugin-managed properties
      ...(editingAgent?.pluginId ? { pluginId: editingAgent.pluginId } : {}),
      ...(editingAgent?.pluginScopedName ? { pluginScopedName: editingAgent.pluginScopedName } : {}),
    };

    postMessage({
      type: 'saveAgent',
      agent: finalAgent,
    });

    setIsCreating(false);
    setEditingAgent(null);
    setModelsResult(null);
    setErrorMsg(null);
  };

  const deleteAgent = (agentId: string) => {
    postMessage({
      type: 'deleteAgent',
      agentId,
    });
  };

  const showForm = isCreating || editingAgent !== null;

  return (
    <div className="tab-pane agents-tab">
      <div className="tab-pane__header">
        <h3>Agents</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Add Agent
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error"><WarningIcon size={13} /> {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Create Agent' : `Edit Agent: ${editingAgent?.name}`}</h4>
          
          <div className="glass-form__body">
            <div className="form-group">
            <label htmlFor="agent-name">Agent Name</label>
            <input
              id="agent-name"
              type="text"
              placeholder="e.g. Senior Architect"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="agent-prompt">System Prompt</label>
            <textarea
              id="agent-prompt"
              rows={4}
              placeholder="System prompt to guide the agent's behavior..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agent-provider">Provider</label>
              <select
                id="agent-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="" disabled>-- Select Provider --</option>
                {config.providers.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>

            {!isClaudeCode && (
              <div className="form-group">
                <label htmlFor="agent-turns">Max Turns</label>
                <input
                  id="agent-turns"
                  type="number"
                  min={1}
                  max={150}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(parseInt(e.target.value) || 30)}
                />
              </div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="agent-model">Model</label>
            <div className="input-with-action">
              {!isClaudeCode && modelsResult?.ok ? (
                <select
                  id="agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">-- Select Model --</option>
                  {modelsResult.ids.map(id => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              ) : (
                <input
                  id="agent-model"
                  type="text"
                  placeholder={isClaudeCode ? 'sonnet | opus | haiku (or full model id)' : 'e.g. claude-3-5-sonnet-latest'}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
              {!isClaudeCode && (
                <button
                  type="button"
                  className="btn btn--secondary btn--xs"
                  disabled={fetchingModels || !provider}
                  onClick={fetchModelsList}
                >
                  {fetchingModels ? '...' : 'Fetch'}
                </button>
              )}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="agent-dir">Working Directory (Absolute Path - Optional)</label>
            <FolderPicker
              id="agent-dir"
              placeholder="e.g. /home/user/my-project"
              value={workingDir}
              onChange={setWorkingDir}
            />
          </div>

          {isClaudeCode ? (
            /* Permission mode (replaces the tool/plugins pickers, which are ignored at runtime) */
            <div className="form-group">
              <label htmlFor="agent-permission-mode">Permission Mode</label>
              <select
                id="agent-permission-mode"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
              >
                <option value="">Auto (Claude Code default from ~/.claude/settings.json)</option>
                {['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.4', margin: '4px 0 0' }}>
                Claude Code uses its own tools and permissions. Uses your local Claude Code session;
                Anthropic may bill programmatic use as extra usage.
              </p>
            </div>
          ) : (
            <>
              {/* Tools Selection */}
              <div className="form-group form-group--chips">
                <label>Exposed Tools</label>
                <div className="chips-container-vertical">
                  <div className="chips-header-row">
                    <span className="chip-col-name">Tool</span>
                    <span className="chip-col-check">
                      <span>Allow</span>
                      <input
                        type="checkbox"
                        checked={availableTools.length > 0 && availableTools.every(t => selectedTools[t])}
                        onChange={(e) => {
                          const nextTools: Record<string, boolean> = {};
                          availableTools.forEach(t => {
                            nextTools[t] = e.target.checked;
                          });
                          setSelectedTools(nextTools);
                          if (!e.target.checked) {
                            setConfirmTools({});
                          }
                        }}
                      />
                    </span>
                    <span className="chip-col-check">
                      <span>Ask First</span>
                      <input
                        type="checkbox"
                        disabled={!availableTools.some(t => selectedTools[t])}
                        checked={availableTools.length > 0 && availableTools.every(t => !selectedTools[t] || confirmTools[t])}
                        onChange={(e) => {
                          const nextConfirm: Record<string, boolean> = {};
                          availableTools.forEach(t => {
                            if (selectedTools[t]) {
                              nextConfirm[t] = e.target.checked;
                            }
                          });
                          setConfirmTools(nextConfirm);
                        }}
                      />
                    </span>
                  </div>
                  {availableTools.map(tool => (
                    <div key={tool} className="chip-row">
                      <span className="chip-name">{tool}</span>
                      <input
                        type="checkbox"
                        className="chip-check"
                        checked={selectedTools[tool] || false}
                        onChange={(e) => {
                          setSelectedTools({
                            ...selectedTools,
                            [tool]: e.target.checked
                          });
                        }}
                      />
                      <input
                        type="checkbox"
                        className="chip-check"
                        disabled={!selectedTools[tool]}
                        checked={selectedTools[tool] && (confirmTools[tool] || false)}
                        onChange={(e) => {
                          setConfirmTools({
                            ...confirmTools,
                            [tool]: e.target.checked
                          });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Plugins Selection */}
              {pluginsFile.plugins.length > 0 && (
                <div className="form-group">
                  <label>Mounted Plugins</label>
                  <div className="chips-list">
                    {pluginsFile.plugins.map(p => (
                      <label key={p.name} className="chip-item">
                        <input
                          type="checkbox"
                          checked={selectedPlugins[p.name] || false}
                          onChange={(e) => {
                            setSelectedPlugins({
                              ...selectedPlugins,
                              [p.name]: e.target.checked
                            });
                          }}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* MCP Servers Selection */}
          {mcpServersFile.servers.length > 0 && (
            <div className="form-group">
              <label>Mounted MCP Servers</label>
              <div className="chips-list">
                {mcpServersFile.servers.map(s => (
                  <label key={s.id} className="chip-item">
                    <input
                      type="checkbox"
                      checked={selectedMcpServers[s.id] || false}
                      onChange={(e) => {
                        setSelectedMcpServers({
                          ...selectedMcpServers,
                          [s.id]: e.target.checked
                        });
                      }}
                    />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
            </div>
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
          {agents.length === 0 ? (
            <p className="empty-message">No agents configured. Add one to define your assistant.</p>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} className="settings-card">
                <div className="settings-card__body">
                  <div className="settings-card__title">
                    {agent.name}
                    {agent.pluginId && (
                      <span className="settings-card__badge-managed" title="Managed by a plugin sync">
                        Managed
                      </span>
                    )}
                  </div>
                  <div className="settings-card__subtitle">
                    {agent.provider} • {agent.model}
                  </div>
                  <div className="settings-card__metadata">
                    Turns: {agent.maxTurns || 30} • Tools: {agent.allowedTools.length}
                    {agent.plugins && agent.plugins.length > 0 && ` • Plugins: ${agent.plugins.length}`}
                    {agent.mcpServers && agent.mcpServers.length > 0 && ` • MCP: ${agent.mcpServers.length}`}
                  </div>
                </div>
                <div className="settings-card__actions">
                  <button
                    className="icon-btn"
                    onClick={() => startEdit(agent)}
                    title="Edit agent"
                  >
                    <EditIcon size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => deleteAgent(agent.id)}
                    title="Delete agent"
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
