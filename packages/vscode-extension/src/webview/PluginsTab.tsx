import { useState, useEffect } from 'react';
import type { PluginsFile, PluginSource, PluginRecord } from 'caretaker-cli/types';
import type { ViewToHost, RefreshOutcome } from '../bridge.js';

interface PluginsTabProps {
  pluginsFile: PluginsFile;
  refreshingSourceId: string | null;
  refreshOutcome: RefreshOutcome | null;
  setRefreshOutcome: (out: RefreshOutcome | null) => void;
  postMessage: (msg: ViewToHost) => void;
}

export function PluginsTab({
  pluginsFile,
  refreshingSourceId,
  refreshOutcome,
  setRefreshOutcome,
  postMessage,
}: PluginsTabProps) {
  const [editingSource, setEditingSource] = useState<PluginSource | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [kind, setKind] = useState<'git' | 'path'>('git');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [refreshOnStart, setRefreshOnStart] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Clear outcome on unmount
  useEffect(() => {
    return () => {
      setRefreshOutcome(null);
    };
  }, []);

  const startCreate = () => {
    setIsCreating(true);
    setEditingSource(null);
    setKind('git');
    setUrl('');
    setRef('');
    setAuthToken('');
    setRefreshOnStart(true);
    setErrorMsg(null);
  };

  const startEdit = (source: PluginSource) => {
    setEditingSource(source);
    setIsCreating(false);
    setKind(source.kind);
    setUrl(source.url);
    setRef(source.ref || '');
    setAuthToken(source.authToken || '');
    setRefreshOnStart(source.refreshOnStart || false);
    setErrorMsg(null);
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingSource(null);
    setErrorMsg(null);
  };

  const validateAndSave = () => {
    const trimmedUrl = url.trim();
    const trimmedRef = ref.trim();
    const trimmedAuth = authToken.trim();

    if (!trimmedUrl) {
      setErrorMsg('Repository URL or Local Path is required.');
      return;
    }

    if (kind === 'git') {
      // Basic git URL check
      if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://') && !trimmedUrl.startsWith('git@')) {
        setErrorMsg('URL must be a valid Git remote endpoint (HTTPS/SSH).');
        return;
      }
    } else {
      // Local path check
      if (!trimmedUrl.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmedUrl)) {
        setErrorMsg('Filesystem path must be an absolute path.');
        return;
      }
    }

    const duplicate = pluginsFile.sources.find(s => s.url.toLowerCase() === trimmedUrl.toLowerCase());
    if (isCreating && duplicate) {
      setErrorMsg('This plugin source is already registered.');
      return;
    }
    if (editingSource && editingSource.url !== trimmedUrl && duplicate) {
      setErrorMsg('This plugin source is already registered.');
      return;
    }

    const payload = {
      id: editingSource ? editingSource.id : '',
      kind,
      url: trimmedUrl,
      ref: trimmedRef || null,
      authToken: trimmedAuth || null,
      refreshOnStart,
    };

    postMessage({
      type: 'savePluginSource',
      source: payload,
    });

    setIsCreating(false);
    setEditingSource(null);
    setErrorMsg(null);
  };

  const deleteSource = (sourceId: string) => {
    postMessage({
      type: 'deletePluginSource',
      sourceId,
    });
  };

  const refreshSource = (sourceId: string) => {
    setRefreshOutcome(null);
    postMessage({
      type: 'refreshPluginSource',
      sourceId,
    });
  };

  const showForm = isCreating || editingSource !== null;

  return (
    <div className="tab-pane plugins-tab">
      <div className="tab-pane__header">
        <h3>Plugins</h3>
        {!showForm && (
          <button className="btn btn--primary btn--xs" onClick={startCreate}>
            + Register Source
          </button>
        )}
      </div>

      {errorMsg && <div className="validation-error">⚠ {errorMsg}</div>}

      {refreshOutcome && (
        <div className={`sync-banner ${refreshOutcome.error ? 'sync-banner--error' : 'sync-banner--success'}`}>
          <div className="sync-banner__title">
            {refreshOutcome.error ? 'Sync Failed' : 'Sync Succeeded'}
            <button className="sync-banner__close" onClick={() => setRefreshOutcome(null)}>×</button>
          </div>
          <div className="sync-banner__body">
            {refreshOutcome.error ? (
              <span className="error-text">{refreshOutcome.error}</span>
            ) : (
              <span>
                Found {refreshOutcome.pluginsFound} plugins.{' '}
                {refreshOutcome.sha && <span className="sha-text">SHA: {refreshOutcome.sha.substring(0, 8)}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {showForm ? (
        <div className="glass-form">
          <h4>{isCreating ? 'Register Plugin Source' : 'Edit Plugin Source'}</h4>
          
          <div className="form-group">
            <label>Source Type</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="source-kind"
                  checked={kind === 'git'}
                  onChange={() => setKind('git')}
                />
                <span>Git Remote</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="source-kind"
                  checked={kind === 'path'}
                  onChange={() => setKind('path')}
                />
                <span>Local Path</span>
              </label>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="source-url">
              {kind === 'git' ? 'Git Repository URL' : 'Absolute Filesystem Path'}
            </label>
            <input
              id="source-url"
              type="text"
              placeholder={kind === 'git' ? 'https://github.com/org/repo.git' : '/absolute/path/to/plugins'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          {kind === 'git' && (
            <>
              <div className="form-group">
                <label htmlFor="source-ref">Branch / Ref (Optional)</label>
                <input
                  id="source-ref"
                  type="text"
                  placeholder="e.g. main, v1.0.0"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="source-token">Auth Token (Optional - encrypted)</label>
                <input
                  id="source-token"
                  type="password"
                  placeholder={editingSource?.authToken ? '••••••••' : 'Credentials for private repositories'}
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                />
              </div>
            </>
          )}

          <div className="form-group form-group--checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={refreshOnStart}
                onChange={(e) => setRefreshOnStart(e.target.checked)}
              />
              <span>Automatically refresh on startup</span>
            </label>
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
          {pluginsFile.sources.length === 0 ? (
            <p className="empty-message">No plugin sources configured. Register a Git repository or local folder.</p>
          ) : (
            pluginsFile.sources.map((source) => {
              const discovered = pluginsFile.plugins.filter(p => p.sourceId === source.id);
              const isRefreshing = refreshingSourceId === source.id;

              return (
                <div key={source.id} className="settings-card settings-card--plugin">
                  <div className="settings-card__body">
                    <div className="settings-card__title">
                      {source.kind === 'git' ? '📦 Git Source' : '📁 Local Source'}
                      {isRefreshing && <span className="settings-card__badge-managed">Syncing...</span>}
                    </div>
                    <div className="settings-card__subtitle text-ellipsis" title={source.url}>
                      {source.url}
                    </div>
                    {source.kind === 'git' && source.ref && (
                      <div className="settings-card__metadata">Ref: {source.ref}</div>
                    )}

                    {discovered.length > 0 ? (
                      <div className="discovered-plugins">
                        <div className="discovered-plugins__title">Discovered Plugins:</div>
                        <ul className="discovered-plugins__list">
                          {discovered.map(p => (
                            <li key={p.id} className="discovered-plugin-item" title={p.description || ''}>
                              <span className="plugin-name">{p.name}</span>
                              {p.manifestKind && <span className="plugin-manifest-badge">{p.manifestKind}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="discovered-plugins discovered-plugins--empty">
                        No plugins synced. Click Sync below.
                      </div>
                    )}

                    {source.lastFetchedAt && (
                      <div className="settings-card__footer">
                        Last Synced: {new Date(source.lastFetchedAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>

                  <div className="settings-card__actions-bottom">
                    <button
                      className="btn btn--secondary btn--xs"
                      disabled={isRefreshing}
                      onClick={() => refreshSource(source.id)}
                    >
                      {isRefreshing ? 'Syncing...' : 'Sync Now'}
                    </button>
                    <div className="actions-right">
                      <button
                        className="icon-btn"
                        disabled={isRefreshing}
                        onClick={() => startEdit(source)}
                        title="Edit source"
                      >
                        ✏️
                      </button>
                      <button
                        className="icon-btn icon-btn--danger"
                        disabled={isRefreshing}
                        onClick={() => deleteSource(source.id)}
                        title="Delete source"
                      >
                        🗑️
                      </button>
                    </div>
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
