import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { FetchResult } from '../types.js';

export function validatePathInput(input: string): void {
  if (!path.isAbsolute(input)) {
    throw new Error(`PATH source must be absolute, got: ${input}`);
  }
}

export async function fetchPath(absolutePath: string): Promise<FetchResult> {
  validatePathInput(absolutePath);
  let st;
  try {
    st = await stat(absolutePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PATH source not found: ${absolutePath} (${msg})`);
  }
  if (!st.isDirectory()) {
    throw new Error(`PATH source is not a directory: ${absolutePath}`);
  }
  return { root: absolutePath, sha: null };
}
