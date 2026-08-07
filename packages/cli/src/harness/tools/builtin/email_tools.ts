// Agent-facing email tools. Named `mcp__email__*` so the shared builtin MCP
// server (mcp/builtin_server.ts) picks them up by prefix and serves them over
// both the stdio subcommand and the per-task HTTP bridge, exactly like the
// `mcp__task__*` set.
//
// Accounts come from the Services collection (`type: 'email'`); see lib/email.ts.
// Sending is gated by the account's own `allowedRecipients` allowlist, checked
// before any connection is opened.

import type { Tool, ToolResult } from '../types.js';
import {
  listEmailAccounts,
  findAccount,
  matchesAllowlist,
  bareAddress,
  sendEmail,
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
    'List the email accounts available for sending. Returns each account name (use it as the `account` argument of email_send), its From address, its SMTP host, and its recipient allowlist. Passwords are never returned.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (): Promise<ToolResult> => {
    const accounts = await listEmailAccounts();
    return {
      content: JSON.stringify({
        accounts: accounts.map((a) => ({
          name: a.name,
          from: a.from,
          smtpHost: `${a.smtpHost}:${a.smtpPort}`,
          // Empty list = no restriction; say so instead of showing `[]`.
          allowedRecipients: a.allowedRecipients.length ? a.allowedRecipients : 'any',
        })),
      }),
    };
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
  execute: async (args: any): Promise<ToolResult> => {
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

    const accounts = await listEmailAccounts();
    const account = findAccount(accounts, name);
    if (!account) {
      const available = accounts.map((a) => a.name);
      return err(
        available.length
          ? `Unknown email account "${name}". Available: ${available.join(', ')}`
          : `Unknown email account "${name}". No account is configured for sending — an email service needs an SMTP host and must be enabled.`,
      );
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
