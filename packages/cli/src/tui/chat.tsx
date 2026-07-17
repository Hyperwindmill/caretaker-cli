import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { run, type ConfirmDecision } from '../harness/loop.js';
import { tools as toolRegistry } from '../harness/tools/instance.js';
import { resolveAgentTools } from '../harness/tools/index.js';
import { expandTemplate, parseSlashInvocation, resolveCommand } from '../commands/loader.js';
import {
  appendMessage,
  createSession,
  readSession,
  updateTitle,
  userMessage,
} from '../session/store.js';
import { generateTitle } from '../harness/title.js';
import { computeContextUsage } from '../session/context_usage.js';
import type { AssistantPart, MessageRecord, SessionMetaRecord } from '../session/types.js';
import type { AgentConfig, ProviderConfig } from '../types.js';

type ChatMode = 'loading' | 'input' | 'running' | 'error';

export default function ChatScreen({
  agent,
  provider,
  initialSession,
  onBack,
}: {
  agent: AgentConfig;
  provider: ProviderConfig;
  /** Existing session to resume; null/undefined = new chat (created on first prompt submit). */
  initialSession?: SessionMetaRecord | null;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<ChatMode>(initialSession ? 'loading' : 'input');
  const [session, setSession] = useState<SessionMetaRecord | null>(initialSession ?? null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [prompt, setPrompt] = useState('');
  const [liveText, setLiveText] = useState('');
  const [liveThinking, setLiveThinking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleAbortRef = useRef<AbortController | null>(null);
  const titlePendingRef = useRef(false);
  // Tools that still require confirmation in this session. Mutated when the
  // user picks "always", so subsequent calls skip the prompt for that tool.
  // Init from the agent's persisted confirmTools; "always" is in-memory only.
  const confirmSetRef = useRef<Set<string>>(new Set(agent.confirmTools ?? []));
  const [pendingConfirm, setPendingConfirm] = useState<{
    id: string;
    name: string;
    args: unknown;
    resolve: (d: ConfirmDecision) => void;
  } | null>(null);

  useEffect(() => {
    if (!initialSession) return;
    void readSession(initialSession.agentId, initialSession.id)
      .then((s) => {
        setSession(s.meta);
        setMessages(s.messages);
        setMode('input');
      })
      .catch((err) => {
        setError(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
        setMode('error');
      });
  }, [initialSession]);

  useEffect(() => {
    return () => {
      titleAbortRef.current?.abort();
      titleAbortRef.current = null;
    };
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (pendingConfirm) {
      // Esc during a confirm prompt → reject this call without aborting
      // the run; the model may recover or stop on its own.
      pendingConfirm.resolve('reject');
      setPendingConfirm(null);
      return;
    }
    if (mode === 'running') {
      abortRef.current?.abort();
    } else {
      // input / loading / error → leave the chat
      onBack();
    }
  });

  const persist = async (target: SessionMetaRecord, msg: MessageRecord) => {
    await appendMessage(target, msg);
    setMessages((prev) => [...prev, msg]);
  };

  const startTurn = async (input: string) => {
    // Slash-command resolution runs before any persistence so a typo
    // doesn't spawn an empty session or pollute history. The user types
    // `/foo args`; we look it up in the agent's active plugins, expand
    // `$N`/`$ARGUMENTS`, and use the result as the user message. Unknown
    // commands surface as an inline error and the chat stays in input
    // mode.
    let text = input;
    const slash = parseSlashInvocation(input);
    if (slash) {
      const cmd = await resolveCommand(slash.name, agent.plugins ?? []);
      if (!cmd) {
        const active = (agent.plugins ?? []).join(', ') || '(none)';
        setError(`Unknown command: /${slash.name}  ·  active plugins: ${active}`);
        return;
      }
      text = expandTemplate(cmd.spec.body, slash.args, slash.raw);
    }

    setMode('running');
    setError(null);
    setLiveText('');
    setLiveThinking('');

    // Resolve target session: create on first prompt of a new chat.
    let target = session;
    let priorMessages = messages;
    if (!target) {
      try {
        const fallbackTitle = text.length > 50 ? `${text.slice(0, 50)}…` : text;
        target = await createSession({ agentId: agent.id, title: fallbackTitle });
        setSession(target);
        titlePendingRef.current = true;
      } catch (err) {
        setError(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
        setMode('error');
        return;
      }
      priorMessages = [];
    }

    // Persist the user message immediately, before running the loop.
    const userMsg = userMessage(text);
    try {
      await persist(target, userMsg);
    } catch (err) {
      setError(
        `Failed to persist user message: ${err instanceof Error ? err.message : String(err)}`,
      );
      setMode('error');
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const result = await run(
        {
          agent,
          provider,
          tools: await resolveAgentTools(agent, toolRegistry),
          prompt: text,
          history: priorMessages,
          signal: ac.signal,
          workingDir: agent.workingDir,
          sessionId: target.id,
        },
        {
          onChunk: (s) => setLiveText((prev) => prev + s),
          onThinking: (s) => setLiveThinking((prev) => prev + s),
          confirmTool: (id, name, args) =>
            new Promise<ConfirmDecision>((resolve) => {
              if (!confirmSetRef.current.has(name)) {
                resolve('once');
                return;
              }
              setPendingConfirm({ id, name, args, resolve });
            }),
          onMessage: async (msg) => {
            if (msg.role === 'assistant') {
              setLiveText('');
              setLiveThinking('');
            }
            await persist(target!, msg);
          },
        },
      );
      setMode('input');

      // Title generation: best-effort, after the first successful turn of a
      // freshly-created session. Fire-and-forget — failure leaves the
      // truncation-fallback title in place.
      if (titlePendingRef.current && result.stop !== 'aborted' && target) {
        titlePendingRef.current = false;
        const sessionForTitle = target;
        const titleAc = new AbortController();
        titleAbortRef.current = titleAc;
        void (async () => {
          const title = await generateTitle({
            agent,
            provider,
            firstUserPrompt: text,
            firstAssistantText: result.text,
            signal: titleAc.signal,
          });
          if (titleAc.signal.aborted) return;
          if (!title) return;
          try {
            const updated = await updateTitle(sessionForTitle, title);
            setSession(updated);
          } catch {
            /* keep fallback title silently */
          } finally {
            if (titleAbortRef.current === titleAc) titleAbortRef.current = null;
          }
        })();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode('input'); // keep transcript visible; surface error banner
    } finally {
      abortRef.current = null;
    }
  };

  if (mode === 'loading') {
    return <Text dimColor>loading session…</Text>;
  }

  if (mode === 'error' && !session) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Box marginTop={1}>
          <SelectInput items={[{ label: '← Back', value: 'back' }]} onSelect={onBack} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>{session?.title ?? 'New chat'}</Text>
        <Text dimColor>
          {' '}
          · {agent.name} · {agent.model} via {provider.name}
        </Text>
      </Box>

      {messages.map((m) => (
        <MessageView key={m.id} msg={m} />
      ))}

      {(liveThinking || liveText) && (
        <Box flexDirection="column">
          {liveThinking && <Text dimColor>· {liveThinking}</Text>}
          {liveText && <Text>{liveText}</Text>}
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}

      {mode === 'input' && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={prompt}
              onChange={setPrompt}
              onSubmit={() => {
                const p = prompt.trim();
                if (!p) return;
                setPrompt('');
                void startTurn(p);
              }}
              placeholder="(message — enter to send, esc to leave)"
            />
          </Box>
        </Box>
      )}

      {mode === 'running' && pendingConfirm && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow" bold>
            confirm tool call
          </Text>
          <Text>
            <Text bold>{pendingConfirm.name}</Text>
            <Text dimColor>{`(${JSON.stringify(pendingConfirm.args).slice(0, 200)})`}</Text>
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: 'Run once', value: 'once' },
                { label: 'Always (this session)', value: 'always' },
                { label: 'Reject', value: 'reject' },
              ]}
              onSelect={(item) => {
                const decision = item.value as ConfirmDecision;
                if (decision === 'always') {
                  confirmSetRef.current.delete(pendingConfirm.name);
                }
                pendingConfirm.resolve(decision);
                setPendingConfirm(null);
              }}
            />
          </Box>
        </Box>
      )}

      {mode === 'running' && !pendingConfirm && (
        <Box marginTop={1}>
          <Text dimColor>(running… esc to abort)</Text>
        </Box>
      )}

      <ContextBar messages={messages} model={agent.model} />
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

function ContextBar({ messages, model }: { messages: MessageRecord[]; model: string }) {
  const usage = computeContextUsage(messages, model);
  if (!usage) return null;
  const { lastTokens, contextWindow, percent } = usage;
  if (contextWindow === null || percent === null) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{`ctx ${formatTokens(lastTokens)}`}</Text>
      </Box>
    );
  }
  const width = 12;
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  const bar = `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const color = percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : undefined;
  const dim = color === undefined;
  return (
    <Box marginTop={1}>
      <Text color={color} dimColor={dim}>
        {`ctx ${bar} ${percent}%  ·  ${formatTokens(lastTokens)} / ${formatTokens(contextWindow)}`}
      </Text>
    </Box>
  );
}

function MessageView({ msg }: { msg: MessageRecord }) {
  if (msg.role === 'user') {
    return (
      <Box>
        <Text color="cyan">› </Text>
        <Text>{msg.content}</Text>
      </Box>
    );
  }
  if (msg.role === 'assistant') {
    return (
      <Box flexDirection="column">
        {Array.isArray(msg.parts) && msg.parts.length > 0 ? (
          msg.parts.map((p, i) => <PartView key={i} part={p} />)
        ) : msg.content ? (
          <Text>{msg.content}</Text>
        ) : null}
        {msg.usage && (
          <Text dimColor>
            {`  [usage: in=${msg.usage.input} out=${msg.usage.output}${
              msg.usage.cacheRead ? ` cR=${msg.usage.cacheRead}` : ''
            }${msg.usage.reasoning ? ` r=${msg.usage.reasoning}` : ''}]`}
          </Text>
        )}
      </Box>
    );
  }
  // role === "tool"
  return (
    <Box flexDirection="column">
      <Text dimColor>{`  ← ${msg.content.slice(0, 200)}`}</Text>
      {msg.attachments && msg.attachments.map((att, i) => (
        <Text key={i} color="yellow">{`    [allegato immagine: ${att.mime} (ID: ${att.id})]`}</Text>
      ))}
    </Box>
  );
}

function PartView({ part }: { part: AssistantPart }) {
  switch (part.type) {
    case 'text':
      return <Text>{part.text}</Text>;
    case 'thinking':
      return part.text.trim().length > 0 ? <Text dimColor>· {part.text}</Text> : null;
    case 'tool_use':
      return (
        <Text color="yellow">{`  → ${part.name}(${JSON.stringify(part.args).slice(0, 120)})`}</Text>
      );
  }
}
