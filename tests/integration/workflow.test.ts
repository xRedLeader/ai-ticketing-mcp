import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, adapters } from './helpers.js';
import { hasCode, registerAdapterContractTests } from '../../src/testing/contracts.js';
registerAdapterContractTests('PostgreSQL', async () => adapters());

it('requires independent review and invalidates completed dependents when requirements change', async () => {
  const f = await setup();
  try {
    const prerequisite = await f.ticket();
    const dependent = await f.ticket();
    await f.call(f.worker.id, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: dependent.id,
      kind: 'blocks',
      action: 'add',
    });
    await assert.rejects(f.claim(dependent.id), hasCode('DEPENDENCY_BLOCKED'));
    const claim = await f.claim(prerequisite.id);
    const submission = await f.submit(prerequisite.id, claim.claim.token);
    assert.equal(submission.ticket.status, 'in_review');
    await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
    await assert.rejects(
      f.call(f.worker.id, 'ticket_review', {
        ticket_id: prerequisite.id,
        submission_id: submission.submission.id,
        expected_revision: submission.ticket.revision,
        decision: 'approve',
        feedback: 'self review',
      }),
      hasCode('INDEPENDENT_REVIEW_REQUIRED'),
    );
    await f.call(f.reviewer.id, 'ticket_review', {
      ticket_id: prerequisite.id,
      submission_id: submission.submission.id,
      expected_revision: submission.ticket.revision,
      decision: 'approve',
      feedback: 'Independently verified.',
    });
    const dependentClaim = await f.claim(dependent.id);
    const dependentSubmission = await f.submit(dependent.id, dependentClaim.claim.token);
    await f.call(f.reviewer.id, 'ticket_review', {
      ticket_id: dependent.id,
      submission_id: dependentSubmission.submission.id,
      expected_revision: dependentSubmission.ticket.revision,
      decision: 'approve',
      feedback: 'Checked.',
    });
    const current = await f.read(prerequisite.id);
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: prerequisite.id,
      expected_revision: current.ticket.revision,
      criteria: ['Changed requirement'],
    });
    assert.equal((await f.read(dependent.id)).ticket.status, 'ready');
    assert.equal((await f.read(dependent.id)).ticket.approved_submission_id, null);
    const original = await f.storage.get('submissions', submission.submission.id);
    assert.equal(original?.requirements_snapshot?.criteria[0]?.text, 'The access check works.');
  } finally {
    await f.dispose();
  }
});

it('supports self verification and requires human identity for human review', async () => {
  for (const policy of ['self', 'human'] as const) {
    const f = await setup(policy);
    try {
      const ticket = await f.ticket();
      const claim = await f.claim(ticket.id);
      const result = await f.submit(ticket.id, claim.claim.token);
      if (policy === 'self') assert.equal(result.ticket.status, 'done');
      else {
        await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'verifier' });
        await assert.rejects(
          f.call(f.other.id, 'ticket_review', {
            ticket_id: ticket.id,
            submission_id: result.submission.id,
            expected_revision: result.ticket.revision,
            decision: 'approve',
            feedback: 'verified',
          }),
          hasCode('HUMAN_REVIEW_REQUIRED'),
        );
        await f.call(f.reviewer.id, 'ticket_review', {
          ticket_id: ticket.id,
          submission_id: result.submission.id,
          expected_revision: result.ticket.revision,
          decision: 'approve',
          feedback: 'Human checked evidence.',
        });
      }
    } finally {
      await f.dispose();
    }
  }
});

it('recovers checkpoints, blocks on questions, and rejects cycles', async () => {
  const f = await setup();
  try {
    const a = await f.ticket();
    const b = await f.ticket();
    await f.call(f.worker.id, 'ticket_link', {
      source_id: a.id,
      target_id: b.id,
      kind: 'blocks',
      action: 'add',
    });
    await assert.rejects(
      f.call(f.worker.id, 'ticket_link', { source_id: b.id, target_id: a.id, kind: 'blocks', action: 'add' }),
      hasCode('DEPENDENCY_CYCLE'),
    );
    const claim = await f.claim(a.id);
    await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: a.id,
      claim_token: claim.claim.token,
      progress: 'Database migrated',
      remaining: ['Add authorization tests'],
    });
    const q = (await f.call(f.worker.id, 'ticket_note', {
      ticket_id: a.id,
      kind: 'question',
      blocking: true,
      body: 'Which policy?',
    })) as any;
    await assert.rejects(f.submit(a.id, claim.claim.token), hasCode('DEPENDENCY_BLOCKED'));
    await f.call(f.reviewer.id, 'ticket_note', {
      ticket_id: a.id,
      kind: 'answer',
      answer_to: q.note.id,
      body: 'Independent verification.',
    });
    f.clock.now = new Date(f.clock.now.getTime() + 601000);
    await f.claim(a.id, f.other.id);
    const context = (await f.app.execute(f.other.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: a.id,
      detail: 'brief',
    })) as any;
    assert.equal(context.latest_checkpoint.body, 'Database migrated');
    assert.deepEqual(context.latest_checkpoint.metadata.remaining, ['Add authorization tests']);
  } finally {
    await f.dispose();
  }
});

it('requires every criterion and all child work before completion', async () => {
  const f = await setup('self');
  try {
    const parent = await f.ticket({ criteria: ['First', 'Second'] });
    const child = await f.ticket({ parent_id: parent.id });
    const claim = await f.claim(parent.id);
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: parent.id,
      detail: 'brief',
    })) as any;
    assert.equal(context.completion_blockers[0].reference, child.id);
    assert.equal(Object.hasOwn(context, 'next_actions'), false);
    const children = (await f.app.execute(f.worker.id, 'ticket_list', {
      project_id: f.project.id,
      parent_id: parent.id,
    })) as any;
    assert.deepEqual(
      children.tickets.map((item: any) => item.id),
      [child.id],
    );
    await assert.rejects(f.submit(parent.id, claim.claim.token), hasCode('CHILDREN_INCOMPLETE'));
    const currentChild = await f.read(child.id);
    await f.call(f.worker.id, 'ticket_transition', {
      ticket_id: child.id,
      expected_revision: currentChild.ticket.revision,
      status: 'cancelled',
      reason: 'No longer needed',
    });
    const newClaim = await f.claim(parent.id);
    const current = await f.read(parent.id);
    await assert.rejects(
      f.call(f.worker.id, 'ticket_submit', {
        ticket_id: parent.id,
        claim_token: newClaim.claim.token,
        expected_revision: current.ticket.revision,
        summary: 'Incomplete',
        evidence: [
          {
            criterion_id: current.criteria[0].id,
            result: 'pass',
            summary: 'ok',
            references: ['https://example.test/check'],
          },
        ],
      }),
      hasCode('EVIDENCE_INCOMPLETE'),
    );
  } finally {
    await f.dispose();
  }
});

it('prevents cross-project reads and stale or archived search results', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    await assert.rejects(
      f.app.execute(f.outsider.id, 'ticket_get', { project_id: f.project.id, ticket_id: ticket.id }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.app.execute(f.outsider.id, 'changes_since', { project_id: f.project.id }),
      hasCode('FORBIDDEN'),
    );
    await f.app.indexOnce(1000);
    let result = (await f.app.execute(f.worker.id, 'search', {
      project_id: f.project.id,
      query: 'database',
    })) as any;
    assert.ok(result.results.some((r: any) => r.id === ticket.id));
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: ticket.revision,
      title: 'Changed title',
    });
    result = (await f.app.execute(f.worker.id, 'search', {
      project_id: f.project.id,
      query: 'database',
    })) as any;
    assert.ok(!result.results.some((r: any) => r.id === ticket.id));
    const doc = (await f.call(f.worker.id, 'knowledge_write', {
      title: 'Database decision',
      body: 'Use database transactions.',
      kind: 'decision',
    })) as any;
    await f.app.indexOnce(1000);
    const currentDoc = (await f.app.execute(f.worker.id, 'knowledge_get', {
      project_id: f.project.id,
      knowledge_id: doc.id,
    })) as any;
    await f.call(f.worker.id, 'knowledge_write', {
      knowledge_id: doc.id,
      expected_revision: doc.revision,
      title: doc.title,
      body: currentDoc.body,
      kind: doc.kind,
      archived: true,
    });
    result = (await f.app.execute(f.worker.id, 'search', {
      project_id: f.project.id,
      query: 'database',
    })) as any;
    assert.ok(!result.results.some((r: any) => r.id === doc.id));
  } finally {
    await f.dispose();
  }
});

it('keeps text search available when embedding generation fails', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const original = f.app.embeddings.embed;
    f.app.embeddings.embed = async () => {
      throw new Error('offline');
    };
    try {
      await f.app.indexOnce(1000);
      const result = (await f.app.execute(f.worker.id, 'search', {
        project_id: f.project.id,
        query: 'database',
      })) as any;
      assert.match(result.degraded, /unavailable/);
      assert.ok(result.results.some((r: any) => r.id === ticket.id));
    } finally {
      f.app.embeddings.embed = original;
    }
  } finally {
    await f.dispose();
  }
});

it('makes ticket creation batches atomic and preserves full requirements in context', async () => {
  const f = await setup();
  try {
    const key = randomUUID();
    await assert.rejects(
      f.call(f.worker.id, 'tickets_create', {
        idempotency_key: key,
        tickets: [
          { title: 'First', description: 'first', criteria: ['ok'] },
          { title: 'Bad parent', description: 'second', criteria: ['ok'], parent_id: randomUUID() },
        ],
      }),
      hasCode('NOT_FOUND'),
    );
    const list = (await f.app.execute(f.worker.id, 'ticket_list', { project_id: f.project.id })) as any;
    assert.equal(list.tickets.length, 0);
    const ticket = await f.ticket({ description: 'x '.repeat(8000), criteria: ['y '.repeat(499) + 'yy'] });
    await assert.rejects(
      f.app.execute(f.worker.id, 'ticket_context', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        detail: 'brief',
        max_tokens: 512,
      }),
      hasCode('CONTEXT_TOO_LARGE'),
    );
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      detail: 'full',
    })) as any;
    assert.equal(context.criteria[0].text.length, 1000);
  } finally {
    await f.dispose();
  }
});
