// Whisper log-mel features with the semantics of HF WhisperFeatureExtractor (measured to
// match faster-whisper's extractor to 3.8e-6): 16 kHz audio padded to 30 s, STFT with
// n_fft 400 / hop 160 / periodic Hann / reflect padding, power spectrum, 80 Slaney mel
// bins (the ONNX export ships no filterbank, so it is computed here), log10, clamp to
// max - 8, (x + 4) / 4.

export const SAMPLE_RATE = 16000;
export const N_FFT = 400;
export const HOP_LENGTH = 160;
export const N_MELS = 80;
export const N_SAMPLES = 30 * SAMPLE_RATE; // the encoder's fixed 30 s window
export const N_FRAMES = N_SAMPLES / HOP_LENGTH;

const N_BINS = N_FFT / 2 + 1;
const LOG_FLOOR = -10; // log10(1e-10), the value of an all-zero frame

// Mixed-radix FFT for any length with small factors (400 = 4 * 4 * 5 * 5). Writes the
// complex spectrum of (inR, inI) into (outR, outI).
export function makeFFT(
  n: number,
): (inR: Float64Array, inI: Float64Array, outR: Float64Array, outI: Float64Array) => void {
  const factors: number[] = [];
  let m = n;
  for (const p of [4, 2, 3, 5, 7]) {
    while (m % p === 0) {
      factors.push(p);
      m /= p;
    }
  }
  if (m !== 1) factors.push(m);
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const maxP = Math.max(1, ...factors);
  const tr = new Float64Array(maxP);
  const ti = new Float64Array(maxP);

  const rec = (
    inR: Float64Array,
    inI: Float64Array,
    inOff: number,
    stride: number,
    len: number,
    oR: Float64Array,
    oI: Float64Array,
    oOff: number,
    fi: number,
  ): void => {
    if (len === 1) {
      oR[oOff] = inR[inOff];
      oI[oOff] = inI[inOff];
      return;
    }
    const p = factors[fi];
    const sub = len / p;
    const tw = n / len;
    for (let q = 0; q < p; q++)
      rec(inR, inI, inOff + q * stride, stride * p, sub, oR, oI, oOff + q * sub, fi + 1);
    for (let k = 0; k < sub; k++) {
      for (let q = 0; q < p; q++) {
        tr[q] = oR[oOff + q * sub + k];
        ti[q] = oI[oOff + q * sub + k];
      }
      for (let s = 0; s < p; s++) {
        const kk = k + s * sub;
        let ar = 0;
        let ai = 0;
        for (let q = 0; q < p; q++) {
          const idx = ((q * kk) % len) * tw;
          const c = cos[idx];
          const d = sin[idx];
          ar += tr[q] * c - ti[q] * d;
          ai += tr[q] * d + ti[q] * c;
        }
        oR[oOff + kk] = ar;
        oI[oOff + kk] = ai;
      }
    }
  };
  return (inR, inI, outR, outI) => rec(inR, inI, 0, 1, n, outR, outI, 0, 0);
}

// Slaney mel scale and area-normalized triangles (librosa.filters.mel(htk=False,
// norm='slaney'), as HF WhisperFeatureExtractor). Row-major [nMels][nFft / 2 + 1].
const hzToMel = (f: number): number =>
  f < 1000 ? (3 * f) / 200 : 15 + (Math.log(f / 1000) * 27) / Math.log(6.4);
const melToHz = (m: number): number =>
  m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));

export function melFilters(nMels = N_MELS, nFft = N_FFT, sampleRate = SAMPLE_RATE): Float64Array {
  const nBins = nFft / 2 + 1;
  const mMin = hzToMel(0);
  const mMax = hzToMel(sampleRate / 2);
  const pts = Array.from({ length: nMels + 2 }, (_, i) =>
    melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1)),
  );
  const fb = new Float64Array(nMels * nBins);
  for (let m = 0; m < nMels; m++) {
    const enorm = 2 / (pts[m + 2] - pts[m]);
    for (let k = 0; k < nBins; k++) {
      const f = (k * sampleRate) / nFft;
      const down = (f - pts[m]) / (pts[m + 1] - pts[m]);
      const up = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
      fb[m * nBins + k] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  return fb;
}

let tables: { fft: ReturnType<typeof makeFFT>; fb: Float64Array; hann: Float64Array } | null = null;
function getTables(): NonNullable<typeof tables> {
  tables ??= {
    fft: makeFFT(N_FFT),
    fb: melFilters(),
    hann: Float64Array.from(
      { length: N_FFT },
      (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT),
    ),
  };
  return tables;
}

// [N_MELS * N_FRAMES], row-major by mel bin. Input is 16 kHz mono; anything past 30 s is
// ignored (callers split longer audio first).
export function logMel(samples: Float32Array): Float32Array {
  const { fft, fb, hann } = getTables();
  const len = Math.min(samples.length, N_SAMPLES);
  const x = new Float64Array(N_SAMPLES);
  x.set(samples.subarray(0, len));
  const pad = N_FFT / 2;
  const mel = new Float32Array(N_MELS * N_FRAMES).fill(LOG_FLOOR);
  const fr = new Float64Array(N_FFT);
  const fi = new Float64Array(N_FFT);
  const oR = new Float64Array(N_FFT);
  const oI = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  let max = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP_LENGTH - pad;
    if (start >= len) {
      // The frame lies entirely in the zero padding.
      max = Math.max(max, LOG_FLOOR);
      continue;
    }
    for (let i = 0; i < N_FFT; i++) {
      let idx = start + i;
      if (idx < 0) idx = -idx;
      else if (idx >= N_SAMPLES) idx = 2 * (N_SAMPLES - 1) - idx; // reflect padding
      fr[i] = x[idx] * hann[i];
      fi[i] = 0;
    }
    fft(fr, fi, oR, oI);
    for (let k = 0; k < N_BINS; k++) power[k] = oR[k] * oR[k] + oI[k] * oI[k];
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const row = m * N_BINS;
      for (let k = 0; k < N_BINS; k++) s += fb[row + k] * power[k];
      const v = Math.log10(Math.max(s, 1e-10));
      mel[m * N_FRAMES + t] = v;
      if (v > max) max = v;
    }
  }
  const floor = max - 8;
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], floor) + 4) / 4;
  return mel;
}
