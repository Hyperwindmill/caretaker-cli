// Two parallel bundles:
//   - dist/extension.js (Node CJS, vscode external)
//   - dist/webview.js   (browser IIFE, React + CSS inlined)
//
// caretaker-cli is inlined in the extension bundle so vsce doesn't
// have to walk pnpm's symlinked node_modules at package time. React
// and the rest of the webview tree are inlined too because the
// webview is a hermetic browser context.

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionOpts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewOpts = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/webview.js',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctxs = await Promise.all([context(extensionOpts), context(webviewOpts)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[caretaker] esbuild watching…');
} else {
  await Promise.all([build(extensionOpts), build(webviewOpts)]);
}
