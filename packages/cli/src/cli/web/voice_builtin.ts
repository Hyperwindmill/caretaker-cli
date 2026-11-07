// Routes for the built-in voice installer. The in-flight guard is per language so a
// second install of the same language cannot start a parallel download.

import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { POCKET_LANGUAGES, type PocketLanguage } from '../../voice/pocket/catalog.js';
import {
  builtinVoiceStatus,
  deleteBuiltinVoice,
  installBuiltinVoice,
} from '../../voice/pocket/install.js';
import { releasePocketModels, runtimeLoadError, runtimeLoaded, speakBuiltin } from '../../voice/pocket/engine.js';
import { setBuiltinSpeaker } from './voice_proxy.js';

// One install or delete at a time: languages share the runtime directory.
let busy: PocketLanguage | null = null;

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
  app.get('/api/voice/builtin', async (c) => c.json(await statusWithLoadError()));

  app.post('/api/voice/builtin/install', async (c) => {
    const lang = reqLanguage(c.req.query('language'));
    if (!lang) return c.text('Unknown language.', 400);
    if (busy) return c.text(`An install of ${busy} is already in progress.`, 409);
    busy = lang;
    c.header('Content-Type', 'application/x-ndjson');
    return stream(c, async (s) => {
      try {
        for await (const p of installBuiltinVoice(lang)) await s.writeln(JSON.stringify(p));
      } finally {
        busy = null;
      }
    });
  });

  app.post('/api/voice/builtin/delete', async (c) => {
    const lang = reqLanguage(c.req.query('language'));
    if (!lang) return c.text('Unknown language.', 400);
    if (busy) return c.text('An install is in progress; wait for it to finish.', 409);
    busy = lang;
    try {
      await releasePocketModels();
      await deleteBuiltinVoice(lang, { keepRuntime: runtimeLoaded() });
    } finally {
      busy = null;
    }
    return c.json(await statusWithLoadError());
  });
}
