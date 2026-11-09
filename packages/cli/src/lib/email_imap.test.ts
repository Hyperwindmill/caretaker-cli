import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: later tests in this file may write config under CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-email-imap-'));

import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  sendEmail,
  listUnseenEnvelopes,
  readMessage,
  markSeen,
  type EmailAccount,
} from './email.js';

// GreenMail fixture: docker compose -f docker-compose.mail.yml up -d
const reachable = await new Promise<boolean>((resolve) => {
  const s = net.connect(3143, '127.0.0.1');
  const done = (ok: boolean) => {
    s.destroy();
    resolve(ok);
  };
  s.setTimeout(500, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});
const skip = !reachable && 'GreenMail not running (docker compose -f docker-compose.mail.yml up -d)';

function mailbox(over: Partial<EmailAccount> = {}): EmailAccount {
  const user = `user-${randomBytes(4).toString('hex')}@example.com`;
  return {
    id: 'svc_t',
    name: 'T',
    from: user,
    smtpHost: '127.0.0.1',
    smtpPort: 3025,
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    imapHost: '127.0.0.1',
    imapPort: 3143,
    imapSecure: false,
    imapUser: user,
    imapPassword: user,
    allowedRecipients: [],
    allowedSenders: [],
    allowedAgents: [],
    ...over,
  };
}

/** Deliver one message into the account's mailbox from an arbitrary sender. */
async function deliver(account: EmailAccount, from: string, subject: string) {
  await sendEmail({ ...account, from }, { to: [account.imapUser], subject, body: `body of ${subject}` });
}

test('listUnseenEnvelopes returns allowed envelopes oldest first and counts refused', { skip }, async () => {
  const acc = mailbox({ allowedSenders: ['*@ok.com'] });
  await deliver(acc, 'a@ok.com', 's1');
  await deliver(acc, 'x@bad.com', 's2');
  await deliver(acc, 'b@ok.com', 's3');
  const r = await listUnseenEnvelopes(acc, 10);
  assert.deepEqual(r.envelopes.map((e) => e.from), ['a@ok.com', 'b@ok.com']);
  assert.equal(r.refused, 1);
  assert.ok(r.uidValidity);
});

test('listUnseenEnvelopes caps at max', { skip }, async () => {
  const acc = mailbox();
  for (const s of ['1', '2', '3']) await deliver(acc, 'a@ok.com', s);
  assert.equal((await listUnseenEnvelopes(acc, 2)).envelopes.length, 2);
});

test('listUnseenEnvelopes leaves everything unseen', { skip }, async () => {
  const acc = mailbox();
  await deliver(acc, 'a@ok.com', '1');
  await deliver(acc, 'a@ok.com', '2');
  const first = await listUnseenEnvelopes(acc, 10);
  const second = await listUnseenEnvelopes(acc, 10);
  assert.equal(first.envelopes.length, 2);
  assert.equal(second.envelopes.length, 2);
});

test('readMessage does not set \\Seen', { skip }, async () => {
  const acc = mailbox();
  await deliver(acc, 'a@ok.com', 'peek');
  const { envelopes } = await listUnseenEnvelopes(acc, 10);
  const msg = await readMessage(acc, envelopes[0].uid);
  assert.ok(msg);
  assert.match(msg.body, /body of peek/);
  const after = await listUnseenEnvelopes(acc, 10);
  assert.deepEqual(after.envelopes.map((e) => e.uid), [envelopes[0].uid]);
});

test('readMessage returns null for a refused sender and for a missing uid', { skip }, async () => {
  const acc = mailbox({ allowedSenders: ['*@ok.com'] });
  await deliver(acc, 'x@bad.com', 'nope');
  // The refused message is the only one in the box: UID 1.
  assert.equal(await readMessage(acc, 1), null);
  assert.equal(await readMessage(acc, 9999), null);
});

test('markSeen marks only the given uids', { skip }, async () => {
  const acc = mailbox();
  await deliver(acc, 'a@ok.com', '1');
  await deliver(acc, 'a@ok.com', '2');
  const { envelopes, uidValidity } = await listUnseenEnvelopes(acc, 10);
  assert.equal(await markSeen(acc, [envelopes[0].uid], uidValidity), 'marked');
  const after = await listUnseenEnvelopes(acc, 10);
  assert.deepEqual(after.envelopes.map((e) => e.uid), [envelopes[1].uid]);
});

test('markSeen refuses on a different uidValidity', { skip }, async () => {
  const acc = mailbox();
  await deliver(acc, 'a@ok.com', '1');
  const { envelopes } = await listUnseenEnvelopes(acc, 10);
  assert.equal(await markSeen(acc, [envelopes[0].uid], '0'), 'uidvalidity-changed');
  assert.equal((await listUnseenEnvelopes(acc, 10)).envelopes.length, 1);
});
