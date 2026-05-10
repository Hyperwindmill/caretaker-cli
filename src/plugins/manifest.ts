// Plugin discovery: given a fetched source root, identify the plugins it
// contains. Three manifest kinds, tried in order:
//   1. cc-marketplace — `.claude-plugin/marketplace.json` lists multiple
//      plugins by name + relative source path
//   2. cc-plugin      — `.claude-plugin/plugin.json` defines a single plugin
//      whose root is the entire source
//   3. skill-glob     — fallback: every `**/SKILL.md` is its own plugin,
//      named from frontmatter or its containing directory
//
// Returns the first kind that matches; throws NoPluginsFoundError if none
// of the three turn up anything. Ports server src/plugins/manifest.ts
// behavior 1-for-1 so a source authored for caretaker server discovers
// identically here.

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import { NoPluginsFoundError, type DiscoveredPlugin } from "./types.js";
import type { McpServerSpec } from "../types.js";

const MCP_FILE_REL = ".mcp.json";

const MARKETPLACE_REL = ".claude-plugin/marketplace.json";
const PLUGIN_REL = ".claude-plugin/plugin.json";

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Parse a `mcpServers` record into validated specs. The input is the value
 * side of a `.mcp.json` map (or its `mcpServers` wrapper). Entries missing
 * both `command` (stdio) and `url` (http) are silently dropped so a
 * malformed manifest can't poison sync. The optional `type` field is a hint
 * the spec emits but we don't rely on it — `command` vs `url` discriminates
 * unambiguously.
 */
function parseMcpServersMap(raw: unknown): Record<string, McpServerSpec> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, McpServerSpec> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.command === "string" && v.command.trim() !== "") {
      out[name] = {
        command: v.command,
        args: Array.isArray(v.args) ? (v.args as string[]) : undefined,
        env:
          v.env && typeof v.env === "object"
            ? (v.env as Record<string, string>)
            : undefined,
      };
    } else if (typeof v.url === "string" && v.url.trim() !== "") {
      out[name] = {
        url: v.url,
        headers:
          v.headers && typeof v.headers === "object"
            ? (v.headers as Record<string, string>)
            : undefined,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read `<pluginRoot>/.mcp.json` and return the declared MCP server specs.
 * Two shapes are observed in the wild and both are accepted:
 *   - `{ "mcpServers": { name: { … } } }`  (lh-youtrack, official spec)
 *   - `{ name: { … } }`                     (claude-plugins-official examples)
 *
 * Returns `undefined` when the file is absent, malformed, or contains zero
 * usable entries — the caller treats that as "this plugin declares no MCP
 * servers" and the row stays clean. Path traversal is guarded by the
 * caller; we only read the resolved absolute path.
 */
export async function discoverPluginMcpServers(
  pluginRoot: string,
): Promise<Record<string, McpServerSpec> | undefined> {
  const abs = path.join(pluginRoot, MCP_FILE_REL);
  if (!(await fileExists(abs))) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf-8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  // Wrappered form takes precedence when both could match.
  const wrappered = (raw as { mcpServers?: unknown }).mcpServers;
  if (wrappered !== undefined) return parseMcpServersMap(wrappered);
  return parseMcpServersMap(raw);
}

function dedupeByName(plugins: DiscoveredPlugin[]): DiscoveredPlugin[] {
  const seen = new Set<string>();
  const out: DiscoveredPlugin[] = [];
  for (const p of plugins) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

async function readMarketplace(root: string): Promise<DiscoveredPlugin[] | null> {
  const abs = path.join(root, MARKETPLACE_REL);
  if (!(await fileExists(abs))) return null;
  const raw = JSON.parse(await readFile(abs, "utf-8")) as {
    plugins?: Array<{ name?: string; source?: string; description?: string }>;
  };
  const entries = Array.isArray(raw.plugins) ? raw.plugins : [];
  const out: DiscoveredPlugin[] = [];
  for (const e of entries) {
    if (!e.name || !e.source) continue;
    if (!isInside(root, e.source)) continue;
    out.push({
      name: e.name,
      description: e.description ?? null,
      manifestKind: "cc-marketplace",
      relPath: e.source,
      rawManifest: e,
    });
  }
  const deduped = dedupeByName(out);
  return deduped.length === 0 ? null : deduped;
}

async function readSinglePlugin(root: string): Promise<DiscoveredPlugin[] | null> {
  const abs = path.join(root, PLUGIN_REL);
  if (!(await fileExists(abs))) return null;
  const raw = JSON.parse(await readFile(abs, "utf-8")) as {
    name?: string;
    description?: string;
  };
  if (!raw.name) return null;
  return [{
    name: raw.name,
    description: raw.description ?? null,
    manifestKind: "cc-plugin",
    relPath: ".",
    rawManifest: raw,
  }];
}

async function readSkillGlob(root: string): Promise<DiscoveredPlugin[] | null> {
  const matches = await fg("**/SKILL.md", {
    cwd: root,
    ignore: ["node_modules/**", ".git/**"],
    onlyFiles: true,
    dot: false,
  });
  if (matches.length === 0) return null;
  const out: DiscoveredPlugin[] = [];
  for (const rel of matches) {
    const abs = path.join(root, rel);
    let frontmatter: Record<string, unknown> = {};
    try {
      const text = await readFile(abs, "utf-8");
      const m = /^---\n([\s\S]*?)\n---/m.exec(text);
      if (m) frontmatter = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch { /* ignore parse errors, fall through */ }
    const dir = path.dirname(rel);
    const name = (typeof frontmatter.name === "string" && frontmatter.name)
      || path.basename(dir);
    const description = typeof frontmatter.description === "string"
      ? frontmatter.description : null;
    out.push({
      name,
      description,
      manifestKind: "skill-glob",
      relPath: dir,
      rawManifest: { frontmatter, file: rel },
    });
  }
  const deduped = dedupeByName(out);
  return deduped.length === 0 ? null : deduped;
}

export async function discoverPlugins(root: string): Promise<DiscoveredPlugin[]> {
  const fromMarketplace = await readMarketplace(root);
  if (fromMarketplace) return fromMarketplace;
  const fromSingle = await readSinglePlugin(root);
  if (fromSingle) return fromSingle;
  const fromGlob = await readSkillGlob(root);
  if (fromGlob) return fromGlob;
  throw new NoPluginsFoundError();
}
