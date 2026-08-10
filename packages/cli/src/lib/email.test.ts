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
  visibleAccounts,
  canSend,
  canRead,
  clampLimit,
  isoDate,
  truncateBody,
  messageText,
  MAX_FETCH,
  MAX_BODY_CHARS,
  sendEmail,
} from './email.js';
import net from 'node:net';

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

test('visibleAccounts hides a scoped account from every other agent', () => {
  const accounts = emailAccounts([
    email({ id: 'a', name: 'Shared' }),
    email({ id: 'b', name: 'Boss only', allowedAgents: ['agent_1'] }),
  ]);
  assert.deepEqual(
    visibleAccounts(accounts, 'agent_1').map((a) => a.name),
    ['Shared', 'Boss only'],
  );
  assert.deepEqual(
    visibleAccounts(accounts, 'agent_2').map((a) => a.name),
    ['Shared'],
  );
  // An empty list is "every agent", not "no agent".
  assert.deepEqual(
    visibleAccounts(emailAccounts([email({ allowedAgents: [] })]), 'agent_9').length,
    1,
  );
});

test('visibleAccounts without an agent identity is unscoped (trusted local caller)', () => {
  const accounts = emailAccounts([email({ name: 'Boss only', allowedAgents: ['agent_1'] })]);
  assert.equal(visibleAccounts(accounts, undefined).length, 1);
  assert.equal(visibleAccounts(accounts, '').length, 1);
});

test('findAccount matches the service name case-insensitively', () => {
  const accounts = emailAccounts([email({ name: 'Work Inbox' })]);
  assert.equal(findAccount(accounts, 'work inbox')?.name, 'Work Inbox');
  assert.equal(findAccount(accounts, 'nope'), undefined);
});

/**
 * A one-shot SMTP sink: accepts a single message and resolves with the raw DATA.
 * ponytail: 15 lines of protocol beat pulling in a mock-SMTP dependency for the
 * one thing worth asserting — that the wire really carries both body parts.
 */
function smtpSink(): Promise<{ port: number; message: Promise<string> }> {
  let resolveMessage: (data: string) => void;
  const message = new Promise<string>((r) => (resolveMessage = r));
  const server = net.createServer((socket) => {
    let inData = false;
    let data = '';
    socket.write('220 sink\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        data += chunk.toString();
        if (!data.includes('\r\n.\r\n')) return;
        inData = false;
        socket.write('250 OK queued\r\n');
        resolveMessage(data);
        return;
      }
      const verb = chunk.toString().slice(0, 4).toUpperCase();
      if (verb.startsWith('EHLO') || verb.startsWith('HELO')) socket.write('250 sink\r\n');
      else if (verb.startsWith('DATA')) ((inData = true), socket.write('354 go\r\n'));
      else if (verb.startsWith('QUIT')) (socket.write('221 bye\r\n'), socket.end());
      else socket.write('250 OK\r\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      message.finally(() => server.close());
      resolve({ port, message });
    });
  });
}

test('sendEmail sends the html part alongside the text one', async () => {
  const { port, message } = await smtpSink();
  const [account] = emailAccounts([
    email({
      smtpHost: '127.0.0.1',
      smtpPort: port,
      smtpUser: '',
      imapUser: '',
      smtpFrom: 'me@x.io',
    }),
  ]);
  await sendEmail(account, {
    to: ['ada@example.com'],
    subject: 'Report',
    body: 'plain fallback',
    html: '<p>rich <b>body</b></p>',
  });
  const raw = await message;
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /text\/plain/);
  assert.match(raw, /text\/html/);
  assert.ok(raw.includes('plain fallback'), 'text part must survive');
  assert.ok(raw.includes('rich <b>body</b>'), 'html part must survive');
});

test('sendEmail with no html stays a single text/plain message', async () => {
  const { port, message } = await smtpSink();
  const [account] = emailAccounts([
    email({
      smtpHost: '127.0.0.1',
      smtpPort: port,
      smtpUser: '',
      imapUser: '',
      smtpFrom: 'me@x.io',
    }),
  ]);
  await sendEmail(account, { to: ['ada@example.com'], subject: 'Plain', body: 'just text' });
  const raw = await message;
  assert.match(raw, /text\/plain/);
  assert.ok(!raw.includes('multipart'), 'no html means no multipart envelope');
});
