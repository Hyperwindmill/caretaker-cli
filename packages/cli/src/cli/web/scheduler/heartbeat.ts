import { randomUUID } from 'node:crypto';

import * as harness from '../../../harness/index.js';
import { loadAgents, loadConfig } from '../../../store/json.js';
import { userMessage } from '../../../session/store.js';
import type { MessageRecord } from '../../../session/types.js';
import type { ScheduledTaskConfig } from '../../../types.js';
import { saveTaskRun } from './logs.js';
import { runningTasks } from './locks.js';
import type { SchedulerStrategy } from './strategy.js';

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

    const unattendedNotice = `[UNATTENDED RUN] Note: You are running as an unattended scheduled task. No human is supervising this execution. Act autonomously and complete the task to the best of your ability.`;
    const effectivePrompt = `${unattendedNotice}\n\n${task.prompt}`;

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
        content: task.prompt,
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

const lastCheckedMinutes = new Map<string, string>();

export const HeartbeatStrategy: SchedulerStrategy = {
  type: 'heartbeat',
  async tick(task: ScheduledTaskConfig, now: Date): Promise<void> {
    const currentMinuteStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (lastCheckedMinutes.get(task.id) === currentMinuteStr) return;

    if (matchesCron(task.cron, now)) {
      lastCheckedMinutes.set(task.id, currentMinuteStr);
      console.log(
        `[scheduler] Task "${task.name}" matches cron expression "${task.cron}". Launching run...`,
      );
      void executeTaskRun(task).catch((err) => {
        console.error(`[scheduler] Background task run failed to execute:`, err);
      });
    }
  },
};


