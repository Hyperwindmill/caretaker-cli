export type ProviderConfig = {
  name: string;
  /** Runner kind. Absent = 'openai' (OpenAI-compatible HTTP endpoint). */
  type?: 'openai' | 'claude-code';
  /** OpenAI-compatible base URL. Unused when type === 'claude-code'. */
  endpoint: string;
  apiKey?: string;
  /** claude-code only: path to the Claude Code CLI binary. Default: 'claude' from PATH. */
  command?: string;
};

export type ScheduledTaskConfig = {
  id: string;
  name: string;
  type: 'heartbeat' | 'telegram';
  enabled: boolean;
  agentId: string;
  cron: string;
  workingDir?: string;
  prompt: string;
  telegramBotToken?: string;
  telegramAllowedChats?: string;
};

export type ProjectConfig = {
  id: number;
  name: string;
  description: string;
  workingDir: string;
  agentId: string;
  active: boolean;
  /** Optional planner-role agent; falls back to the developer chain when unset. */
  plannerAgentId?: string | null;
  /** Optional reviewer-role agent; falls back to the developer chain when unset. */
  reviewerAgentId?: string | null;
  /** Planning phase default for tasks in this project. Unset = enabled. */
  planningEnabled?: boolean | null;
  /** DONE-review gate default for tasks in this project. Unset = enabled. */
  reviewEnabled?: boolean | null;
  /** SDD mode default for tasks in this project: planner may write .md files. Unset = disabled. */
  sddEnabled?: boolean | null;
  /**
   * Shell commands run once, in order, right after a task worktree is created
   * (worktree/git projects only), before the agent's first cycle — e.g.
   * `pnpm install`. The run stops at the first command that fails.
   */
  bootstrapCommands?: string[] | null;
  /**
   * Wall-clock budget (seconds) for a single heartbeat invocation, enforced as
   * an abort for every provider. Tasks inherit it. Unset = default (120s native,
   * 900s for claude-code).
   */
  maxRunSeconds?: number | null;
  /**
   * Docker image the autonomous task agent runs its shell work inside (e.g.
   * `node:22`). Unset/empty = run on the host worktree in place. Phase-1:
   * project-level only. The worktree is bind-mounted into the container at an
   * identical absolute path; only shell commands + bootstrap run in the
   * container, and file access is confined to the working dir.
   */
  dockerImage?: string | null;
};

export type CaretakerConfig = {
  port: number;
  providers: ProviderConfig[];
  scheduler?: {
    tasks: ScheduledTaskConfig[];
  };
  projects?: ProjectConfig[];
};

export type PluginManifestKind = 'cc-marketplace' | 'cc-plugin' | 'skill-glob';

/** A plugin source — a fetchable place that contains one or more plugins
 *  (discovered via the manifest layer). `git` sources are cached under
 *  `~/.caretaker/plugin-cache/<id>`; `path` sources read directly from the
 *  given absolute directory. */
export type PluginSource = {
  id: string;
  kind: 'git' | 'path';
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
  /** Sub-agents declared under `agents/*.md`, keyed by filename basename
   *  (without the .md extension). Each entry produces one AgentConfig row
   *  tagged with this plugin's id at sync time. */
  agents?: Record<string, AgentSpec>;
  /** Slash commands declared under `commands/*.md`, keyed by filename
   *  basename. Available to agents whose `plugins` list includes this
   *  plugin's name. Resolved at chat time, never synced into a separate
   *  store — the plugin record is the source of truth. */
  commands?: Record<string, CommandSpec>;
  /** Skills exposed by this plugin, keyed by scoped name. For skill-glob
   *  the plugin itself is one skill; for cc-plugin / cc-marketplace it's
   *  one entry per `**\/SKILL.md` file inside the plugin root.
   *  `list_skills` enumerates these flat across all active plugins. */
  skills?: Record<string, SkillSpec>;
};

/** On-disk shape of plugins.json. */
export type PluginsFile = {
  sources: PluginSource[];
  plugins: PluginRecord[];
};

/** Wire transport for an MCP server. */
export type McpTransport = 'stdio' | 'http';

/** Plugin-manifest declaration of an MCP server (claude-code's `mcpServers`
 *  record shape, value side). The plugin source manager converts each entry
 *  into a fully-fledged McpServerConfig at refresh time. */
export type McpServerSpec =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/** Plugin-manifest declaration of a single skill (`<plugin-root>/.../SKILL.md`,
 *  Markdown with optional YAML frontmatter). One spec per file — a cc-plugin
 *  pack like superpowers contributes N specs (one per `skills/<name>/SKILL.md`),
 *  not one. Resolved at refresh time and persisted on `PluginRecord.skills`;
 *  `read_skill` reads the body lazily from `<pluginRoot>/<relPath>`. */
export type SkillSpec = {
  /** Frontmatter `name`, fallback to the basename of the directory that
   *  contains SKILL.md (or the plugin's name when SKILL.md sits at the
   *  plugin root). */
  name: string;
  /** Frontmatter `description`, optional. Surfaced in `list_skills`. */
  description?: string;
  /** Path of the SKILL.md file relative to the plugin's root, e.g.
   *  `skills/brainstorming/SKILL.md` for a cc-plugin pack, or `SKILL.md`
   *  for a skill-glob plugin whose own root is the skill. */
  relPath: string;
};

/** Plugin-manifest declaration of a slash command (`<plugin-root>/commands/<name>.md`,
 *  Markdown with YAML frontmatter). The body is a prompt template; `$1`,
 *  `$2`, …, `$ARGUMENTS` are substituted from the user's invocation at chat
 *  time. The expanded text becomes the user message sent to the model. */
export type CommandSpec = {
  /** Frontmatter `description`, optional. Surfaced in `/help`-style listings. */
  description?: string;
  /** Frontmatter `argument-hint`, optional. A free-text placeholder shown to
   *  the user (e.g. `<system-dir> <target-vision>`). Not validated. */
  argumentHint?: string;
  /** Markdown body with `$N` / `$ARGUMENTS` placeholders. */
  body: string;
};

/** Plugin-manifest declaration of a sub-agent (`<plugin-root>/agents/<name>.md`,
 *  Markdown with YAML frontmatter). The body becomes the system prompt; the
 *  frontmatter contributes name/description/model. We deliberately ignore
 *  the frontmatter `tools:` field at sync time — its vocabulary is
 *  Anthropic's (Read, Bash, …) and does not match ours. The user wires
 *  allowedTools via the agent form after the row is materialized. */
export type AgentSpec = {
  /** Frontmatter `name`, falls back to the filename's basename. */
  name: string;
  /** Frontmatter `description`, may be undefined. */
  description?: string;
  /** Frontmatter `model`, used as the AgentConfig.model literal. May be
   *  undefined — the user fills it in via the form. */
  model?: string;
  /** Markdown body below the frontmatter, used as the AgentConfig.systemPrompt. */
  systemPrompt: string;
};

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
  /** OAuth state for an http MCP server, AES-256-GCM encrypted at rest:
   *  a single encrypted JSON blob of { clientInformation, tokens }. The PKCE
   *  code verifier is transient and never stored here. */
  oauthState?: string;
  /** Transient property indicating if valid OAuth tokens are stored in the state.
   *  Computed on the server side to avoid sending decryption keys/logic to client. */
  hasMcpTokens?: boolean;
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
  /** claude-code providers only: Claude Code permission mode passed as
   *  --permission-mode. Unset = detect from ~/.claude/settings.json
   *  permissions.defaultMode, falling back to 'acceptEdits'. Unattended
   *  runs (scheduler/tasks) force 'bypassPermissions' regardless. */
  permissionMode?: string;
  // ─── plugin-managed origin ──────────────────────────────────────────
  /** PluginRecord.id this agent was derived from. Set on rows synthesized
   *  from a plugin manifest's `agents/*.md` files. Re-sync rewrites
   *  `name` and `systemPrompt` (manifest-owned) but preserves every
   *  other user-controlled field. The row is removed when the source
   *  plugin disappears. */
  pluginId?: string;
  /** Filename-derived scoped name (e.g. `security-auditor` for
   *  `agents/security-auditor.md`). The pair (pluginId, pluginScopedName)
   *  is the dedupe key during sync. */
  pluginScopedName?: string;
  maxTurns: number;
  /** Absolute directory passed to the harness as ToolContext.workingDir.
   *  Empty/undefined → process.cwd() (legacy behavior). Validated as
   *  absolute by the agent form. */
  workingDir?: string;
};
