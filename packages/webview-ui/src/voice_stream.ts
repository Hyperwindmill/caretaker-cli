/** Pure helpers for streamed speech playback. See speech_player.ts. */

export type PlaybackPath = 'pcm' | 'mse' | 'buffered';

/** `audio/pcm;rate=24000;channels=1` -> its parameters; null for any other type. */
export function parsePcmType(contentType: string | null): { rate: number; channels: number } | null {
  if (!contentType) return null;
  const [type, ...params] = contentType.split(';').map((s) => s.trim().toLowerCase());
  if (type !== 'audio/pcm' && type !== 'audio/l16') return null;
  const get = (key: string) => {
    const p = params.find((x) => x.startsWith(`${key}=`));
    return p ? Number(p.slice(key.length + 1)) : NaN;
  };
  const rate = get('rate');
  const channels = get('channels');
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : 24000,
    channels: Number.isFinite(channels) && channels > 0 ? channels : 1,
  };
}

/** Decode int16 little-endian PCM. A network chunk may end mid-sample: the odd
 *  trailing byte is returned as `carry` and must be passed with the next chunk,
 *  otherwise every following sample would be shifted by one byte. */
export function pcm16Chunk(
  bytes: Uint8Array,
  carry: Uint8Array | null,
): { samples: Float32Array; carry: Uint8Array | null } {
  let data = bytes;
  if (carry && carry.length > 0) {
    data = new Uint8Array(carry.length + bytes.length);
    data.set(carry, 0);
    data.set(bytes, carry.length);
  }
  const count = data.length >> 1;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = data[2 * i] | (data[2 * i + 1] << 8);
    samples[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return { samples, carry: data.length & 1 ? data.slice(data.length - 1) : null };
}

/** When to start the next scheduled buffer: never in the past, never before the previous one ends. */
export function nextStart(now: number, cursor: number, leadSeconds: number): number {
  return Math.max(cursor, now + leadSeconds);
}

export function choosePath(contentType: string | null, mseSupports: (t: string) => boolean): PlaybackPath {
  if (parsePcmType(contentType)) return 'pcm';
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'audio/mpeg' && mseSupports('audio/mpeg')) return 'mse';
  return 'buffered';
}
