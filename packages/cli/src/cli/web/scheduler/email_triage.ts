// Email triage orchestrator: list unread envelopes, run one agent over them,
// mail the report, then mark exactly the triaged messages read.
//
// Deliberately free of any `harness` import: the real deps (agent runner,
// store, IMAP/SMTP wiring) and the scheduler strategy live in
// email_triage_agent.ts, so this file is testable with plain fakes.
import { randomUUID } from 'node:crypto';

import {
  canRead,
  canSend,
  MAX_FETCH,
  MAX_SCAN,
  clampLimit,
  emailAccounts,
  markdownToHtml,
  parsePatterns,
  type EmailAccount,
  type OutgoingMail,
  type TriageEnvelope,
  type listUnseenEnvelopes,
} from '../../../lib/email.js';
import type { MessageRecord } from '../../../session/types.js';
import type { AgentConfig, CaretakerConfig, ProviderConfig, ServiceConfig } from '../../../types.js';
import { runningTasks } from './locks.js';
import { CLAUDE_CODE_DEFAULT_RUN_SECONDS } from './task_roles.js';

const DEFAULT_PREFIX = '[Email Triage]';

export const TRIAGE_INSTRUCTIONS = `You are triaging an inbox. Classify every unread email below into exactly one bucket:

- IMPORTANT: needs action soon: outages, blocked users or customers, failures, direct requests with a deadline.
- INFORMATION: worth knowing, no immediate action.
- TRASH: noise: automated notifications without a decision, time tracking, routine bot chatter. Count only, never list.

Your final message must contain only the report, in exactly this shape, starting with "## IMPORTANT". Every bucket header is always present; when a table would be empty, write "_No important emails._" or "_No information emails._" instead of it.

## IMPORTANT
| From | Subject | Category | Summary | Suggested Action |

## INFORMATION
| From | Subject | Category | Summary | Suggested Action |

## TRASH
N emails classified as trash (not listed).

Headers, bucket names and the table header row are literal and must never be translated, whatever language the rest of the report is written in.

Guidelines:
- Work from the envelopes (From, Subject, Date). Open a body with email_read only when the subject is not enough.
- Cluster related notifications into one row.
- Other tools you have (for example an issue tracker) may be used to understand a reference in an email.
- Do not send mail: your final message is delivered automatically.`;

const UNATTENDED_NOTICE = `[UNATTENDED RUN] Note: You are running as an unattended scheduled task. No human is supervising this execution. Act autonomously and complete the task to the best of your ability.`;

export type TriageStop = 'done' | 'max_turns' | 'aborted';

export function buildTriagePrompt(p: {
  accountName: string;
  extra: string;
  envelopes: TriageEnvelope[];
}): string {
  const parts = [UNATTENDED_NOTICE, TRIAGE_INSTRUCTIONS];
  if (p.extra.trim()) parts.push(p.extra.trim());
  parts.push(`Account: ${p.accountName} — pass it as the account argument of email_read.`);
  parts.push(
    'Unread emails (UID | From | Subject | Date):\n' +
      p.envelopes.map((e) => `- ${e.uid} | ${e.from} | ${e.subject} | ${e.date}`).join('\n'),
  );
  return parts.join('\n\n');
}

/** The report is the last non-empty assistant message, from its `## IMPORTANT`
 *  line on. A truncated run (max_turns/aborted) never yields one: its last
 *  message may be a half-finished "let me read uid 42". */
export function extractReport(messages: MessageRecord[], stop: TriageStop): string | null {
  if (stop !== 'done') return null;
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content?.trim());
  if (!last) return null;
  // ACP emits one record per turn with every text part concatenated in
  // `content` (no separator), so prose before a tool call glues onto the
  // report header. Prefer the text after the last tool_use.
  let text = last.content;
  if (last.parts?.length) {
    const lastTool = last.parts.map((p) => p.type).lastIndexOf('tool_use');
    const tail = last.parts
      .slice(lastTool + 1)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    if (tail.trim()) text = tail;
  }
  const m = /^## IMPORTANT\b.*$/m.exec(text);
  return m ? text.slice(m.index).trim() : null;
}

export function triageSubject(prefix: string, count: number, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  return `${prefix} ${count} emails triaged — ${stamp}`;
}

export function parseRecipients(raw: string | undefined): string[] {
  return parsePatterns(raw);
}

/** Preflight: everything that can be checked before touching IMAP. Looks the
 *  raw record up first (emailAccounts drops disabled ones) so each failure has
 *  its own message. Not `visibleAccounts`: a scoped mailbox is a readable
 *  error here, not an invisible one. */
export function resolveTriageAccount(
  services: ServiceConfig[],
  service: ServiceConfig,
  agentId: string,
): { account: EmailAccount } | { error: string } {
  const id = service.triageAccountId;
  const rec = services.find((s) => s.id === id);
  if (!rec) return { error: `Email account "${id ?? ''}" not found.` };
  if (rec.type !== 'email') return { error: `Service "${rec.name}" is not an email account.` };
  if (!rec.enabled) return { error: `Email account "${rec.name}" is disabled.` };
  const account = emailAccounts([rec])[0]!;
  if (account.allowedAgents.length > 0 && !account.allowedAgents.includes(agentId)) {
    return { error: `Email account "${rec.name}" is restricted to other agents, not the triage agent.` };
  }
  if (!canRead(account)) return { error: `Email account "${rec.name}" has no IMAP host to read from.` };
  if (!canSend(account)) return { error: `Email account "${rec.name}" has no SMTP host to send the report through.` };
  if (!account.from) return { error: `Email account "${rec.name}" has no From address.` };
  return { account };
}

export type TriageAgentInput = {
  agent: AgentConfig;
  provider: ProviderConfig;
  prompt: string;
  account: EmailAccount;
  workingDir: string;
  signal: AbortSignal;
};

export type TriageDeps = {
  load(): Promise<{ agents: AgentConfig[]; config: CaretakerConfig }>;
  listEnvelopes(
    account: EmailAccount,
    max: number,
    signal: AbortSignal,
  ): ReturnType<typeof listUnseenEnvelopes>;
  runAgent(i: TriageAgentInput): Promise<{ messages: MessageRecord[]; stop: TriageStop }>;
  /** No budget signal: a delivery in flight must finish on its own timeout. */
  send(account: EmailAccount, mail: OutgoingMail, signal?: AbortSignal): Promise<string>;
  markSeen(
    account: EmailAccount,
    uids: number[],
    uidValidity: string,
    signal?: AbortSignal,
  ): Promise<'marked' | 'uidvalidity-changed'>;
  saveRun(serviceId: string, run: unknown): Promise<void>;
  now(): Date;
};

export type TriageOutcome =
  | { kind: 'skipped' }
  | { kind: 'failure'; error: string }
  | { kind: 'success'; included: number; refused: number; marked: boolean; warning?: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const toChat = (m: MessageRecord) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  parts: m.parts,
  toolCallId: m.toolCallId,
  createdAt: m.createdAt,
});

const assistantNote = (content: string) => ({
  id: randomUUID(),
  role: 'assistant' as const,
  content,
  createdAt: new Date().toISOString(),
});

export async function executeTriageRun(
  service: ServiceConfig,
  deps: TriageDeps,
): Promise<TriageOutcome> {
  if (runningTasks.has(service.id)) {
    console.log(`[scheduler] Triage "${service.name}" is already running — skipping.`);
    return { kind: 'skipped' };
  }
  runningTasks.add(service.id);

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAUDE_CODE_DEFAULT_RUN_SECONDS * 1000);
  const messages: Partial<ReturnType<typeof toChat>>[] = [];

  const fail = async (error: string): Promise<TriageOutcome> => {
    console.error(`[scheduler] Triage run ${runId} for "${service.name}" failed:`, error);
    await deps.saveRun(service.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'failure',
      error,
      messages: [
        ...messages,
        assistantNote(`⚠️ Triage run failed:\n\n\`\`\`\n${error}\n\`\`\``),
      ],
    });
    return { kind: 'failure', error };
  };

  try {
    const { agents, config } = await deps.load();
    const agent = agents.find((a) => a.id === service.agentId);
    if (!agent) return await fail(`Agent with ID "${service.agentId}" not found for "${service.name}"`);
    const provider = config.providers.find((p) => p.name === agent.provider);
    if (!provider) return await fail(`Provider "${agent.provider}" not found for agent "${agent.name}"`);

    const resolved = resolveTriageAccount(config.scheduler?.tasks ?? [], service, agent.id);
    if ('error' in resolved) return await fail(resolved.error);
    const { account } = resolved;

    const recipients = parseRecipients(service.triageRecipients);
    if (recipients.length === 0) return await fail(`Triage service "${service.name}" has no report recipients.`);

    let listing: Awaited<ReturnType<typeof listUnseenEnvelopes>>;
    try {
      listing = await deps.listEnvelopes(account, service.triageMaxEmails == null ? MAX_FETCH : clampLimit(service.triageMaxEmails), ctrl.signal);
    } catch (e) {
      return await fail(`Listing unread mail failed: ${errText(e)}`);
    }
    const { envelopes, refused, uidValidity, scanTruncated } = listing;
    if (envelopes.length === 0) {
      if (scanTruncated) {
        return await fail(
          `The oldest ${MAX_SCAN} unread messages are all from senders outside the account's allowedSenders, so triage cannot see newer mail. Read, move or delete them (or widen the allowlist).`,
        );
      }
      return { kind: 'skipped' };
    }

    const prompt = buildTriagePrompt({
      accountName: account.name,
      extra: service.prompt ?? '',
      envelopes,
    });
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    });

    let result: Awaited<ReturnType<TriageDeps['runAgent']>>;
    try {
      result = await deps.runAgent({
        agent,
        provider,
        prompt,
        account,
        workingDir: service.workingDir || agent.workingDir || process.cwd(),
        signal: ctrl.signal,
      });
    } catch (e) {
      return await fail(`Agent run failed: ${errText(e)}`);
    }
    messages.push(...result.messages.map(toChat));

    const report = extractReport(result.messages, result.stop);
    if (report === null) {
      return await fail(
        result.stop !== 'done'
          ? `Agent run ended with stop reason "${result.stop}"; no report to send.`
          : 'Agent did not produce a report starting with "## IMPORTANT".',
      );
    }

    const included = envelopes.length;
    try {
      await deps.send(
        account,
        {
          to: recipients,
          subject: triageSubject(service.triageSubjectPrefix || DEFAULT_PREFIX, included, deps.now()),
          body: report,
          html: markdownToHtml(report),
        },
      );
    } catch (e) {
      return await fail(`Sending the report failed: ${errText(e)}`);
    }

    // The report is out: from here on a problem is a warning, never a failure.
    let marked = false;
    let warning: string | undefined;
    try {
      const r = await deps.markSeen(account, envelopes.map((e) => e.uid), uidValidity);
      if (r === 'marked') marked = true;
      else warning = 'mailbox UIDVALIDITY changed since listing; messages left unread';
    } catch (e) {
      warning = errText(e);
    }

    messages.push(
      assistantNote(
        `Triage: ${included} included, ${refused} refused by sender allowlist, ${
          marked ? 'marked read' : `not marked read: ${warning}`
        }${
          scanTruncated
            ? `. Warning: more than ${MAX_SCAN} unread messages; only the oldest ${MAX_SCAN} were scanned, newer mail waits for the next runs.`
            : ''
        }`,
      ),
    );
    await deps.saveRun(service.id, {
      runId,
      timestamp: new Date().toISOString(),
      status: 'success',
      messages,
    });
    return { kind: 'success', included, refused, marked, ...(warning ? { warning } : {}) };
  } catch (e) {
    return await fail(errText(e));
  } finally {
    clearTimeout(timer);
    runningTasks.delete(service.id);
  }
}
