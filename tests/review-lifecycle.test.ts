import assert from 'node:assert/strict';
import { it } from 'node:test';
// @ts-expect-error standalone offline benchmark runs with the tsx loader.
import {
  captureReviewLifecyclePair,
  discoverLifecycleTools,
  runReviewLifecycleBenchmark,
} from '../scripts/review-lifecycle.mjs';

it('retrieves every discovery page and requires the operations before starting the lifecycle', async () => {
  const calls: unknown[] = [];
  const client = {
    async listTools(input: { cursor?: string }) {
      calls.push(input);
      return input.cursor
        ? { tools: [{ name: 'ticket_review' }] }
        : { tools: [{ name: 'ticket_get' }], nextCursor: 'review-page' };
    },
  };
  assert.deepEqual(await discoverLifecycleTools(client, ['ticket_get', 'ticket_review']), [
    'ticket_get',
    'ticket_review',
  ]);
  assert.deepEqual(calls, [{}, { cursor: 'review-page' }]);
  await assert.rejects(discoverLifecycleTools(client, ['ticket_submit']), /was not discovered/);
});

it('resolves every deficient ticket only after repair and records every lifecycle boundary', async () => {
  const report = await runReviewLifecycleBenchmark();
  assert.equal(report.workflows.length, 4);
  assert.equal(report.totals.baseline.correct_finalized_tickets, 4);
  assert.equal(report.totals.candidate.correct_finalized_tickets, 4);
  assert.equal(report.totals.baseline.model_requests, 9);
  assert.equal(report.totals.candidate.model_requests, 8);
  assert.ok(report.totals.candidate.wire_reference_tokens < report.totals.baseline.wire_reference_tokens);
  for (const workflow of report.workflows) {
    for (const arm of [workflow.baseline, workflow.candidate]) {
      assert.equal(arm.submitted_evidence_requests, 2);
      assert.equal(arm.retrieved_submission_evidence_requests, 2);
      assert.ok(arm.tool_discovery_requests >= 2);
      assert.equal(
        arm.groups['mcp/tools/list/request'].messages,
        arm.groups['mcp/tools/list/response'].messages,
      );
      assert.equal(arm.recorded_review_requests, 2);
      assert.equal(arm.rejected_submissions, 1);
      assert.equal(arm.repair_checkpoint_requests, 1);
      assert.equal(arm.repair_files_written.length, 1);
      assert.equal(arm.stages[0].decision, 'request_changes');
      assert.equal(arm.stages[1].decision, 'approve');
      assert.equal(arm.provider_usage, null);
      assert.equal(arm.uncached_provider_tokens, null);
      assert.equal(arm.provider_latency_ms, null);
      assert.equal(arm.reference_tokens_per_correctly_finalized_ticket, arm.wire_reference_tokens);
      assert.ok(arm.observed_offline_lifecycle_ms > 0);
    }
  }
  const missing = report.workflows.find(
    (workflow: { scenario: string }) => workflow.scenario === 'missing-evidence',
  );
  assert.equal(missing.baseline.preflight_rejections, 0);
  assert.equal(missing.baseline.model_requests, 2);
  assert.equal(missing.candidate.preflight_rejections, 1);
  assert.equal(missing.candidate.model_requests, 1);
  assert.deepEqual(missing.candidate.stages[0].evidence_coverage[0].statuses, ['missing']);
  for (const scenario of ['comment-blocker', 'wrong-header']) {
    const workflow = report.workflows.find((entry: { scenario: string }) => entry.scenario === scenario);
    assert.equal(workflow.candidate.preflight_rejections, 0);
    assert.equal(workflow.candidate.model_requests, 2);
  }
  const retry = report.workflows.find(
    (workflow: { scenario: string }) => workflow.scenario === 'provider-retry',
  );
  for (const arm of [retry.baseline, retry.candidate]) {
    assert.equal(arm.retries, 1);
    assert.equal(arm.retryable_launch_failures, 1);
    assert.equal(arm.model_requests, 3);
    assert.equal(arm.model_responses, 3);
    assert.equal(arm.stages[0].requests[0].status, 429);
    assert.equal(arm.stages[0].requests[1].status, 200);
  }
});

it('proves the missing candidate model request is a real criterion-specific preflight rejection', async () => {
  const pair = await captureReviewLifecyclePair('missing-evidence');
  assert.equal(pair.baseline.stages[0].requests.length, 1);
  assert.equal(pair.candidate.stages[0].requests.length, 0);
  assert.equal(pair.candidate.stages[0].preflight, true);
  assert.equal(pair.candidate.stages[0].decision, 'request_changes');
  assert.match(pair.candidate.stages[0].feedback, /criterion/i);
  assert.equal(pair.candidate.stages[1].requests.length, 1);
  assert.equal(pair.candidate.correct_finalized_tickets, 1);
});

it('rejects the bad header and finalizes only the repaired current submission', async () => {
  const pair = await captureReviewLifecyclePair('wrong-header');
  for (const arm of [pair.baseline, pair.candidate]) {
    assert.equal(arm.stages[0].preflight, false);
    assert.match(
      arm.stages[0].feedback,
      /SAMPLE-HEADER: wrong prefix; observed_prefix=e37d5cd68b3d10f2, expected_prefix=53594e5448524354\./,
    );
    assert.equal(arm.stages[0].requests.length, 1);
    assert.equal(arm.stages[1].requests.length, 1);
    assert.notEqual(arm.stages[0].submission_id, arm.stages[1].submission_id);
    assert.equal(arm.repairs[0].reference, 'evidence/cache.json');
    assert.ok(arm.repairs[0].bytes > 0);
    assert.equal(
      arm.events.filter(
        (event: { boundary: string; direction: string }) =>
          event.boundary === 'provider-mock' && event.direction === 'request',
      ).length,
      2,
    );
  }
});
