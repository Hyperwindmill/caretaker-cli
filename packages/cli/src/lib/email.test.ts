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
  sendableAccounts,
  findAccount,
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

test('sendableAccounts defaults from/user/password to the IMAP values', () => {
  const [account] = sendableAccounts([email()]);
  assert.equal(account.from, 'me@example.com');
  assert.equal(account.smtpUser, 'me@example.com');
  assert.equal(account.smtpPassword, 'imap-pw');
  assert.equal(account.smtpPort, 587);
  assert.equal(account.smtpSecure, false);
  assert.deepEqual(account.allowedRecipients, []);
});

test('sendableAccounts honours explicit SMTP overrides', () => {
  const [account] = sendableAccounts([
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

test('sendableAccounts defaults the port to 465 when implicit TLS is on', () => {
  const [account] = sendableAccounts([email({ smtpSecure: true, smtpPort: undefined })]);
  assert.equal(account.smtpPort, 465);
});

test('sendableAccounts skips disabled entries, other types and accounts without an SMTP host', () => {
  const accounts = sendableAccounts([
    email({ id: 'a', name: 'Off', enabled: false }),
    email({ id: 'b', name: 'No SMTP', smtpHost: '  ' }),
    { ...email({ id: 'c', name: 'Telegram' }), type: 'telegram' },
    email({ id: 'd', name: 'Good' }),
  ]);
  assert.deepEqual(
    accounts.map((a) => a.name),
    ['Good'],
  );
});

test('findAccount matches the service name case-insensitively', () => {
  const accounts = sendableAccounts([email({ name: 'Work Inbox' })]);
  assert.equal(findAccount(accounts, 'work inbox')?.name, 'Work Inbox');
  assert.equal(findAccount(accounts, 'nope'), undefined);
});
