// Agent-facing email tools. Named `mcp__email__*` so the shared builtin MCP
// server (mcp/builtin_server.ts) picks them up by prefix and serves them over
// both the stdio subcommand and the per-task HTTP bridge, exactly like the
// `mcp__task__*` set.
//
// Accounts come from the Services collection (`type: 'email'`); see lib/email.ts.
// Three boundaries, all host-side and none of them the model's choice:
//   - which accounts exist at all for this agent (`allowedAgents`, resolved from
//     ctx.callerAgent — a scoped account is invisible, not refused);
//   - who an account may send to (`allowedRecipients`, checked before connecting);
//   - whose mail it may read (`allowedSenders`, checked on the envelope pass).

import type { Tool, ToolResult } from '../types.js';
import {
  listEmailAccounts,
  findAccount,
  matchesAllowlist,
  bareAddress,
  sendEmail,
  fetchInbox,
  canSend,
  canRead,
  clampLimit,
  MAX_FETCH,
} from '../../../lib/email.js';

function err(msg: string): ToolResult {
  return { content: JSON.stringify({ error: msg }) };
}

/** Accept either a single address or a list of them. */
function toList(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') {
    const items = value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return items;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value.map((v) => v.trim()).filter(Boolean);
  }
  return null;
}

export const emailListAccountsTool: Tool = {
  name: 'mcp__email__email_list_accounts',
  description:
    'List the configured email accounts. Returns each account name (use it as the `account` argument of email_send / email_fetch), its From address, whether it can send and/or be read, and its address allowlists. Passwords are never returned.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, ctx): Promise<ToolResult> => {
    const accounts = await listEmailAccounts(ctx.callerAgent?.id);
    return {
      content: JSON.stringify({
        accounts: accounts.map((a) => ({
          name: a.name,
          from: a.from,
          // Empty list = no restriction; say so instead of showing `[]`.
          canSend: canSend(a) ? `${a.smtpHost}:${a.smtpPort}` : false,
          canRead: canRead(a) ? `${a.imapHost}:${a.imapPort}` : false,
          allowedRecipients: a.allowedRecipients.length ? a.allowedRecipients : 'any',
          allowedSenders: a.allowedSenders.length ? a.allowedSenders : 'any',
        })),
      }),
    };
  },
};

export const emailFetchTool: Tool = {
  name: 'mcp__email__email_fetch',
  description:
    'Read the oldest unread messages from an account inbox and mark them read, so a later run does not see them again. Messages from senders outside the account allowlist are never returned. Bodies are plain text and may be truncated; attachments are listed by name only, not downloaded.',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Account name from email_list_accounts.' },
      limit: {
        type: 'number',
        description: `How many messages to read this call. Default 10, hard maximum ${MAX_FETCH}.`,
      },
      unread_only: {
        type: 'boolean',
        description: 'Default true. Set false to re-read messages already marked read.',
      },
      subject: { type: 'string', description: 'Only messages whose subject contains this text.' },
      mark_seen: {
        type: 'boolean',
        description:
          'Default true. Set false to leave the messages unread — they will come back on the next call.',
      },
    },
    required: ['account'],
  },
  execute: async (args: any, ctx): Promise<ToolResult> => {
    const name = typeof args?.account === 'string' ? args.account : '';
    if (!name.trim()) return err('account must be a non-empty string');

    const accounts = await listEmailAccounts(ctx.callerAgent?.id);
    const account = findAccount(accounts, name);
    if (!account) {
      const available = accounts.filter(canRead).map((a) => a.name);
      return err(
        available.length
          ? `Unknown email account "${name}". Readable accounts: ${available.join(', ')}`
          : `Unknown email account "${name}". No account is configured for reading — an email service needs an IMAP host and must be enabled.`,
      );
    }
    if (!canRead(account)) {
      return err(`Account "${account.name}" has no IMAP host, so it cannot be read.`);
    }

    try {
      const { messages, refused } = await fetchInbox(account, {
        limit: clampLimit(args?.limit),
        unreadOnly: args?.unread_only !== false,
        subject: typeof args?.subject === 'string' ? args.subject : undefined,
        markSeen: args?.mark_seen !== false,
      });
      return {
        content: JSON.stringify({
          account: account.name,
          count: messages.length,
          // Surfaced rather than silent: "nothing new" and "3 messages you are
          // not allowed to see" are different situations for the agent.
          ...(refused ? { refusedBySenderAllowlist: refused } : {}),
          messages,
        }),
      };
    } catch (e: any) {
      return err(`IMAP fetch failed: ${e?.message ?? String(e)}`);
    }
  },
};

export const emailSendTool: Tool = {
  name: 'mcp__email__email_send',
  description:
    'Send a plain-text email through one of the configured accounts. Pick the account by its name from email_list_accounts. Recipients outside the account allowlist are refused and nothing is sent.',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Account name from email_list_accounts.' },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient addresses. A single comma-separated string is also accepted.',
      },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain text. No HTML, no attachments.' },
    },
    required: ['account', 'to', 'subject', 'body'],
  },
  dangerous: true,
  execute: async (args: any, ctx): Promise<ToolResult> => {
    const name = typeof args?.account === 'string' ? args.account : '';
    if (!name.trim()) return err('account must be a non-empty string');
    const subject = typeof args?.subject === 'string' ? args.subject : '';
    const body = typeof args?.body === 'string' ? args.body : '';
    if (!subject.trim()) return err('subject must be a non-empty string');
    if (typeof args?.body !== 'string') return err('body must be a string');

    const to = toList(args?.to);
    const cc = toList(args?.cc);
    const bcc = toList(args?.bcc);
    if (!to || !cc || !bcc) return err('to/cc/bcc must be a string or an array of strings');
    if (to.length === 0) return err('to must contain at least one recipient');

    const accounts = await listEmailAccounts(ctx.callerAgent?.id);
    const account = findAccount(accounts, name);
    if (!account) {
      const available = accounts.filter(canSend).map((a) => a.name);
      return err(
        available.length
          ? `Unknown email account "${name}". Available: ${available.join(', ')}`
          : `Unknown email account "${name}". No account is configured for sending — an email service needs an SMTP host and must be enabled.`,
      );
    }
    if (!canSend(account)) {
      return err(`Account "${account.name}" has no SMTP host, so it cannot send.`);
    }
    if (!account.from) {
      return err(`Account "${account.name}" has no From address — set its From or IMAP user.`);
    }

    // Allowlist first, for every recipient kind: a refusal must cost no I/O and
    // must never leave a partially delivered message behind.
    const refused = [...to, ...cc, ...bcc].filter(
      (r) => !matchesAllowlist(bareAddress(r), account.allowedRecipients),
    );
    if (refused.length) {
      return err(
        `Recipient(s) not allowed by account "${account.name}": ${refused.join(', ')}. Allowed patterns: ${account.allowedRecipients.join(', ')}`,
      );
    }

    try {
      const messageId = await sendEmail(account, { to, cc, bcc, subject, body });
      return {
        content: JSON.stringify({ ok: true, messageId, from: account.from, to, cc, bcc }),
      };
    } catch (e: any) {
      return err(`SMTP send failed: ${e?.message ?? String(e)}`);
    }
  },
};
