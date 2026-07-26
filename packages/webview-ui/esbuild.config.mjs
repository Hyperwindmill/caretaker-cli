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

  // onnxruntime-web ships its wasm/mjs runtime files; the VAD loads them by name
  // from the same base path.
  if (fs.existsSync(ortDist)) {
    for (const name of fs.readdirSync(ortDist)) {
      if (name.startsWith('ort-wasm') && (name.endsWith('.wasm') || name.endsWith('.mjs'))) {
        files.push([path.join(ortDist, name), name]);
      }
    }
  }

  let copied = 0;
  for (const [from, to] of files) {
    if (!fs.existsSync(from)) {
      console.warn(`[webview-ui] VAD asset missing, skipping: ${from}`);
      continue;
    }
    fs.copyFileSync(from, path.join(dest, to));
    copied++;
  }
  console.log(`[webview-ui] copied ${copied} VAD assets -> ${dest}`);
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
