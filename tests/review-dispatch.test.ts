import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
// @ts-expect-error The standalone dispatcher runs directly on Node.
import { openLedger, scanReviews } from '../examples/review-dispatch.mjs';

it('routes a pending independent submission once and retries recording the durable decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-review-dispatch-'));
  const ledgerPath = join(directory, 'review.sqlite');
  let db = openLedger(ledgerPath);
  try {
    const projectId = 'project',
      reviewerId = 'astra';
    const ticket = {
      id: 'ticket',
      key: 'GAME-2',
      status: 'in_review',
      requirements_revision: 1,
      revision: 2,
    };
    let project = { policy: 'independent', reviewer_actor_id: 'other' };
    let submission = { id: 'submission', actor_id: 'worker', requirements_revision: 1 };
    let launches = 0;
    const recorded: Record<string, unknown>[] = [];
    const app = {
      async execute(actor: string, operation: string, input: Record<string, unknown>) {
        assert.equal(actor, reviewerId);
        assert.equal(input.project_id, projectId);
        switch (operation) {
          case 'project_get': {
            return { project, members: [{ actor_id: reviewerId, kind: 'agent', role: 'verifier' }] };
          }
          case 'ticket_list':
            return { tickets: [ticket] };
          case 'ticket_history':
            return { items: [submission] };
          case 'ticket_get':
            return { ticket };
          case 'ticket_review': {
            assert.equal(input.expected_revision, 2);
            assert.equal(input.submission_id, submission.id);
            recorded.push(input);
            if (recorded.length === 1) throw new Error('lost connection before commit');
            ticket.status = 'done';
            return {};
          }
          default:
            throw new Error(`Unexpected operation ${operation}`);
        }
      },
    };
    const scan = () =>
      scanReviews({
        app,
        projectId,
        reviewerId,
        db,
        async review() {
          launches++;
          return { decision: 'approve', feedback: 'The pinned evidence meets the criterion.' };
        },
      });
    await scan();
    assert.equal(launches, 0);
    project = { policy: 'independent', reviewer_actor_id: reviewerId };
    const original = submission;
    submission = { ...original, actor_id: reviewerId };
    await scan();
    assert.equal(launches, 0);
    submission = original;
    await scan();
    db.close();
    db = openLedger(ledgerPath);
    await scan();
    await scan();
    assert.equal(launches, 1);
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded[0], recorded[1]);
    assert.equal(ticket.status, 'done');
  } finally {
    db.close();
    await rm(ledgerPath);
    await rmdir(directory);
  }
});
