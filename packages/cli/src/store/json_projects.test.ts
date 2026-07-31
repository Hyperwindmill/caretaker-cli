import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope CARETAKER_HOME so config and encryption key land in a temp dir.
process.env.CARETAKER_HOME = await mkdtemp(join(tmpdir(), 'ct-json-proj-'));

const { saveConfig, configPath } = await import('./json.js');
const { isEncrypted } = await import('../lib/encryption.js');

const project = {
  id: 1,
  name: 'p',
  description: '',
  workingDir: '',
  agentId: 'a',
  active: true,
  repositoryUrl: 'https://example.com/org/repo.git',
  repositoryToken: 'ghp_supersecret',
};

test('saveConfig encrypts projects[].repositoryToken at rest, without double-encrypting', async () => {
  await saveConfig({ port: 1, providers: [], projects: [{ ...project }] });

  const raw = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.ok(isEncrypted(raw.projects[0].repositoryToken), 'token must be encrypted on disk');
  assert.ok(!JSON.stringify(raw).includes('ghp_supersecret'), 'plaintext must not hit disk');

  // Round-trip an already-encrypted config (the saveConfig websocket path):
  // the blob must pass through unchanged, not be encrypted twice.
  const first = raw.projects[0].repositoryToken;
  await saveConfig({ port: 1, providers: [], projects: [{ ...project, repositoryToken: first }] });
  const raw2 = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.equal(raw2.projects[0].repositoryToken, first);
});
