import { build, context } from 'esbuild';
import fs from 'fs';

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

copyHtml();

if (watch) {
  const ctx = await context(standaloneOpts);
  await ctx.watch();
  console.log('[webview-ui] esbuild watching…');
} else {
  await build(standaloneOpts);
  console.log('[webview-ui] esbuild completed.');
}
