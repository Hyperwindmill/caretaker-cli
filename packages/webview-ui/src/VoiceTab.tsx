import { useEffect, useRef, useState } from 'react';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';
import type { ViewToHost, VoiceCatalog, VoiceCatalogResult } from './bridge.js';
import { voiceSignature } from './voice_utils.js';
import {
  backendStatusText,
  splitNdjsonLines,
  type BackendStatus,
  type StartProgress,
} from './voice_backend_utils.js';

const BACKEND_POLL_MS = 10_000;
const CONFIRM_DELETE_MS = 4000;

export interface VoiceTabProps {
  config: CaretakerConfig;
  onSave: (config: CaretakerConfig) => void;
  postMessage: (msg: ViewToHost) => void;
  /** Result of the last catalogue fetch, or null if none has been requested. */
  catalogResult: VoiceCatalogResult | null;
}

const EMPTY: VoiceConfig = { enabled: false, endpoint: '', sttModel: '' };

/** The README's canonical local setup — what the managed Speaches backend runs
 *  with zero decisions. Prefilled into the form, never saved directly: the user
 *  still reviews (the endpoint's port is where a busy 8969 gets changed) and
 *  presses Save themselves. */
const LOCAL_DEFAULTS = {
  endpoint: 'http://127.0.0.1:8969/v1',
  sttModel: 'Systran/faster-whisper-small',
  ttsModel: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
  ttsVoice: 'af_heart',
};

/** Offer the fetched ids, but never drop a value the user already had: an endpoint
 *  that lists nothing (or lists something else) must not silently clear the form. */
function withCurrent(ids: string[], current: string): string[] {
  const trimmed = current.trim();
  if (!trimmed || ids.includes(trimmed)) return ids;
  return [trimmed, ...ids];
}

function voiceLabel(v: { id: string; language?: string; gender?: string }): string {
  const meta = [v.language, v.gender].filter(Boolean).join(', ');
  return meta ? `${v.id} — ${meta}` : v.id;
}

export function VoiceTab({ config, onSave, postMessage, catalogResult }: VoiceTabProps) {
  const current = config.voice ?? EMPTY;
  const [enabled, setEnabled] = useState(current.enabled);
  const [endpoint, setEndpoint] = useState(current.endpoint);
  const [apiKey, setApiKey] = useState(current.apiKey ?? '');
  const [sttModel, setSttModel] = useState(current.sttModel);
  const [ttsModel, setTtsModel] = useState(current.ttsModel ?? '');
  const [ttsVoice, setTtsVoice] = useState(current.ttsVoice ?? '');
  const [ttsSpeed, setTtsSpeed] = useState(
    current.ttsSpeed === undefined ? '' : String(current.ttsSpeed),
  );
  const [lang, setLang] = useState(current.lang ?? '');
  const [fetching, setFetching] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** Signature of the payload the last Save submitted, awaiting confirmation. */
  const pendingSave = useRef<string | null>(null);

  // --- Managed local backend (Docker) -------------------------------------
  const [autoStartBackend, setAutoStartBackend] = useState(current.autoStartBackend ?? false);
  // null until the first fetch resolves — that is also what keeps the block
  // hidden on surfaces (VSCode) where these routes do not exist at all.
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendBusy, setBackendBusy] = useState(false);
  /** Latest streamed message while a start is running; replaces the status
   *  line until the terminal line adopts its `status`. */
  const [backendProgress, setBackendProgress] = useState<string | null>(null);
  /** The verbatim failure from a start/stop attempt — surfaced separately from
   *  the one-line status because "docker run failed: port already in use" is
   *  exactly the case the design doc says must not be silently swallowed. */
  const [backendError, setBackendError] = useState<string | null>(null);
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
    confirmDeleteTimer.current = setTimeout(() => setConfirmingDelete(false), CONFIRM_DELETE_MS);
  };
  // Unmount cleanup clears only the timer — no setState on an unmounted component.
  useEffect(
    () => () => {
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    },
    [],
  );

  /** Container state as of the last adopted status. A ref, not state: the 10 s
   *  poll closes over the mount-time render, so comparing against state would
   *  compare against `null` forever. */
  const lastContainer = useRef<BackendStatus['container'] | null>(null);
  const adoptBackendStatus = (status: BackendStatus) => {
    lastContainer.current = status.container;
    setBackendStatus(status);
  };

  const fetchBackendStatus = async () => {
    try {
      const res = await fetch('/api/voice/backend');
      if (!res.ok) return;
      const status = (await res.json()) as BackendStatus;
      // Clear a leftover failure only when the container comes up *between*
      // polls — fixed outside caretaker, e.g. a hand-run `docker start`. The
      // check is a transition, not the state: a model-install failure's own
      // terminal status already reports 'running' (failures never roll back
      // the container), and clearing on state would wipe that message on the
      // next poll — hiding exactly the failure the install step exists to
      // surface.
      if (status.container === 'running' && lastContainer.current !== 'running') {
        setBackendError(null);
      }
      adoptBackendStatus(status);
    } catch {
      // Route doesn't exist on this surface (VSCode sidebar) or the request
      // failed outright — no status means the block stays hidden, which is
      // the correct outcome, not an error to surface.
    }
  };

  useEffect(() => {
    fetchBackendStatus();
    const interval = setInterval(fetchBackendStatus, BACKEND_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startBackend = async () => {
    setBackendBusy(true);
    setBackendError(null);
    setBackendProgress('Starting…');
    try {
      const res = await fetch('/api/voice/backend/start', { method: 'POST' });
      if (!res.ok || !res.body) {
        setBackendError((await res.text().catch(() => '')) || 'Start failed.');
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
          let progress: StartProgress;
          try {
            progress = JSON.parse(line) as StartProgress;
          } catch {
            continue; // Malformed line — the terminal line is what matters.
          }
          if (progress.status) {
            // Terminal line: adopt the fresh status and stop showing progress text.
            adoptBackendStatus(progress.status);
            setBackendProgress(null);
            if (progress.step === 'error') setBackendError(progress.message);
          } else {
            setBackendProgress(progress.message);
          }
        }
      }
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackendBusy(false);
      setBackendProgress(null);
      fetchBackendStatus();
    }
  };

  const stopBackend = async () => {
    setBackendBusy(true);
    setBackendError(null);
    try {
      const res = await fetch('/api/voice/backend/stop', { method: 'POST' });
      if (res.ok) adoptBackendStatus((await res.json()) as BackendStatus);
    } catch {
      // Best-effort — the poll below re-syncs regardless.
    } finally {
      setBackendBusy(false);
      fetchBackendStatus();
    }
  };

  const deleteBackend = async () => {
    disarmDelete();
    setBackendBusy(true);
    setBackendError(null);
    try {
      const res = await fetch('/api/voice/backend/delete', { method: 'POST' });
      if (res.ok) adoptBackendStatus((await res.json()) as BackendStatus);
      else setBackendError((await res.text().catch(() => '')) || 'Delete failed.');
    } catch {
      // Best-effort — the poll below re-syncs regardless.
    } finally {
      setBackendBusy(false);
      fetchBackendStatus();
    }
  };

  useEffect(() => {
    if (catalogResult) setFetching(false);
  }, [catalogResult]);

  useEffect(() => {
    if (saveState !== 'saving' || pendingSave.current === null) return;
    if (voiceSignature(config.voice as Record<string, unknown>) !== pendingSave.current) return;
    setSaveState('saved');
  }, [config.voice, saveState]);

  // The timer lives in its own effect on purpose. Scheduling it in the one above
  // never worked: `saveState` is one of that effect's dependencies, so flipping to
  // 'saved' ran its cleanup and cancelled the timeout before it could fire, and the
  // re-run then returned early. The badge stuck forever.
  useEffect(() => {
    if (saveState !== 'saved') return;
    const clear = setTimeout(() => setSaveState('idle'), 2500);
    return () => clearTimeout(clear);
  }, [saveState]);

  // Never sit in 'saving' forever: a failed save reports itself elsewhere, and a
  // stuck spinner reads as a hung app.
  useEffect(() => {
    if (saveState !== 'saving') return;
    const giveUp = setTimeout(() => setSaveState('idle'), 6000);
    return () => clearTimeout(giveUp);
  }, [saveState]);

  const catalog: VoiceCatalog | null = catalogResult?.ok ? catalogResult.catalog : null;
  const fetchError = catalogResult && !catalogResult.ok ? catalogResult.error : null;

  const fetchCatalog = () => {
    if (!endpoint.trim()) return;
    setFetching(true);
    postMessage({
      type: 'fetchVoiceModels',
      endpoint: endpoint.trim(),
      apiKey: apiKey.trim() || undefined,
    });
  };

  // Voices come embedded in the selected TTS model's entry, which is scoped
  // correctly per model — unlike the server's global voice catalogue.
  const voicesForModel = catalog?.tts.find((m) => m.id === ttsModel.trim())?.voices ?? [];

  const save = () => {
    const voice: VoiceConfig = { enabled, endpoint: endpoint.trim(), sttModel: sttModel.trim() };
    if (apiKey.trim()) voice.apiKey = apiKey.trim();
    if (ttsModel.trim()) voice.ttsModel = ttsModel.trim();
    if (ttsVoice.trim()) voice.ttsVoice = ttsVoice.trim();
    const speed = Number.parseFloat(ttsSpeed);
    // Clamp rather than trust the field: 0 or a negative would make the upstream
    // fail with something unhelpful.
    if (Number.isFinite(speed) && speed > 0) {
      voice.ttsSpeed = Math.min(Math.max(speed, 0.5), 2);
    }
    if (lang.trim()) voice.lang = lang.trim();
    if (autoStartBackend) voice.autoStartBackend = true;
    pendingSave.current = voiceSignature(voice as unknown as Record<string, unknown>);
    setSaveState('saving');
    onSave({ ...config, voice });
  };

  // Rendered only once a status has been fetched AND the container is the
  // right kind of "not usable" (Docker installed) AND the saved endpoint is
  // loopback — the server is the single source of truth for the latter (see
  // `port`), never re-parsed from the endpoint field here.
  const showBackendBlock =
    backendStatus !== null && backendStatus.docker !== 'absent' && backendStatus.port !== null;

  return (
    <div className="glass-form">
      <h4>Voice</h4>
      <div className="glass-form__body">
        {!endpoint.trim() && (
          <div className="form-group">
            <button
              type="button"
              onClick={() => {
                setEnabled(true);
                setEndpoint(LOCAL_DEFAULTS.endpoint);
                setSttModel(LOCAL_DEFAULTS.sttModel);
                setTtsModel(LOCAL_DEFAULTS.ttsModel);
                setTtsVoice(LOCAL_DEFAULTS.ttsVoice);
              }}
            >
              Use local defaults
            </button>
            <small>
              Fills the form for a fully local backend (a Speaches container on port
              8969) that caretaker can run for you if Docker is installed. Nothing is
              saved yet — adjust anything, including the port in the endpoint, then
              press Save; a Start button appears below afterwards.
            </small>
          </div>
        )}

        {showBackendBlock && backendStatus && (
          <div className="form-group">
            <div className="voice-backend-status">
              <span>{backendProgress ?? backendStatusText(backendStatus)}</span>
              {backendStatus.container === 'running' ? (
                <button type="button" onClick={stopBackend} disabled={backendBusy}>
                  {backendBusy ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button type="button" onClick={startBackend} disabled={backendBusy}>
                  {backendBusy ? 'Starting…' : 'Start'}
                </button>
              )}
              {backendStatus.container !== 'absent' && (
                <button
                  type="button"
                  onClick={confirmingDelete ? deleteBackend : armDelete}
                  disabled={backendBusy}
                >
                  {confirmingDelete ? 'Really delete?' : 'Delete'}
                </button>
              )}
            </div>
            {backendError && <small className="form-error">{backendError}</small>}
            <div className="form-group form-group--checkbox">
              <label htmlFor="voice-backend-autostart">
                <input
                  id="voice-backend-autostart"
                  type="checkbox"
                  checked={autoStartBackend}
                  onChange={(e) => setAutoStartBackend(e.target.checked)}
                />
                Start automatically with caretaker
              </label>
            </div>
            <small>
              The first start downloads about 2 GB. The container publishes on the
              port in your endpoint — if that port is taken, change it there and
              save; caretaker never picks a port for you. Delete removes the
              container but keeps the downloaded models — try it when the backend
              misbehaves after switching networks.
            </small>
          </div>
        )}

        <div className="form-group form-group--checkbox">
          <label htmlFor="voice-enabled">
            <input
              id="voice-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable voice mode
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="voice-endpoint">Speech Endpoint</label>
          <input
            id="voice-endpoint"
            type="text"
            placeholder="http://127.0.0.1:8969/v1"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <small>
            OpenAI-compatible speech endpoint — e.g. a local Speaches container.
            Transcription posts to <code>/audio/transcriptions</code>, synthesis to{' '}
            <code>/audio/speech</code>. Leave the synthesis fields empty for dictation
            only. Voice is unavailable in the VSCode sidebar.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-key">API Key (optional)</label>
          <input
            id="voice-key"
            type="password"
            placeholder="Leave empty for a local server with no auth"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <small>Stored encrypted. Never sent to the browser — requests are proxied.</small>
        </div>

        <div className="form-group">
          <button type="button" onClick={fetchCatalog} disabled={fetching || !endpoint.trim()}>
            {fetching ? 'Fetching…' : 'Fetch models'}
          </button>
          <small>
            Reads the endpoint's installed models so the fields below become lists.
            Endpoints that do not report a task per model still work — the fields stay
            free text.
          </small>
          {fetchError && <small className="form-error">Fetch failed: {fetchError}</small>}
        </div>

        <div className="form-group">
          <label htmlFor="voice-stt">Transcription Model</label>
          {catalog && catalog.stt.length > 0 ? (
            <select
              id="voice-stt"
              value={sttModel}
              onChange={(e) => setSttModel(e.target.value)}
            >
              <option value="">-- Select a model --</option>
              {withCurrent(catalog.stt, sttModel).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="voice-stt"
              type="text"
              placeholder="e.g. Systran/faster-whisper-small"
              value={sttModel}
              onChange={(e) => setSttModel(e.target.value)}
            />
          )}
        </div>

        <div className="form-group">
          <label htmlFor="voice-tts">Synthesis Model (optional)</label>
          {catalog && catalog.tts.length > 0 ? (
            <select
              id="voice-tts"
              value={ttsModel}
              onChange={(e) => {
                setTtsModel(e.target.value);
                // The voice belongs to the model: a stale id would 400 at synthesis.
                const next = catalog.tts.find((m) => m.id === e.target.value);
                if (next && !next.voices.some((v) => v.id === ttsVoice)) {
                  setTtsVoice(next.voices.length === 1 ? next.voices[0].id : '');
                }
              }}
            >
              <option value="">-- None (dictation only) --</option>
              {withCurrent(
                catalog.tts.map((m) => m.id),
                ttsModel,
              ).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="voice-tts"
              type="text"
              placeholder="e.g. speaches-ai/Kokoro-82M-v1.0-ONNX"
              value={ttsModel}
              onChange={(e) => setTtsModel(e.target.value)}
            />
          )}
          <small>Required for conversation mode. Without it, only dictation is offered.</small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-voice">Voice (optional)</label>
          {voicesForModel.length > 0 ? (
            <select
              id="voice-voice"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
            >
              <option value="">-- Select a voice --</option>
              {voicesForModel.map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="voice-voice"
              type="text"
              placeholder="e.g. if_sara"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
            />
          )}
          <small>
            Pick one whose language matches yours. A model trained mostly on English
            keeps an English inflection even on its other-language voices.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-speed">Speaking Rate (optional)</label>
          <input
            id="voice-speed"
            type="number"
            min="0.5"
            max="2"
            step="0.05"
            placeholder="1 — the model's natural pace"
            value={ttsSpeed}
            onChange={(e) => setTtsSpeed(e.target.value)}
          />
          <small>
            Multiplier, clamped to 0.5–2. Useful because some voices are just slow:
            raise it if the reply drags. Piper responds less to this than Kokoro,
            since for Piper it stretches phoneme durations.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-lang">Language (optional)</label>
          <input
            id="voice-lang"
            type="text"
            placeholder="e.g. it-IT — defaults to the browser language"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" onClick={save}>
          Save
        </button>
        <span role="status" aria-live="polite" className="form-save-state">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : ''}
        </span>
      </div>
    </div>
  );
}
