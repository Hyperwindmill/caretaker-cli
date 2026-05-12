// Enumerate the plugin skills active for the current agent. The model uses
// this catalog to decide which skill (if any) is worth pulling into context
// via `read_skill`. When no plugins are active, returns an empty list.

import type { Tool } from '../types.js';
import { listActiveSkills } from '../../../plugins/loader.js';

export const listSkillsTool: Tool = {
  name: 'list_skills',
  description:
    'List the skills available to this agent. Returns one entry per skill ' +
    'across all active plugins (a cc-plugin pack contributes multiple ' +
    'entries, one per `skills/<name>/SKILL.md`). Each entry has `name`, ' +
    '`description`, and `plugin` (the owning plugin). Call `read_skill` ' +
    "with a `name` from this list to load that skill's full instructions.",
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, ctx) {
    const skills = await listActiveSkills(ctx.activePlugins ?? []);
    if (skills.length === 0) {
      return { content: 'No skills available.' };
    }
    return { content: JSON.stringify(skills, null, 2) };
  },
};
