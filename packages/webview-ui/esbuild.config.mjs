import { build, context } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

const standaloneOpts = {
  entryPoints: ['src/standalone.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/standalone.js',
  jsx: 'automatic',
  loader: { 
    '.css': 'css', 
    '.png': 'dataurl', 
    '.ttf': 'dataurl', 
    '.woff2': 'dataurl', 
    '.woff': 'dataurl' 
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  sourcemap: true,
  logLevel: 'info',
};

// Also copy index.html to dist/
const copyHtml = () => {
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist');
  }
  fs.copyFileSync('src/index.html', 'dist/index.html');
};

// The VAD library is NOT bundled: webview-ui builds a single iife with no code
// splitting, so a dynamic import would be inlined and grow the bundle for every
// user, voice or not. Instead its assets are served and the script is injected on
// demand (see useVoice.ts). Assets stay local — a CDN would break offline use.
const copyVadAssets = () => {
  const dest = 'dist/vad';
  fs.mkdirSync(dest, { recursive: true });

  const vadPkg = require.resolve('@ricky0123/vad-web/package.json');
  const vadDist = path.join(path.dirname(vadPkg), 'dist');
  const ortDist = path.dirname(require.resolve('onnxruntime-web', { paths: [vadPkg] }));

  const files = [
    [path.join(vadDist, 'bundle.min.js'), 'bundle.min.js'],
    [path.join(vadDist, 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
    [path.join(vadDist, 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
    [path.join(vadDist, 'silero_vad_legacy.onnx'), 'silero_vad_legacy.onnx'],
  ];

  // Exactly one onnxruntime variant, not every ort-wasm* file. vad-web imports
  // `onnxruntime-web/wasm` (no WebGPU) and its shipped bundle references only
  // `ort-wasm-simd-threaded.mjs`, which pulls the matching .wasm. Copying the
  // asyncify/jsep/jspi builds too added ~66 MB of dead weight to the published
  // npm package, since scripts/copy-webview.mjs ships this whole tree.
  for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    files.push([path.join(ortDist, name), name]);
  }

  let copied = 0;
  const missing = [];
  for (const [from, to] of files) {
    if (!fs.existsSync(from)) {
      missing.push(from);
      continue;
    }
    fs.copyFileSync(from, path.join(dest, to));
    copied++;
  }
  // Fail loudly: a missing asset used to produce a green build and a runtime
  // failure, which is the worst of both worlds.
  if (missing.length > 0) {
    throw new Error(
      `[webview-ui] VAD assets missing (the upstream layout changed?):\n  ${missing.join('\n  ')}`,
    );
  }

  const bytes = fs
    .readdirSync(dest)
    .reduce((sum, name) => sum + fs.statSync(path.join(dest, name)).size, 0);
  const mb = bytes / 1024 / 1024;
  // Guard against silently re-inflating the npm tarball. One wasm variant is
  // ~13 MB; anything near 30 means the glob crept back.
  if (mb > 30) {
    throw new Error(
      `[webview-ui] dist/vad is ${mb.toFixed(1)} MB — expected well under 30. ` +
        `Only one onnxruntime wasm variant should be copied.`,
    );
  }
  console.log(`[webview-ui] copied ${copied} VAD assets (${mb.toFixed(1)} MB) -> ${dest}`);
};

copyHtml();
copyVadAssets();

if (watch) {
  const ctx = await context(standaloneOpts);
  await ctx.watch();
  console.log('[webview-ui] esbuild watching…');
} else {
  await build(standaloneOpts);
  console.log('[webview-ui] esbuild completed.');
}
