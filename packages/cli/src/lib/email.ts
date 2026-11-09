// Email accounts for the agent-facing email tools.
//
// An account is a `type: 'email'` entry in the Services collection
// (`caretaker.json` → `scheduler.tasks`, see store/json.ts). The record holds
// both halves of a mailbox: IMAP for reading and SMTP for sending, each
// independently optional — an account with no `smtpHost` cannot send, one with
// no `imapHost` cannot read. The SMTP credentials default to the IMAP ones —
// one mailbox, one login, in the common case — and only need their own fields
// when the provider splits them.
//
// This module owns account resolution, the address allowlists, and the two
// network operations. Everything except sendEmail()/fetchInbox() is pure, which
// is where the tests live.

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import TurndownService from 'turndown';
import { marked } from 'marked';
import type { ServiceConfig } from '../types.js';
import { loadConfig } from '../store/json.js';
import { decrypt, isEncrypted } from './encryption.js';

/**
 * Ceiling on one mail network operation, and the same reasoning as
 * `NET_TIMEOUT_MS` in lib/task_git.ts: an unattended run must not hang forever
 * on a wedged server. The abort also carries `ctx.signal`, so Pause and the
 * task's wall-clock budget reach *inside* an in-flight connection — the loop
 * only checks the signal between turns, and would otherwise sit awaiting this
 * tool call.
 */
export const NET_TIMEOUT_MS = 60_000;

/** Arm `close` on abort or timeout; returns the disarm to call in a finally. */
function armAbort(close: () => void, signal?: AbortSignal): () => void {
  const timer = setTimeout(close, NET_TIMEOUT_MS);
  const onAbort = () => close();
  signal?.addEventListener('abort', onAbort, { once: true });
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
}

/** An email account with its secrets decrypted and its defaults applied. */
export type EmailAccount = {
  /** The service record id. */
  id: string;
  name: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  /** Outbound: who this account may send to. Enforced by email_send. */
  allowedRecipients: string[];
  /** Inbound: whose mail this account may hand to an agent. Enforced by fetchInbox. */
  allowedSenders: string[];
  /** Agent ids this account is restricted to. Empty = every agent. */
  allowedAgents: string[];
};

/** An account can send only if it has somewhere to send through. */
export function canSend(a: EmailAccount): boolean {
  return !!a.smtpHost;
}

/** …and can be read only if it has a mailbox to read. */
export function canRead(a: EmailAccount): boolean {
  return !!a.imapHost;
}

function reveal(value: string | undefined): string {
  if (!value) return '';
  return isEncrypted(value) ? decrypt(value) : value;
}

/** Split a comma/newline-separated allowlist into patterns. */
export function parsePatterns(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n;]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Does `address` match any of `patterns`? `*` is the only wildcard and matches
 * any run of characters, so `*@example.com` and a bare `*` both work; anything
 * else is compared literally. Case-insensitive.
 *
 * An empty pattern list means "no allowlist configured" and allows everything —
 * the restriction is opt-in, see the design doc.
 */
export function matchesAllowlist(address: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const addr = address.trim().toLowerCase();
  return patterns.some((pattern) => {
    const rx = new RegExp(
      '^' +
        pattern
          .toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\\\*/g, '.*') +
        '$',
    );
    return rx.test(addr);
  });
}

/**
 * Pull the bare address out of a recipient string, so a display-name form
 * ("Ada <ada@example.com>") is checked against the allowlist by its address and
 * not by the whole label.
 */
export function bareAddress(recipient: string): string {
  const angled = recipient.match(/<([^>]*)>/);
  return (angled ? angled[1] : recipient).trim();
}

/** Every enabled `email` service, with defaults applied and secrets revealed.
 *  Direction is not filtered here — ask canSend()/canRead(). */
export function emailAccounts(services: ServiceConfig[]): EmailAccount[] {
  return services
    .filter((s) => s.type === 'email' && s.enabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      from: (s.smtpFrom || s.imapUser || '').trim(),
      smtpHost: (s.smtpHost ?? '').trim(),
      // ponytail: 587 covers plaintext-or-STARTTLS, which is what smtpSecure
      // false means; a 465 account has to say so via the port anyway.
      smtpPort: s.smtpPort || (s.smtpSecure ? 465 : 587),
      smtpSecure: s.smtpSecure ?? false,
      smtpUser: (s.smtpUser || s.imapUser || '').trim(),
      smtpPassword: reveal(s.smtpPassword || s.imapPassword),
      imapHost: (s.imapHost ?? '').trim(),
      imapPort: s.imapPort || (s.imapSecure === false ? 143 : 993),
      imapSecure: s.imapSecure !== false,
      imapUser: (s.imapUser ?? '').trim(),
      imapPassword: reveal(s.imapPassword),
      allowedRecipients: parsePatterns(s.allowedRecipients),
      allowedSenders: parsePatterns(s.allowedSenders),
      allowedAgents: (s.allowedAgents ?? []).filter(Boolean),
    }));
}

/**
 * Narrow a list to the accounts one agent may use. A scoped account is removed
 * outright rather than refused later: the agent never sees a mailbox it cannot
 * touch, so it cannot name it, be tricked into naming it, or report that it
 * exists.
 *
 * `agentId` undefined means the caller has no agent identity, and that only
 * happens for callers that already hold full access to CARETAKER_HOME — the
 * `caretaker-cli mcp` stdio server (whose trust boundary IS local process
 * access) and direct in-process calls. Those see everything. Any new surface
 * that executes these tools on behalf of an agent MUST set `ctx.callerAgent`,
 * or it silently opts out of scoping.
 */
export function visibleAccounts(accounts: EmailAccount[], agentId?: string): EmailAccount[] {
  if (!agentId) return accounts;
  return accounts.filter((a) => a.allowedAgents.length === 0 || a.allowedAgents.includes(agentId));
}

/** Configured accounts visible to `agentId`, read from the live config. */
export async function listEmailAccounts(agentId?: string): Promise<EmailAccount[]> {
  const config = await loadConfig();
  return visibleAccounts(emailAccounts(config.scheduler?.tasks ?? []), agentId);
}

/** Look an account up by service name, case-insensitively. */
export function findAccount(accounts: EmailAccount[], name: string): EmailAccount | undefined {
  const wanted = name.trim().toLowerCase();
  return accounts.find((a) => a.name.trim().toLowerCase() === wanted);
}

/**
 * Render the markdown an agent already wrote as `body` into the HTML part, so a
 * formatted mail costs one copy of the content instead of two. The wrapper is
 * the whole styling story: `marked` emits bare `<p>`/`<h2>`, and mail clients
 * have no sensible default for those. Inline styles only — clients strip
 * `<style>` blocks and never fetch anything external.
 *
 * ponytail: no sanitizer. This is outbound mail written by the agent, which can
 * already send arbitrary HTML through `email_send`'s `html` argument; the
 * recipient's client is what sanitizes on render.
 */
export function markdownToHtml(markdown: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
  // Tables: clients strip <style>, so borders go inline; border="1" is for old Outlook.
  const cell = 'border:1px solid #999;padding:6px 10px;text-align:left;vertical-align:top';
  const html = body
    .replace(/<table(?=[\s>])/g, '<table border="1" style="border-collapse:collapse"')
    .replace(/<(th|td)(?=[\s>])/g, `<$1 style="${cell}"`);
  return (
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
    'font-size:14px;line-height:1.5;color:#1a1a1a;max-width:40em">' +
    html +
    '</div>'
  );
}

export type OutgoingMail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text part. Always sent — the fallback when `html` is set. */
  body: string;
  /** Optional HTML part. Set together with `body` it makes a multipart/alternative. */
  html?: string;
};

/** Send one message (plain text, plus an HTML alternative when given).
 *  Returns the SMTP message id. */
export async function sendEmail(
  account: EmailAccount,
  mail: OutgoingMail,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('aborted before connecting');
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    // A server with auth disabled (the GreenMail fixture) rejects an AUTH
    // command outright, so omit the credentials rather than send empty ones.
    auth: account.smtpUser ? { user: account.smtpUser, pass: account.smtpPassword } : undefined,
  });
  const disarm = armAbort(() => transport.close(), signal);
  try {
    const info = await transport.sendMail({
      from: account.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject,
      text: mail.body,
      // Both parts → nodemailer builds multipart/alternative on its own.
      ...(mail.html ? { html: mail.html } : {}),
    });
    return info.messageId;
  } finally {
    disarm();
    transport.close();
  }
}

// ─── Inbound ──────────────────────────────────────────────────────────────
//
// There is no `email` scheduler strategy and no stored UID cursor: an inbound
// workflow is a `heartbeat` service whose prompt tells the agent to call
// email_fetch, and "already handled" is the IMAP `\Seen` flag — server state,
// shared with the user's own mail client. Two behaviours on one account are two
// heartbeats, which is also how a per-subject triage is expressed.

/** Hard ceiling on messages per call, whatever the caller asks for. */
export const MAX_FETCH = 50;
/** How many unread messages we are willing to look at to fill one window.
 *  Only matters with a sender allowlist: unlisted mail is skipped and left
 *  unread, so without a bound a mailbox full of junk would be re-scanned
 *  forever. The scan itself is one cheap ENVELOPE fetch, not a download. */
export const MAX_SCAN = 200;
/** Hard ceiling on the body text handed to the model, per message. */
export const MAX_BODY_CHARS = 8000;

export type InboundMessage = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  /** Set when the body hit MAX_BODY_CHARS. */
  truncated?: boolean;
  attachments: string[];
};

/** ISO-8601 for whatever the parser or the server gave us; '' when unusable. */
export function isoDate(value: Date | string | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function clampLimit(limit: unknown): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(n, MAX_FETCH);
}

export function truncateBody(text: string): { body: string; truncated: boolean } {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= MAX_BODY_CHARS) return { body: clean, truncated: false };
  return { body: clean.slice(0, MAX_BODY_CHARS) + '\n[…truncated]', truncated: true };
}

const turndown = new TurndownService();

/** Best-effort plain text for a message: the text/plain part, else the HTML converted. */
export function messageText(parsed: { text?: string; html?: string | false }): string {
  if (parsed.text?.trim()) return parsed.text;
  if (typeof parsed.html === 'string' && parsed.html.trim()) return turndown.turndown(parsed.html);
  return '';
}

export type FetchOptions = {
  limit?: number;
  /** Unread only (default true) — the whole point of the \Seen convention. */
  unreadOnly?: boolean;
  /** Server-side subject substring filter. */
  subject?: string;
  /** Mark the delivered messages \Seen (default true), so the next run skips them. */
  markSeen?: boolean;
  /** Run-level abort (ctx.signal): closes the connection mid-flight. */
  signal?: AbortSignal;
};

/** Connect, lock INBOX, run `fn`, and always release and log out. */
async function withInbox<T>(
  account: EmailAccount,
  signal: AbortSignal | undefined,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new Error('aborted before connecting');
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.imapUser, pass: account.imapPassword },
    logger: false,
  });
  const disarm = armAbort(() => client.close(), signal);
  try {
    await client.connect();
  } catch (err) {
    disarm();
    throw err;
  }
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } finally {
    disarm();
    lock.release();
    await client.logout().catch(() => client.close());
  }
}

/** Build the model-facing message from a parsed source. */
function toInbound(
  uid: number,
  parsed: Awaited<ReturnType<typeof simpleParser>>,
  internalDate: Date | string | undefined,
): InboundMessage {
  const { body, truncated } = truncateBody(messageText(parsed));
  return {
    uid,
    from: parsed.from?.text ?? '',
    to: (parsed.to as { text?: string } | undefined)?.text ?? '',
    subject: parsed.subject ?? '',
    // The server's INTERNALDATE always exists; a Date header may be absent
    // or malformed, and mailparser then leaves the field undefined. (imapflow
    // types internalDate as string | Date depending on the fetch shape.)
    date: isoDate(parsed.date ?? internalDate),
    body,
    ...(truncated ? { truncated } : {}),
    attachments: (parsed.attachments ?? []).map((a) => a.filename ?? '(unnamed)'),
  };
}

/** Read the oldest matching messages from INBOX. */
export async function fetchInbox(
  account: EmailAccount,
  opts: FetchOptions = {},
): Promise<{ messages: InboundMessage[]; refused: number; scanTruncated?: boolean }> {
  const limit = clampLimit(opts.limit);
  const markSeen = opts.markSeen !== false;
  return withInbox(account, opts.signal, async (client) => {
    // Only the two criteria every server implements the same way. The sender
    // allowlist is applied below, host-side: IMAP `SEARCH FROM` is substring by
    // spec but not in practice (GreenMail matches whole addresses only and
    // errors on a leading `@`), and `OR` is just as uneven — a filter that
    // silently returns nothing on some servers is worse than no filter.
    const criteria: Record<string, unknown> = {};
    if (opts.unreadOnly !== false) criteria.seen = false;
    if (opts.subject?.trim()) criteria.subject = opts.subject.trim();
    const uids = (await client.search(Object.keys(criteria).length ? criteria : { all: true }, {
      uid: true,
    })) as number[] | false;
    if (!uids || uids.length === 0) return { messages: [], refused: 0 };

    // Oldest first: a queue is processed from the front, never sampled.
    const window = uids.slice(0, MAX_SCAN);
    const scanTruncated = uids.length > window.length;

    // One cheap pass over envelopes decides who is allowed, so mail we may not
    // read is never downloaded.
    const allowed: number[] = [];
    let refused = 0;
    for await (const msg of client.fetch(
      window.join(','),
      { envelope: true, uid: true },
      { uid: true },
    )) {
      const address = msg.envelope?.from?.[0]?.address ?? '';
      if (matchesAllowlist(address, account.allowedSenders)) {
        if (allowed.length < limit) allowed.push(msg.uid);
      } else {
        refused++;
      }
      if (allowed.length >= limit) break;
    }

    const messages: InboundMessage[] = [];
    for (const uid of allowed) {
      const msg = await client.fetchOne(
        String(uid),
        { source: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) continue;
      messages.push(toInbound(uid, await simpleParser(msg.source), msg.internalDate));
    }
    // Only what the agent actually received is marked read — a refused message
    // is left untouched for the human.
    if (markSeen && messages.length) {
      await client.messageFlagsAdd(messages.map((m) => m.uid).join(','), ['\\Seen'], { uid: true });
    }
    return { messages, refused, ...(scanTruncated ? { scanTruncated } : {}) };
  });
}

// ─── Triage helpers ───────────────────────────────────────────────────────
//
// Host-driven triage reads in three separate steps (list, read, mark) so the
// orchestrator decides what is handled; none of the first two touch `\Seen`.

export type TriageEnvelope = { uid: number; from: string; subject: string; date: string };

/** Oldest unseen envelopes the account may read; no bodies, no flag changes. */
export async function listUnseenEnvelopes(
  account: EmailAccount,
  max: number,
  signal?: AbortSignal,
): Promise<{ envelopes: TriageEnvelope[]; refused: number; uidValidity: string }> {
  const limit = clampLimit(max);
  return withInbox(account, signal, async (client) => {
    const uidValidity = String((client.mailbox as { uidValidity?: bigint | number }).uidValidity ?? '');
    const uids = (await client.search({ seen: false }, { uid: true })) as number[] | false;
    const envelopes: TriageEnvelope[] = [];
    let refused = 0;
    if (!uids || uids.length === 0) return { envelopes, refused, uidValidity };
    for await (const msg of client.fetch(
      uids.slice(0, MAX_SCAN).join(','),
      { envelope: true, uid: true, internalDate: true },
      { uid: true },
    )) {
      const from = msg.envelope?.from?.[0]?.address ?? '';
      if (!matchesAllowlist(from, account.allowedSenders)) {
        refused++;
        continue;
      }
      envelopes.push({
        uid: msg.uid,
        from,
        subject: msg.envelope?.subject ?? '',
        date: isoDate(msg.envelope?.date ?? msg.internalDate),
      });
      if (envelopes.length >= limit) break;
    }
    return { envelopes, refused, uidValidity };
  });
}

/** One message by UID, or null when it does not exist or its sender is not
 *  allowed. `source` is fetched as BODY.PEEK[], so `\Seen` stays untouched. */
export async function readMessage(
  account: EmailAccount,
  uid: number,
  signal?: AbortSignal,
): Promise<InboundMessage | null> {
  return withInbox(account, signal, async (client) => {
    const env = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    if (!env) return null;
    if (!matchesAllowlist(env.envelope?.from?.[0]?.address ?? '', account.allowedSenders)) return null;
    const msg = await client.fetchOne(
      String(uid),
      { source: true, internalDate: true },
      { uid: true },
    );
    if (!msg || !msg.source) return null;
    return toInbound(uid, await simpleParser(msg.source), msg.internalDate);
  });
}

/** Mark `uids` seen, unless the mailbox was reset since they were listed. */
export async function markSeen(
  account: EmailAccount,
  uids: number[],
  expectedUidValidity: string,
  signal?: AbortSignal,
): Promise<'marked' | 'uidvalidity-changed'> {
  return withInbox(account, signal, async (client) => {
    const current = String((client.mailbox as { uidValidity?: bigint | number }).uidValidity ?? '');
    if (current !== expectedUidValidity) return 'uidvalidity-changed';
    if (uids.length) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
    return 'marked';
  });
}
