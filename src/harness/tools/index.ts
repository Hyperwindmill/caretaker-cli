// Barrel export. Imports throughout the app go through this module so the
// internal layout (types / registry / builtin / future mcp adapter) can be
// reorganized without touching consumers.

export type { Tool, ToolContext, ToolResult, OpenAiFunctionTool } from "./types.js";
export { toOpenAiTool } from "./types.js";
export { ToolRegistry } from "./registry.js";
export { registerBuiltins } from "./builtin/index.js";
