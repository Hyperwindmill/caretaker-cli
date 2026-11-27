import { useCallback, useEffect, useRef, useState } from 'react';
import { SecretInput } from './SecretInput.js';

interface OrchestratorConfigView {
  enabled: boolean;
  name: string;
  endpoint: string;
  hasToken: boolean;
  pollSeconds: number;
  policy: 'auto' | 'approve';
  instanceId: string;
}

interface OrchestratorStatus {
  state: 'off' | 'registering' | 'connected' | 'error';
  orchestratorName?: string;
  lastPollAt?: string;
  lastError?: string;
}

interface MessageSummary {
  id: string;
  method: string;
  path: string;
  receivedAt: string;
  state: 'pending' | 'applying' | 'done';
  status?: number;
  resolvedAt?: string;
  delivered: boolean;
  body?: unknown;
}

interface OrchestratorView {
  config: OrchestratorConfigView;
  status: OrchestratorStatus;
  pending: number;
  messages: MessageSummary[];
}

interface TestResult {
  ok: boolean;
  name?: string;
  protocol?: unknown;
  error?: string;
}

function relativeTime(iso?: string): string {
  if (!iso) return 'never';
  const diffSec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.round(diffMin / 60)}h ago`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusText(status: OrchestratorStatus): string {
  switch (status.state) {
    case 'off':
      return 'Off';
    case 'registering':
      return 'Registering…';
    case 'connected': {
      const target = status.orchestratorName ? `"${status.orchestratorName}"` : 'orchestrator';
      return `Connected to ${target} · last poll ${relativeTime(status.lastPollAt)}`;
    }
    case 'error':
      return `Error: ${status.lastError ?? 'Unknown error'}`;
  }
}

export function OrchestrationTab({ onPendingChange }: { onPendingChange?: (count: number) => void }) {
  const [view, setView] = useState<OrchestratorView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [pollSeconds, setPollSeconds] = useState('15');
  const [policy, setPolicy] = useState<'auto' | 'approve'>('approve');
  // Errors from the user's own actions (Save, Test, Approve, Reject) are kept
  // apart from the periodic refresh's, which would otherwise wipe them within 5 s.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const seededRef = useRef(false);

  const seedForm = useCallback((cfg: OrchestratorConfigView) => {
    setEnabled(cfg.enabled);
    setName(cfg.name);
    setEndpoint(cfg.endpoint);
    setToken('');
    setRemoveToken(false);
    setPollSeconds(String(cfg.pollSeconds));
    setPolicy(cfg.policy);
  }, []);

  const call = useCallback(
    async <T = OrchestratorView>(
      path: string,
      init?: RequestInit,
      report: (message: string | null) => void = setError,
    ): Promise<T | null> => {
      report(null);
      try {
        const res = await fetch(path, {
          ...init,
          headers: init?.body ? { 'content-type': 'application/json' } : undefined,
        });
        const data = await res.json();
        if (!res.ok) {
          report(data?.error ?? `Request failed (${res.status})`);
          return null;
        }
        return data as T;
      } catch {
        report('The server did not answer.');
        return null;
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const data = await call<OrchestratorView>('/api/orchestrator', undefined, setLoadError);
    if (!data) return;
    setView(data);
    onPendingChange?.(data.pending);
    if (!seededRef.current) {
      seededRef.current = true;
      seedForm(data.config);
    }
  }, [call, onPendingChange, seedForm]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleSave = async () => {
    setBusy(true);
    setTestResult(null);
    const data = await call<OrchestratorView>('/api/orchestrator', {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        name,
        endpoint,
        // '' keeps the stored token, null removes it.
        token: removeToken && !token.trim() ? null : token,
        pollSeconds: Number(pollSeconds),
        policy,
      }),
    });
    setBusy(false);
    if (data) {
      setView(data);
      onPendingChange?.(data.pending);
      seedForm(data.config);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setTestResult(null);
    const res = await call<TestResult>('/api/orchestrator/test', {
      method: 'POST',
      body: JSON.stringify({ endpoint, token }),
    });
    setBusy(false);
    if (res) setTestResult(res);
  };

  const handleDecision = async (id: string, decision: 'approve' | 'reject') => {
    await call<{ ok: boolean }>(`/api/orchestrator/messages/${encodeURIComponent(id)}/${decision}`, {
      method: 'POST',
    });
    await refresh();
  };

  if (!view) {
    return (
      <div className="glass-form">
        <h4>Orchestration</h4>
        <div className="glass-form__body">
          <small className={loadError ? 'form-error' : undefined}>{loadError ?? 'Loading…'}</small>
        </div>
      </div>
    );
  }

  const pendingMessages = view.messages.filter((m) => m.state === 'pending');
  const activityMessages = view.messages.filter((m) => m.state !== 'pending');

  return (
    <div className="glass-form orchestration-tab">
      <div className="orchestration-tab__header">
        <h4>Orchestration</h4>
        <span className={`orchestration-tab__status orchestration-tab__status--${view.status.state}`}>
          {statusText(view.status)}
        </span>
      </div>

      <div className="glass-form__body orchestration-tab__body">
        {loadError && <small className="form-error">{loadError}</small>}
        {error && <small className="form-error">{error}</small>}

        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>

        <div className="form-group">
          <label htmlFor="orch-name">Instance name</label>
          <input
            id="orch-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My workstation"
          />
        </div>

        <div className="form-group">
          <label htmlFor="orch-endpoint">Endpoint</label>
          <input
            id="orch-endpoint"
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://orchestrator.example.com/v1"
          />
        </div>

        <div className="form-group">
          <label htmlFor="orch-token">Token</label>
          <SecretInput
            id="orch-token"
            value={token}
            onChange={setToken}
            hasSaved={view.config.hasToken}
            remove={removeToken}
            onRemoveChange={setRemoveToken}
            placeholder="Bearer token"
          />
        </div>

        <div className="form-group">
          <label htmlFor="orch-poll">Poll every (seconds)</label>
          <input
            id="orch-poll"
            type="number"
            min={5}
            max={3600}
            value={pollSeconds}
            onChange={(e) => setPollSeconds(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Policy</label>
          <div className="orchestration-tab__radios">
            <label className="form-radio">
              <input
                type="radio"
                name="orch-policy"
                checked={policy === 'approve'}
                onChange={() => setPolicy('approve')}
              />
              <span>Ask me before applying changes</span>
            </label>
            <label className="form-radio">
              <input
                type="radio"
                name="orch-policy"
                checked={policy === 'auto'}
                onChange={() => setPolicy('auto')}
              />
              <span>Apply automatically</span>
            </label>
            {policy === 'auto' && (
              <small className="orchestration-tab__warning">
                The orchestrator can create projects and start tasks on this machine without asking.
              </small>
            )}
          </div>
        </div>

        <div className="orchestration-tab__actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={handleTest} disabled={busy}>
            Test connection
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={handleSave} disabled={busy}>
            Save
          </button>
        </div>

        {testResult && (
          <small className={testResult.ok ? 'orchestration-tab__test-ok' : 'form-error'}>
            {testResult.ok
              ? `✓ Reached "${testResult.name || 'orchestrator'}" (protocol ${testResult.protocol})`
              : testResult.error ?? 'Connection test failed.'}
          </small>
        )}
      </div>

      <div className="orchestration-tab__section">
        <h5>Waiting for approval ({pendingMessages.length})</h5>
        {pendingMessages.length === 0 ? (
          <small className="orchestration-tab__empty">No pending messages.</small>
        ) : (
          <div className="orchestration-tab__list">
            {pendingMessages.map((m) => (
              <div key={m.id} className="orchestration-tab__pending-row">
                <div className="orchestration-tab__pending-main">
                  <code>{m.method}</code> <span>{m.path}</span>
                  <div className="orchestration-tab__row-actions">
                    <button
                      type="button"
                      className="btn btn--primary btn--xs"
                      onClick={() => void handleDecision(m.id, 'approve')}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--xs"
                      onClick={() => void handleDecision(m.id, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
                {m.body !== undefined && (
                  <details className="orchestration-tab__details">
                    <summary>Body</summary>
                    <pre>{JSON.stringify(m.body, null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="orchestration-tab__section">
        <h5>Activity</h5>
        {activityMessages.length === 0 ? (
          <small className="orchestration-tab__empty">No activity yet.</small>
        ) : (
          <div className="orchestration-tab__list orchestration-tab__list--activity">
            {activityMessages.map((m) => (
              <div key={m.id} className="orchestration-tab__activity-row">
                <span className="orchestration-tab__time">{formatTime(m.resolvedAt ?? m.receivedAt)}</span>
                <code>{m.method}</code>
                <span className="orchestration-tab__path">{m.path}</span>
                <span className="orchestration-tab__code">
                  {m.status === 403 ? '403 rejected' : m.status ?? m.state}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
