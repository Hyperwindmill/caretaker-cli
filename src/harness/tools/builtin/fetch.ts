// Ported from caretaker server's src/mcp/web.ts (fetch).
// HTTP GET with format conversion (text/markdown/json/raw). 30s timeout,
// 5 MB body cap. Honors ctx.signal.

import TurndownService from "turndown";
import type { Tool } from "../types.js";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const fetchTool: Tool = {
  name: "fetch",
  description:
    "GET a URL (http/https only). Format options: text (default), markdown (HTML→md), json, raw.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      format: { type: "string", enum: ["text", "markdown", "json", "raw"] },
    },
    required: ["url"],
    additionalProperties: false,
  },
  dangerous: true,
  async execute(args, ctx) {
    const a = args as { url?: unknown; format?: unknown };
    if (typeof a.url !== "string" || !a.url.trim()) {
      return { content: "Error: url must be a non-empty string" };
    }
    let parsed: URL;
    try {
      parsed = new URL(a.url);
    } catch {
      return { content: `Error: invalid URL: ${a.url}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { content: `Error: unsupported scheme: ${parsed.protocol}` };
    }
    const fmt = typeof a.format === "string" ? a.format : "text";
    if (!["text", "markdown", "json", "raw"].includes(fmt)) {
      return { content: `Error: unknown format: ${fmt}` };
    }

    // Tie the per-tool timeout to the caller-provided abort: aborting the
    // run cancels the in-flight fetch.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const onParentAbort = () => ac.abort();
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(a.url, { signal: ac.signal, redirect: "follow" });
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        return { content: `Error: body too large: ${buf.byteLength} bytes (max ${MAX_BYTES})` };
      }
      const text = new TextDecoder("utf-8").decode(buf);
      if (fmt === "raw" || fmt === "text") return { content: text };
      if (fmt === "json") {
        try {
          return { content: JSON.stringify(JSON.parse(text), null, 2) };
        } catch {
          return { content: "Error: body is not valid JSON" };
        }
      }
      // markdown
      const td = new TurndownService();
      return { content: td.turndown(text) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: fetch failed: ${msg}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  },
};
