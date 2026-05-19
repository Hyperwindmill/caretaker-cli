// Owns a single chat conversation: lazy session-on-disk creation,
// persisted history, abortable runs. The controller is dumb about
// preconditions (sidebar.ts checks workspace / agent existence before
// constructing one) and dumb about the wire format (callers translate
// callback fires into bridge messages).
//
// Dependencies are injectable so tests can swap in a fake harness +
// in-memory session store without touching CARETAKER_HOME.

import * as harness from 'caretaker-cli/harness';
import * as session from 'caretaker-cli/session';
import type { ConfirmDecision } from 'caretaker-cli/harness';
import type { MessageRecord, SessionMetaRecord } from 'caretaker-cli/session';
import type { AgentConfig, ProviderConfig } from 'caretaker-cli/types';

/** Called by the controller when a tool that requires confirmation
 * (i.e. is in `agent.confirmTools`) is about to be invoked. The
 * caller resolves with the user's decision. Returning `'always'`
 * tells the controller to skip future asks for the same tool name
 * within this controller's lifetime — same semantics as the TUI. */
export type AskConfirm = (
  id: string,
  toolName: string,
  args: unknown,
) => Promise<ConfirmDecision>;

export interface ChatCallbacks {
  onChunk: (text: string) => void;
  onToolCall: (id: string, name: string, args: unknown) => void;
  onToolResult: (id: string, content: string) => void;
  askConfirm: AskConfirm;
  onError: (message: string) => void;
  onDone: () => void;
  onSessionCreated?: (sessionId: string) => void;
}

export interface ChatDeps {
  run: typeof harness.run;
  createSession: typeof session.createSession;
  appendMessage: typeof session.appendMessage;
  userMessage: typeof session.userMessage;
}

export const productionDeps: ChatDeps = {
  run: harness.run,
  createSession: session.createSession,
  appendMessage: session.appendMessage,
  userMessage: session.userMessage,
};

export interface ChatSessionOptions {
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: harness.Tool[];
  workingDir: string;
  /** Optional existing session id. If not provided, a new session is created on first start. */
  sessionId?: string;
  /** Override for tests; defaults to the real caretaker-cli implementations. */
  deps?: ChatDeps;
}

export class ChatSessionController {
  private metaRecord: SessionMetaRecord | null = null;
  private history: MessageRecord[] = [];
  private inflight: AbortController | null = null;
  /** Tools that still require explicit confirmation. Seeded from
   * `agent.confirmTools`; mutated in-session when the user picks
   * "always" so subsequent calls for the same tool bypass the prompt.
   * The persisted `agent.confirmTools` is never changed from here. */
  private readonly confirmSet: Set<string>;
  /** Optional existing session id to load messages from. */
  private readonly sessionId?: string;

  constructor(private readonly opts: ChatSessionOptions) {
    this.confirmSet = new Set(opts.agent.confirmTools ?? []);
    this.sessionId = opts.sessionId;
  }

  get isRunning(): boolean {
    return this.inflight !== null;
  }

  async start(prompt: string, cb: ChatCallbacks): Promise<void> {
    if (this.inflight) {
      cb.onError('A turn is already in progress.');
      return;
    }
    const deps = this.opts.deps ?? productionDeps;
    const ac = new AbortController();
    this.inflight = ac;

    try {
      if (!this.metaRecord) {
        if (this.sessionId) {
          // Load existing session
          const sessionData = await session.readSession(this.opts.agent.id, this.sessionId);
          this.metaRecord = sessionData.meta;
          this.history = sessionData.messages;
        } else {
          // Create new session
          const title = prompt.length > 50 ? `${prompt.slice(0, 50)}…` : prompt;
          this.metaRecord = await deps.createSession({ agentId: this.opts.agent.id, title });
          cb.onSessionCreated?.(this.metaRecord.id);
          this.history = [];
        }
      }

      // At this point metaRecord is guaranteed to be set
      const meta = this.metaRecord!;

      const userMsg = deps.userMessage(prompt);
      await deps.appendMessage(meta, userMsg);
      const priorHistory = [...this.history];
      this.history.push(userMsg);

      await deps.run(
        {
          agent: this.opts.agent,
          provider: this.opts.provider,
          tools: this.opts.tools,
          prompt,
          history: priorHistory,
          signal: ac.signal,
          workingDir: this.opts.workingDir,
        },
        {
          onChunk: cb.onChunk,
          onToolCall: cb.onToolCall,
          onToolResult: cb.onToolResult,
          confirmTool: async (id, name, args) => {
            if (!this.confirmSet.has(name)) return 'once';
            const decision = await cb.askConfirm(id, name, args);
            if (decision === 'always') this.confirmSet.delete(name);
            return decision;
          },
          onMessage: async (msg) => {
            await deps.appendMessage(meta, msg);
            this.history.push(msg);
          },
        },
      );
      cb.onDone();
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.inflight = null;
    }
  }

  abort(): void {
    this.inflight?.abort();
  }
}
