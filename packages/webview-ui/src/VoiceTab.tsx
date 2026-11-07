import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaretakerConfig, PronunciationEntry, VoiceConfig } from 'caretaker-types';
import type { BuiltinVoiceStatus, ViewToHost, VoiceCatalog, VoiceCatalogResult } from './bridge.js';
import { voiceSignature } from './voice_utils.js';
import {
  type BackendStatus,
  type BackendStatuses,
} from './voice_backend_utils.js';
import { VoiceBackendBlock } from './VoiceBackendBlock.js';
import { BuiltinVoiceBlock } from './BuiltinVoiceBlock.js';
import { BuiltinSttBlock } from './BuiltinSttBlock.js';
import { PronunciationTable } from './PronunciationTable.js';
import { playSpeech } from './speech_player.js';
import { DEFAULT_PLAYBACK_BUFFER_MS, MAX_PLAYBACK_BUFFER_MS } from './voice_stream.js';

/** The form's buffer field as a whole number of ms, clamped; blank ⇒ undefined (default). */
function parsedBufferMs(v: string): number | undefined {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_PLAYBACK_BUFFER_MS) : undefined;
}
import { builtinPreset, edgePreset, localDefaultsPreset } from './voice_tab_presets.js';

const BACKEND_POLL_MS = 10_000;

export interface VoiceTabProps {
  config: CaretakerConfig;
  onSave: (config: CaretakerConfig) => void;
  postMessage: (msg: ViewToHost) => void;
  /** Result of the last STT (Speaches) catalogue fetch. */
  sttCatalogResult: VoiceCatalogResult | null;
  /** Result of the last TTS (edge-tts) catalogue fetch. */
  ttsCatalogResult: VoiceCatalogResult | null;
}

const EMPTY: VoiceConfig = { enabled: false, endpoint: '', sttModel: '' };

const SAMPLES: Record<string, string> = {
  it: 'Ciao, questa è una prova della voce.',
  en: 'Hello, this is a test of the voice.',
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

export function VoiceTab({ config, onSave, postMessage, sttCatalogResult, ttsCatalogResult }: VoiceTabProps) {
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
  const [bufferMs, setBufferMs] = useState(
    current.playbackBufferMs === undefined ? '' : String(current.playbackBufferMs),
  );
  const [ttsEngine, setTtsEngine] = useState<'endpoint' | 'builtin'>(current.ttsEngine ?? 'endpoint');
  const [sttEngine, setSttEngine] = useState<'endpoint' | 'builtin'>(current.sttEngine ?? 'endpoint');
  const [sttBuiltinModel, setSttBuiltinModel] = useState(current.sttBuiltinModel ?? 'base');
  const [ttsLanguage, setTtsLanguage] = useState(current.ttsLanguage ?? '');
  const [pronEnabled, setPronEnabled] = useState(current.pronunciationEnabled ?? false);
  // Per ISO code; an absent key means "the shipped defaults for that language".
  const [pronunciation, setPronunciation] = useState<Record<string, PronunciationEntry[]>>(
    current.pronunciation ?? {},
  );
  // null until the fetch resolves — keeps the block hidden where the route
  // does not exist (VSCode sidebar), like the backend block.
  const [builtinStatus, setBuiltinStatus] = useState<BuiltinVoiceStatus | null>(null);
  const [listening, setListening] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const listenAbort = useRef<AbortController | null>(null);
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
    fetch('/api/voice/builtin')
      .then((res) => (res.ok ? (res.json() as Promise<BuiltinVoiceStatus>) : null))
      .then((st) => st && setBuiltinStatus(st))
      .catch(() => {});
    return () => listenAbort.current?.abort();
  }, []);

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
    if (sttCatalogResult) setFetching(false);
  }, [sttCatalogResult]);

  useEffect(() => {
    if (ttsCatalogResult) setFetchingTts(false);
  }, [ttsCatalogResult]);

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

  // Two catalogue slots keyed by target, so a TTS fetch (edge-tts) does not
  // overwrite the STT fetch (Speaches) and vice versa. Each slot also carries
  // its own error, so a failed TTS fetch shows its error in the synthesis
  // section without being cleared by a successful STT fetch (and the reverse).
  //
  // When no separate ttsEndpoint is configured (the default Speaches-only
  // setup), synthesis uses the same endpoint as transcription, so the STT
  // catalogue's TTS entries (Kokoro, Piper, …) with their embedded voices are
  // the right data for the synthesis pickers too. Fall back to sttCatalog in
  // that case so the Speaches-only user keeps the synthesis model and voice
  // dropdowns they had on main.
  const sttCatalog: VoiceCatalog | null = sttCatalogResult?.ok ? sttCatalogResult.catalog : null;
  const sttFetchError = sttCatalogResult && !sttCatalogResult.ok ? sttCatalogResult.error : null;
  const ttsCatalog: VoiceCatalog | null = ttsCatalogResult?.ok
    ? ttsCatalogResult.catalog
    : !ttsEndpoint.trim()
      ? sttCatalog
      : null;
  const ttsFetchError = ttsCatalogResult && !ttsCatalogResult.ok ? ttsCatalogResult.error : null;

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
    // Only rendered when ttsEndpoint is set, so it is always truthy here.
    const ep = ttsEndpoint.trim();
    setFetchingTts(true);
    postMessage({
      type: 'fetchVoiceModels',
      endpoint: ep,
      apiKey: ttsApiKey.trim() || undefined,
      target: 'tts',
    });
  };

  // Voices come embedded in the selected TTS model's entry, which is scoped
  // correctly per model — unlike the server's global voice catalogue.
  const voicesForModel = ttsCatalog?.tts.find((m) => m.id === ttsModel.trim())?.voices ?? [];

  const applyPreset = (p: Partial<VoiceConfig>) => {
    if (p.enabled !== undefined) setEnabled(p.enabled);
    if (p.endpoint !== undefined) setEndpoint(p.endpoint);
    if (p.sttModel !== undefined) setSttModel(p.sttModel);
    if (p.sttEngine !== undefined) setSttEngine(p.sttEngine);
    if (p.sttBuiltinModel !== undefined) setSttBuiltinModel(p.sttBuiltinModel);
    if (p.ttsEngine !== undefined) setTtsEngine(p.ttsEngine);
    if (p.ttsLanguage !== undefined) setTtsLanguage(p.ttsLanguage);
    if (p.ttsEndpoint !== undefined) setTtsEndpoint(p.ttsEndpoint);
    if (p.ttsModel !== undefined) setTtsModel(p.ttsModel);
    if (p.ttsVoice !== undefined) setTtsVoice(p.ttsVoice);
    if (p.pronunciationEnabled !== undefined) setPronEnabled(p.pronunciationEnabled);
  };

  const builtin = ttsEngine === 'builtin';
  const sttBuiltin = sttEngine === 'builtin' && !!builtinStatus;
  // The endpoint/key serve endpoint transcription and, absent a separate
  // synthesis endpoint, endpoint synthesis; hide them only when neither is used.
  const showEndpoint = !sttBuiltin || !builtin;
  // Dictionary language: the built-in language's code, else the primary subtag of `lang`.
  const synthCode = useMemo<string | null>(() => {
    if (builtin) return builtinStatus?.languages.find((l) => l.id === ttsLanguage)?.code ?? null;
    return lang.trim().split(/[-_]/)[0].toLowerCase() || null;
  }, [builtin, builtinStatus, ttsLanguage, lang]);
  const pronEntries = synthCode
    ? (pronunciation[synthCode] ?? builtinStatus?.defaults[synthCode] ?? [])
    : [];

  const stopListening = () => listenAbort.current?.abort();

  // Speaks `text` with the form as it is now (unsaved) via the preview route.
  // ttsEndpoint is always sent: the server treats absent as empty.
  const listen = async (text?: string) => {
    const code = synthCode ?? 'en';
    const sample = text ? `${text}.` : (SAMPLES[code] ?? SAMPLES.en);
    const speed = Number.parseFloat(ttsSpeed);
    const ac = new AbortController();
    listenAbort.current = ac;
    setListening(true);
    setListenError(null);
    try {
      const res = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          text: sample,
          settings: {
            ttsEngine,
            ttsLanguage,
            ttsVoice: ttsVoice.trim(),
            ttsModel: ttsModel.trim(),
            ttsSpeed: Number.isFinite(speed) && speed > 0 ? speed : undefined,
            ttsEndpoint: ttsEndpoint.trim(),
            pronunciationEnabled: pronEnabled,
            pronunciation: synthCode ? pronEntries.filter((e) => e.term.trim()) : undefined,
          },
        }),
      });
      if (!res.ok) {
        setListenError((await res.text().catch(() => '')) || `HTTP ${res.status}`);
        return;
      }
      await playSpeech(res, ac.signal, { bufferMs: parsedBufferMs(bufferMs) });
    } catch (err) {
      if (!ac.signal.aborted) setListenError(err instanceof Error ? err.message : String(err));
    } finally {
      setListening(false);
    }
  };

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
    const buf = parsedBufferMs(bufferMs);
    if (buf !== undefined) voice.playbackBufferMs = buf;
    if (autoStartBackend) voice.autoStartBackend = true;
    if (sttBuiltin) {
      voice.sttEngine = 'builtin';
      voice.sttBuiltinModel = sttBuiltinModel as 'tiny' | 'base' | 'small';
    }
    if (builtin) {
      voice.ttsEngine = 'builtin';
      if (ttsLanguage) voice.ttsLanguage = ttsLanguage;
    }
    if (pronEnabled) voice.pronunciationEnabled = true;
    const dict: Record<string, PronunciationEntry[]> = {};
    for (const [code, entries] of Object.entries(pronunciation)) {
      dict[code] = entries.filter((e) => e.term.trim());
    }
    if (Object.keys(dict).length) voice.pronunciation = dict;
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
    backendStatuses !== null &&
    backendStatuses.tts !== null &&
    backendStatuses.tts.docker !== 'absent' &&
    backendStatuses.tts.port !== null;

  return (
    <div className="glass-form">
      <h4>Voice</h4>
      <div className="glass-form__body">
        <div className="form-group">
          {builtinStatus && !builtinStatus.runtime.loadError && (
            <button type="button" onClick={() => applyPreset(builtinPreset(lang, builtinStatus))}>
              Use built-in voice (recommended)
            </button>
          )}{' '}
          <button type="button" onClick={() => applyPreset(localDefaultsPreset(lang, builtinStatus))}>
            Use local defaults
          </button>{' '}
          <button type="button" onClick={() => applyPreset(edgePreset())}>
            Use Microsoft Edge voices
          </button>
          <small>
            Presets only fill the form. The built-in voice runs inside caretaker; local
            defaults add a Speaches container on port 8969 for transcription (caretaker
            can run it for you if Docker is installed); Edge voices use an
            openai-edge-tts container on port 5050. Nothing is saved yet — adjust
            anything, then press Save.
          </small>
        </div>

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

        {builtinStatus && (
          <div className="form-group">
            <label htmlFor="voice-stt-engine">Transcription engine</label>
            <select
              id="voice-stt-engine"
              value={sttEngine}
              onChange={(e) => setSttEngine(e.target.value as 'endpoint' | 'builtin')}
            >
              <option value="endpoint">Speech endpoint (Speaches, OpenAI…)</option>
              <option value="builtin">Built-in transcription (Whisper)</option>
            </select>
          </div>
        )}

        {sttBuiltin && builtinStatus && (
          <BuiltinSttBlock
            status={builtinStatus}
            onStatusChange={setBuiltinStatus}
            model={sttBuiltinModel}
            onModelChange={setSttBuiltinModel}
          />
        )}

        {showEndpoint && (
          <>
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

          </>
        )}

        {!sttBuiltin && (
          <>
        <div className="form-group">
          <button type="button" onClick={fetchSttCatalog} disabled={fetching || !endpoint.trim()}>
            {fetching ? 'Fetching…' : 'Fetch models'}
          </button>
          <small>
            Reads the endpoint's installed models so the transcription field below
            becomes a list. Endpoints that do not report a task per model still work —
            the field stays free text.
          </small>
          {sttFetchError && <small className="form-error">Fetch failed: {sttFetchError}</small>}
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

          </>
        )}

        <div className="form-group">
          <label htmlFor="voice-engine">Synthesis engine</label>
          <select
            id="voice-engine"
            value={ttsEngine}
            onChange={(e) => setTtsEngine(e.target.value as 'endpoint' | 'builtin')}
          >
            <option value="endpoint">Speech endpoint (Speaches, edge-tts, OpenAI…)</option>
            {builtinStatus && <option value="builtin">Built-in voice</option>}
          </select>
        </div>

        {builtin && builtinStatus && (
          <BuiltinVoiceBlock
            status={builtinStatus}
            onStatusChange={setBuiltinStatus}
            language={ttsLanguage}
            onLanguageChange={setTtsLanguage}
            voice={ttsVoice}
            onVoiceChange={setTtsVoice}
          />
        )}

        {!builtin && (
          <>
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
              disabled={fetchingTts}
            >
              {fetchingTts ? 'Fetching…' : 'Fetch synthesis models'}
            </button>
            <small>
              Reads the synthesis endpoint's models and voices. For edge-tts, the
              voice list comes from <code>/voices/all</code>.
            </small>
            {ttsFetchError && (
              <small className="form-error">Fetch failed: {ttsFetchError}</small>
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

          </>
        )}

        <div className="form-group">
          <label htmlFor="voice-buffer">Playback buffer, ms (optional)</label>
          <input
            id="voice-buffer"
            type="number"
            min="0"
            max={MAX_PLAYBACK_BUFFER_MS}
            step="100"
            placeholder={`${DEFAULT_PLAYBACK_BUFFER_MS} — default`}
            value={bufferMs}
            onChange={(e) => setBufferMs(e.target.value)}
          />
          <small>
            Audio collected before speech starts, and again if it runs dry. Raise it if
            speech stutters (a slower machine or endpoint); lower it for a quicker start.
            Listen uses the value in the form, so you can try it before saving.
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

        <PronunciationTable
          code={synthCode}
          entries={pronEntries}
          enabled={pronEnabled}
          onEnabledChange={setPronEnabled}
          onChange={(entries) => synthCode && setPronunciation((p) => ({ ...p, [synthCode]: entries }))}
          onRestoreDefaults={() =>
            synthCode &&
            setPronunciation((p) => {
              const { [synthCode]: _drop, ...rest } = p;
              return rest;
            })
          }
          onListen={(t) => void listen(t)}
          listening={listening}
          listenError={listenError}
        />

        <div className="form-group">
          <button type="button" onClick={listening ? stopListening : () => void listen()}>
            {listening ? 'Stop' : 'Listen'}
          </button>
          <small>Speaks a sample sentence with the form as it is now, without saving.</small>
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
