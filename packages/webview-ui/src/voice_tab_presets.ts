import type { VoiceConfig } from 'caretaker-types';
import type { BuiltinVoiceStatus } from './bridge.js';

/** The README's canonical local setup — what the managed Speaches backend runs
 *  with zero decisions. Prefilled into the form, never saved directly. */
export const LOCAL_DEFAULTS = {
  endpoint: 'http://127.0.0.1:8969/v1',
  sttModel: 'Systran/faster-whisper-small',
  ttsModel: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
  ttsVoice: 'af_heart',
};

/** The openai-edge-tts local setup — Microsoft Neural voices for synthesis
 *  while Speaches handles transcription. */
export const EDGE_TTS_DEFAULTS = {
  ttsEndpoint: 'http://127.0.0.1:5050/v1',
  ttsModel: 'tts-1',
  ttsVoice: 'it-IT-ElsaNeural',
};

/** Built-in language id for a BCP-47 tag ('it-IT' → 'italian'); unknown → 'english'. */
export function pocketLanguageFor(bcp47: string | undefined, status: BuiltinVoiceStatus): string {
  const primary = (bcp47 ?? '').trim().toLowerCase().split(/[-_]/)[0];
  const hit = primary ? status.languages.find((l) => l.code === primary) : undefined;
  return hit?.id ?? 'english';
}

export function builtinPreset(lang: string | undefined, status: BuiltinVoiceStatus): Partial<VoiceConfig> {
  const id = pocketLanguageFor(lang, status);
  const entry = status.languages.find((l) => l.id === id);
  return {
    ttsEngine: 'builtin',
    ttsLanguage: id,
    ttsVoice: entry?.nativeVoice ?? status.voices[0] ?? '',
    pronunciationEnabled: true,
  };
}

export function edgePreset(): Partial<VoiceConfig> {
  return { ...EDGE_TTS_DEFAULTS, ttsEngine: 'endpoint', pronunciationEnabled: false };
}

/** Speaches for transcription plus the built-in engine for synthesis when the
 *  runtime can load; otherwise the all-Speaches Kokoro setup. */
export function localDefaultsPreset(
  lang: string | undefined,
  status: BuiltinVoiceStatus | null,
): Partial<VoiceConfig> {
  const stt = { enabled: true, endpoint: LOCAL_DEFAULTS.endpoint, sttModel: LOCAL_DEFAULTS.sttModel };
  if (status && !status.runtime.loadError) return { ...stt, ...builtinPreset(lang, status) };
  return {
    ...stt,
    ttsEngine: 'endpoint',
    ttsModel: LOCAL_DEFAULTS.ttsModel,
    ttsVoice: LOCAL_DEFAULTS.ttsVoice,
  };
}
