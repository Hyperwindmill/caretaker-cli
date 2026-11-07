// Pinned catalog for the built-in Whisper transcription engine: ONNX exports on Hugging Face.
//
// Weights: OpenAI Whisper, MIT licence. ONNX export: onnx-community (transformers.js
// layout). Each size is pinned to one commit, with sha256 and size per file; the two
// graphs are the quantized encoder and the q4 merged decoder (the int8 decoder was
// measured 2.5x slower per token on a CPU without VNNI). `name` keeps the repo path;
// the installer decides how to lay the files out on disk.

export type WhisperSize = 'tiny' | 'base' | 'small';

// Files live at <base>/onnx-community/whisper-<size>/resolve/<revision>/<name>.
export const WHISPER_BASE_URL = 'https://huggingface.co';

export type WhisperFile = { name: string; sha256: string; bytes: number };

export const WHISPER_MODELS: Readonly<
  Record<WhisperSize, { repo: string; revision: string; files: readonly WhisperFile[] }>
> = {
  tiny: {
    repo: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
    files: [
      { name: 'onnx/encoder_model_quantized.onnx', sha256: '2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19', bytes: 10124990 },
      { name: 'onnx/decoder_model_merged_q4.onnx', sha256: 'a7573efde84f7d018d59e50e7f860c03e26623d68e23eb6037b76135367e72eb', bytes: 86713702 },
      { name: 'vocab.json', sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a', bytes: 1036584 },
      { name: 'added_tokens.json', sha256: '9715fd2243b6f06a5858b5e32950d2853f73dd5bc201aafcf76f5082a2d8acd1', bytes: 34604 },
      { name: 'generation_config.json', sha256: 'f5c67e5a4f7102f8cb4d058bc95da276bbc19eeec997267c3bb0f25ef68facd1', bytes: 3772 },
      { name: 'preprocessor_config.json', sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d', bytes: 339 },
      { name: 'config.json', sha256: '46aeea0a406afbeb563fc8e59ca10609203df4299af6a83f73752fef369efd2d', bytes: 2243 },
    ],
  },
  base: {
    repo: 'onnx-community/whisper-base',
    revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
    files: [
      { name: 'onnx/encoder_model_quantized.onnx', sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46', bytes: 23201314 },
      { name: 'onnx/decoder_model_merged_q4.onnx', sha256: '09f83b71ceedc97dab1d90b914715dc532a646a147abda11d83c64867b7c319c', bytes: 123602419 },
      { name: 'vocab.json', sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a', bytes: 1036584 },
      { name: 'added_tokens.json', sha256: '9715fd2243b6f06a5858b5e32950d2853f73dd5bc201aafcf76f5082a2d8acd1', bytes: 34604 },
      { name: 'generation_config.json', sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0', bytes: 3832 },
      { name: 'preprocessor_config.json', sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d', bytes: 339 },
      { name: 'config.json', sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b', bytes: 2243 },
    ],
  },
  small: {
    repo: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    files: [
      { name: 'onnx/encoder_model_quantized.onnx', sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92', bytes: 92326160 },
      { name: 'onnx/decoder_model_merged_q4.onnx', sha256: '795c61b344576719c2b249cc9911c78b4cc552c8c6a5407be21a3380a0791b13', bytes: 233149327 },
      { name: 'vocab.json', sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a', bytes: 1036584 },
      { name: 'added_tokens.json', sha256: '9715fd2243b6f06a5858b5e32950d2853f73dd5bc201aafcf76f5082a2d8acd1', bytes: 34604 },
      { name: 'generation_config.json', sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0', bytes: 3893 },
      { name: 'preprocessor_config.json', sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d', bytes: 339 },
      { name: 'config.json', sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18', bytes: 2227 },
    ],
  },
};

export const DEFAULT_WHISPER_SIZE: WhisperSize = 'base';

// Whisper's feature extractor and encoder are fixed at 16 kHz mono.
export const WHISPER_SAMPLE_RATE = 16000;
