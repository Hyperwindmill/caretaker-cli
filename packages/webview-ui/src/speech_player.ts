import { choosePath, nextStart, parsePcmType, pcm16Chunk } from './voice_stream.js';

const LEAD_SECONDS = 0.05;

/** Play a `/api/voice/speak` response as it arrives. Resolves after the last
 *  sample has played; rejects on a decode/playback error; on abort stops the
 *  audio immediately and resolves. A fully buffered body is just one big chunk. */
export async function playSpeech(res: Response, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const contentType = res.headers.get('content-type');
  const path = choosePath(contentType, (t) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t));
  if (path === 'pcm' && res.body) return playPcm(res, signal, parsePcmType(contentType)!);
  if (path === 'mse' && res.body) return playMse(res, signal);
  return playBuffered(res, signal);
}

async function playPcm(
  res: Response,
  signal: AbortSignal,
  fmt: { rate: number; channels: number },
): Promise<void> {
  const ctx = new AudioContext();
  const reader = res.body!.getReader();
  const sources: AudioBufferSourceNode[] = [];
  const onAbort = () => {
    void reader.cancel().catch(() => {});
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await ctx.resume();
    let carry: Uint8Array | null = null;
    let rest = new Float32Array(0); // samples short of a whole frame (multi-channel only)
    let cursor = 0;
    let last: AudioBufferSourceNode | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) break;
      const out = pcm16Chunk(value, carry);
      carry = out.carry;
      let samples = out.samples;
      if (rest.length) {
        const joined = new Float32Array(rest.length + samples.length);
        joined.set(rest, 0);
        joined.set(samples, rest.length);
        samples = joined;
      }
      const frames = Math.floor(samples.length / fmt.channels);
      rest = samples.slice(frames * fmt.channels);
      if (frames === 0) continue;
      const buf = ctx.createBuffer(fmt.channels, frames, fmt.rate);
      for (let c = 0; c < fmt.channels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) ch[i] = samples[i * fmt.channels + c];
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = nextStart(ctx.currentTime, cursor, LEAD_SECONDS);
      src.start(at);
      cursor = at + buf.duration;
      sources.push(src);
      last = src;
    }
    if (!last) return;
    await new Promise<void>((resolve) => {
      last!.onended = () => resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    void ctx.close().catch(() => {});
  }
}

async function playMse(res: Response, signal: AbortSignal): Promise<void> {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const audio = new Audio(url);
  const reader = res.body!.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
    audio.pause();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
    const sb = ms.addSourceBuffer('audio/mpeg');
    const append = (data: Uint8Array<ArrayBuffer>) =>
      new Promise<void>((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
        sb.addEventListener('error', () => reject(new Error('Could not decode the synthesized reply.')), { once: true });
        sb.appendBuffer(data);
      });
    let started = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) break;
      await append(value as Uint8Array<ArrayBuffer>);
      if (signal.aborted) return;
      if (!started) {
        started = true;
        await audio.play();
      }
    }
    if (!started) return;
    const ended = new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Could not play the synthesized reply.'));
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (ms.readyState === 'open') ms.endOfStream();
    await ended;
  } finally {
    signal.removeEventListener('abort', onAbort);
    audio.pause();
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

async function playBuffered(res: Response, signal: AbortSignal): Promise<void> {
  const blob = await res.blob();
  if (signal.aborted) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const onAbort = () => audio.pause();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const ended = new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Could not play the synthesized reply.'));
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await audio.play();
    await ended;
  } finally {
    signal.removeEventListener('abort', onAbort);
    audio.pause();
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}
