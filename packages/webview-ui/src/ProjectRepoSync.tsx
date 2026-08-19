import { useCallback, useEffect, useState } from 'react';

type RepoStatus = { state: 'absent' | 'syncing' | 'cloned' | 'broken'; branch?: string; commit?: string };

function badgeText(s: RepoStatus): string {
  if (s.state === 'cloned') return s.branch ? `cloned: ${s.branch} @ ${s.commit ?? '?'}` : 'cloned';
  if (s.state === 'syncing') return 'syncing…';
  if (s.state === 'broken') return 'broken (will re-clone)';
  return 'not cloned';
}

/** Repo badge + Clone/Sync button for a saved remote-backed project. Renders
 *  nothing where the API doesn't exist (non-web surfaces): the status fetch
 *  fails and the block stays hidden — same mechanism as the voice backend UI. */
export function ProjectRepoSync({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetch(`/api/projects/${projectId}/repo-status`)
      .then((r) => (r.ok ? (r.json() as Promise<RepoStatus>) : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const sync = async () => {
    setBusy(true);
    setProgress('');
    try {
      const res = await fetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
      if (res.status === 409) {
        setProgress('A sync is already running.');
        return;
      }
      if (!res.ok || !res.body) {
        setProgress(`Sync failed: HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line) as { step: string; message: string };
            setProgress(p.step === 'error' ? `Sync failed: ${p.message}` : p.message);
          } catch {
            // Ignore malformed progress lines; the final refresh tells the truth.
          }
        }
      }
    } catch (err) {
      setProgress(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (status === null) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
      <div className="settings-card__badge">{busy ? 'syncing…' : badgeText(status)}</div>
      <button className="btn btn--secondary btn--xs" onClick={sync} disabled={busy}>
        {status.state === 'absent' ? 'Clone now' : 'Sync now'}
      </button>
      {progress && (
        <span style={{ fontSize: '10px', opacity: 0.75, fontFamily: 'var(--font-mono)' }}>{progress}</span>
      )}
    </div>
  );
}
