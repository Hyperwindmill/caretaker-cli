// Skill loader: given a list of plugin names active for an agent, read the
// SKILL.md files from each and render them as a passive-context block to
// prepend to the system prompt. Mirrors src/plugins/plugin_loader.ts but
// reads from plugins.json instead of the DB and takes a string[] instead of
// the comma-separated allowedTools surface (the app uses AgentConfig.plugins,
// a dedicated field).

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import fg from "fast-glob";
import { loadPlugins } from "../store/json.js";
import type { PluginRecord, PluginSource } from "../types.js";

const SKILL_FILE_BYTE_CAP = 100_000;

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

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
    // The plugin IS a skill directory; SKILL.md sits directly inside.
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

  // cc-marketplace / cc-plugin: glob every SKILL.md under the plugin root.
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

/**
 * Read SKILL.md files for every active plugin name and return the
 * concatenated content, each plugin wrapped in <skill name="…"> tags.
 * Names that reference unknown plugins or whose SKILL.md is missing are
 * silently skipped. Returns "" when activeNames is empty or no plugin
 * yields any content.
 */
export async function loadPluginSkills(activeNames: string[]): Promise<string> {
  const wanted = activeNames.map((n) => n.trim()).filter(Boolean);
  if (wanted.length === 0) return "";

  let file;
  try {
    file = await loadPlugins();
  } catch (err) {
    console.error("[plugin loader] failed to read plugins.json:", err);
    return "";
  }

  const sourceById = new Map<string, PluginSource>(file.sources.map((s) => [s.id, s] as const));
  const wantedSet = new Set(wanted);
  const matchingPlugins = file.plugins.filter((p) => wantedSet.has(p.name));

  const blocks: string[] = [];
  for (const plugin of matchingPlugins) {
    const src = sourceById.get(plugin.sourceId);
    if (!src) continue;
    const content = await readSkillContent(rootForSource(src), plugin);
    if (content === null) continue;
    blocks.push(`<skill name="${escapeXmlAttr(plugin.name)}">\n${content}\n</skill>`);
  }

  if (blocks.length === 0) return "";

  const header =
    "The following skills are injected as passive context — they are not callable tools. " +
    "Follow their instructions directly without attempting to invoke them as functions.";

  return `${header}\n\n${blocks.join("\n\n")}`;
}
