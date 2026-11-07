import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logMel, makeFFT, melFilters, N_FRAMES, N_MELS, SAMPLE_RATE } from './features.js';

// Reference values produced by the throwaway spike whose features matched faster-whisper's
// extractor to 3.8e-6.

const close = (actual: number, expected: number, tol: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected}`);

function tones(seconds: number, parts: Array<[hz: number, amp: number]>): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    for (const [hz, amp] of parts) out[i] += amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return out;
}

test('FFT of 400 points matches the reference spectrum', () => {
  const fft = makeFFT(400);
  const re = new Float64Array(400);
  const im = new Float64Array(400);
  const oR = new Float64Array(400);
  const oI = new Float64Array(400);
  for (let i = 0; i < 400; i++) re[i] = Math.cos((2 * Math.PI * 7 * i) / 400) + (i % 3) * 0.1;
  fft(re, im, oR, oI);
  close(oR[0], 39.9, 1e-9, 'bin 0');
  close(oR[7], 199.8997978847934, 1e-9, 'bin 7 re');
  close(oI[7], -0.003672596351822932, 1e-9, 'bin 7 im');
  close(oR[133], -16.564979997322787, 1e-9, 'bin 133 re');
  close(oI[133], -9.563621390660614, 1e-9, 'bin 133 im');
});

test('Slaney filterbank matches the reference values', () => {
  const fb = melFilters();
  assert.equal(fb.length, N_MELS * 201);
  const at = (m: number, k: number): number => fb[m * 201 + k];
  close(at(0, 1), 0.024862593984176087, 1e-12, 'fb[0][1]');
  assert.equal(at(0, 2), 0);
  close(at(10, 10), 0.019908218880980738, 1e-12, 'fb[10][10]');
  close(at(40, 43), 0.014735565741439144, 1e-12, 'fb[40][43]');
  close(at(70, 133), 0.001779249714824272, 1e-12, 'fb[70][133]');
  close(at(79, 190), 0.0022320550527126443, 1e-12, 'fb[79][190]');
});

test('log-mel has the fixed 80 x 3000 shape and the reference values', () => {
  const mel = logMel(
    tones(1, [
      [440, 0.5],
      [3000, 0.25],
    ]),
  );
  assert.equal(mel.length, N_MELS * N_FRAMES);
  const at = (m: number, t: number): number => mel[m * N_FRAMES + t];
  close(at(11, 50), 1.438204, 1e-5, 'peak (max)');
  close(at(10, 50), 1.348738, 1e-5, 'mel[10][50]');
  close(at(54, 50), 1.163527, 1e-5, 'mel[54][50] (3 kHz)');
  close(at(11, 100), 1.2928457, 1e-5, 'mel[11][100] (signal edge)');
  close(at(46, 101), -0.173766, 1e-5, 'mel[46][101]');
  // Clamped to max - 8, then (x + 4) / 4.
  close(at(30, 50), (1.438204 * 4 - 4 - 8 + 4) / 4, 1e-5, 'floor');
  close(at(5, N_FRAMES - 1), -0.561796, 1e-5, 'padding');
  let min = Infinity;
  let max = -Infinity;
  for (const v of mel) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  close(min, -0.561796, 1e-5, 'min');
  close(max, 1.438204, 1e-5, 'max');
});

test('a 440 Hz sine peaks in mel bin 11', () => {
  const mel = logMel(tones(1, [[440, 0.5]]));
  for (const t of [10, 50, 90]) {
    let best = -1;
    for (let m = 0; m < N_MELS; m++)
      if (best < 0 || mel[m * N_FRAMES + t] > mel[best * N_FRAMES + t]) best = m;
    assert.equal(best, 11, `frame ${t}`);
  }
});

test('silence and audio past 30 s are handled without errors', () => {
  const zeros = logMel(new Float32Array(3200));
  assert.ok(zeros.every((v) => v === -1.5)); // (log10(1e-10) + 4) / 4
  const long = tones(31, [[440, 0.5]]);
  const capped = logMel(long);
  assert.deepEqual(capped, logMel(long.subarray(0, 30 * SAMPLE_RATE)));
});
