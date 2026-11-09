import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CARETAKER_HOME = mkdtempSync(join(tmpdir(), 'ct-triage-'));

import type { MessageRecord } from '../../../session/types.js';
import type { ServiceConfig, AgentConfig } from '../../../types.js';
import { markdownToHtml } from '../../../lib/email.js';
import { runningTasks } from './locks.js';
import {
  TRIAGE_INSTRUCTIONS,
  buildTriagePrompt,
  executeTriageRun,
  extractReport,
  parseRecipients,
  resolveTriageAccount,
  triageSubject,
  type TriageDeps,
} from './email_triage.js';

const msg = (role: 'user' | 'assistant', content: string): MessageRecord =>
  ({ id: Math.random().toString(36), role, content, createdAt: new Date().toISOString() }) as MessageRecord;

const REPORT = '## IMPORTANT\n_No important emails._\n\n## INFORMATION\n_No information emails._\n\n## TRASH\n0 emails classified as trash (not listed).';

function mailbox(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'mb1',
    name: 'Work',
    type: 'email',
    enabled: true,
    agentId: '',
    cron: '* * * * *',
    prompt: '',
    imapHost: 'imap.example.com',
    imapUser: 'me@example.com',
    smtpHost: 'smtp.example.com',
    ...over,
  };
}

function triage(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'tr1',
    name: 'Triage',
    type: 'email_triage',
    enabled: true,
    agentId: 'a1',
    cron: '0 8 * * *',
    prompt: '',
    triageAccountId: 'mb1',
    triageRecipients: 'boss@example.com',
    triageMaxEmails: 10,
    ...over,
  };
}

const agent = { id: 'a1', name: 'Triager', provider: 'p1' } as AgentConfig;

type Calls = { order: string[]; sent: any[]; marked: any[]; saved: any[]; agentInputs: any[] };

function makeDeps(
  over: Partial<TriageDeps> = {},
  services: ServiceConfig[] = [mailbox(), triage()],
): { deps: TriageDeps; calls: Calls } {
  const calls: Calls = { order: [], sent: [], marked: [], saved: [], agentInputs: [] };
  const deps: TriageDeps = {
    load: async () => {
      calls.order.push('load');
      return {
        agents: [agent],
        config: { providers: [{ name: 'p1' }], scheduler: { tasks: services } } as any,
      };
    },
    listEnvelopes: async () => {
      calls.order.push('list');
      return {
        envelopes: [
          { uid: 4, from: 'a@x.com', subject: 'S4', date: 'd4' },
          { uid: 7, from: 'b@x.com', subject: 'S7', date: 'd7' },
        ],
        refused: 2,
        scanTruncated: false,
        uidValidity: '99',
      };
    },
    runAgent: async (i) => {
      calls.order.push('run');
      calls.agentInputs.push(i);
      return { messages: [msg('assistant', REPORT)], stop: 'done' };
    },
    send: async (_a, mail) => {
      calls.order.push('send');
      calls.sent.push(mail);
      return 'id1';
    },
    markSeen: async (_a, uids, uv) => {
      calls.order.push('mark');
      calls.marked.push({ uids, uv });
      return 'marked';
    },
    saveRun: async (id, run) => {
      calls.order.push('save');
      calls.saved.push({ id, run });
    },
    now: () => new Date(2026, 10, 9, 8, 5),
    ...over,
  };
  return { deps, calls };
}

// ─── pure ────────────────────────────────────────────────────────────────

test('extractReport returns from ## IMPORTANT, dropping a preamble', () => {
  const r = extractReport([msg('assistant', `Here you go\n\n${REPORT}\n`)], 'done');
  assert.equal(r, REPORT);
});

test('extractReport uses the last non-empty assistant message', () => {
  const r = extractReport(
    [msg('assistant', 'old'), msg('assistant', REPORT), msg('assistant', '   ')],
    'done',
  );
  assert.equal(r, REPORT);
});

test('extractReport handles an ACP-shaped record (text glued to the header)', () => {
  const rec = {
    ...msg('assistant', `Let me read 42.${REPORT}`),
    parts: [
      { type: 'text', text: 'Let me read 42.' },
      { type: 'tool_use', id: 't1', name: 'email_read', args: {} },
      { type: 'text', text: REPORT },
    ],
  } as MessageRecord;
  assert.equal(extractReport([rec], 'done'), REPORT);
});

test('extractReport is null on max_turns, aborted, or without the header', () => {
  assert.equal(extractReport([msg('assistant', REPORT)], 'max_turns'), null);
  assert.equal(extractReport([msg('assistant', REPORT)], 'aborted'), null);
  assert.equal(extractReport([msg('assistant', 'no header')], 'done'), null);
});

test('triageSubject formats local time', () => {
  assert.equal(
    triageSubject('[Email Triage]', 3, new Date(2026, 10, 9, 8, 5)),
    '[Email Triage] 3 emails triaged — 2026-11-09 08:05',
  );
});

test('parseRecipients splits on comma, newline and semicolon', () => {
  assert.deepEqual(parseRecipients('Ada <ada@example.com>, bob@example.com\ncy@example.com;'), [
    'Ada <ada@example.com>',
    'bob@example.com',
    'cy@example.com',
  ]);
  assert.deepEqual(parseRecipients(undefined), []);
});

test('buildTriagePrompt lists envelopes, account, extra and the literal-headers rule', () => {
  const envelopes = [{ uid: 4, from: 'a@x.com', subject: 'Hi', date: 'D' }];
  const p = buildTriagePrompt({ accountName: 'Work', extra: 'Write in Italian.', envelopes });
  assert.ok(p.startsWith('[UNATTENDED RUN]'));
  assert.ok(p.includes(TRIAGE_INSTRUCTIONS));
  assert.ok(p.includes('Write in Italian.'));
  assert.ok(p.includes('Account: Work — pass it as the account argument of email_read.'));
  assert.ok(p.includes('Unread emails (UID | From | Subject | Date):\n- 4 | a@x.com | Hi | D'));
  assert.match(TRIAGE_INSTRUCTIONS, /never be translated/);
  const blank = buildTriagePrompt({ accountName: 'Work', extra: '  ', envelopes });
  assert.equal(blank.includes('\n\n\n'), false);
  assert.ok(blank.indexOf(TRIAGE_INSTRUCTIONS) < blank.indexOf('Account: Work'));
});

test('resolveTriageAccount: happy path and every error', () => {
  const svc = triage();
  const ok = resolveTriageAccount([mailbox(), svc], svc, 'a1');
  assert.ok('account' in ok && ok.account.id === 'mb1');

  const err = (services: ServiceConfig[], s = svc) => {
    const r = resolveTriageAccount(services, s, 'a1');
    assert.ok('error' in r, 'expected error');
    return (r as { error: string }).error;
  };
  const msgs = [
    err([svc]),
    err([mailbox({ type: 'heartbeat' }), svc]),
    err([mailbox({ enabled: false }), svc]),
    err([mailbox({ allowedAgents: ['other'] }), svc]),
    err([mailbox({ imapHost: '' }), svc]),
    err([mailbox({ smtpHost: '' }), svc]),
    err([mailbox({ imapUser: '', smtpFrom: '' }), svc]),
  ];
  assert.equal(new Set(msgs).size, 7);
  const scoped = resolveTriageAccount([mailbox({ allowedAgents: ['a1'] }), svc], svc, 'a1');
  assert.ok('account' in scoped);
});

// ─── core ────────────────────────────────────────────────────────────────

test('extractReport accepts a decorated header', () => {
  for (const h of ['## IMPORTANT (3)', '## IMPORTANT:']) {
    const body = `${h}\n_No important emails._`;
    assert.equal(extractReport([msg('assistant', `intro\n${body}`)], 'done'), body);
  }
  assert.equal(extractReport([msg('assistant', '## IMPORTANTLY\nx')], 'done'), null);
});

test('empty mailbox, window truncated → logged failure, no agent/send/mark', async () => {
  const { deps, calls } = makeDeps({
    listEnvelopes: async () => ({ envelopes: [], refused: 200, scanTruncated: true, uidValidity: '1' }),
  });
  const out = await executeTriageRun(triage(), deps);
  assertFailure(calls, out, /oldest 200 unread[\s\S]*allowedSenders/);
  assert.equal(calls.order.includes('run'), false);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.marked.length, 0);
});

test('some included, window truncated → success with a warning in the summary', async () => {
  const base = makeDeps();
  const { deps, calls } = makeDeps({
    listEnvelopes: async (...a) => ({ ...(await base.deps.listEnvelopes(...a)), scanTruncated: true }),
  });
  const out = await executeTriageRun(triage(), deps);
  assert.equal(out.kind, 'success');
  const summary = calls.saved[0].run.messages.at(-1).content;
  assert.match(summary, /oldest 200/);
});

test('empty recipients → failure before listEnvelopes and the agent', async () => {
  const { deps, calls } = makeDeps();
  const out = await executeTriageRun(triage({ triageRecipients: ' ; , ' }), deps);
  assertFailure(calls, out, /recipient/i);
  assert.equal(calls.order.includes('list'), false);
  assert.equal(calls.order.includes('run'), false);
});

test('send and markSeen are not tied to the budget signal', async () => {
  const sigs: Record<string, AbortSignal | undefined> = {};
  const { deps } = makeDeps({
    runAgent: async (i) => {
      sigs.run = i.signal;
      return { messages: [msg('assistant', REPORT)], stop: 'done' };
    },
    send: async (_a, _m, s) => {
      sigs.send = s;
      return 'id';
    },
    markSeen: async (_a, _u, _v, s) => {
      sigs.mark = s;
      return 'marked';
    },
  });
  await executeTriageRun(triage(), deps);
  assert.ok(sigs.run);
  assert.notEqual(sigs.send, sigs.run);
  assert.notEqual(sigs.mark, sigs.run);
});

test('empty mailbox → skipped, no runAgent, no saveRun', async () => {
  const { deps, calls } = makeDeps({
    listEnvelopes: async () => ({ envelopes: [], refused: 3, scanTruncated: false, uidValidity: '1' }),
  });
  const out = await executeTriageRun(triage(), deps);
  assert.deepEqual(out, { kind: 'skipped' });
  assert.deepEqual(calls.order, ['load']);
});

test('happy path sends once and marks exactly the included uids', async () => {
  const { deps, calls } = makeDeps();
  const out = await executeTriageRun(triage(), deps);
  assert.deepEqual(out, { kind: 'success', included: 2, refused: 2, marked: true });
  assert.deepEqual(calls.order, ['load', 'list', 'run', 'send', 'mark', 'save']);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0].to, ['boss@example.com']);
  assert.equal(calls.sent[0].subject, '[Email Triage] 2 emails triaged — 2026-11-09 08:05');
  assert.equal(calls.sent[0].body, REPORT);
  assert.equal(calls.sent[0].html, markdownToHtml(REPORT));
  assert.deepEqual(calls.marked, [{ uids: [4, 7], uv: '99' }]);
  const run = calls.saved[0].run;
  assert.equal(run.status, 'success');
  const last = run.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, 'Triage: 2 included, 2 refused by sender allowlist, marked read');
  assert.equal(calls.agentInputs[0].workingDir.length > 0, true);
});

function assertFailure(calls: Calls, out: any, match: RegExp) {
  assert.equal(out.kind, 'failure');
  assert.match(out.error, match);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.marked.length, 0);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].run.status, 'failure');
  assert.match(calls.saved[0].run.error, match);
}

test('agent throws → failure logged, no send, no mark', async () => {
  const { deps, calls } = makeDeps({
    runAgent: async () => {
      throw new Error('boom');
    },
  });
  assertFailure(calls, await executeTriageRun(triage(), deps), /boom/);
});

test('max_turns → failure, no send, no mark', async () => {
  const { deps, calls } = makeDeps({
    runAgent: async () => ({ messages: [msg('assistant', REPORT)], stop: 'max_turns' }),
  });
  assertFailure(calls, await executeTriageRun(triage(), deps), /max_turns/);
});

test('report without ## IMPORTANT → failure, no send, no mark', async () => {
  const { deps, calls } = makeDeps({
    runAgent: async () => ({ messages: [msg('assistant', 'hello')], stop: 'done' }),
  });
  assertFailure(calls, await executeTriageRun(triage(), deps), /## IMPORTANT/);
});

test('smtp failure → failure logged, no mark', async () => {
  const { deps, calls } = makeDeps({
    send: async () => {
      throw new Error('smtp down');
    },
  });
  assertFailure(calls, await executeTriageRun(triage(), deps), /smtp down/);
});

test('markSeen throws → success with warning, log status success', async () => {
  const { deps, calls } = makeDeps({
    markSeen: async () => {
      throw new Error('imap gone');
    },
  });
  const out: any = await executeTriageRun(triage(), deps);
  assert.equal(out.kind, 'success');
  assert.equal(out.marked, false);
  assert.match(out.warning, /imap gone/);
  assert.equal(calls.saved[0].run.status, 'success');
  assert.match(calls.saved[0].run.messages.at(-1).content, /not marked read: .*imap gone/);
});

test('uidvalidity changed → success, marked false', async () => {
  const { deps, calls } = makeDeps({ markSeen: async () => 'uidvalidity-changed' });
  const out: any = await executeTriageRun(triage(), deps);
  assert.equal(out.kind, 'success');
  assert.equal(out.marked, false);
  assert.ok(out.warning);
  assert.equal(calls.saved[0].run.status, 'success');
});

test('account disabled → failure before listEnvelopes', async () => {
  const { deps, calls } = makeDeps({}, [mailbox({ enabled: false }), triage()]);
  const out = await executeTriageRun(triage(), deps);
  assert.equal((out as any).kind, 'failure');
  assert.equal(calls.order.includes('list'), false);
  assert.equal(calls.saved[0].run.status, 'failure');
});

test('missing agent → failure', async () => {
  const { deps, calls } = makeDeps();
  const out = await executeTriageRun(triage({ agentId: 'nope' }), deps);
  assert.equal((out as any).kind, 'failure');
  assert.equal(calls.sent.length, 0);
});

test('listEnvelopes throws → failure', async () => {
  const { deps, calls } = makeDeps({
    listEnvelopes: async () => {
      throw new Error('imap refused');
    },
  });
  assertFailure(calls, await executeTriageRun(triage(), deps), /imap refused/);
});

test('second run while the first is in flight → skipped', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = makeDeps();
  const { deps } = makeDeps({
    listEnvelopes: async (...a) => {
      await gate;
      return base.deps.listEnvelopes(...a);
    },
  });
  const first = executeTriageRun(triage(), deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await executeTriageRun(triage(), deps), { kind: 'skipped' });
  release();
  assert.equal(((await first) as any).kind, 'success');
  assert.equal(runningTasks.has('tr1'), false);
});

test('the run is aborted after the budget', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let sig!: AbortSignal;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = makeDeps({
      runAgent: async (i) => {
        sig = i.signal;
        await gate;
        return { messages: [], stop: 'aborted' };
      },
    });
    const run = executeTriageRun(triage(), deps);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(sig.aborted, false);
    mock.timers.tick(900_000);
    assert.equal(sig.aborted, true);
    release();
    assert.equal(((await run) as any).kind, 'failure');
  } finally {
    mock.timers.reset();
  }
});

test('triageMaxEmails: unset → 50, 100 → 100, 500 → 200, 7 → 7', async () => {
  for (const [input, want] of [[undefined, 50], [100, 100], [500, 200], [7, 7]] as const) {
    let got = -1;
    const base = makeDeps();
    const { deps } = makeDeps({
      listEnvelopes: async (a, max, s) => {
        got = max;
        return base.deps.listEnvelopes(a, max, s);
      },
    });
    await executeTriageRun(triage({ triageMaxEmails: input }), deps);
    assert.equal(got, want);
  }
});
