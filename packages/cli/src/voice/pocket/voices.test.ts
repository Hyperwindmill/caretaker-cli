import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padInto, parseVoices } from './voices.js';

// Writes a voices.bin in the bundle layout.
function build(
  voices: {
    name: string;
    tensors: { key: string; dtype: 0 | 1; dims: number[]; values: number[] }[];
  }[],
) {
  const parts: Buffer[] = [Buffer.from('PTVB1')];
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s: string) => [u16(Buffer.byteLength(s)), Buffer.from(s)];
  parts.push(u32(voices.length));
  for (const v of voices) {
    parts.push(...str(v.name), u16(v.tensors.length));
    for (const t of v.tensors) {
      const data =
        t.dtype === 0
          ? Buffer.from(Float32Array.from(t.values).buffer)
          : Buffer.from(BigInt64Array.from(t.values.map(BigInt)).buffer);
      parts.push(
        ...str(t.key),
        Buffer.from([t.dtype, t.dims.length]),
        ...t.dims.map(u32),
        u32(data.length),
        data,
      );
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

const sample = () =>
  build([
    {
      name: 'alba',
      tensors: [
        {
          key: 'transformer.layers.0.self_attn/cache',
          dtype: 0,
          dims: [2, 1, 2, 1, 2],
          values: [1, 2, 3, 4, 5, 6, 7, 8],
        },
        { key: 'transformer.layers.0.self_attn/offset', dtype: 1, dims: [1], values: [2] },
      ],
    },
    {
      name: 'jean',
      tensors: [{ key: 'transformer.layers.0.self_attn/pad', dtype: 1, dims: [1], values: [0] }],
    },
  ]);

test('parses every voice and tensor, at unaligned offsets', () => {
  const voices = parseVoices(Buffer.from(sample()));
  assert.deepEqual([...voices.keys()], ['alba', 'jean']);
  const cache = voices.get('alba')!.get('transformer.layers.0.self_attn/cache')!;
  assert.equal(cache.dtype, 'float32');
  assert.deepEqual(cache.dims, [2, 1, 2, 1, 2]);
  assert.deepEqual([...cache.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    [...voices.get('alba')!.get('transformer.layers.0.self_attn/offset')!.data],
    [2n],
  );
  assert.deepEqual([...voices.get('jean')!.get('transformer.layers.0.self_attn/pad')!.data], [0n]);
});

test('rejects a bad magic, a truncated file and trailing bytes', () => {
  const ok = sample();
  assert.throws(
    () => parseVoices(Uint8Array.from([...ok].map((b, i) => (i === 0 ? 0 : b)))),
    /magic/,
  );
  assert.throws(() => parseVoices(ok.subarray(0, ok.length - 3)), /truncated/);
  assert.throws(() => parseVoices(Uint8Array.from([...ok, 0])), /trailing/);
});

test('padInto places the voice cache in the leading rows of the larger axis', () => {
  const cache = parseVoices(sample()).get('alba')!.get('transformer.layers.0.self_attn/cache')!;
  // [2,1,2,1,2] into [2,1,3,1,2]: per kv slice, two rows of voice then one zero row.
  assert.deepEqual([...padInto(cache, [2, 1, 3, 1, 2])], [1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0]);
  assert.throws(() => padInto(cache, [2, 1, 1, 1, 2]), /cannot place/);
});
