// Ported from caretaker server's src/mcp/fs.ts (glob).
// Find files matching a glob pattern, scoped to the working directory.
// Returns paths relative to the workingDir (or to a sub-path when supplied),
// capped at 1000 entries.

import fg from "fast-glob";
import type { Tool } from "../types.js";
import { assertWithinRoot, OutsideRootError } from "../sandbox.js";

const MAX_RESULTS = 1000;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. **/*.ts) within the working directory. " +
    "Returns up to 1000 paths relative to the search root.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
      path: {
        type: "string",
        description: "Optional sub-path under the working directory to scope the search.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { pattern?: unknown; path?: unknown };
    if (typeof a.pattern !== "string" || !a.pattern.trim()) {
      return { content: "Error: pattern must be a non-empty string" };
    }

    let root: string;
    try {
      root =
        typeof a.path === "string" && a.path.trim()
          ? assertWithinRoot(ctx.workingDir, a.path)
          : ctx.workingDir;
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }

    let found: string[];
    try {
      found = await fg(a.pattern, { cwd: root, onlyFiles: true, dot: false });
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const capped = found.slice(0, MAX_RESULTS);
    const tail = found.length > MAX_RESULTS ? `\n[truncated to ${MAX_RESULTS} of ${found.length}]` : "";
    return { content: capped.join("\n") + tail };
  },
};
