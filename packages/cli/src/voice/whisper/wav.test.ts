import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav16kMono } from './wav.js';

export function makeWav(
  samples: number[],
  o: { rate?: number; channels?: number; format?: number; bits?: number; extra?: boolean } = {},
): Uint8Array {
  const { rate = 16000, channels = 1, format = 1, bits = 16, extra = false } = o;
  const list = extra ? [0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0] : [];
  const dataBytes = samples.length * 2;
  const b = new Uint8Array(12 + 24 + list.length + 8 + dataBytes);
  const dv = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  dv.setUint32(4, b.length - 8, true);
  b.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, (rate * channels * bits) / 8, true);
  dv.setUint16(32, (channels * bits) / 8, true);
  dv.setUint16(34, bits, true);
  b.set(list, 36);
  const d = 36 + list.length;
  b.set([0x64, 0x61, 0x74, 0x61], d);
  dv.setUint32(d + 4, dataBytes, true);
  samples.forEach((s, i) => dv.setInt16(d + 8 + i * 2, s, true));
  return b;
}

test('parses 16 kHz mono PCM16', () => {
  const out = parseWav16kMono(makeWav([0x4000, -0x4000, 0]));
  assert.deepEqual(Array.from(out), [0.5, -0.5, 0]);
});

test('finds the data chunk after an extra LIST chunk', () => {
  assert.deepEqual(Array.from(parseWav16kMono(makeWav([0x4000], { extra: true }))), [0.5]);
});

test('rejects wrong rate, stereo, float, 8-bit', () => {
  assert.throws(() => parseWav16kMono(makeWav([0], { rate: 44100 })), /44100/);
  assert.throws(() => parseWav16kMono(makeWav([0, 0], { channels: 2 })), /mono/);
  assert.throws(() => parseWav16kMono(makeWav([0], { format: 3 })), /integer PCM/);
  assert.throws(() => parseWav16kMono(makeWav([0], { bits: 8 })), /16-bit/);
});

test('rejects truncated and non-WAV input', () => {
  assert.throws(() => parseWav16kMono(new Uint8Array(4)), /too short/);
  assert.throws(() => parseWav16kMono(new Uint8Array(64)), /RIFF/);
  assert.throws(() => parseWav16kMono(makeWav([1, 2]).slice(0, 30)), /fmt|data/);
  assert.throws(() => parseWav16kMono(makeWav([1, 2]).slice(0, 36)), /no data/);
});
