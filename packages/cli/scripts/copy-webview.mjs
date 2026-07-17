// Copy the webview-ui build output into the CLI's dist so the published npm
// package can serve `caretaker-cli web` standalone (no monorepo sibling to reach).
// Skips with a warning when the source is absent (e.g. building the CLI alone in
// dev before `pnpm -F webview-ui build`); server.ts falls back to the dev path.
import { existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../webview-ui/dist');
const dest = path.resolve(here, '../dist/webview');

if (!existsSync(src)) {
  console.warn(`[copy-webview] ${src} not found — skipping (run "pnpm -F webview-ui build" first for a shippable build).`);
  process.exit(0);
}

cpSync(src, dest, { recursive: true });
console.log(`[copy-webview] copied ${src} -> ${dest}`);
