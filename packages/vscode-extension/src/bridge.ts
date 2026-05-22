// Wire protocol between the extension host and the chat webview.
// Both sides import these types so a change here forces both ends to
// update. Event names mirror the sister repo's SSE protocol where the
// concepts overlap, adapted to the in-process model (no `thinking`
// stream for now, no `usage` until the harness exposes it cleanly).
//
// The webview is hostile until proven otherwise: messages arriving on
// the host side must be runtime-validated with `parseViewToHost`. The
// other direction (host → view) is trusted because the host builds the
// messages itself.

export type ConfirmDecision = 'once' | 'always' | 'reject';

export interface AgentSummary {
  id: string;
  name: string;
  model: string;
  provider: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export type HostToView =
  | { type: 'ready' }
  | { type: 'agentsLoaded'; agents: AgentSummary[] }
  | { type: 'sessionsLoaded'; sessions: SessionSummary[] }
  | { type: 'sessionLoaded'; messages: ChatMessage[] }
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'permission_request'; id: string; toolName: string; args: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ViewToHost =
  | { type: 'start'; prompt: string }
  | { type: 'abort' }
  | { type: 'permission_response'; id: string; decision: ConfirmDecision }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'createSession' }
  | { type: 'webviewReady' };

/** Runtime validator for messages coming from the webview. Returns
 * the typed message on success, or null on any structural mismatch.
 * Keep this exhaustive — adding a new `ViewToHost` variant must add a
 * branch here, otherwise the host will silently drop it.
 */
export function parseViewToHost(value: unknown): ViewToHost | null {
  if (!isRecord(value)) return null;
  const type = value.type;

  switch (type) {
    case 'start':
      return typeof value.prompt === 'string' ? { type, prompt: value.prompt } : null;
    case 'abort':
      return { type };
    case 'permission_response': {
      const { id, decision } = value;
      if (typeof id !== 'string') return null;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return null;
      return { type, id, decision };
    }
    case 'selectAgent':
      return typeof value.agentId === 'string' ? { type, agentId: value.agentId } : null;
    case 'selectSession':
      return typeof value.sessionId === 'string' ? { type, sessionId: value.sessionId } : null;
    case 'createSession':
      return { type };
    case 'webviewReady':
      return { type };
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
