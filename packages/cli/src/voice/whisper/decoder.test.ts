import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteDecode, parseVocab } from './decoder.js';

// Real pieces and ids from the Whisper multilingual vocab.json.
const vocab = parseVocab(
  {
    Ġciao: 42860,
    Ġperch: 29240,
    'Ã©': 526,
    'ĠÃ¨': 4873,
    Ã: 127,
    '©': 102,
    Ċ: 198,
    '<|endoftext|>': 50257,
  },
  [50257],
);

test('Ġ is a space and accented characters come back from their bytes', () => {
  assert.equal(byteDecode([42860, 29240, 526], vocab), ' ciao perché');
  assert.equal(byteDecode([4873], vocab), ' è');
  assert.equal(byteDecode([198], vocab), '\n');
});

test('a character split across two tokens is reassembled', () => {
  assert.equal(byteDecode([29240, 127, 102], vocab), ' perché');
});

test('special and unknown ids are skipped', () => {
  assert.equal(vocab.has(50257), false);
  assert.equal(byteDecode([50257, 42860, 99999, 50257], vocab), ' ciao');
  assert.equal(byteDecode([], vocab), '');
});
