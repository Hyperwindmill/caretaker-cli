// Update notice for the web GUI / desktop (sidebar layout only — the routes
// exist only on the web server). See docs/superpowers/specs/2026-11-25-update-notice-design.md.
import { useEffect, useState } from 'react';
import {
  bannerHeadline,
  bannerVisible,
  cliUpdateMessage,
  UPDATE_COMMAND,
  type CliUpdateResult,
  type UpdateStatus,
} from './update_banner_utils.js';

const POLL_MS = 3600_000;

/** `/api/update`, fetched on mount and hourly. Owned by App so the banner and
 *  the nav rail's version label share one request. */
export function useUpdateStatus(enabled: boolean): [UpdateStatus | null, (s: UpdateStatus) => void] {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);
  return [status, setStatus];
}

export function UpdateBanner({
  status,
  setStatus,
}: {
  status: UpdateStatus | null;
  setStatus: (s: UpdateStatus) => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CliUpdateResult | null>(null);
  const [copied, setCopied] = useState(false);

  if (!status || !bannerVisible(status, result)) return null;

  const dismiss = () => {
    setStatus({ ...status, dismissedVersion: status.latest });
    setResult(null); // a shown update result would otherwise keep the banner up
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
          {bannerHeadline(status)}
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
