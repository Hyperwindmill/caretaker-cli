import { useEffect, useRef, useState } from 'react';
import {
  backendStatusText,
  splitNdjsonLines,
  type BackendStatus,
  type StartProgress,
} from './voice_backend_utils.js';

const CONFIRM_DELETE_MS = 4000;

/** The managed-backend block — one per container (Speaches for STT, edge-tts for
 *  TTS). Extracted from VoiceTab so each container owns its own busy / progress /
 *  error / confirm-delete state independently: a 2 GB Speaches pull must not
 *  block the edge-tts Start button, and a Speaches error must not appear in the
 *  edge-tts block. The parent (VoiceTab) polls `GET /api/voice/backend` once and
 *  renders one `VoiceBackendBlock` per non-null status, keeping the single
 *  auto-start checkbox for itself.
 *
 *  All Docker interaction routes take `?target=${target}` so the server operates
 *  on the right container. The status shown here comes from the parent's poll
 *  and from the start/stop/delete responses — the block never polls on its own,
 *  so there is one poll, not two. */
export interface VoiceBackendBlockProps {
  /** Which container this block manages. */
  target: 'stt' | 'tts';
  /** Human-readable label, e.g. "Speech backend (Speaches)". */
  label: string;
  /** Current status from the parent's poll. */
  status: BackendStatus;
  /** Called when a start/stop/delete response adopts a fresh status. */
  onStatusChange: (status: BackendStatus) => void;
  /** Small help text shown under the block. */
  hint: string;
}

export function VoiceBackendBlock({
  target,
  label,
  status,
  onStatusChange,
  hint,
}: VoiceBackendBlockProps) {
  const [busy, setBusy] = useState(false);
  /** Latest streamed message while a start is running; replaces the status
   *  line until the terminal line adopts its `status`. */
  const [progress, setProgress] = useState<string | null>(null);
  /** The verbatim failure from a start/stop attempt — surfaced separately from
   *  the one-line status because "docker run failed: port already in use" is
   *  exactly the case the design doc says must not be silently swallowed. */
  const [error, setError] = useState<string | null>(null);
  /** Two-step confirm for Delete: first click arms, second click executes.
   *  Auto-disarms after a few seconds so a stale "Really delete?" never
   *  lingers. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmDelete = () => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    confirmDeleteTimer.current = null;
    setConfirmingDelete(false);
  };
  const armDelete = () => {
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    setConfirmingDelete(true);
    confirmDeleteTimer.current = setTimeout(
      () => setConfirmingDelete(false),
      CONFIRM_DELETE_MS,
    );
  };
  // Unmount cleanup clears only the timer — no setState on an unmounted component.
  useEffect(
    () => () => {
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    },
    [],
  );

  /** Container state as of the last adopted status. A ref, not state: comparing
   *  against state in the parent's poll callback would compare against a stale
   *  closure. Used to clear a leftover error only when the container transitions
   *  to running between polls. Updated synchronously in start()/stop()/remove()
   *  before onStatusChange so the status-effect does not see a transition and
   *  wipe an error set in the same batch — e.g. a model-install failure reports
   *  container: 'running' (failures never roll back), and clearing on that
   *  transition would hide exactly the failure the install step exists to
   *  surface. */
  const lastContainer = useRef<BackendStatus['container'] | null>(null);
  useEffect(() => {
    // Clear error when the container comes up between polls (not from a
    // start/stop/delete action — those update the ref synchronously first).
    if (status.container === 'running' && lastContainer.current !== 'running') {
      setError(null);
    }
    lastContainer.current = status.container;
  }, [status]);

  const query = `?target=${target}`;

  const start = async () => {
    setBusy(true);
    setError(null);
    setProgress('Starting…');
    try {
      const res = await fetch(`/api/voice/backend/start${query}`, { method: 'POST' });
      if (!res.ok || !res.body) {
        setError((await res.text().catch(() => '')) || 'Start failed.');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const { lines, remainder } = splitNdjsonLines(
          buffer,
          decoder.decode(value, { stream: true }),
        );
        buffer = remainder;
        for (const line of lines) {
          let p: StartProgress;
          try {
            p = JSON.parse(line) as StartProgress;
          } catch {
            continue; // Malformed line — the terminal line is what matters.
          }
          if (p.status) {
            // Terminal line: adopt the fresh status and stop showing progress text.
            // Update the ref synchronously BEFORE onStatusChange so the
            // status-effect below does not see a transition and wipe an error we
            // are about to set — a model-install failure reports
            // container: 'running' (failures never roll back), and clearing on
            // that transition would hide exactly the failure the install step
            // exists to surface.
            lastContainer.current = p.status.container;
            onStatusChange(p.status);
            setProgress(null);
            if (p.step === 'error') setError(p.message);
          } else {
            setProgress(p.message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/voice/backend/stop${query}`, { method: 'POST' });
      if (res.ok) {
        const status = (await res.json()) as BackendStatus;
        lastContainer.current = status.container;
        onStatusChange(status);
      }
    } catch {
      // Best-effort — the parent's poll re-syncs regardless.
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    disarmDelete();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/voice/backend/delete${query}`, { method: 'POST' });
      if (res.ok) {
        const status = (await res.json()) as BackendStatus;
        lastContainer.current = status.container;
        onStatusChange(status);
      } else setError((await res.text().catch(() => '')) || 'Delete failed.');
    } catch {
      // Best-effort — the parent's poll re-syncs regardless.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-group">
      <div className="voice-backend-status">
        <span>{progress ?? backendStatusText(status)}</span>
        {status.container === 'running' ? (
          <button type="button" onClick={stop} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button type="button" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        )}
        {status.container !== 'absent' && (
          <button
            type="button"
            onClick={confirmingDelete ? remove : armDelete}
            disabled={busy}
          >
            {confirmingDelete ? 'Really delete?' : 'Delete'}
          </button>
        )}
      </div>
      {error && <small className="form-error">{error}</small>}
      <small>
        <strong>{label}.</strong> {hint}
      </small>
    </div>
  );
}