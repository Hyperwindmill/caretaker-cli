// Email accounts for the agent-facing email tools.
//
// An account is a `type: 'email'` entry in the Services collection
// (`caretaker.json` → `scheduler.tasks`, see store/json.ts). The record holds
// both halves of a mailbox: IMAP for reading (no tool yet) and SMTP for
// sending. The SMTP credentials default to the IMAP ones — one mailbox, one
// login, in the common case — and only need their own fields when the provider
// splits them.
//
// This module owns account resolution and the address allowlist. Everything
// here except sendEmail() is pure, which is where the tests live.

import nodemailer from 'nodemailer';
import type { ServiceConfig } from '../types.js';
import { loadConfig } from '../store/json.js';
import { decrypt, isEncrypted } from './encryption.js';

/** An email account with its secrets decrypted and its defaults applied. */
export type EmailAccount = {
  name: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  allowedRecipients: string[];
};

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
      '^' + pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$',
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

/** The `email` services that are enabled and have an SMTP host to send through. */
export function sendableAccounts(services: ServiceConfig[]): EmailAccount[] {
  return services
    .filter((s) => s.type === 'email' && s.enabled && (s.smtpHost ?? '').trim())
    .map((s) => ({
      name: s.name,
      from: (s.smtpFrom || s.imapUser || '').trim(),
      smtpHost: (s.smtpHost as string).trim(),
      // ponytail: 587 covers plaintext-or-STARTTLS, which is what smtpSecure
      // false means; a 465 account has to say so via the port anyway.
      smtpPort: s.smtpPort || (s.smtpSecure ? 465 : 587),
      smtpSecure: s.smtpSecure ?? false,
      smtpUser: (s.smtpUser || s.imapUser || '').trim(),
      smtpPassword: reveal(s.smtpPassword || s.imapPassword),
      allowedRecipients: parsePatterns(s.allowedRecipients),
    }));
}

/** Accounts available for sending, read from the live config. */
export async function listEmailAccounts(): Promise<EmailAccount[]> {
  const config = await loadConfig();
  return sendableAccounts(config.scheduler?.tasks ?? []);
}

/** Look an account up by service name, case-insensitively. */
export function findAccount(accounts: EmailAccount[], name: string): EmailAccount | undefined {
  const wanted = name.trim().toLowerCase();
  return accounts.find((a) => a.name.trim().toLowerCase() === wanted);
}

export type OutgoingMail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
};

/** Send one plain-text message. Returns the SMTP message id. */
export async function sendEmail(account: EmailAccount, mail: OutgoingMail): Promise<string> {
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    // A server with auth disabled (the GreenMail fixture) rejects an AUTH
    // command outright, so omit the credentials rather than send empty ones.
    auth: account.smtpUser ? { user: account.smtpUser, pass: account.smtpPassword } : undefined,
  });
  try {
    const info = await transport.sendMail({
      from: account.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject,
      text: mail.body,
    });
    return info.messageId;
  } finally {
    transport.close();
  }
}
