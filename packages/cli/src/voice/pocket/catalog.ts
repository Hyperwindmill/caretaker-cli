// Pinned catalog for the built-in Pocket TTS engine: model bundles (Hugging Face), the
// ONNX runtime (npm registry tarballs) and the choice of who drives the graphs.
//
// INFERENCE_SOURCE = 'own-loop'. The npm `pocket-tts` package (1.0.0, MIT) was read, not
// run, and fails all three conditions. (1) It targets a different export, the community
// `KevinAHM/pocket-tts-onnx` repo (tokenizer.model, bos_before_voice.npy, a mimi encoder),
// not the schema-3 bundles of `Alias-Alias/pocket-3-3-0-tts-onnx` (explicit state_N /
// next_state_N tensors, tokenizer.json, voices.bin). (2) Local mode requires a reference
// WAV and encodes it (cloning); it never reads voices.bin or built-in voices. (3) It loads
// the runtime with a bare `import("onnxruntime-node")` (local/runtime.js) and exposes no
// way to pass a session factory or module, so it could not see our downloaded runtime.
// We therefore drive the four graphs ourselves; see the engine, which sits behind the
// small interface of the spec so the source can still be swapped.

export type PocketLanguage =
  | 'english'
  | 'french'
  | 'german'
  | 'spanish'
  | 'portuguese'
  | 'italian'
  | 'dutch';

export const POCKET_BASE_URL =
  'https://huggingface.co/Alias-Alias/pocket-3-3-0-tts-onnx/resolve';
export const POCKET_REVISION = '71a4d6d11a76e26b98709fa163477c77d16bdbdb';

export type BundleFile = { name: string; sha256: string; bytes: number };

// `dir` is the bundle's subdirectory in the repo (also its language code). `nativeVoice`
// is the voice suggested first in the UI. The bundles ship no per-language native voices:
// every language carries the same eight official voices (each with a language-specific
// state in its own voices.bin), so the default is one shared voice.
export const POCKET_LANGUAGES: Readonly<
  Record<
    PocketLanguage,
    { code: string; dir: string; nativeVoice: string; files: readonly BundleFile[] }
  >
> = {
  english: {
    code: 'en',
    dir: 'en',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: 'ccbb828d6dceee19688ee6eee884bb8de16edcc0f21fac5ed713a8739d978b2e', bytes: 13438 },
      { name: 'tokenizer.json', sha256: 'f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687', bytes: 245020 },
      { name: 'voices.bin', sha256: '720343118b8ec5177397d3898d43b0d13c7948f76794956610e5f0e795100cf1', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: 'a060f0926e87a12309c54a681dde9daba8e32821e1e2348224fd6c30a3a7a28b', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: 'c9328891492caaa7580284d81d47d01679f570f297023d68fc4c7ce503113dc8', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: '7edfcbccb1d40a84b2b59ac1e921963287471ff0cb266603d7fd4282a131d716', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: 'b27d1c38b96947a08bc54a7b660b553866a47b3b368b2170b89b09f5c7f35b56', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  french: {
    code: 'fr',
    dir: 'fr',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '0894c2fc533b0a94d1f120fa9f959f4125ccff2443ac5362925989a5fcdd7fae', bytes: 13638 },
      { name: 'tokenizer.json', sha256: '6211acffe9cb95172f71f0051f18e26ea305b2b32ea00b331ee976551c70887f', bytes: 246403 },
      { name: 'voices.bin', sha256: 'a43532290caa733c6670bc52427f0ed9f709c43867049f3e511f85568fcf9c5c', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: '6127b51df140da0123123aa929a9453fc9a63a7cfebdc33f8a1f3fb46c5f2139', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: '1c6611cc3d524843e990e3abfdc15ce84f16f7a9250b5970b0255df4759fe70b', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: '8c72996bdcae9ea4a981b6afc0a40986523525aaa5491c09ef9546c14becd272', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: 'd7b00abae02b2916f0be6d42bfbe14e87e0b4f1aaa25b1d5778a1f128edb6bb6', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  german: {
    code: 'de',
    dir: 'de',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '7e43fa70568f3a1800a7dfeab6b3f97e2b5f1ff682c11db9cf22103d53f5fea5', bytes: 13623 },
      { name: 'tokenizer.json', sha256: '2d77849811e3d1b6ae80e5b11b203f57e1847901104d8a0573b34f46f8dddb53', bytes: 245966 },
      { name: 'voices.bin', sha256: 'a45485ca28c8f046f6e45089d7b01ea45e9a2d36f1ac4cb0947a956b27f4a70d', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: '0479f6bc635fedf130086c357d013a6a0c54568b301d9b255ffd67d732965378', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: '96cb9a628438ca4b26d7ed3160d79bd8ad2e0f097d08a8faea95e00c944ea84e', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: '6198087a456287420d14b98083cd534bee3e92fa107dca1324f03a27c65c8315', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: '3d0f9574384d73c91404514b933e239333d9580bc42c8fcc161e5402ff67d6b9', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  spanish: {
    code: 'es',
    dir: 'es',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '196151a61b907afb2b0ccb4570a4c39993de69d705b371d38ae459120f6aac23', bytes: 13654 },
      { name: 'tokenizer.json', sha256: '9ade09bbdc64ab2b59952b90773fa0890b780ece4fd5aef0d36a00c6ad5f0531', bytes: 246610 },
      { name: 'voices.bin', sha256: '49a8e4d3562074a1e8d041edb4fad3877b327daf4cd898893ff10273216ae178', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: '8e98c0abd4ba06fde1db0decb75e3b211e6097ba15854fc9266aa1d16feaeae4', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: 'f37c8b4a2409de010f638529daf947b863396a78b8b659a77ed6e35362174629', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: 'b3f028c3cdd909ffa10dffa8055edc9147f273e43bda852733e6a4a36cc3d292', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: 'f2f1b6e380a6388557768534d24036cb8b549b9f4eb49bedbb7ed3c4fb06336a', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  portuguese: {
    code: 'pt',
    dir: 'pt',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '4b23a635bd375e5d476416cc960ad7488aabd4441aea2861eaf54d98734ea34b', bytes: 13624 },
      { name: 'tokenizer.json', sha256: 'b33e269f7f042a763080d71ba087d74d2f6759674b238a723c028e436b1a25ab', bytes: 247014 },
      { name: 'voices.bin', sha256: '402d569dcb5d25c5b93cae6995d6d4d499cf1bfc591ed8edf2ce50547a8b3651', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: '22ee9182a3dadc37ba06cdf3ff9c0e0ac0622f006a2eb29d2f5e0a13ba642d3e', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: '15357eb39cbd574bc4193fef960d6b332a861c84bfcf99e9417316bac129d1d8', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: 'f2e2a3da0fb5c1e6b472f1921459f7e6c051fa54c25e08186b46d559d620b379', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: '6974a4330bbbfe91fcc46084b26e769c8eefd6121bd3ad42e84861f9f05854b2', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  italian: {
    code: 'it',
    dir: 'it',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '5dce446b175a8b9fd8766bde7ce3ee15fb396f2228b77777028c26eb88acfc4f', bytes: 13624 },
      { name: 'tokenizer.json', sha256: '4bc1c0d4d54f9480183e94c94cfabf74fd89b0912537d4ef607d1982c4a381ec', bytes: 246586 },
      { name: 'voices.bin', sha256: 'cf8f292f5d91d887f8370ebbd4329928421a87f564d475f53a7d456bf144acac', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: 'f716f278fa279495889fbe8f4426da68d4ca5112b962121991ec8fed002ff090', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: '80c1ebae13a0033f7746f2b7a886e3d7fa3523c9d7be2122bec9412ad82c46b8', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: 'b4da5f938b81d895eee0a8c6267162c6466382b761114affb96049db9e649431', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: 'c258c72d1b8079eb16a08fc9c6a255e918d897f53f784abcb5eaae2f3a0e9344', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
  dutch: {
    code: 'nl',
    dir: 'nl',
    nativeVoice: 'alba',
    files: [
      { name: 'bundle.json', sha256: '48581badbfe176db6df37ac0f784893fe2c681ae1e845263c4cd36106d8c1705', bytes: 13624 },
      { name: 'tokenizer.json', sha256: 'e6f610b98c427641b4ab0e1024dca7843e3d6b620871a14b204932e42c5a1736', bytes: 245206 },
      { name: 'voices.bin', sha256: '1e7f812d5824a931fef68337291896bd88521c9f031d545877e7f46b144ed38c', bytes: 52404520 },
      { name: 'text_conditioner_int8.onnx', sha256: '3bd2960e2ea136a8f870149f4238789f6dbcc54c1b643a4639b7be028e52fbb2', bytes: 16388338 },
      { name: 'flow_lm_main_int8.onnx', sha256: 'b6ae39189f6881ec0d87fa50ac690db239c6759c110e179714752b8b5d36e75c', bytes: 76397201 },
      { name: 'flow_lm_flow_int8.onnx', sha256: 'd0b3e7da6ef29c0c0a2e6f721b9c3b3835b93c3f3f2854f5882e11222f7450ea', bytes: 10040048 },
      { name: 'mimi_decoder_int8.onnx', sha256: '2cf5feebf7ba7486491c87a49036b0afae3093546aff3f5a46ec5e967b6c3ca5', bytes: 22638621 },
      { name: 'LICENSE-upstream.txt', sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3', bytes: 1023 },
    ],
  },
};

// Built-in voice names stored in every bundle's voices.bin (bundle.json `predefined_voices`).
export const POCKET_VOICES: readonly string[] = [
  'alba',
  'azelma',
  'cosette',
  'eponine',
  'fantine',
  'javert',
  'jean',
  'marius',
];

export const ORT_VERSION = '1.31.1';

// The node package bundles the native binding for every platform (~115 MB compressed);
// `postinstall` only fetches optional CUDA binaries and is never run.
export const ORT_TARBALLS: Readonly<Record<'node' | 'common', { url: string; integrity: string }>> = {
  node: {
    url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',
    integrity:
      'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==',
  },
  common: {
    url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz',
    integrity:
      'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==',
  },
};

export const POCKET_SAMPLE_RATE = 24000;

export type InferenceSource = 'npm-pocket-tts' | 'own-loop';
export const INFERENCE_SOURCE: InferenceSource = 'own-loop';
