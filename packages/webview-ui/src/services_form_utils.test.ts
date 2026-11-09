import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceConfig } from 'caretaker-types';
import { triageFormError, triageAccountOptions, splitRecipients } from './services_form_utils.js';

const svc = (o: Partial<ServiceConfig>): ServiceConfig =>
  ({ id: 'a', name: 'A', type: 'email', enabled: true, agentId: '', cron: '', prompt: '', ...o }) as ServiceConfig;

const mail = svc({ id: 'm1', imapHost: 'imap.x', smtpHost: 'smtp.x' });
const valid = { agentId: 'ag', cron: '*/15 * * * *', accountId: 'm1', recipients: 'a@b.c', maxEmails: '50' };

test('triageFormError: valid form', () => {
  assert.equal(triageFormError(valid, [mail]), null);
});

test('triageFormError: each missing piece', () => {
  assert.ok(triageFormError({ ...valid, agentId: '' }, [mail]));
  assert.ok(triageFormError({ ...valid, cron: '* * *' }, [mail]));
  assert.ok(triageFormError({ ...valid, accountId: '' }, [mail]));
  assert.ok(triageFormError({ ...valid, accountId: 'zz' }, [mail]));
  assert.ok(triageFormError({ ...valid, recipients: ' \n ' }, [mail]));
});

test('triageFormError: maxEmails must be an integer 1-200', () => {
  for (const bad of ['0', '201', '1.5', 'x', '']) {
    assert.ok(triageFormError({ ...valid, maxEmails: bad }, [mail]), bad);
  }
  assert.equal(triageFormError({ ...valid, maxEmails: '1' }, [mail]), null);
  assert.equal(triageFormError({ ...valid, maxEmails: '200' }, [mail]), null);
});

test('triageAccountOptions keeps only enabled accounts that can read and send', () => {
  const list = [
    mail,
    svc({ id: 'off', enabled: false, imapHost: 'i', smtpHost: 's' }),
    svc({ id: 'sendonly', smtpHost: 's' }),
    svc({ id: 'readonly', imapHost: 'i' }),
    svc({ id: 'hb', type: 'heartbeat', imapHost: 'i', smtpHost: 's' }),
  ];
  assert.deepEqual(triageAccountOptions(list, 'ag').map(s => s.id), ['m1']);
});

test('triageAccountOptions drops accounts scoped to other agents', () => {
  const scoped = svc({ id: 's', imapHost: 'i', smtpHost: 's', allowedAgents: ['other'] });
  const open = svc({ id: 'o', imapHost: 'i', smtpHost: 's', allowedAgents: ['ag'] });
  assert.deepEqual(triageAccountOptions([scoped, open, mail], 'ag').map(s => s.id), ['o', 'm1']);
  assert.ok(triageFormError(valid, triageAccountOptions([svc({ ...scoped, id: 'm1' })], 'ag')));
});

test('recipients may be separated by semicolons', () => {
  assert.deepEqual(splitRecipients('a@x.com; b@x.com'), ['a@x.com', 'b@x.com']);
  assert.equal(triageFormError({ ...valid, recipients: ' ; ' }, [mail]) !== null, true);
  assert.equal(triageFormError({ ...valid, recipients: 'a@x.com; b@x.com' }, [mail]), null);
});
