import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPronunciation,
  DEFAULT_PRONUNCIATION,
  dictionaryFor,
  synthesisLanguage,
} from './pronunciation.js';

test('whole-word, case-insensitive, longest term first', () => {
  const e = [
    { term: 'request', say: 'X' },
    { term: 'merge request', say: 'mèrg riquèst' },
  ];
  assert.equal(
    applyPronunciation('Two Merge Requests and a merge request.', e),
    'Two Merge Requests and a mèrg riquèst.',
  );
});

test('never matches inside a longer word', () =>
  assert.equal(applyPronunciation('buildings build', [{ term: 'build', say: 'bìld' }]), 'buildings bìld'));

test('regex metacharacters are literal', () =>
  assert.equal(
    applyPronunciation('use node.js and c++ not nodexjs', [
      { term: 'node.js', say: 'nod gèi es' },
      { term: 'c++', say: 'ci plus plus' },
    ]),
    'use nod gèi es and ci plus plus not nodexjs',
  ));

test('sentence-initial capital still matches', () =>
  assert.equal(applyPronunciation('Pipeline verde.', [{ term: 'pipeline', say: 'pàiplain' }]), 'pàiplain verde.'));

test('empty term is ignored', () => assert.equal(applyPronunciation('ciao', [{ term: '', say: 'x' }]), 'ciao'));

test('a replacement is never matched again', () =>
  assert.equal(
    applyPronunciation('build', [
      { term: 'build', say: 'bìld stage' },
      { term: 'stage', say: 'stèij' },
    ]),
    'bìld stage',
  ));

test('italian defaults are the approved generic list', () => {
  assert.deepEqual(
    DEFAULT_PRONUNCIATION.it.map((e) => e.term).sort(),
    ['branch', 'build', 'deploy', 'feature', 'merge request', 'pipeline', 'pull request', 'review', 'stage'],
  );
  assert.equal(DEFAULT_PRONUNCIATION.it.find((e) => e.term === 'stage')!.say, 'stèij');
});

test('synthesis language: builtin uses ttsLanguage, endpoint uses lang subtag, else null', () => {
  assert.equal(synthesisLanguage({ ttsEngine: 'builtin', ttsLanguage: 'italian' } as any), 'it');
  assert.equal(synthesisLanguage({ lang: 'en-GB' } as any), 'en');
  assert.equal(synthesisLanguage({} as any), null);
});

test('saved dictionary replaces defaults for that language only', () => {
  const v = { pronunciation: { it: [{ term: 'deploy', say: 'diplói' }] } } as any;
  assert.deepEqual(dictionaryFor(v, 'it'), [{ term: 'deploy', say: 'diplói' }]);
  assert.deepEqual(dictionaryFor({} as any, 'it'), DEFAULT_PRONUNCIATION.it);
  assert.deepEqual(dictionaryFor({} as any, 'fr'), []);
});
