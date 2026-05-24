import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import * as harness from '../../harness/index.js';
import { loadAgents, loadConfig, dataDir } from '../../store/json.js';
import { userMessage } from '../../session/store.js';
import type { MessageRecord } from '../../session/types.js';
import type { ScheduledTaskConfig } from '../../types.js';

/**
 * Returns the folder where scheduler logs are cached under ~/.caretaker/scheduler-logs
 */
export function schedulerLogsDir(): string {
  return join(dataDir(), 'scheduler-logs');
}

/**
 * Returns the path to a specific task's JSONL log file
 */
export function schedulerLogPath(taskId: string): string {
  return join(schedulerLogsDir(), `${taskId}.jsonl`);
}

/**
 * Ensures the scheduler logs folder exists
 */
export async function ensureSchedulerLogsDir(): Promise<void> {
  const dir = schedulerLogsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Parses and returns all execution runs for a given task ID, sorted by timestamp descending (newest first).
 */
export async function loadTaskRuns(taskId: string): Promise<any[]> {
  const path = schedulerLogPath(taskId);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    const runs: any[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        runs.push(JSON.parse(trimmed));
      } catch (err) {
        console.warn(`[scheduler/logs] failed to parse line: ${err}`);
      }
    }
    return runs.reverse();
  } catch (err) {
    console.error(`[scheduler/logs] failed to load runs for task ${taskId}:`, err);
    return [];
  }
}

/**
 * Appends a task execution run record to the task's JSONL file.
 */
export async function saveTaskRun(taskId: string, run: any): Promise<void> {
  await ensureSchedulerLogsDir();
  const path = schedulerLogPath(taskId);
  await appendFile(path, JSON.stringify(run) + '\n', { mode: 0o600 });
}

/**
 * Parses and evaluates a cron expression string against a given Date.
 * Supports standard syntax fields: minute, hour, day of month, month, day of week.
 * Handles wildcards (*), step levels (e.g. *\/5), ranges (e.g. 1-5), and comma lists (e.g. 1,3,5).
 */
export function matchesCron(cronStr: string, date: Date): boolean {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [min, hr, dom, mon, dow] = fields;
  const m = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const mo = date.getMonth() + 1; // 0-indexed month
  const w = date.getDay(); // 0 is Sunday

  const matchField = (field: string, val: number, isDow = false): boolean => {
    if (field === '*') return true;

    // Handle list parsing (e.g., 1,3,5)
    if (field.includes(',')) {
      return field.split(',').some((p) => matchField(p, val, isDow));
    }

    // Handle step patterns (e.g., */5)
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return val % step === 0;
    }

    // Handle range with step patterns (e.g., 1-5/2)
    if (field.includes('/')) {
      const [range, stepStr] = field.split('/');
      const step = parseInt(stepStr || '1', 10);
      if (range === '*') {
        return val % step === 0;
      }
      if (range.includes('-')) {
        const [start, end] = range.split('-').map(Number);
        if (val >= start && val <= end) {
          return (val - start) % step === 0;
        }
        return false;
      }
    }

    // Handle range parsing (e.g., 1-5)
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return val >= start && val <= end;
    }

    // Exact number match
    const num = parseInt(field, 10);
    return num === val;
  };

  return (
    matchField(min!, m) &&
    matchField(hr!, h) &&
    matchField(dom!, d) &&
    matchField(mon!, mo) &&
    matchField(dow!, w, true)
  );
}

/** Task IDs currently being executed — prevents concurrent runs of the same task. */
const runningTasks = new Set<string>();

/**
 * Headless runner execution of a single task prompt loop.
 * Runs completely in background, automatically approving tool runs.
 * Guards against concurrent execution: if the task is already running, skips.
 */
export async function executeTaskRun(task: ScheduledTaskConfig): Promise<void> {
  if (runningTasks.has(task.id)) {
    console.log(`[scheduler] Task "${task.name}" is already running — skipping.`);
    return;
  }
  runningTasks.add(task.id);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  console.log(`[scheduler] Starting execution run ${runId} for task: "${task.name}"`);

  const runMessages: MessageRecord[] = [];
  const unattendedNotice = `[UNATTENDED RUN] Note: You are running as an unattended scheduled task. No human is supervising this execution. Act autonomously, execute required tools, and complete the task to the best of your ability.`;
  const effectivePrompt = `${unattendedNotice}\n\n${task.prompt}`;

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

    // Track the initial user prompt inside run history
    const startMsg = userMessage(effectivePrompt);
    runMessages.push(startMsg);

    // Invoke headless loop run
    await harness.run(
      {
        agent,
        provider,
        tools,
        prompt: effectivePrompt,
        history: [],
        workingDir,
      },
      {
        onMessage: async (msg) => {
          runMessages.push(msg);
        },
        confirmTool: async () => 'once', // Headless cron triggers auto-approve all tools
      },
    );

    // Map captured MessageRecords to webview ChatMessage schema
    const chatMessages: any[] = runMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt,
    }));

    await saveTaskRun(task.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'success',
      messages: chatMessages,
    });

    console.log(`[scheduler] Run ${runId} for task "${task.name}" finished successfully.`);
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Run ${runId} for task "${task.name}" failed:`, errorMsg);

    const chatMessages: any[] = runMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt,
    }));

    // Synthesize user prompt trigger if failed before loop initiation
    if (chatMessages.length === 0) {
      chatMessages.push({
        id: randomUUID(),
        role: 'user',
        content: effectivePrompt,
        createdAt: new Date().toISOString(),
      });
    }

    // Append descriptive system assistant error to let the user review the failure details in UI
    chatMessages.push({
      id: randomUUID(),
      role: 'assistant',
      content: `⚠️ Task run failed:\n\n\`\`\`\n${errorMsg}\n\`\`\``,
      createdAt: new Date().toISOString(),
    });

    await saveTaskRun(task.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'failure',
      error: errorMsg,
      messages: chatMessages,
    });
  } finally {
    // Always release the lock so future ticks can re-schedule this task
    runningTasks.delete(task.id);
  }
}

let lastCheckedMinuteStr = '';

/**
 * Evaluates all scheduled tasks and triggers execution loops for matching ones.
 */
export async function runSchedulerTick(): Promise<void> {
  const now = new Date();
  const currentMinuteStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
  if (lastCheckedMinuteStr === currentMinuteStr) return; // Tick already processed for this minute
  lastCheckedMinuteStr = currentMinuteStr;

  try {
    const config = await loadConfig();
    const tasks = config.scheduler?.tasks || [];
    const enabledTasks = tasks.filter((t) => t.enabled && t.type !== 'telegram');

    for (const task of enabledTasks) {
      if (matchesCron(task.cron, now)) {
        console.log(
          `[scheduler] Task "${task.name}" matches cron expression "${task.cron}". Launching run...`,
        );
        void executeTaskRun(task).catch((err) => {
          console.error(`[scheduler] Background task run failed to execute:`, err);
        });
      }
    }
  } catch (err) {
    console.error('[scheduler] Error evaluating scheduler tasks tick:', err);
  }
}

// ─── Telegram Poller Implementation ─────────────────────────────────────────────

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
  const compoundLockKey = `${task.id}:${msg.chat.id}`;
  if (runningTasks.has(compoundLockKey)) {
    const token = task.telegramBotToken!.trim();
    await tgApi(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ A session is already in progress in this chat. Please wait for it to complete.',
    }).catch(() => {});
    return;
  }
  runningTasks.add(compoundLockKey);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const fromUser = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'User';
  console.log(
    `[scheduler/telegram] Starting run ${runId} for user ${fromUser} in chat ${msg.chat.id}`,
  );

  const runMessages: MessageRecord[] = [];
  const token = task.telegramBotToken!.trim();
  const chatId = msg.chat.id;

  let typingInterval: NodeJS.Timeout | null = null;
  const sendTyping = () => {
    void tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
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
    await tgApi(token, 'sendMessage', { chat_id: chatId, text }).catch(() => {});
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

    const unattendedNotice = `[UNATTENDED RUN] Note: You are running as an unattended Telegram scheduled poller session. No human is supervising this execution directly. Act autonomously, execute required tools, and reply to the user message.`;
    const effectivePrompt = `[Telegram Message from ${fromUser}]\n\n${msg.text}\n\n---\n${unattendedNotice}`;

    const startMsg = userMessage(effectivePrompt);
    runMessages.push(startMsg);

    await harness.run(
      {
        agent,
        provider,
        tools,
        prompt: effectivePrompt,
        history: [],
        workingDir,
      },
      {
        onMessage: async (msg) => {
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
                  await tgApi(token, 'sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                  }).catch(() => {});
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

    const chatMessages: any[] = runMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt,
    }));

    await saveTaskRun(task.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'success',
      telegramUpdateId: updateId,
      messages: chatMessages,
    });

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
    }).catch(() => {});

    const chatMessages: any[] = runMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt,
    }));

    if (chatMessages.length === 0) {
      chatMessages.push({
        id: randomUUID(),
        role: 'user',
        content: `[Telegram Message from ${fromUser}]\n\n${msg.text}`,
        createdAt: new Date().toISOString(),
      });
    }

    chatMessages.push({
      id: randomUUID(),
      role: 'assistant',
      content: `⚠️ Task run failed:\n\n\`\`\`\n${errorMsg}\n\`\`\``,
      createdAt: new Date().toISOString(),
    });

    await saveTaskRun(task.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'failure',
      telegramUpdateId: updateId,
      error: errorMsg,
      messages: chatMessages,
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
    const token = task.telegramBotToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return;

    const allowedChats = new Set(
      (task.telegramAllowedChats || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const runs = await loadTaskRuns(task.id);
    let maxUpdateId: number | undefined;
    for (const run of runs) {
      if (run.telegramUpdateId !== undefined) {
        if (maxUpdateId === undefined || run.telegramUpdateId > maxUpdateId) {
          maxUpdateId = run.telegramUpdateId;
        }
      }
    }

    const offset = maxUpdateId !== undefined ? maxUpdateId + 1 : undefined;
    const updates = await tgGetUpdates(token, offset);
    if (updates.length === 0) return;

    for (const update of updates) {
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatIdStr = String(msg.chat.id);
      if (allowedChats.size > 0 && !allowedChats.has(chatIdStr)) {
        console.log(`[scheduler/telegram] Skipping message in unauthorized chat ${chatIdStr}`);
        continue;
      }

      void executeTelegramTaskRun(task, msg, update.update_id).catch((err) => {
        console.error(
          `[scheduler/telegram] Failed to execute task run for update ${update.update_id}:`,
          err,
        );
      });
    }

    // Sync progress offset even if all updates in batch were skipped
    if (updates.length > 0) {
      const highestUpdate = updates[updates.length - 1]!;
      let anyProcessed = false;
      for (const update of updates) {
        const msg = update.message;
        if (msg && msg.text && (allowedChats.size === 0 || allowedChats.has(String(msg.chat.id)))) {
          anyProcessed = true;
        }
      }
      if (!anyProcessed) {
        await saveTaskRun(task.id, {
          runId: `sync_${randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          status: 'success',
          telegramUpdateId: highestUpdate.update_id,
          messages: [],
        });
      }
    }
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

let schedulerIntervalRef: NodeJS.Timeout | null = null;

/**
 * Starts the in-process background scheduler loop.
 */
export function startBackgroundScheduler(): void {
  if (schedulerIntervalRef) return;

  console.log('[scheduler] Starting in-process background scheduler daemon...');
  // Check matching jobs every 15 seconds to ensure exact minute matching + telegram ticks
  schedulerIntervalRef = setInterval(() => {
    void runSchedulerTick();
    void runTelegramPollerTick();
  }, 15000);
}

/**
 * Stops the in-process background scheduler loop.
 */
export function stopBackgroundScheduler(): void {
  if (schedulerIntervalRef) {
    console.log('[scheduler] Stopping in-process background scheduler daemon...');
    clearInterval(schedulerIntervalRef);
    schedulerIntervalRef = null;
  }
}
