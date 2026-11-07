import type { Hono } from 'hono';
import type { CaretakerConfig, PronunciationEntry, VoiceConfig } from 'caretaker-types';
// One definition, in the bridge — the CLI already imports types from there
// (server.ts:51) and webview-ui is a workspace dependency.
import type { VoiceCatalog, VoiceClientConfig } from 'webview-ui/bridge';
import { loadConfig } from '../../store/json.js';
import { decrypt, isEncrypted } from '../../lib/encryption.js';
import { applyPronunciation, dictionaryFor, synthesisLanguage } from '../../voice/pronunciation.js';

export function voiceClientConfig(config: CaretakerConfig): VoiceClientConfig | null {
  const voice = config.voice;
  if (!voice) return null;
  const out: VoiceClientConfig = {
    enabled: voice.enabled === true,
    configured: typeof voice.endpoint === 'string' && voice.endpoint.trim().length > 0,
    canSpeak:
      voice.ttsEngine === 'builtin'
        ? typeof voice.ttsLanguage === 'string' && voice.ttsLanguage.length > 0
        : typeof voice.ttsModel === 'string' && voice.ttsModel.trim().length > 0,
  };
  if (voice.lang) out.lang = voice.lang;
  if (Number.isFinite(voice.playbackBufferMs)) out.playbackBufferMs = voice.playbackBufferMs;
  return out;
}

/** Resolve the usable voice config, or a reason it cannot be used. Shared with
 *  voice_backend.ts so the two surfaces refuse for the same reasons, in the same
 *  words (the HTTP status is the caller's choice, the wording is not). */
export async function resolveVoice(): Promise<{ voice: VoiceConfig } | { error: string }> {
  const config = await loadConfig();
  const voice = config.voice;
  if (!voice || voice.enabled !== true) {
    return { error: 'Voice mode is disabled. Enable it in Settings → Voice.' };
  }
  if (!voice.endpoint || voice.endpoint.trim().length === 0) {
    return { error: 'No voice endpoint configured. Set one in Settings → Voice.' };
  }
  return { voice };
}

/** Resolve a key that may be stored encrypted (the settings form round-trips the
 *  stored blob, so what comes back from the view is not necessarily plaintext). */
function plainKey(apiKey: string | undefined | null): string | null {
  if (!apiKey) return null;
  return isEncrypted(apiKey) ? decrypt(apiKey) : apiKey;
}

export function voiceAuthHeaders(voice: VoiceConfig): Record<string, string> {
  return authHeaders(voice.apiKey);
}

/** Build auth headers from an explicit key (which may be stored encrypted).
 *  Used so the synthesis leg can send its own key — or none at all. */
export function authHeaders(apiKey: string | undefined | null): Record<string, string> {
  const key = plainKey(apiKey);
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** Where synthesis goes. A configured `ttsEndpoint` takes its own key — or
 *  none at all: the transcription key belongs to a different host and must
 *  not leak to a third-party TTS service. */
export function ttsTarget(voice: VoiceConfig): { endpoint: string; apiKey?: string } {
  const tts = voice.ttsEndpoint?.trim();
  if (!tts) return { endpoint: voice.endpoint, apiKey: voice.apiKey };
  return { endpoint: tts, ...(voice.ttsApiKey ? { apiKey: voice.ttsApiKey } : {}) };
}

/** Join a base URL and a path without doubling or dropping the slash. */
function url(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/+$/, '')}${suffix}`;
}

export function registerVoiceProxy(app: Hono): void {
  app.post('/api/voice/transcribe', async (c) => {
    const resolved = await resolveVoice();
    if ('error' in resolved) return c.text(resolved.error, 503);
    const { voice } = resolved;
    if (!voice.sttModel) return c.text('No transcription model configured.', 400);

    const incoming = await c.req.formData();
    const file = incoming.get('file');
    if (!file) return c.text('No audio uploaded (expected a "file" part).', 400);

    const form = new FormData();
    form.set('file', file);
    form.set('model', voice.sttModel);
    if (voice.lang) form.set('language', voice.lang.split('-')[0]);

    let upstream: Response;
    try {
      upstream = await fetch(url(voice.endpoint, '/audio/transcriptions'), {
        method: 'POST',
        headers: voiceAuthHeaders(voice),
        body: form,
      });
    } catch (err) {
      return c.text(`Could not reach the voice endpoint: ${err}`, 502);
    }

    // Propagate failures verbatim: with no validation button in the UI, a wrong
    // model id must surface as the provider's own message.
    if (!upstream.ok) {
      return c.body(await upstream.arrayBuffer(), upstream.status as any, {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain',
      });
    }
    return c.body(await upstream.arrayBuffer(), 200, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
  });

  app.post('/api/voice/speak', async (c) => {
    const resolved = await resolveSynthesis();
    if ('error' in resolved) return c.text(resolved.error, 503);

    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = body.text;
    if (typeof text !== 'string' || text.trim().length === 0) return c.text('No text to speak.', 400);
    if (text.length > MAX_SPEAK_CHARS) return c.text('Text is too long to speak.', 400);

    return synthesize(resolved.voice, text, c.req.raw.signal);
  });

  // Listen: synthesize with the form's unsaved settings. Credentials never
  // come from the view; mergePreview keeps the saved ones (see its comment).
  app.post('/api/voice/preview', async (c) => {
    const resolved = await resolveSynthesis();
    if ('error' in resolved) return c.text(resolved.error, 503);

    const body = await c.req.json().catch(() => null);
    const parsed = parsePreviewBody(body);
    if (typeof parsed === 'string') return c.text(parsed, 400);

    const voice = mergePreview(resolved.voice, parsed.settings);
    return synthesize(voice, parsed.text, c.req.raw.signal);
  });
}

const MAX_SPEAK_CHARS = 20_000;
const MAX_PREVIEW_CHARS = 2_000;
const MAX_DICTIONARY_ROWS = 500;

export type SynthesisSettings = Pick<
  VoiceConfig,
  | 'ttsEngine'
  | 'ttsLanguage'
  | 'ttsVoice'
  | 'ttsModel'
  | 'ttsSpeed'
  | 'ttsEndpoint'
  | 'pronunciationEnabled'
> & { pronunciation?: PronunciationEntry[] };

/** Validate the preview body; returns the parsed request or an error message. */
function parsePreviewBody(body: unknown): { text: string; settings: SynthesisSettings } | string {
  if (!body || typeof body !== 'object') return 'Expected a JSON body.';
  const { text, settings } = body as { text?: unknown; settings?: unknown };
  if (typeof text !== 'string' || text.trim().length === 0) return 'No text to speak.';
  if (text.length > MAX_PREVIEW_CHARS) return 'Text is too long for a preview.';
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'Expected a "settings" object.';
  }
  const s = settings as Record<string, unknown>;
  const optString = (k: string) => s[k] === undefined || typeof s[k] === 'string';
  for (const k of ['ttsLanguage', 'ttsVoice', 'ttsModel', 'ttsEndpoint']) {
    if (!optString(k)) return `"${k}" must be a string.`;
  }
  if (s.ttsEngine !== undefined && s.ttsEngine !== 'endpoint' && s.ttsEngine !== 'builtin') {
    return '"ttsEngine" must be "endpoint" or "builtin".';
  }
  if (s.ttsSpeed !== undefined && (typeof s.ttsSpeed !== 'number' || !Number.isFinite(s.ttsSpeed))) {
    return '"ttsSpeed" must be a number.';
  }
  if (s.pronunciationEnabled !== undefined && typeof s.pronunciationEnabled !== 'boolean') {
    return '"pronunciationEnabled" must be a boolean.';
  }
  if (s.pronunciation !== undefined) {
    if (!Array.isArray(s.pronunciation) || s.pronunciation.length > MAX_DICTIONARY_ROWS) {
      return '"pronunciation" must be a list of at most 500 entries.';
    }
    const ok = s.pronunciation.every(
      (e) => e && typeof e.term === 'string' && typeof e.say === 'string',
    );
    if (!ok) return 'Each pronunciation entry needs a string "term" and "say".';
  }
  return { text, settings: s as SynthesisSettings };
}

/** The saved voice config if synthesis can run: voice enabled, and (for the
 *  endpoint engine) some endpoint to talk to. The built-in engine needs none. */
export async function resolveSynthesis(): Promise<{ voice: VoiceConfig } | { error: string }> {
  const voice = (await loadConfig()).voice;
  if (!voice || voice.enabled !== true) {
    return { error: 'Voice mode is disabled. Enable it in Settings → Voice.' };
  }
  if (voice.ttsEngine !== 'builtin' && !voice.endpoint?.trim() && !voice.ttsEndpoint?.trim()) {
    return { error: 'No voice endpoint configured. Set one in Settings → Voice.' };
  }
  return { voice };
}

/** Same server: scheme, host and port. A different path or a trailing slash is
 *  not a different host, so it keeps the saved key. */
export function sameHost(a?: string, b?: string): boolean {
  const origin = (u?: string) => {
    const t = (u ?? '').trim();
    try {
      return new URL(t).origin;
    } catch {
      return t.replace(/\/+$/, '');
    }
  };
  return origin(a) === origin(b);
}

export const KEY_WITHHELD_HINT =
  'The endpoint changed: enter the API key again, or save first, to use it with the new endpoint.';

/** The key to send to `endpoint` for a request built from the settings form. A key
 *  typed in the form is the user's own, for that endpoint. The stored key (the form
 *  round-trips its encrypted blob) goes only to the host it was saved for;
 *  otherwise it is withheld and the request goes without a key. */
export function formKeyFor(
  endpoint: string,
  formKey: string | null | undefined,
  saved: VoiceConfig | undefined,
): { key: string | null; withheld: boolean } {
  if (!formKey) return { key: null, withheld: false };
  if (!isEncrypted(formKey)) return { key: formKey, withheld: false };
  const pairs: [string | undefined, string | undefined][] = [
    [saved?.apiKey, saved?.endpoint],
    [saved?.ttsApiKey, saved?.ttsEndpoint],
  ];
  return pairs.some(([k, ep]) => k === formKey && sameHost(ep, endpoint))
    ? { key: formKey, withheld: false }
    : { key: null, withheld: true };
}

/** Overlay the form's unsaved synthesis settings on the saved config. The saved
 *  `ttsApiKey` is dropped when the previewed `ttsEndpoint` is on another host than
 *  the saved one, so editing the URL can never send the stored key to a new host. */
export function mergePreview(saved: VoiceConfig, s: SynthesisSettings): VoiceConfig {
  const merged: VoiceConfig = {
    ...saved,
    ttsEngine: s.ttsEngine,
    ttsLanguage: s.ttsLanguage,
    ttsVoice: s.ttsVoice,
    ttsModel: s.ttsModel,
    ttsSpeed: s.ttsSpeed,
    ttsEndpoint: s.ttsEndpoint,
    pronunciationEnabled: s.pronunciationEnabled,
  };
  if (!sameHost(s.ttsEndpoint, saved.ttsEndpoint)) delete merged.ttsApiKey;
  if (s.pronunciation) {
    const code = synthesisLanguage(merged);
    if (code) merged.pronunciation = { ...saved.pronunciation, [code]: s.pronunciation };
  }
  return merged;
}

export type BuiltinSpeaker = (
  voice: VoiceConfig,
  text: string,
  signal: AbortSignal,
) => Promise<Response>;

let builtinSpeaker: BuiltinSpeaker | null = null;
/** The built-in engine registers itself here; null unregisters. */
export function setBuiltinSpeaker(fn: BuiltinSpeaker | null): void {
  builtinSpeaker = fn;
}

/** Synthesize `text` with the configured engine, dictionary applied, streaming
 *  the audio back. Failures are Responses (status + readable body), not throws. */
export async function synthesize(
  voice: VoiceConfig,
  text: string,
  signal: AbortSignal,
): Promise<Response> {
  const code = voice.pronunciationEnabled ? synthesisLanguage(voice) : null;
  const input = code ? applyPronunciation(text, dictionaryFor(voice, code)) : text;

  if (voice.ttsEngine === 'builtin') {
    if (!builtinSpeaker) {
      return new Response('The built-in voice engine is not available.', { status: 503 });
    }
    return builtinSpeaker(voice, input, signal);
  }

  if (!voice.ttsModel) return new Response('No synthesis model configured.', { status: 400 });

  const payload: Record<string, unknown> = { model: voice.ttsModel, input };
  if (voice.ttsVoice) payload.voice = voice.ttsVoice;
  if (Number.isFinite(voice.ttsSpeed) && (voice.ttsSpeed as number) > 0) {
    payload.speed = voice.ttsSpeed;
  }

  let upstream: Response;
  try {
    const target = ttsTarget(voice);
    upstream = await fetch(url(target.endpoint, '/audio/speech'), {
      method: 'POST',
      headers: { ...authHeaders(target.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    return new Response(`Could not reach the voice endpoint: ${err}`, { status: 502 });
  }

  // Stream through; failures are propagated verbatim (a wrong model id must
  // surface as the provider's own message).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? (upstream.ok ? 'audio/mpeg' : 'text/plain'),
    },
  });
}

/**
 * Read a speech endpoint's installed models so the settings form can offer real
 * choices instead of free text.
 *
 * Speaches reports `task` per model and embeds each TTS model's own voices — and
 * those are correctly scoped, unlike the global /v1/audio/voices catalogue, which
 * ignores its model_id parameter. A plain OpenAI-compatible endpoint reports
 * neither, so every id is offered for both tasks and the voice stays free text.
 *
 * openai-edge-tts reports models under `{"models": [...]}` (not `{"data": [...]}`),
 * with no task metadata, and publishes its voice list at `/voices/all` rather than
 * per model — voice ids are under the `"name"` key, not `"id"`. When no TTS entry
 * carries its own voices, a best-effort `/voices/all` fetch fills them in; failure
 * degrades to the free-text voice field, which already works.
 */
export async function fetchVoiceCatalog(
  endpoint: string,
  apiKey?: string | null,
): Promise<VoiceCatalog> {
  const key = plainKey(apiKey);
  const headers = authHeaders(key);
  const res = await fetch(url(endpoint, '/models'), { headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: unknown; models?: unknown };
  // Accept both { "data": [...] } (OpenAI/Speaches) and { "models": [...] }
  // (openai-edge-tts) — the latter uses a non-standard envelope key.
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];

  const stt: string[] = [];
  const tts: VoiceCatalog['tts'] = [];
  const untasked: string[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const model = row as { id?: unknown; task?: unknown; voices?: unknown };
    if (typeof model.id !== 'string') continue;

    if (model.task === 'automatic-speech-recognition') {
      stt.push(model.id);
      continue;
    }
    if (model.task === 'text-to-speech') {
      const voices = Array.isArray(model.voices) ? model.voices : [];
      tts.push({
        id: model.id,
        voices: voices.flatMap((v) => {
          const voice = v as { id?: unknown; language?: unknown; gender?: unknown };
          if (typeof voice.id !== 'string') return [];
          return [
            {
              id: voice.id,
              ...(typeof voice.language === 'string' ? { language: voice.language } : {}),
              ...(typeof voice.gender === 'string' ? { gender: voice.gender } : {}),
            },
          ];
        }),
      });
      continue;
    }
    untasked.push(model.id);
  }

  // No task metadata anywhere: offer everything for both, voices unknown.
  if (stt.length === 0 && tts.length === 0) {
    const ttsModels = untasked.map((id) => ({ id, voices: [] }));
    await fillVoicesFromCatalog(endpoint, headers, ttsModels);
    return { stt: untasked, tts: ttsModels };
  }
  // Mixed: keep the untasked ids selectable for transcription, the likelier use.
  if (tts.length > 0 && tts.every((m) => m.voices.length === 0)) {
    await fillVoicesFromCatalog(endpoint, headers, tts);
  }
  return { stt: [...stt, ...untasked], tts };
}

/** Best-effort GET <endpoint>/voices/all — openai-edge-tts publishes its voice
 *  list here rather than per model. Voice ids are under the `"name"` key (not
 *  `"id"`), the route defaults to en-US only on `/voices` (not `/voices/all`),
 *  and it may require auth. Failure is silent: an endpoint without the route
 *  degrades to the free-text voice field, which already works. */
async function fillVoicesFromCatalog(
  endpoint: string,
  headers: Record<string, string>,
  ttsModels: VoiceCatalog['tts'],
): Promise<void> {
  if (ttsModels.length === 0) return;
  let res: Response;
  try {
    res = await fetch(url(endpoint, '/voices/all'), { headers });
  } catch {
    return;
  }
  if (!res.ok) return;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return;
  }
  // Accept both a bare array and a { "voices": [...] } envelope. The edge-tts
  // shape is { "voices": [{ "name": "it-IT-ElsaNeural", "gender": "Female",
  // "language": "it-IT" }, ...] }.
  const voiceRows = Array.isArray(body)
    ? body
    : Array.isArray((body as { voices?: unknown })?.voices)
      ? (body as { voices: unknown[] }).voices
      : [];
  if (voiceRows.length === 0) return;

  const voices = voiceRows.flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const voice = v as {
      name?: unknown;
      id?: unknown;
      ShortName?: unknown;
      language?: unknown;
      Locale?: unknown;
      gender?: unknown;
      Gender?: unknown;
    };
    // edge-tts uses "name" for the voice id; Speaches uses "id"; some APIs use
    // "ShortName". Accept any, preferring "name" first for edge-tts.
    const id =
      typeof voice.name === 'string'
        ? voice.name
        : typeof voice.id === 'string'
          ? voice.id
          : typeof voice.ShortName === 'string'
            ? voice.ShortName
            : null;
    if (!id) return [];
    const language = voice.language ?? voice.Locale;
    const gender = voice.gender ?? voice.Gender;
    return [
      {
        id,
        ...(typeof language === 'string' ? { language } : {}),
        ...(typeof gender === 'string' ? { gender } : {}),
      },
    ];
  });

  if (voices.length > 0) {
    for (const model of ttsModels) model.voices = voices;
  }
}
