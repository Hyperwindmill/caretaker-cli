import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewVerdict,
  reviewTransition,
  reviewRoundLabel,
  MAX_REVIEW_ROUNDS,
  ownerNotes,
  reviewPrompt,
  runDoneReview,
} from './task_review.js';

test('PASS sentinel -> pass', () => {
  assert.equal(parseReviewVerdict('Looks good.\nREVIEW_RESULT: PASS'), 'pass');
});

test('CHANGES_REQUESTED sentinel -> changes', () => {
  assert.equal(parseReviewVerdict('Bug on line 4.\nREVIEW_RESULT: CHANGES_REQUESTED'), 'changes');
});

test('missing sentinel fails safe to changes', () => {
  assert.equal(parseReviewVerdict('I think it is probably fine.'), 'changes');
});

test('last sentinel wins when the model repeats itself', () => {
  const t = 'REVIEW_RESULT: CHANGES_REQUESTED\n...actually re-reading it...\nREVIEW_RESULT: PASS';
  assert.equal(parseReviewVerdict(t), 'pass');
});

test('a pass finalizes on any round, including one granted by an unblock', () => {
  assert.equal(reviewTransition('pass', 1), 'done');
  assert.equal(reviewTransition('pass', MAX_REVIEW_ROUNDS + 1), 'done');
});

test('changes reopen the task while automatic rounds remain', () => {
  assert.equal(reviewTransition('changes', 1), 'reopen');
  assert.equal(reviewTransition('changes', MAX_REVIEW_ROUNDS - 1), 'reopen');
});

test('changes on the last round block instead of finalizing', () => {
  assert.equal(reviewTransition('changes', MAX_REVIEW_ROUNDS), 'block');
});

test('each round past the limit blocks again on changes', () => {
  assert.equal(reviewTransition('changes', MAX_REVIEW_ROUNDS + 1), 'block');
  assert.equal(reviewTransition('changes', MAX_REVIEW_ROUNDS + 5), 'block');
});

test('round label drops the limit once past it', () => {
  assert.equal(reviewRoundLabel(2), `2/${MAX_REVIEW_ROUNDS}`);
  assert.equal(reviewRoundLabel(MAX_REVIEW_ROUNDS + 1), String(MAX_REVIEW_ROUNDS + 1));
});

test('owner notes are the user-role chat messages only', () => {
  const notes = ownerNotes([
    { role: 'user', messageType: 'chat', content: 'skip the full suite' },
    { role: 'user', messageType: 'review', content: '[CODE REVIEW round 1/3] ...' },
    { role: 'assistant', messageType: 'chat', content: 'handoff' },
  ]);
  assert.deepEqual(notes, ['skip the full suite']);
});

test('the review prompt carries the owner notes, and nothing when there are none', () => {
  const p = reviewPrompt('Build X', 'b', 1, ['do not run the test suite']);
  assert.match(p, /binding instructions/);
  assert.match(p, /do not run the test suite/);
  assert.doesNotMatch(reviewPrompt('Build X', 'b', 1), /task owner/);
});

const reviewOpts = {
  agent: { id: 'a', name: 'R', model: 'm' } as never,
  provider: { type: 'openai', endpoint: '', apiKey: '' } as never,
  tools: [],
  objective: 'o',
  branch: 'b',
  workingDir: '/tmp',
  round: 1,
};

test('a review cut by its time budget throws instead of returning a verdict', async () => {
  await assert.rejects(
    runDoneReview({
      ...reviewOpts,
      maxRunSeconds: 0.01,
      // Like a runner that stops on abort and returns what it had streamed so far.
      run: (async (o: { signal: AbortSignal }) => {
        await new Promise((r) => o.signal.addEventListener('abort', r));
        return { text: 'now running the full suite…' };
      }) as never,
    }),
    /time budget/,
  );
});

test('a review that finishes returns its verdict', async () => {
  const r = await runDoneReview({
    ...reviewOpts,
    run: (async () => ({ text: 'fine\nREVIEW_RESULT: PASS' })) as never,
  });
  assert.equal(r.verdict, 'pass');
});
