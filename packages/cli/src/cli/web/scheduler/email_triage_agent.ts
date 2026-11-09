// Harness-facing half of the email triage service: the agent runner, the real
// TriageDeps and the scheduler strategy. Kept apart from email_triage.ts so
// the orchestrator stays testable with plain fakes.
import * as harness from '../../../harness/index.js';
import { claudeCodeTaskExtras } from '../../../harness/claude_code_runner.js';
import { acpTaskExtras } from '../../../harness/acp_policy.js';
import type { RunOptions } from '../../../harness/index.js';
import type { Tool } from '../../../harness/tools/types.js';
import type { ToolRegistry } from '../../../harness/tools/registry.js';
import { listUnseenEnvelopes, markSeen, sendEmail } from '../../../lib/email.js';
import type { MessageRecord } from '../../../session/types.js';
import { loadAgents, loadConfig } from '../../../store/json.js';
import type { AgentConfig } from '../../../types.js';
import { getTaskBridgeUrl, issueBridgeToken, revokeBridgeToken } from '../mcp_bridge.js';
import { executeTriageRun, type TriageAgentInput, type TriageDeps } from './email_triage.js';
import { matchesCron } from './heartbeat.js';
import { saveTaskRun } from './logs.js';
import type { SchedulerStrategy } from './strategy.js';

const EMAIL_READ = 'mcp__email__email_read';

/** The agent's own tools plus email_read, which the triage prompt relies on.
 *  Nothing is removed: the agent keeps whatever the user gave it. */
export async function triageTools(agent: AgentConfig, registry: ToolRegistry): Promise<Tool[]> {
  const tools = await harness.resolveAgentTools(agent, registry);
  const read = registry.get(EMAIL_READ);
  if (read && !tools.some((t) => t.name === EMAIL_READ)) tools.push(read);
  return tools;
}

export async function runTriageAgent(
  i: TriageAgentInput,
): Promise<{ messages: MessageRecord[]; stop: 'done' | 'max_turns' | 'aborted' }> {
  const tools = await triageTools(i.agent, harness.tools);
  const messages: MessageRecord[] = [];

  let bridgeToken: string | undefined;
  let claudeCode: RunOptions['claudeCode'];
  let acp: RunOptions['acp'];
  const isClaudeCode = i.provider.type === 'claude-code';
  const isAcp = i.provider.type === 'acp';
  if (isClaudeCode || isAcp) {
    const bridgeUrl = getTaskBridgeUrl();
    // Only email_read is served: the bridge exposes no task state or send tool.
    bridgeToken = bridgeUrl ? issueBridgeToken(i.agent.id, { only: [EMAIL_READ] }) : undefined;
    const bridge = bridgeUrl && bridgeToken ? { url: bridgeUrl, token: bridgeToken } : undefined;
    if (!bridge) console.warn('[email-triage] external agent without bridge URL — email_read unavailable this run');
    if (isClaudeCode) claudeCode = claudeCodeTaskExtras({ planning: false, sdd: false, bridge });
    else acp = acpTaskExtras({ planning: false, sdd: false, bridge });
  }

  try {
    const result = await harness.run(
      {
        agent: { ...i.agent, permissionMode: 'bypassPermissions' },
        provider: i.provider,
        tools,
        prompt: i.prompt,
        history: [],
        workingDir: i.workingDir,
        claudeCode,
        acp,
        signal: i.signal,
      },
      {
        onMessage: async (msg) => {
          messages.push(msg);
        },
        confirmTool: async () => 'once', // unattended
      },
    );
    return { messages, stop: result.stop };
  } finally {
    if (bridgeToken) revokeBridgeToken(bridgeToken);
  }
}

export const realTriageDeps: TriageDeps = {
  load: async () => {
    const [agents, config] = await Promise.all([loadAgents(), loadConfig()]);
    return { agents, config };
  },
  listEnvelopes: listUnseenEnvelopes,
  runAgent: runTriageAgent,
  send: sendEmail,
  markSeen,
  saveRun: saveTaskRun,
  now: () => new Date(),
};

const lastCheckedMinutes = new Map<string, string>();

export const EmailTriageStrategy: SchedulerStrategy = {
  type: 'email_triage',
  async tick(service, now) {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (lastCheckedMinutes.get(service.id) === minute) return;
    if (!matchesCron(service.cron, now)) return;
    lastCheckedMinutes.set(service.id, minute);
    void executeTriageRun(service, realTriageDeps).catch((err) => {
      console.error('[scheduler] Email triage run failed to execute:', err);
    });
  },
};
