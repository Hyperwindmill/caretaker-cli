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

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { NoPluginsFoundError, type DiscoveredPlugin } from './types.js';
import type {
  AgentSpec,
  CommandSpec,
  McpServerSpec,
  PluginManifestKind,
  SkillSpec,
} from '../types.js';

const MCP_FILE_REL = '.mcp.json';
const AGENTS_DIR_REL = 'agents';
const COMMANDS_DIR_REL = 'commands';

const MARKETPLACE_REL = '.claude-plugin/marketplace.json';
const PLUGIN_REL = '.claude-plugin/plugin.json';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
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
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, McpServerSpec> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (typeof v.command === 'string' && v.command.trim() !== '') {
      out[name] = {
        command: v.command,
        args: Array.isArray(v.args) ? (v.args as string[]) : undefined,
        env: v.env && typeof v.env === 'object' ? (v.env as Record<string, string>) : undefined,
      };
    } else if (typeof v.url === 'string' && v.url.trim() !== '') {
      out[name] = {
        url: v.url,
        headers:
          v.headers && typeof v.headers === 'object'
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
    raw = JSON.parse(await readFile(abs, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;

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
  const raw = JSON.parse(await readFile(abs, 'utf-8')) as {
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
      manifestKind: 'cc-marketplace',
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
  const raw = JSON.parse(await readFile(abs, 'utf-8')) as {
    name?: string;
    description?: string;
  };
  if (!raw.name) return null;
  return [
    {
      name: raw.name,
      description: raw.description ?? null,
      manifestKind: 'cc-plugin',
      relPath: '.',
      rawManifest: raw,
    },
  ];
}

async function readSkillGlob(root: string): Promise<DiscoveredPlugin[] | null> {
  const matches = await fg('**/SKILL.md', {
    cwd: root,
    ignore: ['node_modules/**', '.git/**'],
    onlyFiles: true,
    dot: false,
  });
  if (matches.length === 0) return null;
  const out: DiscoveredPlugin[] = [];
  for (const rel of matches) {
    const abs = path.join(root, rel);
    let frontmatter: Record<string, unknown> = {};
    try {
      const text = await readFile(abs, 'utf-8');
      const m = /^---\n([\s\S]*?)\n---/m.exec(text);
      if (m) frontmatter = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
      /* ignore parse errors, fall through */
    }
    const dir = path.dirname(rel);
    const name = (typeof frontmatter.name === 'string' && frontmatter.name) || path.basename(dir);
    const description =
      typeof frontmatter.description === 'string' ? frontmatter.description : null;
    out.push({
      name,
      description,
      manifestKind: 'skill-glob',
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

/**
 * Read every `<pluginRoot>/agents/*.md` and parse it as a sub-agent spec:
 * YAML frontmatter contributes `name`, `description`, `model`; the body
 * (everything after the closing `---`) becomes the system prompt.
 *
 * The frontmatter `tools:` field is intentionally ignored — its vocabulary
 * is Anthropic's tool surface (Read, Bash, Glob, …) which doesn't map 1:1
 * to ours, and a wrong mapping would silently grant or deny tools. The
 * user wires allowedTools via the agent form after the row is materialized.
 *
 * The map is keyed by the filename basename (without `.md`), which becomes
 * the plugin-scoped name during sync. Files without parseable frontmatter
 * are skipped silently. Returns undefined when the directory is missing or
 * empty so the discovered plugin row stays clean.
 */
export async function discoverPluginAgents(
  pluginRoot: string,
): Promise<Record<string, AgentSpec> | undefined> {
  const agentsDir = path.join(pluginRoot, AGENTS_DIR_REL);
  if (!(await fileExists(agentsDir))) return undefined;

  let matches: string[];
  try {
    matches = await fg('*.md', {
      cwd: agentsDir,
      onlyFiles: true,
      dot: false,
    });
  } catch {
    return undefined;
  }

  const out: Record<string, AgentSpec> = {};
  for (const rel of matches) {
    const abs = path.join(agentsDir, rel);
    let text: string;
    try {
      text = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }

    const fmMatch = /^---\n([\s\S]*?)\n---\s*\n?/m.exec(text);
    let frontmatter: Record<string, unknown> = {};
    let body = text;
    if (fmMatch) {
      try {
        frontmatter = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
      } catch {
        // Malformed YAML — drop the frontmatter, keep the body so the
        // user at least gets a usable system prompt.
        frontmatter = {};
      }
      body = text.slice(fmMatch[0].length);
    }

    const scopedName = path.basename(rel, '.md');
    const fmName =
      typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
        ? frontmatter.name.trim()
        : scopedName;
    const fmDescription =
      typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
    const fmModel = typeof frontmatter.model === 'string' ? frontmatter.model : undefined;

    out[scopedName] = {
      name: fmName,
      description: fmDescription,
      model: fmModel,
      systemPrompt: body.trim(),
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read every `<pluginRoot>/commands/*.md` and return slash-command specs.
 * Frontmatter contributes `description` and `argument-hint` (kebab-case
 * matches the official Claude Code convention); the body below the
 * frontmatter is the prompt template with `$1`/`$2`/`$ARGUMENTS`
 * placeholders. Files without a body are skipped.
 *
 * Map keys are filename basenames so `commands/foo.md` becomes `/foo` at
 * chat time.
 */
export async function discoverPluginCommands(
  pluginRoot: string,
): Promise<Record<string, CommandSpec> | undefined> {
  const dir = path.join(pluginRoot, COMMANDS_DIR_REL);
  if (!(await fileExists(dir))) return undefined;

  let matches: string[];
  try {
    matches = await fg('*.md', { cwd: dir, onlyFiles: true, dot: false });
  } catch {
    return undefined;
  }

  const out: Record<string, CommandSpec> = {};
  for (const rel of matches) {
    const abs = path.join(dir, rel);
    let text: string;
    try {
      text = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }

    const fmMatch = /^---\n([\s\S]*?)\n---\s*\n?/m.exec(text);
    let frontmatter: Record<string, unknown> = {};
    let body = text;
    if (fmMatch) {
      try {
        frontmatter = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
      } catch {
        frontmatter = {};
      }
      body = text.slice(fmMatch[0].length);
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) continue;

    const description =
      typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
    // Claude Code uses kebab-case `argument-hint`; YAML parses it as a
    // dashed key string, NOT a JS property. Read it via bracket access.
    const argRaw = (frontmatter as { 'argument-hint'?: unknown })['argument-hint'];
    const argumentHint = typeof argRaw === 'string' ? argRaw : undefined;

    out[path.basename(rel, '.md')] = {
      description,
      argumentHint,
      body: trimmedBody,
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Enumerate the SKILL.md files inside a plugin and return one SkillSpec
 * per file. For `skill-glob` plugins (the plugin's own root IS the skill)
 * the function looks at `<pluginRoot>/SKILL.md` only. For `cc-plugin` /
 * `cc-marketplace` plugins it globs every `**\/SKILL.md` so a pack like
 * superpowers surfaces each of its sub-skills individually.
 *
 * The scoped name (= map key) comes from the frontmatter `name`, falling
 * back to the basename of the directory containing SKILL.md, falling back
 * to `pluginNameFallback` (used only for the rare `skill-glob` SKILL.md
 * sitting at the plugin root with no frontmatter).
 */
export async function discoverPluginSkills(
  pluginRoot: string,
  manifestKind: PluginManifestKind,
  pluginNameFallback: string,
): Promise<Record<string, SkillSpec> | undefined> {
  const relPaths: string[] =
    manifestKind === 'skill-glob'
      ? (await fileExists(path.join(pluginRoot, 'SKILL.md'))) ? ['SKILL.md'] : []
      : await fg('**/SKILL.md', {
          cwd: pluginRoot,
          ignore: ['node_modules/**', '.git/**'],
          onlyFiles: true,
          dot: false,
        }).catch(() => [] as string[]);

  if (relPaths.length === 0) return undefined;

  const out: Record<string, SkillSpec> = {};
  for (const rel of relPaths) {
    const abs = path.join(pluginRoot, rel);
    let text: string;
    try {
      text = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const fm = /^---\n([\s\S]*?)\n---/m.exec(text);
    let frontmatter: Record<string, unknown> = {};
    if (fm) {
      try {
        frontmatter = (parseYaml(fm[1]) ?? {}) as Record<string, unknown>;
      } catch {
        frontmatter = {};
      }
    }

    const fmName =
      typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
        ? frontmatter.name.trim()
        : null;
    const dir = path.dirname(rel);
    const dirName = dir === '.' ? null : path.basename(dir);
    const scopedName = fmName ?? dirName ?? pluginNameFallback;

    // First-encountered wins on collision (within a single plugin) — keeps
    // the result deterministic when two SKILL.md files frontmatter-clash.
    if (out[scopedName]) continue;

    const description =
      typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
    out[scopedName] = { name: scopedName, description, relPath: rel };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
