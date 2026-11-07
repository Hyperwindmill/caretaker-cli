// Routes for the built-in voice installer. The in-flight guard is per language so a
// second install of the same language cannot start a parallel download.

import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { POCKET_LANGUAGES, type PocketLanguage } from '../../voice/pocket/catalog.js';
import { WHISPER_MODELS, type WhisperSize } from '../../voice/whisper/catalog.js';
import {
  builtinVoiceStatus,
  deleteBuiltinStt,
  deleteBuiltinVoice,
  installBuiltinStt,
  installBuiltinVoice,
} from '../../voice/pocket/install.js';
import { releasePocketModels, runtimeLoadError, runtimeLoaded, speakBuiltin } from '../../voice/pocket/engine.js';
import { releaseWhisperModels, transcribeBuiltin } from '../../voice/whisper/engine.js';
import { setBuiltinSpeaker, setBuiltinTranscriber } from './voice_proxy.js';

// One install or delete at a time: voices and models share the runtime directory.
let busy: string | null = null;

type Target = { kind: 'voice'; lang: PocketLanguage } | { kind: 'stt'; size: WhisperSize };

/** Exactly one of `?language=` / `?stt=`, both known; otherwise a 400 message. */
function reqTarget(language: string | undefined, stt: string | undefined): Target | string {
  if ((language === undefined) === (stt === undefined)) return 'Pass exactly one of language or stt.';
  if (stt !== undefined) {
    return Object.hasOwn(WHISPER_MODELS, stt) ? { kind: 'stt', size: stt as WhisperSize } : 'Unknown model size.';
  }
  const lang = reqLanguage(language);
  return lang ? { kind: 'voice', lang } : 'Unknown language.';
}

function reqLanguage(q: string | undefined): PocketLanguage | null {
  return q && Object.hasOwn(POCKET_LANGUAGES, q) ? (q as PocketLanguage) : null;
}

async function statusWithLoadError() {
  const status = await builtinVoiceStatus();
  const loadError = runtimeLoadError();
  return loadError ? { ...status, runtime: { ...status.runtime, loadError } } : status;
}

export function registerVoiceBuiltin(app: Hono): void {
  setBuiltinSpeaker(speakBuiltin);
  setBuiltinTranscriber(transcribeBuiltin);
  app.get('/api/voice/builtin', async (c) => c.json(await statusWithLoadError()));

  app.post('/api/voice/builtin/install', async (c) => {
    const t = reqTarget(c.req.query('language'), c.req.query('stt'));
    if (typeof t === 'string') return c.text(t, 400);
    const name = t.kind === 'voice' ? t.lang : t.size;
    if (busy) return c.text(`An install of ${busy} is already in progress.`, 409);
    busy = name;
    c.header('Content-Type', 'application/x-ndjson');
    return stream(c, async (s) => {
      try {
        for await (const p of t.kind === 'voice' ? installBuiltinVoice(t.lang) : installBuiltinStt(t.size)) await s.writeln(JSON.stringify(p));
      } finally {
        busy = null;
      }
    });
  });

  app.post('/api/voice/builtin/delete', async (c) => {
    const t = reqTarget(c.req.query('language'), c.req.query('stt'));
    if (typeof t === 'string') return c.text(t, 400);
    if (busy) return c.text('An install is in progress; wait for it to finish.', 409);
    busy = t.kind === 'voice' ? t.lang : t.size;
    try {
      await releasePocketModels();
      await releaseWhisperModels();
      const keepRuntime = runtimeLoaded();
      if (t.kind === 'voice') await deleteBuiltinVoice(t.lang, { keepRuntime });
      else await deleteBuiltinStt(t.size, { keepRuntime });
    } finally {
      busy = null;
    }
    return c.json(await statusWithLoadError());
  });
}
