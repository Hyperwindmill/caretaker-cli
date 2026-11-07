import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePcmType, pcm16Chunk, nextStart, choosePath, bufferSeconds } from './voice_stream.js';

test('pcm type parsing', () => {
  assert.deepEqual(parsePcmType('audio/pcm;rate=24000;channels=1'), { rate: 24000, channels: 1 });
  assert.equal(parsePcmType('audio/mpeg'), null);
});

test('odd-length chunk carries one byte into the next', () => {
  const a = pcm16Chunk(new Uint8Array([0x00, 0x40, 0xff]), null); // 0x4000 then half a sample
  assert.equal(a.samples.length, 1);
  assert.equal(a.samples[0], 0.5);
  assert.deepEqual([...a.carry!], [0xff]);
  const b = pcm16Chunk(new Uint8Array([0x7f]), a.carry); // 0x7fff
  assert.equal(b.samples.length, 1);
  assert.ok(Math.abs(b.samples[0] - 32767 / 32768) < 1e-9);
  assert.equal(b.carry, null);
});

test('scheduling never goes back in time', () => {
  assert.equal(nextStart(10, 0, 0.05), 10.05);
  assert.equal(nextStart(10, 12, 0.05), 12);
});
test('a chunk arriving while audio still plays is appended with no gap', () =>
  assert.equal(nextStart(10, 10.3, 0.5), 10.3));
test('after the audio ran dry, playback waits one buffer before resuming', () =>
  assert.equal(nextStart(10, 9.8, 0.5), 10.5));
test('buffer setting: default, clamp, milliseconds to seconds', () => {
  assert.equal(bufferSeconds(undefined), 0.5);
  assert.equal(bufferSeconds(1200), 1.2);
  assert.equal(bufferSeconds(-5), 0);
  assert.equal(bufferSeconds(99999), 5);
});

test('path choice', () => {
  assert.equal(choosePath('audio/pcm;rate=24000;channels=1', () => true), 'pcm');
  assert.equal(choosePath('audio/mpeg', (t) => t === 'audio/mpeg'), 'mse');
  assert.equal(choosePath('audio/mpeg', () => false), 'buffered');
  assert.equal(choosePath('audio/wav', () => true), 'buffered');
});
