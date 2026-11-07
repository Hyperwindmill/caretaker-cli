import type { PronunciationEntry, VoiceConfig } from 'caretaker-types';
import { POCKET_LANGUAGES, type PocketLanguage } from './pocket/catalog.js';

/** Shipped defaults by ISO 639-1 code. Generic terms only (caretaker is open
 *  source). Respellings tuned by ear on the Italian built-in voice; the other
 *  languages ship empty. */
export const DEFAULT_PRONUNCIATION: Readonly<Record<string, readonly PronunciationEntry[]>> = {
  it: [
    { term: 'merge request', say: 'mèrg riquèst' },
    { term: 'pull request', say: 'pùl riquèst' },
    { term: 'pipeline', say: 'pàiplain' },
    { term: 'deploy', say: 'diplòi' },
    { term: 'branch', say: 'brènc' },
    { term: 'feature', say: 'fìciar' },
    { term: 'build', say: 'bìld' },
    { term: 'review', say: 'riviù' },
    { term: 'stage', say: 'stèij' },
    { term: 'file', say: 'fàil' },
    { term: 'ok', say: 'okèi' },
    { term: 'buffer', say: 'bàffer' },
  ],
};

/** ISO code of the language being synthesized, or null when the server cannot
 *  know it (the renderer's navigator.language never reaches the server). */
export function synthesisLanguage(voice: VoiceConfig): string | null {
  if (voice.ttsEngine === 'builtin') {
    return POCKET_LANGUAGES[voice.ttsLanguage as PocketLanguage]?.code ?? null;
  }
  const primary = voice.lang?.split('-')[0]?.trim().toLowerCase();
  return primary || null;
}

/** The saved dictionary for `code` when present (it replaces the defaults),
 *  else the shipped defaults, else empty. */
export function dictionaryFor(voice: VoiceConfig, code: string): readonly PronunciationEntry[] {
  return voice.pronunciation?.[code] ?? DEFAULT_PRONUNCIATION[code] ?? [];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace every whole-word, case-insensitive occurrence of an entry's term
 *  with its `say`. Terms are literal; the longest wins; one pass, so a
 *  replacement is never matched again. */
export function applyPronunciation(text: string, entries: readonly PronunciationEntry[]): string {
  const say = new Map<string, string>();
  for (const e of entries) {
    const term = e.term.trim();
    if (term) say.set(term.toLowerCase(), e.say);
  }
  if (say.size === 0) return text;
  const alternation = [...say.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, (m) => say.get(m.toLowerCase()) ?? m);
}
