import { useCallback, useEffect, useState } from 'react';

interface ApiAccessStatus {
  port: number | null;
  portOverride: number | null;
  listener: { port: number; host: string; error?: string } | null;
  tokens: { id: string; name: string; createdAt: string }[];
}

/** Settings for the token-authenticated API listener (a second port serving
 *  the REST routes to clients outside the browser). Talks to `/api/access`
 *  over plain HTTP: those routes exist only on the web server, which is why
 *  the tab is gated like Services/Voice in SettingsPanel. */
export function ApiAccessTab() {
  const [status, setStatus] = useState<ApiAccessStatus | null>(null);
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setError(null);
    try {
      const res = await fetch(path, {
        ...init,
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return null;
      }
      setStatus(data);
      return data as ApiAccessStatus & { token?: string };
    } catch {
      setError('The server did not answer.');
      return null;
    }
  }, []);

  useEffect(() => {
    void call('/api/access').then((s) => {
      if (s) setPort(s.port === null ? '' : String(s.port));
    });
  }, [call]);

  const savePort = () =>
    call('/api/access/port', { method: 'PUT', body: JSON.stringify({ port: port.trim() === '' ? null : port }) });

  const createToken = async () => {
    const data = await call('/api/access/tokens', { method: 'POST', body: JSON.stringify({ name }) });
    if (!data?.token) return;
    setCreated(data.token);
    setCopied(false);
    setName('');
  };

  const revoke = async (id: string) => {
    setConfirmId(null);
    await call(`/api/access/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure origin): the token stays selectable.
    }
  };

  if (!status) {
    return (
      <div className="glass-form">
        <h4>API access</h4>
        <div className="glass-form__body">
          <small className={error ? 'form-error' : undefined}>{error ?? 'Loading…'}</small>
        </div>
      </div>
    );
  }

  const { listener, portOverride } = status;

  return (
    <div className="glass-form">
      <h4>API access</h4>
      <div className="glass-form__body">
        <div className="form-group">
          <label htmlFor="api-access-port">API port</label>
          <input
            id="api-access-port"
            type="number"
            min={1}
            max={65535}
            placeholder="off"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <small>
            A second port that serves the REST API to scripts and other programs. Every request to
            it must carry <code>Authorization: Bearer &lt;token&gt;</code>. Leave empty to keep it
            off. The address you are using now is not affected: it stays without authentication, so
            keep it on this machine or behind an authenticating proxy.
          </small>
          {portOverride !== null && (
            <small>
              This server was started with <code>--api-port {portOverride}</code>, which takes
              precedence over the saved port until it restarts without it.
            </small>
          )}
          <small role="status" aria-live="polite" className={listener?.error ? 'form-error' : undefined}>
            {!listener
              ? 'The API is off.'
              : listener.error
                ? `The API could not start on port ${listener.port}: ${listener.error}`
                : `The API is listening on ${listener.host}:${listener.port}.`}
          </small>
        </div>
        <div className="form-actions">
          <button type="button" onClick={savePort}>
            Save port
          </button>
        </div>

        <div className="form-group">
          <label htmlFor="api-access-token-name">Tokens</label>
          {status.tokens.length === 0 ? (
            <small>No tokens yet. Without one, every request to the API port is refused.</small>
          ) : (
            <div className="settings-list">
              {status.tokens.map((t) => (
                <div className="settings-card" key={t.id}>
                  <div className="settings-card__body">
                    <div className="settings-card__title">{t.name}</div>
                    <div className="settings-card__metadata">
                      Created {new Date(t.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="settings-card__actions">
                    {confirmId === t.id ? (
                      <>
                        <button type="button" className="btn btn--secondary btn--xs" onClick={() => revoke(t.id)}>
                          Confirm revoke
                        </button>
                        <button type="button" className="btn btn--secondary btn--xs" onClick={() => setConfirmId(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn--secondary btn--xs" onClick={() => setConfirmId(t.id)}>
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-group">
          <input
            id="api-access-token-name"
            type="text"
            placeholder="Name, e.g. the program that will use it"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="form-actions">
            <button type="button" onClick={createToken} disabled={!name.trim()}>
              Create token
            </button>
          </div>
          {created && (
            <>
              <small>Copy this token now. It is not stored and cannot be shown again.</small>
              <input type="text" readOnly value={created} aria-label="New token" onFocus={(e) => e.target.select()} />
              <div className="form-actions">
                <button type="button" onClick={copy}>
                  Copy
                </button>
                <button type="button" onClick={() => setCreated(null)}>
                  Done
                </button>
                <span role="status" aria-live="polite" className="form-save-state">
                  {copied ? 'Copied ✓' : ''}
                </span>
              </div>
            </>
          )}
        </div>

        {error && (
          <small role="alert" className="form-error">
            {error}
          </small>
        )}
      </div>
    </div>
  );
}
