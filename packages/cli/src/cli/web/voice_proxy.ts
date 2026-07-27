import type { Hono } from 'hono';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';
// One definition, in the bridge — the CLI already imports types from there
// (server.ts:51) and webview-ui is a workspace dependency.
import type { VoiceCatalog, VoiceClientConfig } from 'webview-ui/bridge';
import { loadConfig } from '../../store/json.js';
import { decrypt, isEncrypted } from '../../lib/encryption.js';

export function voiceClientConfig(config: CaretakerConfig): VoiceClientConfig | null {
  const voice = config.voice;
  if (!voice) return null;
  const out: VoiceClientConfig = {
    enabled: voice.enabled === true,
    configured: typeof voice.endpoint === 'string' && voice.endpoint.trim().length > 0,
    canSpeak: typeof voice.ttsModel === 'string' && voice.ttsModel.trim().length > 0,
  };
  if (voice.lang) out.lang = voice.lang;
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
    const resolved = await resolveVoice();
    if ('error' in resolved) return c.text(resolved.error, 503);
    const { voice } = resolved;
    if (!voice.ttsModel) return c.text('No synthesis model configured.', 400);

    const { text } = await c.req.json<{ text?: string }>();
    if (!text || text.trim().length === 0) return c.text('No text to speak.', 400);

    const payload: Record<string, unknown> = { model: voice.ttsModel, input: text };
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
      });
    } catch (err) {
      return c.text(`Could not reach the voice endpoint: ${err}`, 502);
    }

    if (!upstream.ok) {
      return c.body(await upstream.arrayBuffer(), upstream.status as any, {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain',
      });
    }
    return c.body(await upstream.arrayBuffer(), 200, {
      'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
    });
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
