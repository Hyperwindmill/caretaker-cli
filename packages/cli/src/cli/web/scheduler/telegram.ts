import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile, readFile, rename } from 'node:fs/promises';

import * as harness from '../../../harness/index.js';
import { loadAgents, loadConfig } from '../../../store/json.js';
import {
  __forTesting,
  readSession,
  createSession,
  appendMessage,
  userMessage,
} from '../../../session/store.js';
import type { MessageRecord } from '../../../session/types.js';
import type { ScheduledTaskConfig } from '../../../types.js';
import { decrypt, isEncrypted } from '../../../lib/encryption.js';
import { schedulerLogsDir } from './logs.js';
import { runningTasks } from './locks.js';
import type { SchedulerStrategy } from './strategy.js';

export async function saveTelegramOffset(taskId: string, updateId: number): Promise<void> {
  const path = join(schedulerLogsDir(), `${taskId}.offset`);
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, String(updateId), 'utf8');

  // Same rationale as store/json.ts writeJson: retry rename on Windows-style
  // transient lock errors before propagating.
  const maxAttempts = process.platform === 'win32' ? 5 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(tmpPath, path);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
      if (attempt === maxAttempts || !retryable) break;
      await new Promise((r) => setTimeout(r, 50 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function loadTelegramOffset(taskId: string): Promise<number | undefined> {
  const path = join(schedulerLogsDir(), `${taskId}.offset`);
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf8');
    const num = parseInt(raw.trim(), 10);
    return isNaN(num) ? undefined : num;
  } catch {
    return undefined;
  }
}

interface TgMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    title?: string;
    first_name?: string;
    username?: string;
  };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const TOOL_EMOJI: Record<string, string> = {
  read_file: '📖',
  view_file: '📖',
  write_file: '📝',
  write_to_file: '📝',
  replace_file_content: '✍️',
  multi_replace_file_content: '✍️',
  grep_search: '🔍',
  list_dir: '📁',
  run_command: '⚡',
  manage_task: '⚙️',
  search_web: '🌐',
  read_url_content: '🌐',
};

async function tgApi(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description}`);
  }
  return data.result;
}

async function tgGetUpdates(token: string, offset?: number): Promise<TgUpdate[]> {
  const body: Record<string, unknown> = {
    limit: 50,
    allowed_updates: ['message'],
  };
  if (offset !== undefined) {
    body.offset = offset;
  }
  try {
    return await tgApi(token, 'getUpdates', body);
  } catch (err) {
    console.error('[scheduler/telegram] getUpdates failed:', err);
    return [];
  }
}

export function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try splitting at double newline
    const doubleNl = remaining.lastIndexOf('\n\n', maxLen);
    if (doubleNl > maxLen * 0.3) {
      splitAt = doubleNl + 2;
    }

    // Try splitting at code block boundary
    if (splitAt === -1) {
      const codeBlock = remaining.lastIndexOf('```\n', maxLen);
      if (codeBlock > maxLen * 0.3) {
        splitAt = codeBlock + 4;
      }
    }

    // Try splitting at single newline
    if (splitAt === -1) {
      const singleNl = remaining.lastIndexOf('\n', maxLen);
      if (singleNl > maxLen * 0.3) {
        splitAt = singleNl + 1;
      }
    }

    // Hard split as last resort
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

const pollingTasks = new Set<string>();

/**
 * Background loop step execution run specifically formatted for interactive Telegram conversations.
 */
async function executeTelegramTaskRun(
  task: ScheduledTaskConfig,
  msg: TgMessage,
  updateId: number,
): Promise<void> {
  let token = task.telegramBotToken?.trim() || '';
  if (token && isEncrypted(token)) {
    token = decrypt(token);
  }

  const compoundLockKey = `${task.id}:${msg.chat.id}`;
  if (runningTasks.has(compoundLockKey)) {
    await tgApi(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ A session is already in progress in this chat. Please wait for it to complete.',
    }).catch((err) => {
      console.warn(`[scheduler/telegram] Failed to send busy notice to chat ${msg.chat.id}:`, err);
    });
    return;
  }
  runningTasks.add(compoundLockKey);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const fromUser = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'User';
  console.log(
    `[scheduler/telegram] Starting run ${runId} for user ${fromUser} in chat ${msg.chat.id}`,
  );

  const runMessages: MessageRecord[] = [];
  const chatId = msg.chat.id;

  let typingInterval: NodeJS.Timeout | null = null;
  const sendTyping = () => {
    void tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch((err) => {
      console.warn(`[scheduler/telegram] Failed to send typing indicator:`, err);
    });
  };

  sendTyping();
  typingInterval = setInterval(sendTyping, 4000);

  let pendingToolCalls: string[] = [];
  let toolCallTimer: NodeJS.Timeout | null = null;

  const flushToolCalls = async () => {
    if (pendingToolCalls.length === 0) return;
    const text = pendingToolCalls.join('\n');
    pendingToolCalls = [];
    if (toolCallTimer) {
      clearTimeout(toolCallTimer);
      toolCallTimer = null;
    }
    await tgApi(token, 'sendMessage', { chat_id: chatId, text }).catch((err) => {
      console.warn(
        `[scheduler/telegram] Failed to flush tool-call summary to chat ${chatId}:`,
        err,
      );
    });
  };

  const queueToolCall = (toolName: string, summary: string) => {
    const emoji = TOOL_EMOJI[toolName] || '🔧';
    const line = `${emoji} ${toolName}${summary ? ' ' + summary : ''}`;
    pendingToolCalls.push(line);
    if (toolCallTimer) clearTimeout(toolCallTimer);
    toolCallTimer = setTimeout(() => {
      void flushToolCalls();
    }, 800);
  };

  try {
    const [agents, config] = await Promise.all([loadAgents(), loadConfig()]);
    const agent = agents.find((a) => a.id === task.agentId);
    if (!agent) {
      throw new Error(`Agent with ID "${task.agentId}" not found for task "${task.name}"`);
    }

    const provider = config.providers.find((p) => p.name === agent.provider);
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not found for agent "${agent.name}"`);
    }

    const tools = await harness.resolveAgentTools(agent, harness.tools);
    const workingDir = task.workingDir || agent.workingDir || process.cwd();

    // Resolve the prompt format exactly as in the previous repository
    const from = msg.from?.username
      ? `@${msg.from.username}`
      : (msg.from?.first_name ?? 'unknown');

    // Reconstruct conversation history using standard stable Chat Sessions
    const sessionId = `telegram_${chatId}`;
    let sessionMeta: any;
    let historyMessages: MessageRecord[] = [];

    const path = __forTesting.sessionPath(agent.id, sessionId);
    if (existsSync(path)) {
      const session = await readSession(agent.id, sessionId);
      sessionMeta = session.meta;
      historyMessages = session.messages;
    } else {
      sessionMeta = await createSession({
        agentId: agent.id,
        title: `Telegram Chat: ${fromUser} (${chatId})`,
        id: sessionId,
      });
    }

    const isNewSession = historyMessages.length === 0;
    const effectivePrompt = isNewSession
      ? `From: ${from}\nChat: ${msg.chat.title ?? msg.chat.username ?? String(msg.chat.id)} (id: ${msg.chat.id}, type: ${msg.chat.type})\n\n${msg.text ?? ''}`
      : `From: ${from}\n\n${msg.text ?? ''}`;

    // Persist the user prompt in the stable session history
    const startMsg = userMessage(effectivePrompt);
    await appendMessage(sessionMeta, startMsg);
    runMessages.push(startMsg);

    await harness.run(
      {
        agent,
        provider,
        tools,
        prompt: effectivePrompt,
        history: historyMessages,
        workingDir,
      },
      {
        onMessage: async (msg) => {
          // Persist all generated loop turns directly inside standard stable Session store!
          await appendMessage(sessionMeta, msg);
          runMessages.push(msg);

          if (msg.role === 'assistant') {
            if (typingInterval) {
              clearInterval(typingInterval);
              typingInterval = null;
            }
            await flushToolCalls();

            let responseText = msg.content;
            if (msg.parts && msg.parts.length > 0) {
              const textParts = msg.parts.filter((p) => p.type === 'text').map((p) => p.text);
              if (textParts.length > 0) {
                responseText = textParts.join('\n');
              }
            }

            if (responseText) {
              const chunks = splitMessage(responseText);
              for (const chunk of chunks) {
                await tgApi(token, 'sendMessage', {
                  chat_id: chatId,
                  text: chunk,
                  parse_mode: 'Markdown',
                }).catch(async () => {
                  // Markdown rejected by Telegram (unbalanced backticks, etc.) — retry as plain text.
                  await tgApi(token, 'sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                  }).catch((err) => {
                    console.warn(
                      `[scheduler/telegram] Failed to deliver assistant chunk to chat ${chatId}:`,
                      err,
                    );
                  });
                });
              }
            }
          }
        },
        onToolCall: async (id, name, args) => {
          let summary = '';
          if (args && typeof args === 'object') {
            if ('path' in args) summary = String(args.path);
            else if ('TargetFile' in args) summary = String(args.TargetFile);
            else if ('AbsolutePath' in args) summary = String(args.AbsolutePath);
            else if ('CommandLine' in args) summary = String(args.CommandLine);
          }
          queueToolCall(name, summary);
        },
        confirmTool: async () => 'once',
      },
    );

    console.log(`[scheduler/telegram] Run ${runId} finished successfully.`);
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler/telegram] Run ${runId} failed:`, errorMsg);

    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    await flushToolCalls();

    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `❌ Agent error: ${errorMsg}`,
    }).catch((sendErr) => {
      console.warn(
        `[scheduler/telegram] Failed to deliver error notice to chat ${chatId}:`,
        sendErr,
      );
    });

  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    if (toolCallTimer) {
      clearTimeout(toolCallTimer);
    }
    runningTasks.delete(compoundLockKey);
  }
}

async function executeTelegramPoller(task: ScheduledTaskConfig): Promise<void> {
  if (pollingTasks.has(task.id)) return;
  pollingTasks.add(task.id);

  try {
    let token = task.telegramBotToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
    if (token && isEncrypted(token)) {
      token = decrypt(token);
    }
    if (!token) return;

    const allowedChats = new Set(
      (task.telegramAllowedChats || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const offset = await loadTelegramOffset(task.id);
    const updates = await tgGetUpdates(token, offset !== undefined ? offset + 1 : undefined);
    if (updates.length === 0) return;

    // Save the highest offset immediately to prevent reprocessing on subsequent ticks
    const highestUpdate = updates[updates.length - 1]!;
    await saveTelegramOffset(task.id, highestUpdate.update_id);

    // Group updates by chat.id so messages from the same chat are processed
    // sequentially (preserves order, avoids "session already in progress" drops),
    // while different chats progress in parallel.
    const byChat = new Map<number, Array<{ update: TgUpdate; msg: TgMessage }>>();
    for (const update of updates) {
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatIdStr = String(msg.chat.id);
      if (allowedChats.size > 0 && !allowedChats.has(chatIdStr)) {
        console.log(`[scheduler/telegram] Skipping message in unauthorized chat ${chatIdStr}`);
        continue;
      }

      const list = byChat.get(msg.chat.id) ?? [];
      list.push({ update, msg });
      byChat.set(msg.chat.id, list);
    }

    await Promise.all(
      Array.from(byChat.values()).map(async (group) => {
        for (const { update, msg } of group) {
          try {
            await executeTelegramTaskRun(task, msg, update.update_id);
          } catch (err) {
            console.error(
              `[scheduler/telegram] Failed to execute task run for update ${update.update_id}:`,
              err,
            );
          }
        }
      }),
    );
  } catch (err) {
    console.error(`[scheduler/telegram] Polling error for task "${task.name}":`, err);
  } finally {
    pollingTasks.delete(task.id);
  }
}

export async function runTelegramPollerTick(): Promise<void> {
  try {
    const config = await loadConfig();
    const tasks = config.scheduler?.tasks || [];
    const enabledTelegramTasks = tasks.filter((t) => t.type === 'telegram' && t.enabled);

    for (const task of enabledTelegramTasks) {
      void executeTelegramPoller(task).catch((err) => {
        console.error(
          `[scheduler/telegram] Poller tick execution failed for task "${task.name}":`,
          err,
        );
      });
    }
  } catch (err) {
    console.error('[scheduler/telegram] Error in runTelegramPollerTick:', err);
  }
}

export const TelegramStrategy: SchedulerStrategy = {
  type: 'telegram',
  async tick(task: ScheduledTaskConfig, now: Date): Promise<void> {
    await executeTelegramPoller(task);
  },
};

