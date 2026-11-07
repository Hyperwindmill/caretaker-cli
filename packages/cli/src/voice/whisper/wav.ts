/** Parse a RIFF/WAVE file that is exactly what the Whisper engine consumes:
 *  16 kHz, mono, 16-bit integer PCM. Anything else throws a readable Error —
 *  the server has no resampler and must never feed garbage to the model. */
export function parseWav16kMono(buf: Uint8Array): Float32Array {
  if (buf.length < 12) throw new Error('Not a WAV file: too short.');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file: missing RIFF/WAVE header.');

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('Invalid WAV: truncated fmt chunk.');
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('Invalid WAV: data chunk before fmt chunk.');
      if (fmt.format !== 1) throw new Error(`Unsupported WAV: expected integer PCM, got format ${fmt.format}.`);
      if (fmt.bits !== 16) throw new Error(`Unsupported WAV: expected 16-bit samples, got ${fmt.bits}-bit.`);
      if (fmt.channels !== 1) throw new Error(`Unsupported WAV: expected mono, got ${fmt.channels} channels.`);
      if (fmt.rate !== 16000) throw new Error(`Unsupported WAV: expected 16000 Hz, got ${fmt.rate} Hz.`);
      const end = Math.min(body + size, buf.length);
      const n = Math.floor((end - body) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = dv.getInt16(body + i * 2, true) / 32768;
      return out;
    }
    pos = body + size + (size % 2);
  }
  throw new Error(fmt ? 'Invalid WAV: no data chunk.' : 'Invalid WAV: no fmt chunk.');
}
