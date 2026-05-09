// Ported from caretaker server's src/mcp/fs.ts (multiedit).
// Apply a sequence of edits atomically — all-or-nothing. Each edit reuses
// the same applyEdit helper as the single-edit tool.

// Note: multiedit does NOT consult ctx.readPaths. The oldString match is an
// implicit "you've seen this content" check — if the model invents
// content, the EOLDSTRING_NOT_FOUND error surfaces immediately. This
// matches caretaker server's behavior; only `write` enforces the explicit
// read-before-write guard.

import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../types.js";
import { assertWithinRoot, OutsideRootError } from "../sandbox.js";
import { applyEdit } from "./edit.js";

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

function isEditSpec(x: unknown): x is EditSpec {
  if (!x || typeof x !== "object") return false;
  const o = x as { oldString?: unknown; newString?: unknown; replaceAll?: unknown };
  return (
    typeof o.oldString === "string" &&
    typeof o.newString === "string" &&
    (o.replaceAll === undefined || typeof o.replaceAll === "boolean")
  );
}

export const multieditTool: Tool = {
  name: "multiedit",
  description:
    "Apply a sequence of edits to a file atomically (all or nothing). " +
    "Each edit follows the same rules as the edit tool — first occurrence by default, " +
    "or all occurrences with replaceAll=true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within the working directory." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldString: { type: "string" },
            newString: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["oldString", "newString"],
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { path?: unknown; edits?: unknown };
    if (typeof a.path !== "string" || !a.path.trim()) {
      return { content: "Error: path must be a non-empty string" };
    }
    if (!Array.isArray(a.edits) || a.edits.length === 0 || !a.edits.every(isEditSpec)) {
      return { content: "Error: edits must be a non-empty array of {oldString,newString,replaceAll?}" };
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
      content = await readFile(abs, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { content: `Error: file not found: ${a.path}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      for (const e of a.edits) {
        content = applyEdit(content, e.oldString, e.newString, e.replaceAll === true);
      }
    } catch (err) {
      // Atomic: any failure aborts the whole operation, no partial write.
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    await writeFile(abs, content, "utf-8");
    ctx.readPaths.add(abs);
    return { content: `Applied ${a.edits.length} edits to ${a.path}` };
  },
};
