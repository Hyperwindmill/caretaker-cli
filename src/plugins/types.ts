// Runtime-only types for the plugin subsystem. The persisted shapes
// (PluginSource, PluginRecord, PluginsFile) live in src/types.ts next to
// AgentConfig. This module owns the transient types: fetcher output, the
// discovery output (without ids — those are minted on persist), and the
// discovery error.

import type { PluginManifestKind } from "../types.js";

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
}

export class NoPluginsFoundError extends Error {
  constructor(message = "No manifest or SKILL.md found in source") {
    super(message);
    this.name = "NoPluginsFoundError";
  }
}
