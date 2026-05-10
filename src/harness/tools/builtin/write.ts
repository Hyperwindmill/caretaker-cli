// Ported from caretaker server's src/mcp/fs.ts (write).
// Read-before-write guard: existing files cannot be overwritten unless they
// were read in this run (ctx.readPaths). New files can always be created.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';

export const writeTool: Tool = {
  name: 'write',
  description:
    'Create a new file or overwrite an existing one. To overwrite, you must ' +
    'have read the file in this run (read_file).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path within the working directory.' },
      content: { type: 'string', description: 'Full file contents (UTF-8).' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { path?: unknown; content?: unknown };
    if (typeof a.path !== 'string' || !a.path.trim()) {
      return { content: 'Error: path must be a non-empty string' };
    }
    if (typeof a.content !== 'string') {
      return { content: 'Error: content must be a string' };
    }

    let abs: string;
    try {
      abs = assertWithinRoot(ctx.workingDir, a.path);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }

    const exists = await stat(abs)
      .then(() => true)
      .catch(() => false);
    if (exists && !ctx.readPaths.has(abs)) {
      return {
        content: `Error: file ${a.path} exists and was not read in this run. Use read_file first.`,
      };
    }
    try {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, a.content, 'utf-8');
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    ctx.readPaths.add(abs);
    return { content: `Wrote ${Buffer.byteLength(a.content, 'utf-8')} bytes to ${a.path}` };
  },
};
