// Bundles the VSCode extension into a single CJS file under dist/.
// `vscode` is the only external — the host injects it at runtime.
// `caretaker-cli` and the rest of the dep tree are inlined so vsce can
// package without walking pnpm's symlinked node_modules.

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
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

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
