// Skill resolution at chat time. Skills live on PluginRecord.skills (one
// entry per `**/SKILL.md` file inside the plugin), gated per-agent by
// AgentConfig.plugins. Mirrors the commands/loader pattern: PluginRecord
// is the source of truth, no separate store.
//
// Granularity is **per file** since 2c47a72: a cc-plugin pack like
// `superpowers` exposes each `skills/<name>/SKILL.md` as its own entry,
// not a concatenated blob. The model's `list_skills` shows individual
// skill names; `read_skill` reads exactly one file.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadPlugins } from '../store/json.js';
import type { PluginRecord, PluginSource, SkillSpec } from '../types.js';

const SKILL_FILE_BYTE_CAP = 100_000;

export interface SkillSummary {
  name: string;
  description: string;
  /** Plugin that contributes the skill — surfaced so the model (and the
   *  user, in error messages) can see where a skill comes from. */
  plugin: string;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pluginCacheRoot(): string {
  return process.env.PLUGIN_CACHE_DIR ?? path.join(os.homedir(), '.caretaker', 'plugin-cache');
}

function rootForSource(src: PluginSource): string {
  return src.kind === 'git' ? path.join(pluginCacheRoot(), src.id) : src.url;
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

async function activePluginRecords(
  activeNames: string[],
): Promise<Array<{ plugin: PluginRecord; source: PluginSource }>> {
  const wanted = activeNames.map((n) => n.trim()).filter(Boolean);
  if (wanted.length === 0) return [];

  let file;
  try {
    file = await loadPlugins();
  } catch (err) {
    console.error('[plugin loader] failed to read plugins.json:', err);
    return [];
  }

  // Preserve `agent.plugins` ordering so the first-wins rule on collision
  // is deterministic and user-controlled (mirrors commands/loader).
  const sourceById = new Map<string, PluginSource>(file.sources.map((s) => [s.id, s] as const));
  const byName = new Map<string, PluginRecord>();
  for (const p of file.plugins) byName.set(p.name, p);
  const out: Array<{ plugin: PluginRecord; source: PluginSource }> = [];
  for (const name of wanted) {
    const plugin = byName.get(name);
    if (!plugin) continue;
    const source = sourceById.get(plugin.sourceId);
    if (!source) continue;
    out.push({ plugin, source });
  }
  return out;
}

/**
 * Catalog of skills available to the agent. One entry per SkillSpec across
 * all active plugins. Order: agent.plugins ordering, then per-plugin
 * declaration order. On collision (two active plugins both declaring a
 * skill named e.g. `brainstorming`), the first plugin in `agent.plugins`
 * wins; the rest are dropped silently.
 */
export async function listActiveSkills(activeNames: string[]): Promise<SkillSummary[]> {
  const records = await activePluginRecords(activeNames);
  const seen = new Set<string>();
  const out: SkillSummary[] = [];
  for (const { plugin } of records) {
    if (!plugin.skills) continue;
    for (const [scopedName, spec] of Object.entries(plugin.skills)) {
      if (seen.has(scopedName)) continue;
      seen.add(scopedName);
      out.push({
        name: scopedName,
        description: spec.description ?? '',
        plugin: plugin.name,
      });
    }
  }
  return out;
}

/**
 * Read the SKILL.md content of one active skill by scoped name. Returns
 * null when the skill is unknown to the agent (no such name in any active
 * plugin), the file is missing, or the file exceeds the size cap.
 *
 * Sandbox: we resolve `<sourceRoot>/<plugin.relPath>/<spec.relPath>` and
 * reject any path that escapes the source root.
 */
export async function readActiveSkill(name: string, activeNames: string[]): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const records = await activePluginRecords(activeNames);
  for (const { plugin, source } of records) {
    const spec = plugin.skills?.[trimmed];
    if (!spec) continue;
    const sourceRoot = rootForSource(source);
    if (!isInside(sourceRoot, plugin.relPath)) {
      console.warn(`[plugin loader] rejecting out-of-root relPath for ${plugin.name}`);
      return null;
    }
    const pluginRoot = path.join(sourceRoot, plugin.relPath);
    if (!isInside(pluginRoot, spec.relPath)) {
      console.warn(
        `[plugin loader] rejecting out-of-root skill relPath for ${plugin.name}/${trimmed}`,
      );
      return null;
    }
    const skillFile = path.join(pluginRoot, spec.relPath);
    try {
      const { size } = await stat(skillFile);
      if (size > SKILL_FILE_BYTE_CAP) {
        console.warn(
          `[plugin loader] skipping ${plugin.name}/${trimmed}: SKILL.md > ${SKILL_FILE_BYTE_CAP} bytes`,
        );
        return null;
      }
      return await readFile(skillFile, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}
