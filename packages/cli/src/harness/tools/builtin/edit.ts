// Ported from caretaker server's src/mcp/fs.ts (edit + applyEdit).
// Single-occurrence string replace with optional replaceAll. Errors out if
// the substring is missing, or non-unique without replaceAll.

// Note: edit does NOT consult ctx.readPaths. The oldString match is an
// implicit "you've seen this content" check — if the model invents
// content, the EOLDSTRING_NOT_FOUND error surfaces immediately. This
// matches caretaker server's behavior; only `write` enforces the explicit
// read-before-write guard.

import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';

/** Pure: apply one replacement and return the new content. Throws on
 *  missing/non-unique. Exported for testing and reuse by multiedit. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === newString) return content;
  if (replaceAll) {
    if (!content.includes(oldString)) {
      throw new Error(`EOLDSTRING_NOT_FOUND: oldString not found: ${JSON.stringify(oldString)}`);
    }
    return content.split(oldString).join(newString);
  }
  const first = content.indexOf(oldString);
  if (first < 0) {
    throw new Error(`EOLDSTRING_NOT_FOUND: oldString not found: ${JSON.stringify(oldString)}`);
  }
  if (content.indexOf(oldString, first + oldString.length) >= 0) {
    throw new Error(
      `EOLDSTRING_NOT_UNIQUE: ${JSON.stringify(oldString)}; pass replaceAll=true to replace every occurrence`,
    );
  }
  return content.slice(0, first) + newString + content.slice(first + oldString.length);
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace exactly one occurrence of oldString with newString in a file. ' +
    'Set replaceAll=true to replace every occurrence.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path within the working directory.' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as {
      path?: unknown;
      oldString?: unknown;
      newString?: unknown;
      replaceAll?: unknown;
    };
    if (typeof a.path !== 'string' || !a.path.trim()) {
      return { content: 'Error: path must be a non-empty string' };
    }
    if (typeof a.oldString !== 'string' || typeof a.newString !== 'string') {
      return { content: 'Error: oldString and newString must be strings' };
    }

    let abs: string;
    try {
      abs = assertWithinRoot(ctx.workingDir, a.path);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }

    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { content: `Error: file not found: ${a.path}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    let next: string;
    try {
      next = applyEdit(content, a.oldString, a.newString, a.replaceAll === true);
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    await writeFile(abs, next, 'utf-8');
    ctx.readPaths.add(abs);
    return { content: `Applied edit to ${a.path}` };
  },
};
