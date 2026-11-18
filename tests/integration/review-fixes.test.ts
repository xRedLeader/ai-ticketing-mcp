import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.js';
import { hasCode } from '../../src/testing/contracts.js';

it('revokes a live claim when the ticket is reassigned', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const claim = await f.claim(ticket.id);
    const current = await f.read(ticket.id);
    await f.call(f.admin.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: current.ticket.revision,
      assignee_id: f.other.id,
    });
    const after = await f.read(ticket.id);
    assert.equal(after.ticket.status, 'ready');
    assert.equal(after.claim, null);
    await assert.rejects(f.submit(ticket.id, claim.claim.token), hasCode('CLAIM_EXPIRED'));
    await f.claim(ticket.id, f.other.id);
  } finally {
    await f.dispose();
  }
});

it('prevents an asker from answering its own blocking question', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const question = (await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'question',
      blocking: true,
      body: 'Which database?',
    })) as any;
    const answer = { ticket_id: ticket.id, kind: 'answer', answer_to: question.note.id, body: 'Mine.' };
    await assert.rejects(f.call(f.worker.id, 'ticket_note', answer), hasCode('INDEPENDENT_ANSWER_REQUIRED'));
    await f.call(f.other.id, 'ticket_note', answer);
    await f.claim(ticket.id);
  } finally {
    await f.dispose();
  }
});

it('removes members and protects the last admin', async () => {
  const f = await setup();
  try {
    await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'none' });
    await assert.rejects(
      f.app.execute(f.other.id, 'project_get', { project_id: f.project.id }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.call(f.admin.id, 'member_set', { actor_id: f.admin.id, role: 'contributor' }),
      hasCode('LAST_ADMIN'),
    );
    await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
    await f.call(f.admin.id, 'member_set', { actor_id: f.admin.id, role: 'none' });
  } finally {
    await f.dispose();
  }
});

it('keeps an actively worked ticket searchable', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket({ title: 'Rotate the quasar credentials' });
    await f.app.indexOnce(1000);
    const claim = await f.claim(ticket.id);
    await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      progress: 'Halfway there.',
    });
    // No reindex: progress alone must not hide the ticket.
    const result = (await f.app.execute(f.worker.id, 'search', {
      project_id: f.project.id,
      query: 'quasar credentials',
      kind: 'ticket',
    })) as any;
    assert.ok(result.results.some((item: any) => item.id === ticket.id));
  } finally {
    await f.dispose();
  }
});

it('does not reopen finished work when a prerequisite is removed', async () => {
  const f = await setup('self');
  try {
    const prerequisite = await f.ticket();
    const dependent = await f.ticket();
    await f.call(f.worker.id, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: dependent.id,
      kind: 'blocks',
      action: 'add',
    });
    await f.submit(prerequisite.id, (await f.claim(prerequisite.id)).claim.token);
    await f.submit(dependent.id, (await f.claim(dependent.id)).claim.token);
    await f.call(f.worker.id, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: dependent.id,
      kind: 'blocks',
      action: 'remove',
    });
    const after = await f.read(dependent.id);
    assert.equal(after.ticket.status, 'done');
    assert.notEqual(after.ticket.approved_submission_id, null);
  } finally {
    await f.dispose();
  }
});

it('records no event for heartbeats and prunes old receipts', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const claim = await f.claim(ticket.id);
    const before = (await f.app.execute(f.worker.id, 'changes_since', { project_id: f.project.id })) as any;
    await f.call(f.worker.id, 'work_heartbeat', { ticket_id: ticket.id, claim_token: claim.claim.token });
    const after = (await f.app.execute(f.worker.id, 'changes_since', { project_id: f.project.id })) as any;
    assert.equal(after.next_cursor, before.next_cursor);
    const key = randomUUID();
    const note = { ticket_id: ticket.id, body: 'once', idempotency_key: key };
    const first = (await f.call(f.worker.id, 'ticket_note', note)) as any;
    assert.equal(((await f.call(f.worker.id, 'ticket_note', note)) as any).note.id, first.note.id);
    assert.ok((await f.storage.pruneReceipts!(new Date(Date.now() + 60_000).toISOString())) > 0);
    // With its receipt pruned, the same key executes again instead of replaying.
    assert.notEqual(((await f.call(f.worker.id, 'ticket_note', note)) as any).note.id, first.note.id);
  } finally {
    await f.dispose();
  }
});

it('stops leasing index jobs after repeated failures', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const job = (await f.storage.get('jobs', `ticket:${ticket.id}`))!;
    assert.ok(job);
    // Simulate a job whose retries are exhausted and whose backoff has elapsed.
    await f.storage.transaction(f.project.id, async (tx) => {
      await tx.put('jobs', { ...job, attempts: 12, available_at: new Date(0).toISOString() });
    });
    assert.ok(!(await f.storage.leaseJobs(1000, 60_000)).some((item) => item.id === job.id));
  } finally {
    await f.dispose();
  }
});
