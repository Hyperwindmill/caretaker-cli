// Update notice for the web GUI / desktop (sidebar layout only — the routes
// exist only on the web server). See docs/superpowers/specs/2026-11-25-update-notice-design.md.
import { useEffect, useState } from 'react';
import {
  cliUpdateMessage,
  shouldShowBanner,
  UPDATE_COMMAND,
  type CliUpdateResult,
  type UpdateStatus,
} from './update_banner_utils.js';

const POLL_MS = 3600_000;

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CliUpdateResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/update');
        if (!res.ok) return;
        const data = (await res.json()) as UpdateStatus;
        if (!cancelled) setStatus(data);
      } catch {
        /* no route (VSCode) or offline: stay hidden */
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status || !shouldShowBanner(status)) return null;

  const dismiss = () => {
    setStatus({ ...status, dismissedVersion: status.latest });
    void fetch('/api/update/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: status.latest }),
    }).catch(() => {});
  };

  const updateCli = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/update/cli', { method: 'POST' });
      if (res.status === 409) return; // another click already running it
      const r = (await res.json()) as CliUpdateResult;
      setResult(r);
      setStatus({ ...status, cliVersion: r.cliVersion, cliOutdated: r.cliOutdated });
    } catch (err) {
      setResult({ ok: false, output: String(err), cliOutdated: true });
    } finally {
      setRunning(false);
    }
  };

  const copy = () => {
    void navigator.clipboard
      ?.writeText(UPDATE_COMMAND)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const message = result ? cliUpdateMessage(result) : null;
  // A successful update hides the CLI row's actions but keeps its message.
  const showCliRow = status.cliOutdated || message !== null;
  const showCliActions = status.cliOutdated;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__text">
        <div>
          ⬆ Caretaker {status.latest} is available — you have {status.current}
        </div>
        {showCliRow && (
          <div className="update-banner__cli">
            {status.cliOutdated && (
              <>
                Terminal CLI {status.cliVersion}: <code>{UPDATE_COMMAND}</code>
              </>
            )}
            {message && (
              <div className={`update-banner__result update-banner__result--${message.kind}`}>
                {message.text}
                {message.kind === 'failed' && result?.output && <pre>{result.output}</pre>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="update-banner__actions">
        {status.url && (
          <a className="btn btn--primary" href={status.url} target="_blank" rel="noreferrer">
            Download
          </a>
        )}
        {showCliActions && (
          <>
            <button type="button" className="btn btn--secondary" onClick={updateCli} disabled={running}>
              {running ? 'Updating…' : 'Update CLI'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy command'}
            </button>
          </>
        )}
        <button type="button" className="btn btn--secondary" onClick={dismiss} aria-label="Dismiss">
          Dismiss ✕
        </button>
      </div>
    </div>
  );
}
