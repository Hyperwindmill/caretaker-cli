// voices.bin of a Pocket TTS schema-3 bundle ("PTVB1", little endian): per voice, the
// flow LM KV cache after prefilling BOS + the voice conditioning.
//
//   "PTVB1" u32 voiceCount
//   per voice:  u16 nameLen name  u16 tensorCount
//     per tensor: u16 keyLen key("<module>/<key>")  u8 dtype(0 f32, 1 i64)  u8 ndim
//                 u32 dims[ndim]  u32 byteLength  bytes

export type VoiceTensor = {
  dtype: 'float32' | 'int64';
  dims: number[];
  data: Float32Array | BigInt64Array;
};

// voice name -> "<module>/<key>" -> tensor
export type VoiceStates = Map<string, Map<string, VoiceTensor>>;

const MAGIC = 'PTVB1';

export function parseVoices(buf: Uint8Array): VoiceStates {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = new TextDecoder();
  let p = 0;
  const need = (n: number) => {
    if (p + n > buf.byteLength) throw new Error('voices.bin is truncated');
  };
  const u8 = () => (need(1), view.getUint8(p++));
  const u16 = () => (need(2), (p += 2), view.getUint16(p - 2, true));
  const u32 = () => (need(4), (p += 4), view.getUint32(p - 4, true));
  const str = (n: number) => (need(n), (p += n), text.decode(buf.subarray(p - n, p)));

  if (str(5) !== MAGIC) throw new Error('voices.bin: bad magic');
  const voices: VoiceStates = new Map();
  const count = u32();
  for (let v = 0; v < count; v++) {
    const name = str(u16());
    const tensors = new Map<string, VoiceTensor>();
    const tensorCount = u16();
    for (let t = 0; t < tensorCount; t++) {
      const key = str(u16());
      const code = u8();
      const ndim = u8();
      const dims = Array.from({ length: ndim }, u32);
      const byteLength = u32();
      need(byteLength);
      // Copy: the tensor's offset in the file is not aligned for a typed array view (and
      // Buffer#slice would not copy).
      const bytes = new Uint8Array(byteLength);
      bytes.set(buf.subarray(p, p + byteLength));
      p += byteLength;
      const elements = dims.reduce((a, b) => a * b, 1);
      let tensor: VoiceTensor;
      if (code === 0)
        tensor = {
          dtype: 'float32',
          dims,
          data: new Float32Array(bytes.buffer, 0, byteLength / 4),
        };
      else if (code === 1)
        tensor = { dtype: 'int64', dims, data: new BigInt64Array(bytes.buffer, 0, byteLength / 8) };
      else throw new Error(`voices.bin: unknown dtype ${code} for ${name} ${key}`);
      if (tensor.data.length !== elements)
        throw new Error(`voices.bin: ${name} ${key} size does not match its dims`);
      tensors.set(key, tensor);
    }
    voices.set(name, tensors);
  }
  if (p !== buf.byteLength) throw new Error('voices.bin: trailing bytes');
  return voices;
}

// Copy `src` into a zero-filled tensor of shape `dims` that may be larger along one axis
// (the voice KV cache [2,1,K,H,D] into the model's [2,1,1024,H,D]): the leading K rows
// of that axis are the voice, the rest stays zero.
export function padInto(src: VoiceTensor, dims: readonly number[]): Float32Array | BigInt64Array {
  if (src.dims.length !== dims.length) throw new Error(`rank mismatch: [${src.dims}] vs [${dims}]`);
  const axes = dims.map((d, i) => i).filter((i) => dims[i] !== src.dims[i]);
  if (axes.length > 1 || (axes.length === 1 && src.dims[axes[0]] > dims[axes[0]])) {
    throw new Error(`cannot place [${src.dims}] into [${dims}]`);
  }
  const total = dims.reduce((a, b) => a * b, 1);
  const out = src.dtype === 'float32' ? new Float32Array(total) : new BigInt64Array(total);
  if (axes.length === 0) {
    out.set(src.data as never);
    return out;
  }
  const axis = axes[0];
  const outer = dims.slice(0, axis).reduce((a, b) => a * b, 1);
  const inner = dims.slice(axis + 1).reduce((a, b) => a * b, 1);
  const srcBlock = src.dims[axis] * inner;
  const dstBlock = dims[axis] * inner;
  for (let o = 0; o < outer; o++) {
    out.set(src.data.subarray(o * srcBlock, (o + 1) * srcBlock) as never, o * dstBlock);
  }
  return out;
}
