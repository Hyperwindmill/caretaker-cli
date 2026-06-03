// Persistent chat-session record types. Each session lives in a single JSONL
// file at <dataDir>/sessions/<agentId>/<sessionId>.jsonl. Records are
// append-only; meta updates (e.g. retitle) are emitted as a fresh meta line
// — the latest one wins on read. Schema version `v` is per-record so we can
// evolve individual record types without breaking forward-compat: an unknown
// `v` or `type` is skipped with a warning instead of failing the whole replay.
//
// MessageRecord mirrors the chat_messages row shape from caretaker server's
// schema (role + content + optional parts/toolCallId/usage), so the server's
// `mapRowsToChatMessages` logic can be ported here with minimal adaptation.

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: unknown };

export type AssistantUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

export interface SessionMetaRecord {
  v: 1;
  type: 'session_meta';
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
}

export type Role = 'user' | 'assistant' | 'tool';

export interface ToolAttachmentRecord {
  mime: string;
  id: string;
}

export interface MessageRecord {
  v: 1;
  type: 'message';
  id: string;
  role: Role;
  /** Canonical text content. For assistant rows: textConcat(parts) — the same
   *  invariant the server keeps in chat_messages.content. May be empty when
   *  an assistant turn produced only tool_use blocks. */
  content: string;
  /** Structured assistant blocks (text / thinking / tool_use). Assistant only. */
  parts?: AssistantPart[];
  /** Tool only — links the result back to its assistant tool_use id. */
  toolCallId?: string;
  /** Assistant only, openai-style only. */
  usage?: AssistantUsage;
  attachments?: ToolAttachmentRecord[];
  createdAt: string;
}

export type SessionRecord = SessionMetaRecord | MessageRecord;

export interface Session {
  meta: SessionMetaRecord;
  messages: MessageRecord[];
}
