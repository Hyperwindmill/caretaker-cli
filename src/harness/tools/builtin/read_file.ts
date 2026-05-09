// Ported from caretaker server's src/mcp/fs.ts (read).
// Sandbox check, line-numbered output, offset/limit pagination, binary
// detection. On success the absolute path is added to ctx.readPaths so
// the write tool's read-before-write guard will permit overwrites.

import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Tool } from "../types.js";
import { assertWithinRoot, OutsideRootError } from "../sandbox.js";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_OUTPUT_BYTES = 256 * 1024;
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

async function streamLines(
  abs: string,
  offset: number,
  limit: number,
): Promise<{ raw: string[]; total: number; cut: boolean; more: boolean }> {
  const stream = createReadStream(abs, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const start = offset - 1;
  const raw: string[] = [];
  let total = 0;
  let bytes = 0;
  let cut = false;
  let more = false;
  try {
    for await (const text of rl) {
      total++;
      if (total <= start) continue;
      if (raw.length >= limit) {
        more = true;
        continue;
      }
      const line =
        text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + "… (line truncated)" : text;
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0);
      if (bytes + size > MAX_OUTPUT_BYTES) {
        cut = true;
        more = true;
        break;
      }
      raw.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { raw, total, cut, more };
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a file from the working directory (cat -n style with line numbers). " +
    "Use offset/limit to paginate large files. Required before overwriting an " +
    "existing file with `write`; `edit` and `multiedit` rely on oldString matching instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within the working directory." },
      offset: { type: "number", description: "1-based line offset (default 1)." },
      limit: { type: "number", description: "Max lines to return (default 2000)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { path?: unknown; offset?: unknown; limit?: unknown };
    if (typeof a.path !== "string" || !a.path.trim()) {
      return { content: "Error: path must be a non-empty string" };
    }

    let abs: string;
    try {
      abs = assertWithinRoot(ctx.workingDir, a.path);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }

    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { content: `Error: file not found: ${a.path}` };
      if (code === "EACCES") return { content: `Error: permission denied: ${a.path}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (st.isDirectory()) return { content: `Error: path is a directory: ${a.path}` };

    const sample = await readSample(abs, st.size);
    if (isBinarySample(sample)) {
      return {
        content: `Error: ${a.path} appears to be binary; only text files are supported`,
      };
    }

    const offset = Math.max(1, typeof a.offset === "number" ? a.offset : 1);
    const limit = typeof a.limit === "number" && a.limit > 0 ? a.limit : DEFAULT_LIMIT;
    const result = await streamLines(abs, offset, limit);
    const lines = result.raw.map((l, i) => `${String(offset + i).padStart(6, " ")}\t${l}`);
    let formatted = lines.join("\n");
    const next = offset + result.raw.length;
    if (result.cut) {
      formatted += `\n\n(Output capped at ${MAX_OUTPUT_BYTES} bytes; use offset=${next} to continue)`;
    } else if (result.more) {
      formatted += `\n\n(Showing lines ${offset}-${next - 1} of ${result.total}; use offset=${next} to continue)`;
    }

    ctx.readPaths.add(abs);
    return { content: formatted };
  },
};
