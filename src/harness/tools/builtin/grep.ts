// Ported from caretaker server's src/mcp/fs.ts (grep).
// Find lines matching a regex across files. Skips binary files cheaply via
// a leading sample. Output format: "path:line:text", capped at 200 hits.

import fg from "fast-glob";
import * as path from "node:path";
import { open, readFile, stat } from "node:fs/promises";
import type { Tool } from "../types.js";
import { assertWithinRoot, OutsideRootError } from "../sandbox.js";

const MAX_HITS = 200;
const SAMPLE_BYTES = 4096;

function isBinarySample(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++;
  }
  return nonPrintable / buf.length > 0.3;
}

async function readSample(abs: string, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0);
  const fh = await open(abs, "r");
  try {
    const len = Math.min(size, SAMPLE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Find lines matching a regex across files (relative to the working directory). " +
    "Returns up to 200 hits as path:line:text. Filter by glob or file-extension type.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression." },
      path: { type: "string", description: "Optional sub-path under workingDir." },
      glob: { type: "string", description: "Optional glob filter, e.g. **/*.ts" },
      type: { type: "string", description: "Optional file-extension filter, e.g. ts (shorthand for **/*.ts)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { pattern?: unknown; path?: unknown; glob?: unknown; type?: unknown };
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

    const globPat =
      typeof a.glob === "string" && a.glob.trim()
        ? a.glob
        : typeof a.type === "string" && a.type.trim()
          ? `**/*.${a.type}`
          : "**/*";

    let re: RegExp;
    try {
      re = new RegExp(a.pattern);
    } catch (err) {
      return { content: `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}` };
    }

    const files = await fg(globPat, { cwd: root, onlyFiles: true, dot: false });
    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= MAX_HITS) break;
      if (ctx.signal.aborted) break;
      const abs = path.join(root, rel);
      let st: { size: number };
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      let sample: Buffer;
      try {
        sample = await readSample(abs, st.size);
      } catch {
        continue;
      }
      if (isBinarySample(sample)) continue;
      let content: string;
      try {
        content = await readFile(abs, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
        if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}:${lines[i]}`);
      }
    }
    const tail = hits.length === MAX_HITS ? `\n[truncated at ${MAX_HITS} matches]` : "";
    return { content: hits.join("\n") + tail };
  },
};
