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
import type { MessageRecord, ToolAttachmentRecord } from '../../../session/types.js';
import type { ServiceConfig } from '../../../types.js';
import { decrypt, isEncrypted } from '../../../lib/encryption.js';
import { schedulerLogsDir, ensureSchedulerLogsDir } from './logs.js';
import { runningTasks } from './locks.js';
import {
  atomicWriteFile,
  buildMergedPrompt,
  decideFlush,
  isAtCapacity,
  loadPendingState,
  savePendingState,
  telegramSessionId,
  type PendingChat,
} from './telegram_window.js';
import {
  classifyMessage,
  downloadImage,
  messageText,
  selectImage,
  senderLabel,
  FileTooLargeError,
  type TgUpdate,
} from './telegram_media.js';
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
  deps: { run?: typeof harness.run } = {},
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

    await (deps.run ?? harness.run)(
      {
        agent: { ...agent, permissionMode: 'bypassPermissions' }, // unattended: mirror the auto-approve confirm gate
        provider,
        tools,
        prompt: effectivePrompt,
        promptAttachments: promptAttachments.length > 0 ? promptAttachments : undefined,
        history: historyMessages,
        workingDir,
        // Without this the harness resolves attachments under
        // attachments/default/ and silently drops every image.
        sessionId,
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

export interface TickDeps {
  downloadImage: (
    sessionId: string,
    media: { fileId: string; fileSize?: number },
  ) => Promise<ToolAttachmentRecord>;
  notify: (chatId: number, text: string) => Promise<void>;
  isLocked: (chatId: number) => boolean;
  runChat: (chat: PendingChat) => Promise<void>;
  now: () => number;
}

const UNSUPPORTED_NOTICE =
  "\u26a0\ufe0f I can only read text and images. I haven't passed that file to the agent.";
const TOO_LARGE_NOTICE = '\u26a0\ufe0f That image is too large for me to fetch (20 MB limit).';
const DOWNLOAD_FAILED_NOTICE = "\u26a0\ufe0f I couldn't download that image. Try sending it again.";
const OVER_CAPACITY_NOTICE =
  "\u26a0\ufe0f That's more than I can take in one go. I've kept what came first and skipped the rest \u2014 send it again after my reply.";

/**
 * One tick of the accumulation window: fold the new updates into the per-chat
 * buffer, then deliver every window that is ready. Split out of the poller so
 * it can be driven without the Telegram API.
 */
export async function accumulateAndFlush(
  taskId: string,
  updates: TgUpdate[],
  allowedChats: Set<string>,
  deps: TickDeps,
): Promise<void> {
  const state = await loadPendingState(taskId);
  const now = deps.now();

  for (const update of updates) {
    const msg = update.message;
    if (!msg) continue;

    // Authorization comes before any download: an unauthorized chat must not
    // be able to put bytes on our disk.
    const chatIdStr = String(msg.chat.id);
    if (allowedChats.size > 0 && !allowedChats.has(chatIdStr)) {
      console.log(`[scheduler/telegram] Skipping message in unauthorized chat ${chatIdStr}`);
      continue;
    }

    const kind = classifyMessage(msg);
    if (kind === 'service') continue;
    if (kind === 'unsupported') {
      await deps.notify(msg.chat.id, UNSUPPORTED_NOTICE);
      continue;
    }

    let chat = state.chats[chatIdStr];
    if (!chat) {
      chat = {
        chatId: msg.chat.id,
        chatLabel: msg.chat.title ?? msg.chat.username ?? chatIdStr,
        chatType: msg.chat.type,
        entries: [],
        firstAt: now,
      };
      state.chats[chatIdStr] = chat;
    }

    const media = selectImage(msg);
    if (isAtCapacity(chat, media !== null)) {
      await deps.notify(msg.chat.id, OVER_CAPACITY_NOTICE);
      continue;
    }

    let attachments: ToolAttachmentRecord[] = [];
    if (media) {
      try {
        attachments = [await deps.downloadImage(telegramSessionId(msg.chat.id), media)];
      } catch (err) {
        console.error(`[scheduler/telegram] Image download failed for chat ${chatIdStr}:`, err);
        await deps.notify(
          msg.chat.id,
          err instanceof FileTooLargeError ? TOO_LARGE_NOTICE : DOWNLOAD_FAILED_NOTICE,
        );
        continue;
      }
    }

    if (chat.entries.length === 0) chat.firstAt = now;
    chat.entries.push({
      updateId: update.update_id,
      fromLabel: senderLabel(msg),
      text: messageText(msg),
      attachments,
    });
  }

  // Every chat is considered, including ones with no new update: hold expiry
  // and post-lock delivery both happen on ticks that bring no traffic.
  const toRun: PendingChat[] = [];
  for (const [key, chat] of Object.entries(state.chats)) {
    // The allowlist is the only access boundary, so it is re-checked here
    // too: a chat revoked while its window was held must not still run.
    if (allowedChats.size > 0 && !allowedChats.has(key)) {
      delete state.chats[key];
      continue;
    }
    if (deps.isLocked(chat.chatId)) continue;
    if (decideFlush(chat, now) !== 'flush') continue;
    toRun.push({ ...chat, entries: chat.entries });
    chat.entries = [];
    chat.lastFlushAt = now;
  }

  // The window is consumed before the run, never after it: a failed run is
  // reported in the chat by the run itself, and retrying it forever against a
  // broken provider would burn tokens on every tick.
  await savePendingState(taskId, state);

  await Promise.all(
    toRun.map((chat) =>
      deps.runChat(chat).catch((err) => {
        console.error(`[scheduler/telegram] Run failed for chat ${chat.chatId}:`, err);
      }),
    ),
  );
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

    // No early return on an empty poll: a held window expires, and a window
    // parked behind a running chat is delivered, on ticks with no new updates.
    if (updates.length > 0) {
      // Save the highest offset immediately to prevent reprocessing on subsequent ticks
      const highestUpdate = updates[updates.length - 1]!;
      await saveTelegramOffset(task.id, highestUpdate.update_id);
    }

    await accumulateAndFlush(task.id, updates, allowedChats, {
      downloadImage: (sessionId, media) => downloadImage(token, sessionId, media),
      notify: async (chatId, text) => {
        await tgApi(token, 'sendMessage', { chat_id: chatId, text }).catch((err) => {
          console.warn(`[scheduler/telegram] Failed to notify chat ${chatId}:`, err);
        });
      },
      isLocked: (chatId) => runningTasks.has(`${task.id}:${chatId}`),
      runChat: (chat) => executeTelegramTaskRun(task, chat),
      now: () => Date.now(),
    });
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

