export type ProviderConfig = {
  name: string;
  endpoint: string;
  apiKey?: string;
};

export type CaretakerConfig = {
  port: number;
  providers: ProviderConfig[];
};

export type PluginManifestKind = "cc-marketplace" | "cc-plugin" | "skill-glob";

/** A plugin source — a fetchable place that contains one or more plugins
 *  (discovered via the manifest layer). `git` sources are cached under
 *  `~/.caretaker/plugin-cache/<id>`; `path` sources read directly from the
 *  given absolute directory. */
export type PluginSource = {
  id: string;
  kind: "git" | "path";
  /** Git URL or absolute filesystem path. */
  url: string;
  /** Optional git ref (branch / tag / sha). Defaults to the remote's HEAD. */
  ref?: string | null;
  /** Encrypted auth token for private git repos (encrypt() blob, see lib/encryption.ts). */
  authToken?: string | null;
  /** When true, the source is refreshed on app start. */
  refreshOnStart?: boolean;
  /** ISO timestamp of the last successful or failed fetch. */
  lastFetchedAt?: string | null;
  /** Last fetch error message; null when the last fetch succeeded. */
  lastFetchError?: string | null;
  /** Last resolved git sha; null for path sources or after a failed fetch. */
  lastFetchSha?: string | null;
};

/** A plugin record persisted in plugins.json — the result of the manifest
 *  layer's discovery, indexed and tied back to its source. The agent's
 *  `plugins` list references entries here by `name` to activate them.
 *  The transient discovery type (without id/sourceId) lives in
 *  src/plugins/types.ts. */
export type PluginRecord = {
  id: string;
  sourceId: string;
  name: string;
  description: string | null;
  manifestKind: PluginManifestKind;
  /** Path inside the source root (never traverses outside). */
  relPath: string;
  rawManifest: unknown;
};

/** On-disk shape of plugins.json. */
export type PluginsFile = {
  sources: PluginSource[];
  plugins: PluginRecord[];
};

export type AgentConfig = {
  id: string;
  name: string;
  systemPrompt: string;
  provider: string;
  model: string;
  allowedTools: string[];
  /** Subset of allowedTools that require an explicit user confirmation
   *  before each invocation. Persisted as a parallel set so the existing
   *  `allowedTools` semantics stay intact for older agents on disk. */
  confirmTools?: string[];
  /** Names of plugins (referencing PluginConfig.name in plugins.json) whose
   *  SKILL.md files are injected into the system prompt as passive context. */
  plugins?: string[];
  maxTurns: number;
  /** Absolute directory passed to the harness as ToolContext.workingDir.
   *  Empty/undefined → process.cwd() (legacy behavior). Validated as
   *  absolute by the agent form. */
  workingDir?: string;
};
