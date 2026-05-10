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
  /** MCP server specs declared by the plugin manifest. Each entry produces
   *  one McpServerConfig row tagged with this plugin's id at sync time. */
  mcpServers?: Record<string, McpServerSpec>;
};

/** On-disk shape of plugins.json. */
export type PluginsFile = {
  sources: PluginSource[];
  plugins: PluginRecord[];
};

/** Wire transport for an MCP server. */
export type McpTransport = "stdio" | "http";

/** Plugin-manifest declaration of an MCP server (claude-code's `mcpServers`
 *  record shape, value side). The plugin source manager converts each entry
 *  into a fully-fledged McpServerConfig at refresh time. */
export type McpServerSpec =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/** A configured MCP server the agent can connect to. Tools discovered from
 *  the server are exposed in the registry as `mcp__<id>__<toolName>`. */
export type McpServerConfig = {
  id: string;
  /** Human-friendly label shown in the TUI. */
  name: string;
  transport: McpTransport;
  /** Disabled servers are kept on disk but skipped at connect time. */
  enabled: boolean;
  // ─── stdio transport ────────────────────────────────────────────────
  /** Executable to spawn (stdio transport). */
  command?: string;
  /** Args passed to the spawned executable. */
  args?: string[];
  /** Extra env vars merged on top of getDefaultEnvironment(). */
  env?: Record<string, string>;
  // ─── http transport ─────────────────────────────────────────────────
  /** Streamable HTTP endpoint URL. */
  url?: string;
  /** HTTP request headers. Values that look like encrypt() blobs are
   *  decrypted at connect time; freshly-set values are encrypted on save.
   *  Auth tokens belong here (e.g. `Authorization: Bearer …`). */
  headers?: Record<string, string>;
  /** ISO timestamp of the last successful or failed connect. */
  lastConnectedAt?: string | null;
  /** Last connect error message; null when the last connect succeeded. */
  lastConnectError?: string | null;
  // ─── plugin-managed origin ──────────────────────────────────────────
  /** PluginRecord.id this server was derived from. Set on rows synthesized
   *  from a plugin manifest's `mcpServers` field. Edit/delete are blocked
   *  in the TUI for managed rows; toggling `enabled` stays available. The
   *  row is removed automatically when the source plugin disappears. */
  pluginId?: string;
  /** The key used inside the plugin manifest's `mcpServers` record. The
   *  pair (pluginId, pluginScopedName) is the dedupe key during sync. */
  pluginScopedName?: string;
};

/** On-disk shape of mcp.json. */
export type McpServersFile = {
  servers: McpServerConfig[];
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
   *  SKILL.md files are exposed as on-demand list_skills/read_skill tools. */
  plugins?: string[];
  /** IDs of MCP servers (referencing McpServerConfig.id in mcp.json) whose
   *  tools/list output is registered as `mcp__<id>__<toolName>` callable
   *  tools for this agent. Disabled servers are silently skipped. */
  mcpServers?: string[];
  maxTurns: number;
  /** Absolute directory passed to the harness as ToolContext.workingDir.
   *  Empty/undefined → process.cwd() (legacy behavior). Validated as
   *  absolute by the agent form. */
  workingDir?: string;
};
