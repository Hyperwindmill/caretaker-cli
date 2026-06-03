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
  readAttachment,
  saveAttachment,
  attachmentsDir,
} from './store.js';
export { computeContextUsage } from './context_usage.js';
export { initModelLimits } from '../harness/model_limits.js';
export type { ContextUsage } from './context_usage.js';
export type { CreateSessionInput, SessionListEntry } from './store.js';
export type {
  AssistantPart,
  AssistantUsage,
  MessageRecord,
  Session,
  SessionMetaRecord,
  ToolAttachmentRecord,
} from './types.js';
