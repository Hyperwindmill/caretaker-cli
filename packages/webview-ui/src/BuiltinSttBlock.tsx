import { useState } from 'react';
import type { BuiltinInstallProgress, BuiltinVoiceStatus } from './bridge.js';
import { splitNdjsonLines } from './voice_backend_utils.js';

const MB = 1024 * 1024;
type Size = BuiltinVoiceStatus['stt'][number]['id'];

function sizeLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export interface BuiltinSttBlockProps {
  status: BuiltinVoiceStatus;
  onStatusChange: (status: BuiltinVoiceStatus) => void;
  /** Selected model size (form state, not saved yet). */
  model: string;
  onModelChange: (id: Size) => void;
}

/** The built-in Whisper transcription: model size picker plus install/delete
 *  with streamed progress, mirroring BuiltinVoiceBlock. */
export function BuiltinSttBlock({ status, onStatusChange, model, onModelChange }: BuiltinSttBlockProps) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const loadError = status.runtime.loadError;
  const selected = status.stt.find((m) => m.id === model);
  const query = `?stt=${encodeURIComponent(model)}`;

  const install = async () => {
    setBusy(true);
    setError(null);
    setProgress('Starting…');
    try {
      const res = await fetch(`/api/voice/builtin/install${query}`, { method: 'POST' });
      if (!res.ok || !res.body) {
        setError((await res.text().catch(() => '')) || 'Install failed.');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const { lines, remainder } = splitNdjsonLines(buffer, decoder.decode(value, { stream: true }));
        buffer = remainder;
        for (const line of lines) {
          let p: BuiltinInstallProgress;
          try {
            p = JSON.parse(line) as BuiltinInstallProgress;
          } catch {
            continue;
          }
          if (p.step === 'done') onStatusChange(p.status);
          else if (p.step === 'error') setError(p.message);
          else {
            const pct = p.total > 0 ? ` ${Math.floor((p.received / p.total) * 100)}%` : '';
            setProgress(`${p.step === 'runtime' ? 'Runtime' : 'Model'}: ${p.file}${pct}`);
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

  const remove = async () => {
    setConfirmingDelete(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/voice/builtin/delete${query}`, { method: 'POST' });
      if (res.ok) onStatusChange((await res.json()) as BuiltinVoiceStatus);
      else setError((await res.text().catch(() => '')) || 'Delete failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-group">
      <label htmlFor="voice-builtin-stt">
        Built-in transcription{' '}
        {loadError ? <em>(not available on this system)</em> : <em>(Whisper)</em>}
      </label>
      {loadError ? (
        <small className="form-error">{loadError}</small>
      ) : (
        <>
          <select
            id="voice-builtin-stt"
            value={model}
            onChange={(e) => {
              onModelChange(e.target.value as Size);
              setConfirmingDelete(false);
            }}
          >
            {status.stt.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.id === 'base' ? ' (recommended)' : ''} —{' '}
                {m.installed ? 'installed' : `not installed, ${sizeLabel(m.bytes)}`}
              </option>
            ))}
          </select>
          {selected && (
            <div className="voice-backend-status">
              <span>
                {progress ??
                  (selected.installed
                    ? `Installed (${sizeLabel(selected.bytes)})`
                    : `Not installed — downloads ${sizeLabel(selected.bytes)}`)}
              </span>
              {!selected.installed && (
                <button type="button" onClick={install} disabled={busy}>
                  {busy ? 'Installing…' : 'Install'}
                </button>
              )}
              {selected.installed && (
                <button
                  type="button"
                  onClick={confirmingDelete ? remove : () => setConfirmingDelete(true)}
                  disabled={busy}
                >
                  {confirmingDelete ? 'Really delete?' : 'Delete'}
                </button>
              )}
            </div>
          )}
          {error && <small className="form-error">{error}</small>}
          <small>
            Runs inside caretaker — no server or Docker. Small is slow for conversation on
            most CPUs; base is the better trade-off.
          </small>
        </>
      )}
      <small>
        Whisper by OpenAI (MIT), ONNX export by{' '}
        <a
          href={`https://huggingface.co/onnx-community/whisper-${model || 'base'}`}
          target="_blank"
          rel="noreferrer"
        >
          onnx-community
        </a>
        .
      </small>
    </div>
  );
}
