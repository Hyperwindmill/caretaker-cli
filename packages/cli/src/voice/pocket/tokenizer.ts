// Text front end of a Pocket TTS schema-3 bundle: the HF `tokenizers` Unigram model of
// tokenizer.json (Prepend "▁" normalizer, Metaspace pre-tokenizer, byte fallback, no
// post-processor) and upstream's prompt preparation and sentence chunking
// (pocket_tts/models/text_chunking.py at the bundle's upstream commit), ported literally.

const SPACE = '▁';
// HF tokenizers' unigram K_UNK_PENALTY.
const UNK_PENALTY = 10;

type TokenizerJson = {
  model: { type: string; unk_id: number; byte_fallback?: boolean; vocab: [string, number][] };
};

export class UnigramTokenizer {
  private readonly pieces = new Map<string, number>();
  private readonly scores: number[];
  private readonly byteIds: number[] = [];
  private readonly unkId: number;
  private readonly unkScore: number;
  private readonly maxPieceLen: number;
  private readonly vocab: string[];

  constructor(json: TokenizerJson) {
    const m = json.model;
    if (m.type !== 'Unigram') throw new Error(`unsupported tokenizer model: ${m.type}`);
    this.vocab = m.vocab.map(([p]) => p);
    this.scores = m.vocab.map(([, s]) => s);
    this.unkId = m.unk_id;
    this.unkScore = Math.min(...this.scores) - UNK_PENALTY;
    let maxLen = 1;
    m.vocab.forEach(([piece], id) => {
      const byte = /^<0x([0-9A-F]{2})>$/.exec(piece);
      if (byte) {
        this.byteIds[parseInt(byte[1], 16)] = id;
        return;
      }
      // Special pieces (<unk>, <s>, …) are never matched inside text. Divergence from HF,
      // which would split them out as added tokens: irrelevant for speech input.
      if (/^<.*>$/.test(piece) && this.scores[id] === 0) return;
      this.pieces.set(piece, id);
      maxLen = Math.max(maxLen, piece.length);
    });
    this.maxPieceLen = maxLen;
  }

  encode(text: string): number[] {
    if (text === '') return [];
    // Prepend normalizer, then Metaspace (spaces -> ▁, no second ▁ since one is there,
    // split before every ▁).
    const normalized = SPACE + text.replace(/ /g, SPACE);
    const ids: number[] = [];
    for (const word of normalized.match(/▁[^▁]*|[^▁]+/g) ?? []) this.encodeWord(word, ids);
    return ids;
  }

  // Viterbi over one pre-token: maximize the summed piece scores. Positions are UTF-16
  // indices kept on code-point boundaries; ties keep the earlier (shorter) candidate, as HF.
  private encodeWord(word: string, out: number[]): void {
    const n = word.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const via = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let start = 0; start < n; start = nextBoundary(word, start)) {
      const charEnd = nextBoundary(word, start);
      let single = false;
      for (let end = start + 1; end <= Math.min(n, start + this.maxPieceLen); end++) {
        if (end < n && isLowSurrogate(word.charCodeAt(end))) continue;
        const id = this.pieces.get(word.slice(start, end));
        if (id === undefined) continue;
        const score = best[start] + this.scores[id];
        if (from[end] < 0 || score > best[end]) {
          best[end] = score;
          from[end] = start;
          via[end] = id;
        }
        if (end === charEnd) single = true;
      }
      if (!single) {
        const score = best[start] + this.unkScore;
        if (from[charEnd] < 0 || score > best[charEnd]) {
          best[charEnd] = score;
          from[charEnd] = start;
          via[charEnd] = this.unkId;
        }
      }
    }
    // Backtrack; consecutive unknown spans are fused (HF fuse_unk) and then byte-encoded.
    const tokens: { id: number; text: string }[] = [];
    for (let end = n; end > 0; end = from[end]) {
      const id = via[end];
      const text = word.slice(from[end], end);
      const last = tokens[tokens.length - 1];
      if (id === this.unkId && last?.id === this.unkId) last.text = text + last.text;
      else tokens.push({ id, text });
    }
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.id !== this.unkId) {
        out.push(t.id);
        continue;
      }
      const bytes = Buffer.from(t.text, 'utf8');
      const byteIds = [...bytes].map((b) => this.byteIds[b]);
      if (byteIds.every((id) => id !== undefined)) out.push(...byteIds);
      else out.push(this.unkId);
    }
  }

  // Decoder chain Metaspace + ByteFallback + Fuse.
  decode(ids: readonly number[]): string {
    let out = '';
    let bytes: number[] = [];
    const flush = () => {
      if (bytes.length === 0) return;
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      } catch {
        out += '�'.repeat(bytes.length);
      }
      bytes = [];
    };
    ids.forEach((id, i) => {
      const piece = this.vocab[id] ?? '';
      const byte = /^<0x([0-9A-F]{2})>$/.exec(piece);
      if (byte) {
        bytes.push(parseInt(byte[1], 16));
        return;
      }
      flush();
      out += i === 0 ? piece.split(SPACE).join('') : piece.split(SPACE).join(' ');
    });
    flush();
    return out;
  }
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

function nextBoundary(s: string, i: number): number {
  return i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1)) ? i + 2 : i + 1;
}

// The text-prep flags of bundle.json.
export type TextPrepConfig = {
  replace_characters?: Record<string, string> | null;
  remove_semicolons: boolean;
  append_terminal_punctuation: boolean;
  capitalize_first_letter: boolean;
  pad_with_spaces_for_short_inputs: boolean;
  max_token_per_chunk: number;
};

const TERMINAL = '.!?…';
const WEAK = ',;:-–—';
const CLOSERS = '"\'”’)]»';

// Python str.split() with no argument.
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function rstripChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

// upstream prepare_text_prompt: returns the prompt and the frames-after-EOS guess.
export function prepareTextPrompt(
  input: string,
  cfg: TextPrepConfig,
): { text: string; framesAfterEosGuess: number } {
  let text = input.trim();
  const map = cfg.replace_characters ?? {};
  if (Object.keys(map).length > 0) {
    text = pySplit([...text].map((c) => map[c] ?? c).join('')).join(' ');
    text = text.replace(/([.!?…])\s*[,;:]/g, '$1');
  }
  if (text === '') throw new Error('Text prompt cannot be empty');
  text = text.replace(/\n/g, ' ').replace(/\r/g, ' ').split('  ').join(' ');
  if (cfg.remove_semicolons) text = text.replace(/;/g, ',');
  const framesAfterEosGuess = pySplit(text).length <= 4 ? 3 : 1;
  // Python's `if not text[0].isupper(): upper()` is the same as always upper-casing.
  if (cfg.capitalize_first_letter) {
    const first = String.fromCodePoint(text.codePointAt(0)!);
    text = first.toUpperCase() + text.slice(first.length);
  }
  if (cfg.append_terminal_punctuation) text = ensureTerminalPunctuation(text);
  if (cfg.pad_with_spaces_for_short_inputs && pySplit(text).length < 5) text = ' '.repeat(8) + text;
  return { text, framesAfterEosGuess };
}

function ensureTerminalPunctuation(text: string): string {
  const core = rstripChars(text, CLOSERS + ' ');
  const closers = text.slice(core.length).trim();
  if (!core || TERMINAL.includes(core[core.length - 1])) return text;
  if (WEAK.includes(core[core.length - 1])) return rstripChars(core, WEAK + ' ') + '.' + closers;
  return text + '.';
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && /^\p{Nd}$/u.test(c);
}

function boundaryIndices(
  tokens: number[],
  boundary: Set<number>,
  tok: UnigramTokenizer | null,
): number[] {
  const out = [0];
  let previousWasBoundary = false;
  tokens.forEach((t, idx) => {
    if (boundary.has(t)) {
      previousWasBoundary = true;
      return;
    }
    if (previousWasBoundary) {
      let decimal = false;
      if (tok) {
        const prefix = tok.decode(tokens.slice(0, idx));
        const suffix = tok.decode(tokens.slice(idx));
        decimal =
          prefix.length >= 2 &&
          prefix.endsWith('.') &&
          isDigit(prefix[prefix.length - 2]) &&
          isDigit(suffix[0]);
      }
      if (!decimal) out.push(idx);
    }
    previousWasBoundary = false;
  });
  out.push(tokens.length);
  return out;
}

function segments(tokens: number[], bounds: number[], tok: UnigramTokenizer): [number, string][] {
  const out: [number, string][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    out.push([bounds[i + 1] - bounds[i], tok.decode(tokens.slice(bounds[i], bounds[i + 1]))]);
  }
  return out;
}

// upstream split_into_best_sentences.
export function splitIntoChunks(
  text: string,
  tok: UnigramTokenizer,
  cfg: TextPrepConfig,
): string[] {
  const prepared = prepareTextPrompt(text, cfg).text.trim();
  const tokens = tok.encode(prepared);
  const sentenceEnd = new Set(tok.encode('.!...?').slice(1));
  const sentences = segments(tokens, boundaryIndices(tokens, sentenceEnd, tok), tok);

  const fallback = new Set(tok.encode(',;:').slice(1));
  const refined: [number, string][] = [];
  for (const [count, sentence] of sentences) {
    if (count <= cfg.max_token_per_chunk) {
      refined.push([count, sentence]);
      continue;
    }
    const sub = tok.encode(sentence.trim());
    const parts = segments(sub, boundaryIndices(sub, fallback, null), tok);
    if (parts.length > 1) refined.push(...parts);
    else refined.push([count, sentence]);
  }

  const chunks: string[] = [];
  let current = '';
  let currentCount = 0;
  for (const [count, sentence] of refined) {
    if (current === '') {
      current = sentence;
      currentCount = count;
    } else if (currentCount + count > cfg.max_token_per_chunk) {
      chunks.push(current.trim());
      current = sentence;
      currentCount = count;
    } else {
      current += ' ' + sentence;
      currentCount += count;
    }
  }
  if (current !== '') chunks.push(current.trim());
  return chunks;
}

export type PreparedChunk = { text: string; tokenIds: number[]; framesAfterEos: number };

// What the model is fed: every chunk is prepared again (upstream does so in
// generate_audio_stream) and gets two extra frames after EOS on top of the guess.
export function prepareChunks(
  text: string,
  tok: UnigramTokenizer,
  cfg: TextPrepConfig,
): PreparedChunk[] {
  return splitIntoChunks(text, tok, cfg).map((chunk) => {
    const { text: prompt, framesAfterEosGuess } = prepareTextPrompt(chunk, cfg);
    return { text: prompt, tokenIds: tok.encode(prompt), framesAfterEos: framesAfterEosGuess + 2 };
  });
}
