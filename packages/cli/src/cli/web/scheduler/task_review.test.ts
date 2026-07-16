import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict } from './task_review.js';

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
