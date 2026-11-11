import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict, reviewTransition, reviewRoundLabel, MAX_REVIEW_ROUNDS } from './task_review.js';

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
