import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: encryption resolves its key path under CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-email-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceConfig } from '../types.js';
import {
  parsePatterns,
  matchesAllowlist,
  bareAddress,
  emailAccounts,
  findAccount,
  canSend,
  canRead,
  clampLimit,
  isoDate,
  truncateBody,
  messageText,
  MAX_FETCH,
  MAX_BODY_CHARS,
} from './email.js';

function email(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'svc_1',
    name: 'Work',
    type: 'email',
    enabled: true,
    agentId: '',
    cron: '',
    prompt: '',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'me@example.com',
    imapPassword: 'imap-pw',
    imapSecure: true,
    smtpHost: 'smtp.example.com',
    ...over,
  };
}

test('parsePatterns splits on commas, semicolons and newlines and trims', () => {
  assert.deepEqual(parsePatterns('a@x.com, *@y.com\n c@z.com ;'), [
    'a@x.com',
    '*@y.com',
    'c@z.com',
  ]);
  assert.deepEqual(parsePatterns(''), []);
  assert.deepEqual(parsePatterns(undefined), []);
});

test('matchesAllowlist: empty list allows everything', () => {
  assert.equal(matchesAllowlist('anyone@anywhere.com', []), true);
});

test('matchesAllowlist: domain wildcard, bare star and exact address', () => {
  assert.equal(matchesAllowlist('ada@example.com', ['*@example.com']), true);
  assert.equal(matchesAllowlist('ada@other.com', ['*@example.com']), false);
  assert.equal(matchesAllowlist('ada@other.com', ['*']), true);
  assert.equal(matchesAllowlist('ada@example.com', ['ada@example.com']), true);
  assert.equal(matchesAllowlist('bob@example.com', ['ada@example.com']), false);
});

test('matchesAllowlist is case-insensitive and ignores surrounding space', () => {
  assert.equal(matchesAllowlist(' Ada@Example.COM ', ['*@example.com']), true);
});

test('matchesAllowlist does not let regex metacharacters widen a pattern', () => {
  // A literal dot must not match any character: example.com != exampleXcom.
  assert.equal(matchesAllowlist('ada@exampleXcom', ['*@example.com']), false);
  // A prefix match is not enough — the pattern is anchored at both ends.
  assert.equal(matchesAllowlist('ada@example.com.evil.net', ['*@example.com']), false);
});

test('bareAddress unwraps a display-name recipient', () => {
  assert.equal(bareAddress('Ada Lovelace <ada@example.com>'), 'ada@example.com');
  assert.equal(bareAddress('  ada@example.com '), 'ada@example.com');
});

test('emailAccounts defaults from/user/password to the IMAP values', () => {
  const [account] = emailAccounts([email()]);
  assert.equal(account.from, 'me@example.com');
  assert.equal(account.smtpUser, 'me@example.com');
  assert.equal(account.smtpPassword, 'imap-pw');
  assert.equal(account.smtpPort, 587);
  assert.equal(account.smtpSecure, false);
  assert.deepEqual(account.allowedRecipients, []);
});

test('emailAccounts honours explicit SMTP overrides', () => {
  const [account] = emailAccounts([
    email({
      smtpFrom: 'noreply@example.com',
      smtpUser: 'apikey',
      smtpPassword: 'smtp-pw',
      smtpPort: 465,
      smtpSecure: true,
      allowedRecipients: '*@example.com',
    }),
  ]);
  assert.equal(account.from, 'noreply@example.com');
  assert.equal(account.smtpUser, 'apikey');
  assert.equal(account.smtpPassword, 'smtp-pw');
  assert.equal(account.smtpPort, 465);
  assert.equal(account.smtpSecure, true);
  assert.deepEqual(account.allowedRecipients, ['*@example.com']);
});

test('emailAccounts defaults the port to 465 when implicit TLS is on', () => {
  const [account] = emailAccounts([email({ smtpSecure: true, smtpPort: undefined })]);
  assert.equal(account.smtpPort, 465);
});

test('emailAccounts skips disabled entries and other service types', () => {
  const accounts = emailAccounts([
    email({ id: 'a', name: 'Off', enabled: false }),
    { ...email({ id: 'c', name: 'Telegram' }), type: 'telegram' },
    email({ id: 'd', name: 'Good' }),
  ]);
  assert.deepEqual(
    accounts.map((a) => a.name),
    ['Good'],
  );
});

test('canSend / canRead follow the two hosts independently', () => {
  const [sendOnly] = emailAccounts([email({ imapHost: '' })]);
  assert.equal(canSend(sendOnly), true);
  assert.equal(canRead(sendOnly), false);

  const [readOnly] = emailAccounts([email({ smtpHost: '  ' })]);
  assert.equal(canSend(readOnly), false);
  assert.equal(canRead(readOnly), true);
});

test('emailAccounts resolves the IMAP half, defaulting the port to TLS/plaintext', () => {
  const [tls] = emailAccounts([email({ imapPort: undefined })]);
  assert.equal(tls.imapPort, 993);
  assert.equal(tls.imapSecure, true);
  const [plain] = emailAccounts([email({ imapPort: undefined, imapSecure: false })]);
  assert.equal(plain.imapPort, 143);
  assert.equal(plain.imapSecure, false);
});

test('clampLimit floors at 1, defaults on junk and caps at MAX_FETCH', () => {
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit('nope'), 10);
  assert.equal(clampLimit(0), 10);
  assert.equal(clampLimit(-5), 10);
  assert.equal(clampLimit(3.7), 3);
  assert.equal(clampLimit(1000), MAX_FETCH);
});

test('isoDate accepts a Date, a string, and refuses junk', () => {
  assert.equal(isoDate(new Date('2026-08-07T10:00:00Z')), '2026-08-07T10:00:00.000Z');
  assert.equal(isoDate('2026-08-07T10:00:00Z'), '2026-08-07T10:00:00.000Z');
  assert.equal(isoDate(undefined), '');
  assert.equal(isoDate('not a date'), '');
});

test('truncateBody caps the body and flags it', () => {
  const short = truncateBody('  hello\r\nworld  ');
  assert.deepEqual(short, { body: 'hello\nworld', truncated: false });
  const long = truncateBody('x'.repeat(MAX_BODY_CHARS + 100));
  assert.equal(long.truncated, true);
  assert.ok(long.body.endsWith('[…truncated]'));
  assert.ok(long.body.length < MAX_BODY_CHARS + 20);
});

test('messageText prefers text/plain and converts html-only mail', () => {
  assert.equal(messageText({ text: 'plain' }), 'plain');
  assert.equal(messageText({ text: '  ', html: '<p>rich <b>text</b></p>' }), 'rich **text**');
  assert.equal(messageText({ html: false }), '');
});

test('findAccount matches the service name case-insensitively', () => {
  const accounts = emailAccounts([email({ name: 'Work Inbox' })]);
  assert.equal(findAccount(accounts, 'work inbox')?.name, 'Work Inbox');
  assert.equal(findAccount(accounts, 'nope'), undefined);
});
