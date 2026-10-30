// Move or rename a file or directory inside the working directory. Never
// overwrites: an existing destination is refused, so a move cannot silently
// destroy a file. The destination's parent directories are created.

import { lstat, mkdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';

export const moveTool: Tool = {
  name: 'move',
  description:
    'Move or rename a file or directory. Fails if the destination already ' +
    'exists (delete it first if replacing it is intended).',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Existing path within the working directory.' },
      to: { type: 'string', description: 'New path within the working directory.' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { from?: unknown; to?: unknown };
    if (typeof a.from !== 'string' || !a.from.trim()) {
      return { content: 'Error: from must be a non-empty string' };
    }
    if (typeof a.to !== 'string' || !a.to.trim()) {
      return { content: 'Error: to must be a non-empty string' };
    }

    let from: string;
    let to: string;
    try {
      from = assertWithinRoot(ctx.workingDir, a.from);
      to = assertWithinRoot(ctx.workingDir, a.to);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }
    const root = path.resolve(ctx.workingDir);
    if (from === root || to === root) {
      return { content: 'Error: refusing to move the working directory itself' };
    }

    if (!(await lstat(from).catch(() => null))) {
      return { content: `Error: ${a.from} does not exist` };
    }
    // ponytail: check-then-rename race; rename() would overwrite a file
    // created in between. Fine for a soft jail, not a security boundary.
    if (await lstat(to).catch(() => null)) {
      return { content: `Error: ${a.to} already exists; delete it first to replace it` };
    }

    try {
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (ctx.readPaths.delete(from)) ctx.readPaths.add(to);
    return { content: `Moved ${a.from} to ${a.to}` };
  },
};
