import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UnigramTokenizer,
  prepareChunks,
  prepareTextPrompt,
  type TextPrepConfig,
} from './tokenizer.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );

// The bundle's own front-end vectors (tokenizer.json + frontend-fixtures.json, copied
// verbatim from the pinned revision): chunk texts, token ids and frames after EOS.
for (const lang of ['it', 'de']) {
  test(`${lang}: chunks, token ids and frames after EOS match the bundle fixtures`, () => {
    const tok = new UnigramTokenizer(fixture(`${lang}.tokenizer.json`));
    const { textPrep, fixtures } = fixture(`${lang}.frontend.json`);
    for (const f of fixtures) {
      assert.deepEqual(prepareChunks(f.input, tok, textPrep), f.chunks, `${lang} ${f.kind}`);
    }
  });
}

const synthetic = () =>
  new UnigramTokenizer({
    model: {
      type: 'Unigram',
      unk_id: 0,
      byte_fallback: true,
      vocab: [
        ['<unk>', 0],
        ...Array.from(
          { length: 256 },
          (_, b) => [`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`, 0] as [string, number],
        ),
        ['▁', -3],
        ['▁ab', -2],
        ['▁a', -1.5],
        ['b', -1.5],
        ['c', -4],
        ['.', -2],
      ],
    },
  });

test('Viterbi picks the best-scoring segmentation', () => {
  // ▁ab (-2) beats ▁a + b (-3).
  const tok = synthetic();
  assert.deepEqual(tok.encode('ab'), [258]);
  assert.equal(tok.decode(tok.encode('ab c.')), 'ab c.');
});

test('unknown characters fall back to their UTF-8 bytes, fused across a run', () => {
  const tok = synthetic();
  // ▁ then "è" (C3 A8) then "z" (7A) as bytes.
  assert.deepEqual(tok.encode('èz'), [257, 1 + 0xc3, 1 + 0xa8, 1 + 0x7a]);
  assert.equal(tok.decode(tok.encode('èz b')), 'èz b');
  // Astral characters are never split inside a surrogate pair.
  assert.equal(tok.decode(tok.encode('a 😀')), 'a 😀');
});

test('prompt preparation: capitalization, terminal punctuation, frames guess', () => {
  const cfg: TextPrepConfig = {
    replace_characters: {},
    remove_semicolons: true,
    append_terminal_punctuation: true,
    capitalize_first_letter: true,
    pad_with_spaces_for_short_inputs: false,
    max_token_per_chunk: 50,
  };
  assert.deepEqual(prepareTextPrompt('  ciao mondo, ', cfg), {
    text: 'Ciao mondo.',
    framesAfterEosGuess: 3,
  });
  assert.equal(prepareTextPrompt('a; b c d e', cfg).text, 'A, b c d e.');
  assert.equal(prepareTextPrompt('a b c d e', cfg).framesAfterEosGuess, 1);
  assert.equal(prepareTextPrompt('"Davvero?"', cfg).text, '"Davvero?"');
  assert.equal(prepareTextPrompt('Lui disse "sì"', cfg).text, 'Lui disse "sì".');
  assert.throws(() => prepareTextPrompt('   ', cfg), /empty/);
});
