// The `caretaker run` subcommand: one-shot headless invocation of an agent.
// Honors --agent (auto-picks when exactly one agent is configured),
// --tools (comma-separated allowedTools override), and --output (plain
// streaming text vs final JSON blob). Pure helpers (selectAgent,
// parseToolsOverride) are exported for unit tests.

import { loadAgents, loadConfig } from '../store/json.js';
import { run } from '../harness/loop.js';
import { tools as toolRegistry } from '../harness/tools/instance.js';
import { resolveAgentTools } from '../harness/tools/index.js';
import type { AgentConfig } from '../types.js';

export type OutputFormat = 'plain' | 'json';

export interface RunOptions {
  agent?: string;
  tools?: string;
  output?: OutputFormat;
}

export async function selectAgent(
  agents: AgentConfig[],
  name: string | undefined,
): Promise<AgentConfig> {
  if (name) {
    const found = agents.find((a) => a.name === name);
    if (!found) {
      const names = agents.map((a) => a.name).join(', ') || '(none)';
      throw new Error(`agent "${name}" not found. available: ${names}`);
    }
    return found;
  }
  if (agents.length === 0) {
    throw new Error('no agents configured. open the TUI to create one.');
  }
  if (agents.length === 1) return agents[0]!;
  const names = agents.map((a) => a.name).join(', ');
  throw new Error(`multiple agents configured (${names}). pick one with --agent <name>.`);
}

export function parseToolsOverride(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runCommand(prompt: string, opts: RunOptions): Promise<number> {
  if (!prompt) {
    process.stderr.write('error: prompt is required\n');
    return 1;
  }
  const output: OutputFormat = opts.output ?? 'plain';
  if (output !== 'plain' && output !== 'json') {
    process.stderr.write(`error: --output must be "plain" or "json", got "${output}"\n`);
    return 1;
  }

  const [agents, config] = await Promise.all([loadAgents(), loadConfig()]);

  let agent: AgentConfig;
  try {
    agent = await selectAgent(agents, opts.agent);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const provider = config.providers.find((p) => p.name === agent.provider);
  if (!provider) {
    process.stderr.write(
      `error: agent "${agent.name}" references provider "${agent.provider}" which is missing\n`,
    );
    return 1;
  }

  const toolsOverride = parseToolsOverride(opts.tools);
  const effective: AgentConfig =
    toolsOverride === null ? agent : { ...agent, allowedTools: toolsOverride };

  if (output === 'plain') {
    process.stdout.write(
      `→ running "${effective.name}" (${effective.model} via ${provider.name})\n\n`,
    );
  }

  const result = await run(
    {
      agent: effective,
      provider,
      tools: await resolveAgentTools(effective, toolRegistry),
      prompt,
      workingDir: effective.workingDir,
    },
    output === 'json'
      ? {}
      : {
          onChunk: (s) => process.stdout.write(s),
          onToolCall: (_id, name, args) =>
            process.stdout.write(`\n  → tool ${name}(${JSON.stringify(args)})`),
          onToolResult: (_id, content) => process.stdout.write(`\n  ← ${content.slice(0, 200)}\n`),
        },
  );

  if (output === 'json') {
    process.stdout.write(
      JSON.stringify({
        text: result.text,
        toolCalls: result.toolCalls,
        stop: result.stop,
        usage: result.usage,
      }) + '\n',
    );
  } else {
    process.stdout.write(
      `\n\n[stop=${result.stop} tool_calls=${result.toolCalls} usage=${JSON.stringify(result.usage)}]\n`,
    );
  }

  return result.stop === 'done' ? 0 : 2;
}
