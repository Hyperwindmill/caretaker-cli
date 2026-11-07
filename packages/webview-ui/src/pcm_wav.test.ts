import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavPcm16 } from './pcm_wav.js';

test('encodeWavPcm16 writes a 16 kHz mono PCM16 header and clamped samples', () => {
  const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2]), 16000);
  const v = new DataView(wav.buffer);
  const str = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(str(12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36), 'data');
  assert.equal(v.getUint32(40, true), 10);
  assert.equal(v.getUint32(4, true), 46);
  assert.equal(wav.length, 54);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767, -32768]);
});
