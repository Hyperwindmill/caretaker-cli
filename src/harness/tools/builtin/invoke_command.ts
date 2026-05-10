// Expand a slash command template and return the result so the model can
// act on it. Mirrors the user-side path in tui/chat.tsx:
//   1. resolveCommand(name, activePlugins) — gates on agent.plugins
//   2. tokenizeArgs(args) — same quoting rules as the chat input
//   3. expandTemplate(body, args, raw) — `$1`..`$9` and `$ARGUMENTS`
// The expanded body comes back as the tool result; the model reads it
// inline and follows the instructions in the same conversation.

import type { Tool } from "../types.js";
import {
  expandTemplate,
  resolveCommand,
  tokenizeArgs,
} from "../../../commands/loader.js";

export const invokeCommandTool: Tool = {
  name: "invoke_command",
  description:
    "Expand a slash command template into prose you can act on. Pass `name` " +
    "(from list_commands) and optionally `args` as a single string — the " +
    "same text that would follow `/foo` in the chat input. Whitespace splits " +
    "into positionals; double-quoted spans are kept as one. The expanded " +
    "body is returned as the tool result; follow its instructions.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Command name from list_commands." },
      args: {
        type: "string",
        description:
          "Args as a single string (everything that would follow `/<name>`). " +
          "Optional; commands with no positionals or no `$ARGUMENTS` ignore it.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { name?: unknown; args?: unknown };
    if (typeof a.name !== "string" || !a.name.trim()) {
      return { content: "Error: name must be a non-empty string" };
    }
    const cmd = await resolveCommand(a.name, ctx.activePlugins ?? []);
    if (!cmd) {
      return { content: `Error: command "${a.name}" is not available` };
    }
    const tail = typeof a.args === "string" ? a.args : "";
    const tokens = tokenizeArgs(tail);
    return { content: expandTemplate(cmd.spec.body, tokens, tail) };
  },
};
