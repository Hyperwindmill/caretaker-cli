import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';

export const readImageTool: Tool = {
  name: 'read_image',
  description:
    'Read an image file (PNG, JPEG, WEBP, GIF) from the working directory and load it as a tool attachment so the agent can inspect it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path within the working directory.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
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

    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { content: `Error: file not found: ${a.path}` };
      if (code === 'EACCES') return { content: `Error: permission denied: ${a.path}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (st.isDirectory()) {
      return { content: `Error: path is a directory: ${a.path}` };
    }

    const ext = path.extname(abs).toLowerCase();
    let mime = '';
    if (ext === '.png') {
      mime = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mime = 'image/jpeg';
    } else if (ext === '.webp') {
      mime = 'image/webp';
    } else if (ext === '.gif') {
      mime = 'image/gif';
    } else {
      return {
        content: `Error: unsupported image extension '${ext}'. Supported extensions: .png, .jpg, .jpeg, .webp, .gif`,
      };
    }

    try {
      const buffer = await readFile(abs);
      ctx.readPaths.add(abs);
      return {
        content: `Loaded image ${a.path} (${buffer.length} bytes)`,
        attachments: [
          {
            mime,
            data: buffer,
          },
        ],
      };
    } catch (err) {
      return { content: `Error reading image: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
