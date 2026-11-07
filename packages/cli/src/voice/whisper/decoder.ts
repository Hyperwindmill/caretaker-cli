// Whisper's tokenizer is GPT-2's byte-level BPE: every vocabulary entry is a string of
// stand-in characters, one per byte. Decoding only needs the reverse map; encoding is
// never needed (the prompt is special tokens only).

// GPT-2 bytes_to_unicode, reversed: stand-in character -> byte.
const BYTE_OF: ReadonlyMap<string, number> = (() => {
  const bytes: number[] = [];
  for (let b = 33; b <= 126; b++) bytes.push(b);
  for (let b = 161; b <= 172; b++) bytes.push(b);
  for (let b = 174; b <= 255; b++) bytes.push(b);
  const chars = bytes.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      chars.push(256 + n++);
    }
  }
  return new Map(bytes.map((b, i) => [String.fromCharCode(chars[i]), b]));
})();

// vocab.json (token -> id) to id -> token, leaving out the special tokens: they carry no
// text, so decoding skips them.
export function parseVocab(
  vocab: Record<string, number>,
  special: Iterable<number> = [],
): Map<number, string> {
  const skip = new Set(special);
  const out = new Map<number, string>();
  for (const [token, id] of Object.entries(vocab)) if (!skip.has(id)) out.set(id, token);
  return out;
}

// Ids missing from the vocabulary (special tokens) are skipped. A multi-byte character
// split across tokens is reassembled because all bytes are joined before UTF-8 decoding.
export function byteDecode(ids: number[], vocab: ReadonlyMap<number, string>): string {
  const bytes: number[] = [];
  for (const id of ids) {
    const token = vocab.get(id);
    if (token === undefined) continue;
    for (const ch of token) {
      const b = BYTE_OF.get(ch);
      if (b !== undefined) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
