import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// File-scope env: must be set before importing anything that resolves CARETAKER_HOME.
process.env.CARETAKER_HOME = mkdtempSync(path.join(os.tmpdir(), 'ct-services-cfg-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveConfig, configPath } from './json.js';
import { isEncrypted, decrypt } from '../lib/encryption.js';
import type { ServiceConfig } from '../types.js';

function emailService(imapPassword: string): ServiceConfig {
  return {
    id: 'svc_email_1',
    name: 'Work inbox',
    type: 'email',
    enabled: true,
    agentId: '',
    cron: '',
    prompt: 'Email (IMAP) credentials',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'me@example.com',
    imapPassword,
    imapSecure: true,
  };
}

test('saveConfig encrypts a fresh imapPassword at rest', async () => {
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks: [emailService('s3cret')] } });

  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  const stored = raw.scheduler.tasks[0].imapPassword;
  assert.ok(isEncrypted(stored), 'password must be encrypted on disk');
  assert.notEqual(stored, 's3cret');
  assert.equal(decrypt(stored), 's3cret');
});

test('saveConfig does not double-encrypt an already-encrypted imapPassword', async () => {
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks: [emailService('s3cret')] } });
  const once = JSON.parse(readFileSync(configPath(), 'utf8')).scheduler.tasks[0].imapPassword;

  // Re-save the already-encrypted value, as the settings round-trip does.
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks: [emailService(once)] } });
  const twice = JSON.parse(readFileSync(configPath(), 'utf8')).scheduler.tasks[0].imapPassword;
  assert.equal(twice, once);
  assert.equal(decrypt(twice), 's3cret');
});

test('saveConfig leaves non-secret email fields and other service types alone', async () => {
  const heartbeat: ServiceConfig = {
    id: 'svc_hb_1',
    name: 'Morning report',
    type: 'heartbeat',
    enabled: true,
    agentId: 'agent_1',
    cron: '0 9 * * *',
    prompt: 'Report',
  };
  await saveConfig({ port: 3000, providers: [], scheduler: { tasks: [emailService('s3cret'), heartbeat] } });

  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  const [email, hb] = raw.scheduler.tasks;
  assert.equal(email.imapHost, 'imap.example.com');
  assert.equal(email.imapUser, 'me@example.com');
  assert.equal(email.imapPort, 993);
  assert.equal(email.imapSecure, true);
  assert.equal(hb.cron, '0 9 * * *');
  assert.equal(hb.imapPassword, undefined);
});
