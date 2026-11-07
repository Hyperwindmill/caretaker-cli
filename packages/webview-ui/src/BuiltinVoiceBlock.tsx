import { useState } from 'react';
import type { BuiltinInstallProgress, BuiltinVoiceStatus } from './bridge.js';
import { splitNdjsonLines } from './voice_backend_utils.js';

const MB = 1024 * 1024;

function sizeLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

function progressText(p: BuiltinInstallProgress): string | null {
  if (p.step === 'done' || p.step === 'error') return null;
  const what = p.step === 'runtime' ? 'Runtime' : 'Voice';
  const pct = p.total > 0 ? ` ${Math.floor((p.received / p.total) * 100)}%` : '';
  return `${what}: ${p.file}${pct}`;
}

export interface BuiltinVoiceBlockProps {
  status: BuiltinVoiceStatus;
  onStatusChange: (status: BuiltinVoiceStatus) => void;
  /** Selected built-in language id (form state, not saved yet). */
  language: string;
  onLanguageChange: (id: string) => void;
  voice: string;
  onVoiceChange: (voice: string) => void;
}

/** The built-in (in-process) voice: language install/delete with streamed
 *  progress — the same ndjson pattern as VoiceBackendBlock — plus language and
 *  voice pickers. */
export function BuiltinVoiceBlock({
  status,
  onStatusChange,
  language,
  onLanguageChange,
  voice,
  onVoiceChange,
}: BuiltinVoiceBlockProps) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const loadError = status.runtime.loadError;
  const selected = status.languages.find((l) => l.id === language);
  const query = `?language=${encodeURIComponent(language)}`;
  // The language's own default voice first; the bundles share one voice set.
  const voices = selected
    ? [selected.nativeVoice, ...status.voices.filter((v) => v !== selected.nativeVoice)]
    : status.voices;

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
          else setProgress(progressText(p));
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
      <label htmlFor="voice-builtin-language">
        Built-in voice{' '}
        {loadError ? <em>(not available on this system)</em> : <em>(recommended)</em>}
      </label>
      {loadError ? (
        <small className="form-error">{loadError}</small>
      ) : (
        <>
          <select
            id="voice-builtin-language"
            value={language}
            onChange={(e) => {
              onLanguageChange(e.target.value);
              setConfirmingDelete(false);
            }}
          >
            {!selected && <option value={language}>{language || '-- Select a language --'}</option>}
            {status.languages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} ({l.code}) — {l.installed ? 'installed' : `not installed, ${sizeLabel(l.bytes)}`}
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
          <label htmlFor="voice-builtin-voice" style={{ marginTop: '0.6em' }}>
            Voice
          </label>
          <select id="voice-builtin-voice" value={voice} onChange={(e) => onVoiceChange(e.target.value)}>
            {voice && !voices.includes(voice) && <option value={voice}>{voice}</option>}
            {voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <small>
            Runs inside caretaker — no server or Docker. Speaking rate is not adjustable
            with this engine.
          </small>
        </>
      )}
      <small>
        Voice model{' '}
        <a href="https://huggingface.co/kyutai/pocket-tts" target="_blank" rel="noreferrer">
          Pocket TTS
        </a>{' '}
        by Kyutai, via the{' '}
        <a
          href="https://huggingface.co/Alias-Alias/pocket-3-3-0-tts-onnx"
          target="_blank"
          rel="noreferrer"
        >
          ONNX export
        </a>
        , licensed CC BY 4.0.
      </small>
    </div>
  );
}
