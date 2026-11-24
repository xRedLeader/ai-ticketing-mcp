import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compareLiveReviews, reviewUsage } from '../scripts/review-benchmark-live.mjs';
import { createReviewFixture } from '../scripts/fixtures/review-fixture.mjs';
import { mockReviewDecision } from '../scripts/review-benchmark.mjs';

it('requires an independently expected verdict and known lower total use for a paired live result', () => {
  const { expected } = createReviewFixture('comment-blocker');
  const decision = mockReviewDecision(expected);
  const full = {
    mode: 'full',
    usage: reviewUsage(200, 20, 150, 4),
    decision,
    error: null,
    model_observed: 'same',
  };
  const compact = { ...full, mode: 'compact', usage: reviewUsage(170, 20, 0, 0) };
  const compare = (candidate = compact, baseline = full) =>
    compareLiveReviews([baseline, candidate], expected);
  assert.equal(compare().reported_tokens_saved, 30); // Cached input and reasoning are already included.
  assert.equal(compare().passed, true);
  assert.equal(compare({ ...compact, usage: reviewUsage(120, undefined) }).reported_tokens_saved, null);
  assert.equal(compare({ ...compact, usage: reviewUsage(200, 20, 190, 4) }).passed, false);
  assert.equal(compare({ ...compact, usage: reviewUsage(200, 5, 190, 0) }).passed, false);
  assert.equal(compare({ ...compact, usage: reviewUsage(100, 15, 101, 0) }).passed, false);
  assert.equal(compare({ ...compact, error: 'Incomplete reviewer invocation' }).passed, false);
  assert.equal(compare({ ...compact, model_observed: 'different' }).passed, false);
  const unobserved = [
    { ...full, model_observed: null },
    { ...compact, model_observed: null },
  ];
  assert.equal(compareLiveReviews(unobserved, expected).native_responses_gate_passed, false);
  assert.equal(compareLiveReviews(unobserved, expected, 'codex').native_responses_gate_passed, false);
  const wrong = { decision: 'approve', feedback: 'All checks passed.' };
  assert.equal(compare({ ...compact, decision: wrong }, { ...full, decision: wrong }).passed, false);
});
