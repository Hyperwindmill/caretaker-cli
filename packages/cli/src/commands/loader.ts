// Slash command resolution at chat time. Commands live on PluginRecord
// (loaded from plugins.json) and are gated per-agent by AgentConfig.plugins
// — same model as skills. No separate store; the plugin record is the
// source of truth.
//
// Names are scoped: a plugin named "contract-workflow" with
// `commands/contract-writing.md` registers as `/contract-writing`. On a
// collision (two active plugins both define `/foo`), the first plugin
// listed in `agent.plugins` wins; the duplicate is dropped silently and
// the user can disambiguate by removing the conflicting plugin from the
// agent.

import { loadPlugins } from '../store/json.js';
import type { CommandSpec, PluginRecord } from '../types.js';

export interface CommandSummary {
  name: string;
  description?: string;
  argumentHint?: string;
  pluginName: string;
}

export interface ResolvedCommand {
  name: string;
  spec: CommandSpec;
  pluginName: string;
}

async function activePluginRecords(activeNames: string[]): Promise<PluginRecord[]> {
  const wanted = activeNames.map((n) => n.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  let file;
  try {
    file = await loadPlugins();
  } catch {
    return [];
  }
  // Preserve agent.plugins ordering so the "first wins" rule on collision
  // is deterministic and user-controlled.
  const byName = new Map<string, PluginRecord>();
  for (const p of file.plugins) byName.set(p.name, p);
  const out: PluginRecord[] = [];
  for (const name of wanted) {
    const p = byName.get(name);
    if (p) out.push(p);
  }
  return out;
}

/** Catalog of slash commands available to an agent given its active
 *  plugins. Used by the chat input for help-style listing and (future)
 *  autocomplete. Order follows `activePlugins`, then declaration order. */
export async function listActiveCommands(activePlugins: string[]): Promise<CommandSummary[]> {
  const records = await activePluginRecords(activePlugins);
  const seen = new Set<string>();
  const out: CommandSummary[] = [];
  for (const plugin of records) {
    if (!plugin.commands) continue;
    for (const [name, spec] of Object.entries(plugin.commands)) {
      if (seen.has(name)) continue; // first plugin wins
      seen.add(name);
      out.push({
        name,
        description: spec.description,
        argumentHint: spec.argumentHint,
        pluginName: plugin.name,
      });
    }
  }
  return out;
}

/** Look up a command by its scoped name across the agent's active
 *  plugins. Returns `null` when the command does not exist for this
 *  agent (unknown name OR defined only by a non-active plugin). */
export async function resolveCommand(
  name: string,
  activePlugins: string[],
): Promise<ResolvedCommand | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const records = await activePluginRecords(activePlugins);
  for (const plugin of records) {
    if (!plugin.commands) continue;
    const spec = plugin.commands[trimmed];
    if (spec) return { name: trimmed, spec, pluginName: plugin.name };
  }
  return null;
}

// ─── Pure helpers (also exported for unit tests) ────────────────────────

/** Tokenize an arg string. Bare words split on whitespace; double-quoted
 *  spans are kept as one arg (no escapes). Single quotes are NOT special
 *  — Claude Code does not document them either. */
export function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? m[1] : (m[2] as string));
  }
  return out;
}

/** Replace `$1`, `$2`, …, and `$ARGUMENTS` in the body. Unmatched
 *  positionals collapse to empty strings (the user invoked with too few
 *  args — the prompt template should be tolerant). `$0`, `$10`+ are not
 *  supported on purpose; commands rarely need more than 9 positionals. */
export function expandTemplate(body: string, args: string[], rawTail: string): string {
  return body
    .replace(/\$ARGUMENTS\b/g, rawTail)
    .replace(/\$([1-9])\b/g, (_, n: string) => args[Number(n) - 1] ?? '');
}

/** Parse `/cmd-name args…`. Returns null when the input does not start
 *  with `/` or has no command name. */
export function parseSlashInvocation(
  input: string,
): { name: string; args: string[]; raw: string } | null {
  if (!input.startsWith('/')) return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!m) return null;
  const [, name, tail = ''] = m;
  return { name: name as string, args: tokenizeArgs(tail), raw: tail };
}
