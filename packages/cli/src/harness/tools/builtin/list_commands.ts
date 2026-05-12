// Enumerate slash commands available to the current agent. Same plugin
// gating as skills: a command is visible iff its owning plugin is in the
// agent's `plugins` whitelist. The user can also invoke commands by typing
// `/foo args` in the chat — the model gets the same surface programmatically.

import type { Tool } from '../types.js';
import { listActiveCommands } from '../../../commands/loader.js';

interface CommandSummary {
  name: string;
  description?: string;
  argumentHint?: string;
}

export const listCommandsTool: Tool = {
  name: 'list_commands',
  description:
    'List the slash commands available to this agent (from active plugins). ' +
    'Returns one entry per command with `name`, `description?`, and ' +
    '`argumentHint?`. Use `invoke_command` to expand and execute one.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, ctx) {
    const summaries = await listActiveCommands(ctx.activePlugins ?? []);
    if (summaries.length === 0) return { content: 'No commands available.' };
    const out: CommandSummary[] = summaries.map((s) => ({
      name: s.name,
      description: s.description,
      argumentHint: s.argumentHint,
    }));
    return { content: JSON.stringify(out, null, 2) };
  },
};
