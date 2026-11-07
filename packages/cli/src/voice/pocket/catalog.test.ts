import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POCKET_LANGUAGES, POCKET_REVISION, POCKET_VOICES, ORT_TARBALLS } from './catalog.js';

test('revision is a full commit sha', () => assert.match(POCKET_REVISION, /^[0-9a-f]{40}$/));

test('every language pins every file with sha256 and size', () => {
  for (const [lang, l] of Object.entries(POCKET_LANGUAGES)) {
    assert.ok(l.files.length >= 6, lang);
    for (const f of l.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.bytes > 0);
    }
    assert.ok(
      l.files.some((f) => f.name === 'voices.bin'),
      `${lang} ships voices.bin`,
    );
    assert.ok(POCKET_VOICES.includes(l.nativeVoice), `${lang} default voice is a built-in voice`);
  }
});

test('the bundles ship the eight official voices, no per-language native ones', () => {
  assert.deepEqual(
    [...POCKET_VOICES],
    ['alba', 'azelma', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'],
  );
});

test('runtime tarballs carry sha512 integrity', () => {
  for (const t of Object.values(ORT_TARBALLS)) assert.match(t.integrity, /^sha512-/);
});
