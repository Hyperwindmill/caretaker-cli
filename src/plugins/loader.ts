// Skill loader: exposes active plugin skills as on-demand callable surface
// rather than injected system-prompt context. Two helpers:
//   - listActiveSkills(activeNames) → catalog metadata for the model
//   - readActiveSkill(name, activeNames) → SKILL.md content for one plugin
// The harness wires these to the `list_skills` / `read_skill` builtin tools.
//
// Granularity is per-plugin (matches the previous injection semantics). A
// `cc-plugin` source that bundles N SKILL.md files surfaces as one entry
// whose content is the concatenation. Per-file granularity is a follow-up
// (manifest enrichment direction).

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import fg from "fast-glob";
import { loadPlugins } from "../store/json.js";
import type { PluginRecord, PluginSource } from "../types.js";

const SKILL_FILE_BYTE_CAP = 100_000;

export interface SkillSummary {
  name: string;
  description: string;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pluginCacheRoot(): string {
  return (
    process.env.PLUGIN_CACHE_DIR ?? path.join(os.homedir(), ".caretaker", "plugin-cache")
  );
}

function rootForSource(src: PluginSource): string {
  return src.kind === "git" ? path.join(pluginCacheRoot(), src.id) : src.url;
}

/**
 * Resolve the absolute filesystem path of a plugin by id, or null when the
 * plugin (or its source) is not registered. Used by the MCP layer to expand
 * `${CLAUDE_PLUGIN_ROOT}` placeholders at connect time.
 */
export async function pluginAbsoluteRoot(pluginId: string): Promise<string | null> {
  let file;
  try {
    file = await loadPlugins();
  } catch {
    return null;
  }
  const plugin = file.plugins.find((p) => p.id === pluginId);
  if (!plugin) return null;
  const source = file.sources.find((s) => s.id === plugin.sourceId);
  if (!source) return null;
  return path.join(rootForSource(source), plugin.relPath);
}

async function readSkillContent(
  sourceRoot: string,
  plugin: PluginRecord,
): Promise<string | null> {
  if (!isInside(sourceRoot, plugin.relPath)) {
    console.warn(`[plugin loader] rejecting out-of-root relPath for ${plugin.name}`);
    return null;
  }
  const pluginRoot = path.join(sourceRoot, plugin.relPath);

  if (plugin.manifestKind === "skill-glob") {
    const skillFile = path.join(pluginRoot, "SKILL.md");
    try {
      const { size } = await stat(skillFile);
      if (size > SKILL_FILE_BYTE_CAP) {
        console.warn(`[plugin loader] skipping ${plugin.name}: SKILL.md > ${SKILL_FILE_BYTE_CAP} bytes`);
        return null;
      }
      return await readFile(skillFile, "utf-8");
    } catch {
      return null;
    }
  }

  let matches: string[];
  try {
    matches = await fg("**/SKILL.md", {
      cwd: pluginRoot,
      ignore: ["node_modules/**", ".git/**"],
      onlyFiles: true,
      dot: false,
    });
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const rel of matches) {
    if (!isInside(pluginRoot, rel)) continue;
    const skillFile = path.join(pluginRoot, rel);
    try {
      const { size } = await stat(skillFile);
      if (size > SKILL_FILE_BYTE_CAP) {
        console.warn(`[plugin loader] skipping ${plugin.name}/${rel}: > ${SKILL_FILE_BYTE_CAP} bytes`);
        continue;
      }
      parts.push(await readFile(skillFile, "utf-8"));
    } catch {
      /* skip silently */
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}

async function activePluginRecords(activeNames: string[]): Promise<
  Array<{ plugin: PluginRecord; source: PluginSource }>
> {
  const wanted = activeNames.map((n) => n.trim()).filter(Boolean);
  if (wanted.length === 0) return [];

  let file;
  try {
    file = await loadPlugins();
  } catch (err) {
    console.error("[plugin loader] failed to read plugins.json:", err);
    return [];
  }

  const sourceById = new Map<string, PluginSource>(file.sources.map((s) => [s.id, s] as const));
  const wantedSet = new Set(wanted);
  const out: Array<{ plugin: PluginRecord; source: PluginSource }> = [];
  for (const plugin of file.plugins) {
    if (!wantedSet.has(plugin.name)) continue;
    const source = sourceById.get(plugin.sourceId);
    if (!source) continue;
    out.push({ plugin, source });
  }
  return out;
}

/**
 * Catalog of skills available to the agent. Returns one entry per active
 * plugin whose record exists in plugins.json. Description defaults to an
 * empty string when the manifest does not provide one — the model uses the
 * name to decide whether to drill in via read_skill.
 */
export async function listActiveSkills(activeNames: string[]): Promise<SkillSummary[]> {
  const records = await activePluginRecords(activeNames);
  return records.map(({ plugin }) => ({
    name: plugin.name,
    description: plugin.description ?? "",
  }));
}

/**
 * Returns the SKILL.md content for one active plugin by name, or null if
 * the plugin is not active, not installed, has no readable SKILL.md, or
 * exceeds the size cap. A `cc-plugin`/`cc-marketplace` plugin with multiple
 * SKILL.md files returns the concatenation, joined with `\n\n---\n\n`.
 */
export async function readActiveSkill(
  name: string,
  activeNames: string[],
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!activeNames.map((n) => n.trim()).includes(trimmed)) return null;

  const records = await activePluginRecords(activeNames);
  const match = records.find(({ plugin }) => plugin.name === trimmed);
  if (!match) return null;
  return readSkillContent(rootForSource(match.source), match.plugin);
}
