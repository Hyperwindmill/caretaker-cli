import { useEffect, useRef, useState } from 'react';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';
import type { ViewToHost, VoiceCatalog, VoiceCatalogResult } from './bridge.js';
import { voiceSignature } from './voice_utils.js';
import {
  backendStatusText,
  type BackendStatus,
  type BackendStatuses,
} from './voice_backend_utils.js';
import { VoiceBackendBlock } from './VoiceBackendBlock.js';

const BACKEND_POLL_MS = 10_000;

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

/** The openai-edge-tts local setup — Microsoft Neural voices (e.g.
 *  it-IT-ElsaNeural) for synthesis while Speaches handles transcription. Only
 *  prefills the synthesis fields; the transcription endpoint/model/voice stay
 *  as the user already set them (or the local defaults above). */
const EDGE_TTS_DEFAULTS = {
  ttsEndpoint: 'http://127.0.0.1:5050/v1',
  ttsModel: 'tts-1',
  ttsVoice: 'it-IT-ElsaNeural',
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
  const [ttsEndpoint, setTtsEndpoint] = useState(current.ttsEndpoint ?? '');
  const [ttsApiKey, setTtsApiKey] = useState(current.ttsApiKey ?? '');
  const [ttsModel, setTtsModel] = useState(current.ttsModel ?? '');
  const [ttsVoice, setTtsVoice] = useState(current.ttsVoice ?? '');
  const [ttsSpeed, setTtsSpeed] = useState(
    current.ttsSpeed === undefined ? '' : String(current.ttsSpeed),
  );
  const [lang, setLang] = useState(current.lang ?? '');
  const [fetching, setFetching] = useState(false);
  const [fetchingTts, setFetchingTts] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** Signature of the payload the last Save submitted, awaiting confirmation. */
  const pendingSave = useRef<string | null>(null);

  // --- Managed local backends (Docker) ------------------------------------
  const [autoStartBackend, setAutoStartBackend] = useState(current.autoStartBackend ?? false);
  // null until the first fetch resolves — that is also what keeps the block
  // hidden on surfaces (VSCode) where these routes do not exist at all.
  const [backendStatuses, setBackendStatuses] = useState<BackendStatuses | null>(null);

  const fetchBackendStatuses = async () => {
    try {
      const res = await fetch('/api/voice/backend');
      if (!res.ok) return;
      const statuses = (await res.json()) as BackendStatuses;
      setBackendStatuses(statuses);
    } catch {
      // Route doesn't exist on this surface (VSCode sidebar) or the request
      // failed outright — no status means the block stays hidden, which is
      // the correct outcome, not an error to surface.
    }
  };

  useEffect(() => {
    fetchBackendStatuses();
    const interval = setInterval(fetchBackendStatuses, BACKEND_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Allow each VoiceBackendBlock to adopt a fresh status from its own
  // start/stop/delete response, merging into the parent's envelope.
  const adoptStatus = (target: 'stt' | 'tts') => (status: BackendStatus) => {
    setBackendStatuses((prev) =>
      prev ? { ...prev, [target]: status } : { stt: status, tts: null },
    );
  };

  useEffect(() => {
    if (catalogResult) {
      setFetching(false);
      setFetchingTts(false);
    }
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

  // Per-endpoint catalogue state: the STT endpoint's catalogue populates the
  // transcription model field, the TTS endpoint's populates the synthesis model
  // and voice fields. The bridge echoes `target` back on `voiceModelsFetched`
  // so we can keep them apart — but the current App.tsx has a single
  // `voiceCatalogResult` slot, so we store the last result here and rely on
  // the caller to send the right endpoint. The `target` field on the bridge
  // message is plumbed but not yet wired to separate App-level state slots;
  // this is the same incremental approach the plan describes — the view sends
  // the right endpoint for each fetch, and the result fills whichever fields
  // match the fetched ids.
  const sttCatalog = catalog;
  const ttsCatalog = catalog;

  const fetchSttCatalog = () => {
    if (!endpoint.trim()) return;
    setFetching(true);
    postMessage({
      type: 'fetchVoiceModels',
      endpoint: endpoint.trim(),
      apiKey: apiKey.trim() || undefined,
    });
  };

  const fetchTtsCatalog = () => {
    const ep = ttsEndpoint.trim() || endpoint.trim();
    if (!ep) return;
    setFetchingTts(true);
    postMessage({
      type: 'fetchVoiceModels',
      endpoint: ep,
      apiKey: (ttsEndpoint.trim() ? ttsApiKey : apiKey).trim() || undefined,
      target: 'tts',
    });
  };

  // Voices come embedded in the selected TTS model's entry, which is scoped
  // correctly per model — unlike the server's global voice catalogue.
  const voicesForModel = ttsCatalog?.tts.find((m) => m.id === ttsModel.trim())?.voices ?? [];

  const save = () => {
    const voice: VoiceConfig = { enabled, endpoint: endpoint.trim(), sttModel: sttModel.trim() };
    if (apiKey.trim()) voice.apiKey = apiKey.trim();
    if (ttsEndpoint.trim()) voice.ttsEndpoint = ttsEndpoint.trim();
    if (ttsApiKey.trim()) voice.ttsApiKey = ttsApiKey.trim();
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
  const showSttBackend =
    backendStatuses !== null &&
    backendStatuses.stt.docker !== 'absent' &&
    backendStatuses.stt.port !== null;
  const showTtsBackend =
    backendStatuses?.tts !== null &&
    backendStatuses.tts !== null &&
    backendStatuses.tts.docker !== 'absent' &&
    backendStatuses.tts.port !== null;

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

        {showSttBackend && backendStatuses && (
          <VoiceBackendBlock
            target="stt"
            label="Speech backend (Speaches)"
            status={backendStatuses.stt}
            onStatusChange={adoptStatus('stt')}
            hint="The first start downloads about 2 GB. The container publishes on the port in your endpoint — if that port is taken, change it there and save; caretaker never picks a port for you. Delete removes the container but keeps the downloaded models — try it when the backend misbehaves after switching networks."
          />
        )}

        {showTtsBackend && backendStatuses?.tts && (
          <VoiceBackendBlock
            target="tts"
            label="Synthesis backend (edge-tts)"
            status={backendStatuses.tts}
            onStatusChange={adoptStatus('tts')}
            hint="A small image. The container publishes on the port in your synthesis endpoint. Delete removes the container; the image stays cached."
          />
        )}

        {(showSttBackend || showTtsBackend) && (
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
            <small>
              Applies to both containers: a Speaches pull does not block the edge-tts
              start — they are independent.
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
            Transcription posts to <code>/audio/transcriptions</code>. When no
            separate synthesis endpoint is set below, synthesis also posts to{' '}
            <code>/audio/speech</code> here. Voice is unavailable in the VSCode sidebar.
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
          <button type="button" onClick={fetchSttCatalog} disabled={fetching || !endpoint.trim()}>
            {fetching ? 'Fetching…' : 'Fetch models'}
          </button>
          <small>
            Reads the endpoint's installed models so the transcription field below
            becomes a list. Endpoints that do not report a task per model still work —
            the field stays free text.
          </small>
          {fetchError && fetching && <small className="form-error">Fetch failed: {fetchError}</small>}
        </div>

        <div className="form-group">
          <label htmlFor="voice-stt">Transcription Model</label>
          {sttCatalog && sttCatalog.stt.length > 0 ? (
            <select
              id="voice-stt"
              value={sttModel}
              onChange={(e) => setSttModel(e.target.value)}
            >
              <option value="">-- Select a model --</option>
              {withCurrent(sttCatalog.stt, sttModel).map((id) => (
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

        {/* --- Separate synthesis endpoint (optional) --- */}

        <div className="form-group">
          <label htmlFor="voice-tts-endpoint">Synthesis Endpoint (optional)</label>
          <input
            id="voice-tts-endpoint"
            type="text"
            placeholder="Leave empty when one server does both"
            value={ttsEndpoint}
            onChange={(e) => setTtsEndpoint(e.target.value)}
          />
          {!ttsEndpoint.trim() && (
            <button
              type="button"
              onClick={() => {
                setTtsEndpoint(EDGE_TTS_DEFAULTS.ttsEndpoint);
                setTtsModel(EDGE_TTS_DEFAULTS.ttsModel);
                setTtsVoice(EDGE_TTS_DEFAULTS.ttsVoice);
              }}
              style={{ marginTop: '0.4em' }}
            >
              Use Microsoft Edge voices
            </button>
          )}
          <small>
            Leave empty when one server does both. A local openai-edge-tts container
            gives you Microsoft Neural voices such as{' '}
            <code>it-IT-ElsaNeural</code> or <code>it-IT-DiegoNeural</code>, but cannot
            transcribe — transcription always uses the endpoint above. Nothing is saved
            yet — press Save after adjusting.
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="voice-tts-key">Synthesis API Key (optional)</label>
          <input
            id="voice-tts-key"
            type="password"
            placeholder="Leave empty for a local server with no auth"
            value={ttsApiKey}
            onChange={(e) => setTtsApiKey(e.target.value)}
          />
          <small>
            Stored encrypted. Only sent to the synthesis endpoint — the transcription
            key is never sent there, and vice versa.
          </small>
        </div>

        {ttsEndpoint.trim() && (
          <div className="form-group">
            <button
              type="button"
              onClick={fetchTtsCatalog}
              disabled={fetchingTts || (!ttsEndpoint.trim() && !endpoint.trim())}
            >
              {fetchingTts ? 'Fetching…' : 'Fetch synthesis models'}
            </button>
            <small>
              Reads the synthesis endpoint's models and voices. For edge-tts, the
              voice list comes from <code>/voices/all</code>.
            </small>
            {fetchError && fetchingTts && (
              <small className="form-error">Fetch failed: {fetchError}</small>
            )}
          </div>
        )}

        <div className="form-group">
          <label htmlFor="voice-tts">Synthesis Model (optional)</label>
          {ttsCatalog && ttsCatalog.tts.length > 0 ? (
            <select
              id="voice-tts"
              value={ttsModel}
              onChange={(e) => {
                setTtsModel(e.target.value);
                // The voice belongs to the model: a stale id would 400 at synthesis.
                const next = ttsCatalog.tts.find((m) => m.id === e.target.value);
                if (next && !next.voices.some((v) => v.id === ttsVoice)) {
                  setTtsVoice(next.voices.length === 1 ? next.voices[0].id : '');
                }
              }}
            >
              <option value="">-- None (dictation only) --</option>
              {withCurrent(
                ttsCatalog.tts.map((m) => m.id),
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
              placeholder="e.g. speaches-ai/Kokoro-82M-v1.0-ONNX or tts-1"
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
              placeholder="e.g. af_heart or it-IT-ElsaNeural"
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