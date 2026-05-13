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
import type { MessageRecord, SessionMetaRecord } from 'caretaker-cli/session';
import type { AgentConfig, ProviderConfig } from 'caretaker-cli/types';

export interface ChatCallbacks {
  onChunk: (text: string) => void;
  onToolCall: (id: string, name: string, args: unknown) => void;
  onToolResult: (id: string, content: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
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
  /** Override for tests; defaults to the real caretaker-cli implementations. */
  deps?: ChatDeps;
}

export class ChatSessionController {
  private metaRecord: SessionMetaRecord | null = null;
  private history: MessageRecord[] = [];
  private inflight: AbortController | null = null;

  constructor(private readonly opts: ChatSessionOptions) {}

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
        const title = prompt.length > 50 ? `${prompt.slice(0, 50)}…` : prompt;
        this.metaRecord = await deps.createSession({ agentId: this.opts.agent.id, title });
      }
      const meta = this.metaRecord;

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
