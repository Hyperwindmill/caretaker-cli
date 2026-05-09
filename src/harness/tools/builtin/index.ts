// Built-in (in-process, native) tools shipped with the app. New native
// tools are added here. The future MCP adapter will register additional
// tools alongside these via a separate entry point.

import type { ToolRegistry } from "../registry.js";
import { readFileTool } from "./read_file.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { multieditTool } from "./multiedit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { fetchTool } from "./fetch.js";
import { bashTool } from "./bash.js";

export function registerBuiltins(registry: ToolRegistry): void {
  // Filesystem (sandboxed to ctx.workingDir).
  registry.register(readFileTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(multieditTool);
  registry.register(globTool);
  registry.register(grepTool);
  // Network.
  registry.register(fetchTool);
  // Shell.
  registry.register(bashTool);
}

export { readFileTool, writeTool, editTool, multieditTool, globTool, grepTool, fetchTool, bashTool };
