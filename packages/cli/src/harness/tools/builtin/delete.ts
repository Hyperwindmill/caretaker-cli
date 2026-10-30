// Delete a file or an empty directory. Deliberately not recursive: a
// directory is emptied file by file, so one mistaken call cannot wipe a tree.
// Symlinks are removed themselves (lstat), never their targets.

import { lstat, rmdir, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';

export const deleteTool: Tool = {
  name: 'delete',
  description:
    'Delete a file or an empty directory. Not recursive: delete the files ' +
    'inside a directory first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path within the working directory.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { path?: unknown };
    if (typeof a.path !== 'string' || !a.path.trim()) {
      return { content: 'Error: path must be a non-empty string' };
    }

    let abs: string;
    try {
      abs = assertWithinRoot(ctx.workingDir, a.path);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }
    if (abs === path.resolve(ctx.workingDir)) {
      return { content: 'Error: refusing to delete the working directory itself' };
    }

    const st = await lstat(abs).catch(() => null);
    if (!st) return { content: `Error: ${a.path} does not exist` };

    try {
      if (st.isDirectory()) {
        await rmdir(abs);
        return { content: `Deleted empty directory ${a.path}` };
      }
      await unlink(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        return { content: `Error: directory ${a.path} is not empty; delete its contents first` };
      }
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    ctx.readPaths.delete(abs);
    return { content: `Deleted file ${a.path}` };
  },
};
