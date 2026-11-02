import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

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
import type { ServiceConfig } from '../../../types.js';
import { decrypt, isEncrypted } from '../../../lib/encryption.js';
import { schedulerLogsDir, ensureSchedulerLogsDir } from './logs.js';
import { runningTasks } from './locks.js';
import {
  atomicWriteFile,
  buildMergedPrompt,
  telegramSessionId,
  type PendingChat,
} from './telegram_window.js';
import { senderLabel, messageText, type TgMessage, type TgUpdate } from './telegram_media.js';
import type { SchedulerStrategy } from './strategy.js';

export async function saveTelegramOffset(taskId: string, updateId: number): Promise<void> {
  // The offset is committed before any run is logged, so this can be the very
  // first write into scheduler-logs/ — the dir may not exist yet.
  await ensureSchedulerLogsDir();
  await atomicWriteFile(join(schedulerLogsDir(), `${taskId}.offset`), String(updateId));
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
export async function executeTelegramTaskRun(
  task: ServiceConfig,
  chat: PendingChat,
): Promise<void> {
  let token = task.telegramBotToken?.trim() || '';
  if (token && isEncrypted(token)) {
    token = decrypt(token);
  }

  // No busy check here: the caller never flushes a window whose chat is
  // locked, it holds the entries for the next tick instead.
  const compoundLockKey = `${task.id}:${chat.chatId}`;
  runningTasks.add(compoundLockKey);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const fromUser = chat.entries[0]?.fromLabel ?? 'User';
  console.log(
    `[scheduler/telegram] Starting run ${runId} for user ${fromUser} in chat ${chat.chatId}`,
  );

  const runMessages: MessageRecord[] = [];
  const chatId = chat.chatId;
  const promptAttachments = chat.entries.flatMap((e) => e.attachments);

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
    // Reconstruct conversation history using standard stable Chat Sessions
    const sessionId = telegramSessionId(chatId);
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
    const effectivePrompt = buildMergedPrompt(chat, isNewSession);

    // Persist the user prompt in the stable session history. The attachments
    // ride the record too, so later turns replay the images.
    const startMsg = userMessage(effectivePrompt, {
      attachments: promptAttachments.length > 0 ? promptAttachments : undefined,
    });
    await appendMessage(sessionMeta, startMsg);
    runMessages.push(startMsg);

    await harness.run(
      {
        agent: { ...agent, permissionMode: 'bypassPermissions' }, // unattended: mirror the auto-approve confirm gate
        provider,
        tools,
        prompt: effectivePrompt,
        promptAttachments: promptAttachments.length > 0 ? promptAttachments : undefined,
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

async function executeTelegramPoller(task: ServiceConfig): Promise<void> {
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
    // Scaffolding: Task 6 replaces this grouping with the accumulation window.
    const toChat = (msg: TgMessage, now: number): PendingChat => ({
      chatId: msg.chat.id,
      chatLabel: msg.chat.title ?? msg.chat.username ?? String(msg.chat.id),
      chatType: msg.chat.type,
      entries: [
        {
          updateId: msg.message_id,
          fromLabel: senderLabel(msg),
          text: messageText(msg),
          attachments: [],
        },
      ],
      firstAt: now,
    });
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
            await executeTelegramTaskRun(task, toChat(msg, Date.now()));
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
  async tick(task: ServiceConfig, now: Date): Promise<void> {
    await executeTelegramPoller(task);
  },
};

