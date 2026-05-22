// Public API barrel for the JSONL session store. Same surface used by
// the TUI; exposed under `caretaker-cli/session` for external embedders.

export {
  createSession,
  appendMessage,
  readSession,
  listForAgent,
  updateTitle,
  deleteSession,
  userMessage,
  assistantMessage,
  toolMessage,
  dataDir,
  sessionsRoot,
} from './store.js';
export { computeContextUsage } from './context_usage.js';
export type { ContextUsage } from './context_usage.js';
export type { CreateSessionInput, SessionListEntry } from './store.js';
export type {
  AssistantPart,
  AssistantUsage,
  MessageRecord,
  Session,
  SessionMetaRecord,
} from './types.js';
