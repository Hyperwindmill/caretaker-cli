// Runtime-only types for the plugin subsystem. The persisted shapes
// (PluginSource, PluginRecord, PluginsFile) live in src/types.ts next to
// AgentConfig. This module owns the transient types: fetcher output, the
// discovery output (without ids — those are minted on persist), and the
// discovery error.

import type {
  AgentSpec,
  CommandSpec,
  McpServerSpec,
  PluginManifestKind,
  SkillSpec,
} from '../types.js';

export interface FetchResult {
  /** Filesystem root containing the source contents (cache dir for git, the
   *  user-supplied path for path). */
  root: string;
  /** Resolved commit sha for git sources; null for path sources. */
  sha: string | null;
}

/** Output of the manifest discovery layer: a plugin found inside a source
 *  but not yet tied to an id or persisted. The source manager assigns
 *  `id` + `sourceId` to convert this into a PluginRecord. */
export interface DiscoveredPlugin {
  name: string;
  description: string | null;
  manifestKind: PluginManifestKind;
  /** Relative to the source root, never traverses outside. */
  relPath: string;
  rawManifest: unknown;
  /** MCP servers declared by the plugin manifest, keyed by the
   *  plugin-scoped name (claude-code's `mcpServers` shape). The source
   *  manager mints one McpServerConfig row per entry tagged with this
   *  plugin's id, so deleting the plugin cascades to its MCP rows. */
  mcpServers?: Record<string, McpServerSpec>;
  /** Sub-agents declared under `<plugin-root>/agents/*.md`, keyed by the
   *  filename basename. One AgentConfig row per entry, tagged with this
   *  plugin's id. */
  agents?: Record<string, AgentSpec>;
  /** Slash commands declared under `<plugin-root>/commands/*.md`, keyed by
   *  the filename basename. Used at chat time to expand `/cmd args` into
   *  the body's `$N`/`$ARGUMENTS` template. */
  commands?: Record<string, CommandSpec>;
  /** Skills declared under `<plugin-root>/[**\/]SKILL.md`, keyed by scoped
   *  name (frontmatter `name`, or directory basename as fallback). One
   *  entry per file — a cc-plugin pack like superpowers contributes N
   *  entries, one per `skills/<name>/SKILL.md`. */
  skills?: Record<string, SkillSpec>;
}

export class NoPluginsFoundError extends Error {
  constructor(message = 'No manifest or SKILL.md found in source') {
    super(message);
    this.name = 'NoPluginsFoundError';
  }
}
