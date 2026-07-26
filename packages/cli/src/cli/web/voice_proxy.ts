import type { Hono } from 'hono';
import type { CaretakerConfig, VoiceConfig } from 'caretaker-types';
// One definition, in the bridge — the CLI already imports types from there
// (server.ts:51) and webview-ui is a workspace dependency.
import type { VoiceClientConfig } from 'webview-ui/bridge';
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

/** Resolve the usable voice config, or a reason it cannot be used. */
async function resolveVoice(): Promise<{ voice: VoiceConfig } | { error: string }> {
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

function authHeaders(voice: VoiceConfig): Record<string, string> {
  if (!voice.apiKey) return {};
  const key = isEncrypted(voice.apiKey) ? decrypt(voice.apiKey) : voice.apiKey;
  return { authorization: `Bearer ${key}` };
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
        headers: authHeaders(voice),
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

    let upstream: Response;
    try {
      upstream = await fetch(url(voice.endpoint, '/audio/speech'), {
        method: 'POST',
        headers: { ...authHeaders(voice), 'content-type': 'application/json' },
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
