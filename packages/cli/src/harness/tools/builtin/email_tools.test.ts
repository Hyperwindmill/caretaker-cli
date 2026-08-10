import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: the store and the encryption key both resolve under it.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-email-tools-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveConfig } from '../../../store/json.js';
import type { ServiceConfig } from '../../../types.js';
import type { ToolContext } from '../types.js';
import { emailListAccountsTool, emailSendTool, emailFetchTool } from './email_tools.js';

const ctx = {
  workingDir: process.cwd(),
  signal: new AbortController().signal,
  readPaths: new Set<string>(),
} as ToolContext;

function service(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'svc_1',
    name: 'Work',
    type: 'email',
    enabled: true,
    agentId: '',
    cron: '',
    prompt: '',
    imapHost: 'imap.example.com',
    imapUser: 'me@example.com',
    imapPassword: 's3cret',
    // A host that cannot resolve: if the allowlist guard ever stopped running
    // first, these tests would fail with an SMTP error instead of a refusal.
    smtpHost: 'smtp.invalid',
    smtpPort: 587,
    allowedRecipients: '*@example.com',
    ...over,
  };
}

async function writeServices(tasks: ServiceConfig[]): Promise<void> {
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks } });
}

function parse(content: string): any {
  return JSON.parse(content);
}

test('email_list_accounts reports the account without leaking secrets', async () => {
  await writeServices([service()]);
  const res = await emailListAccountsTool.execute({}, ctx);
  assert.ok(!res.content.includes('s3cret'), 'password must not appear in the tool result');
  const { accounts } = parse(res.content);
  assert.deepEqual(accounts, [
    {
      name: 'Work',
      from: 'me@example.com',
      canSend: 'smtp.invalid:587',
      canRead: 'imap.example.com:993',
      allowedRecipients: ['*@example.com'],
      allowedSenders: 'any',
    },
  ]);
});

test('email_fetch refuses an account with no IMAP host', async () => {
  await writeServices([service({ imapHost: '' })]);
  const res = await emailFetchTool.execute({ account: 'Work' }, ctx);
  assert.match(parse(res.content).error, /has no IMAP host/);
});

test('email_fetch reports the readable accounts when the name is unknown', async () => {
  await writeServices([service()]);
  const res = await emailFetchTool.execute({ account: 'Nope' }, ctx);
  assert.match(parse(res.content).error, /Readable accounts: Work/);
});

test('email_list_accounts reports an unrestricted account as "any"', async () => {
  await writeServices([service({ allowedRecipients: '' })]);
  const { accounts } = parse((await emailListAccountsTool.execute({}, ctx)).content);
  assert.equal(accounts[0].allowedRecipients, 'any');
});

test('email_send refuses an unknown account and lists the available ones', async () => {
  await writeServices([service()]);
  const res = await emailSendTool.execute(
    { account: 'Personal', to: ['ada@example.com'], subject: 'hi', body: 'x' },
    ctx,
  );
  assert.match(parse(res.content).error, /Unknown email account "Personal".*Available: Work/);
});

test('email_send refuses a recipient outside the allowlist before connecting', async () => {
  await writeServices([service()]);
  const res = await emailSendTool.execute(
    { account: 'work', to: ['ada@example.com', 'eve@evil.net'], subject: 'hi', body: 'x' },
    ctx,
  );
  const { error } = parse(res.content);
  assert.match(error, /not allowed by account "Work": eve@evil\.net/);
  assert.doesNotMatch(error, /SMTP/, 'no connection may be attempted');
});

test('email_send checks cc and bcc against the allowlist too', async () => {
  await writeServices([service()]);
  for (const field of ['cc', 'bcc']) {
    const res = await emailSendTool.execute(
      {
        account: 'Work',
        to: ['ada@example.com'],
        [field]: 'eve@evil.net',
        subject: 'hi',
        body: 'x',
      },
      ctx,
    );
    assert.match(parse(res.content).error, /eve@evil\.net/, `${field} must be checked`);
  }
});

test('email_send accepts a display-name recipient whose address is allowed', async () => {
  await writeServices([service()]);
  const res = await emailSendTool.execute(
    { account: 'Work', to: ['Ada Lovelace <ada@example.com>'], subject: 'hi', body: 'x' },
    ctx,
  );
  // Passes the allowlist, then fails on the unresolvable host — which is the
  // proof that the guard let it through.
  assert.match(parse(res.content).error, /SMTP send failed/);
});

test('email_send validates its own arguments', async () => {
  await writeServices([service()]);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ to: ['ada@example.com'], subject: 'hi', body: 'x' }, /account must be/],
    [{ account: 'Work', to: [], subject: 'hi', body: 'x' }, /at least one recipient/],
    [{ account: 'Work', to: ['ada@example.com'], subject: ' ', body: 'x' }, /subject must be/],
    [{ account: 'Work', to: ['ada@example.com'], subject: 'hi' }, /body must be/],
    [{ account: 'Work', to: 42, subject: 'hi', body: 'x' }, /must be a string or an array/],
    [
      { account: 'Work', to: ['ada@example.com'], subject: 'hi', body: 'x', html: { p: 1 } },
      /html must be a string/,
    ],
  ];
  for (const [args, expected] of cases) {
    const res = await emailSendTool.execute(args, ctx);
    assert.match(parse(res.content).error, expected);
  }
});

test('a scoped account is invisible to another agent, in both directions', async () => {
  await writeServices([service({ allowedAgents: ['agent_1'] })]);
  const stranger = { ...ctx, callerAgent: { id: 'agent_2' } } as ToolContext;

  const { accounts } = parse((await emailListAccountsTool.execute({}, stranger)).content);
  assert.deepEqual(accounts, [], 'the account must not be listed');

  // Naming it directly reads as "unknown", never "forbidden": the agent must not
  // be able to confirm that a mailbox it may not use exists.
  const sent = await emailSendTool.execute(
    { account: 'Work', to: ['ada@example.com'], subject: 'hi', body: 'x' },
    stranger,
  );
  assert.match(parse(sent.content).error, /Unknown email account "Work"/);
  const fetched = await emailFetchTool.execute({ account: 'Work' }, stranger);
  assert.match(parse(fetched.content).error, /Unknown email account "Work"/);

  // The owner still sees it.
  const owner = { ...ctx, callerAgent: { id: 'agent_1' } } as ToolContext;
  const mine = parse((await emailListAccountsTool.execute({}, owner)).content);
  assert.equal(mine.accounts.length, 1);
});

test('an already-aborted run never opens a connection', async () => {
  await writeServices([service({ imapHost: 'imap.invalid' })]);
  const aborted = new AbortController();
  aborted.abort();
  const dead = { ...ctx, signal: aborted.signal } as ToolContext;

  const sent = await emailSendTool.execute(
    { account: 'Work', to: ['ada@example.com'], subject: 'hi', body: 'x' },
    dead,
  );
  assert.match(parse(sent.content).error, /aborted before connecting/);
  const fetched = await emailFetchTool.execute({ account: 'Work' }, dead);
  assert.match(parse(fetched.content).error, /aborted before connecting/);
});

test('email_send ignores a disabled account', async () => {
  await writeServices([service({ enabled: false })]);
  const res = await emailSendTool.execute(
    { account: 'Work', to: ['ada@example.com'], subject: 'hi', body: 'x' },
    ctx,
  );
  assert.match(parse(res.content).error, /No account is configured for sending/);
});
