import { useState } from 'react';
import type { CaretakerConfig, AgentConfig, ProviderConfig } from 'caretaker-cli/types';
import type { ViewToHost } from './bridge.js';

interface ProvidersTabProps {
  config: CaretakerConfig;
  agents: AgentConfig[];
  postMessage: (msg: ViewToHost) => void;
}

export function ProvidersTab({ config, agents, postMessage }: ProvidersTabProps) {
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startEdit = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setIsCreating(false);
    setName(provider.name);
    setEndpoint(provider.endpoint);
    setApiKey(provider.apiKey || '');
    setErrorMsg(null);
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingProvider(null);
    setName('');
    setEndpoint('');
    setApiKey('');
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingProvider(null);
    setErrorMsg(null);
  };

  const validateAndSave = () => {
    const trimmedName = name.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedApiKey = apiKey.trim();

    if (!trimmedName) {
      setErrorMsg('Name is required.');
      return;
    }
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
    const newProv: ProviderConfig = {
      name: trimmedName,
      endpoint: trimmedEndpoint,
      ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
    };

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

      {errorMsg && <div className="validation-error">⚠ {errorMsg}</div>}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Add Provider' : `Edit Provider: ${editingProvider?.name}`}</h4>
          <div className="form-group">
            <label htmlFor="provider-name">Name</label>
            <input
              id="provider-name"
              type="text"
              placeholder="e.g. Ollama, OpenRouter"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editingProvider !== null} // Don't allow changing name of existing to prevent cascading breakages
            />
          </div>
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
                  <div className="settings-card__subtitle">{prov.endpoint}</div>
                  {prov.apiKey && <div className="settings-card__badge">Key Configured</div>}
                </div>
                <div className="settings-card__actions">
                  <button
                    className="icon-btn"
                    onClick={() => startEdit(prov)}
                    title="Edit provider"
                  >
                    ✏️
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => deleteProvider(prov.name)}
                    title="Delete provider"
                  >
                    🗑️
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
