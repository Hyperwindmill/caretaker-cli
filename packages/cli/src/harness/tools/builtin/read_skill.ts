// Fetch the SKILL.md content for one active plugin by name. Names that are
// not in the agent's active-plugin list, or whose SKILL.md is missing /
// oversized, surface as a plain "Error: ..." result so the model can recover
// (e.g. by re-running list_skills).

import type { Tool } from '../types.js';
import { readActiveSkill } from '../../../plugins/loader.js';

export const readSkillTool: Tool = {
  name: 'read_skill',
  description:
    'Read the full instructions of one plugin skill by name. Use the names ' +
    'returned by `list_skills`. Returns the SKILL.md content; follow it ' +
    'directly — it is not itself a callable tool.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name from list_skills.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { name?: unknown };
    if (typeof a.name !== 'string' || !a.name.trim()) {
      return { content: 'Error: name must be a non-empty string' };
    }
    const content = await readActiveSkill(a.name, ctx.activePlugins ?? []);
    if (content === null) {
      return { content: `Error: skill "${a.name}" is not available` };
    }
    return { content };
  },
};
