// Public API barrel for embedding the harness in external consumers
// (the VSCode extension, future desktop app, tests). Internal modules
// keep importing their specific files; only this barrel is part of the
// stable surface exposed via `caretaker-cli/harness`.

export { run } from './loop.js';
export type { RunOptions, RunCallbacks, RunResult, ConfirmDecision } from './loop.js';

export { resolveAgentTools, ToolRegistry, registerBuiltins, toOpenAiTool } from './tools/index.js';
export type {
  Tool,
  ToolContext,
  ToolResult,
  ConfirmGate,
  OpenAiFunctionTool,
} from './tools/index.js';

export { tools } from './tools/instance.js';

export { fetchOpenAiStyleModels } from './models.js';
export type { ModelsResult } from './models.js';
