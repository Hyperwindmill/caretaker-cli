import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File-scope isolation: dataDir() reads CARETAKER_HOME at call time.
const HOME = mkdtempSync(join(tmpdir(), 'ct-tgrun-'));
process.env.CARETAKER_HOME = HOME;

// Telegram API calls (typing indicator, outbound messages) must not touch the
// network; every tgApi call goes through global fetch.
globalThis.fetch = (async () => ({ json: async () => ({ ok: true, result: {} }) })) as any;

const { executeTelegramTaskRun } = await import('./telegram.js');
const { telegramSessionId } = await import('./telegram_window.js');

await mkdir(HOME, { recursive: true });
await writeFile(
  join(HOME, 'agents.json'),
  JSON.stringify([
    { id: 'a1', name: 'Tester', provider: 'p1', model: 'm1', systemPrompt: '', workingDir: HOME, allowedTools: [], confirmTools: [], plugins: [], mcpServers: [] },
  ]),
  'utf8',
);
await writeFile(
  join(HOME, 'caretaker.json'),
  JSON.stringify({ providers: [{ name: 'p1', endpoint: 'http://127.0.0.1:1/v1', apiKey: 'k' }] }),
  'utf8',
);

const service: any = { id: 'svc1', name: 'tg', type: 'telegram', agentId: 'a1', enabled: true };

function windowWith(attachments: any[]) {
  return {
    chatId: 7,
    chatLabel: 'Lab',
    chatType: 'private',
    entries: [{ updateId: 1, fromLabel: '@ada', text: 'cosa vedi?', attachments }],
    firstAt: 1,
  };
}

test('the run tells the harness which session the attachments live in', async () => {
  // Without sessionId the harness resolves attachments under attachments/default/
  // and silently drops every image, so this is the seam the whole feature hangs on.
  let seen: any = null;
  await executeTelegramTaskRun(service, windowWith([{ mime: 'image/png', id: 'x.png' }]), {
    run: (async (opts: any) => {
      seen = opts;
      return { text: '', toolCalls: 0, usage: {}, stop: 'done' };
    }) as any,
  });
  assert.equal(seen.sessionId, telegramSessionId(7));
  assert.deepEqual(seen.promptAttachments, [{ mime: 'image/png', id: 'x.png' }]);
});
