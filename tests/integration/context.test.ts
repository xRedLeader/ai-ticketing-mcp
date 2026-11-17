import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { serializeSuccessEnvelope } from '../../src/envelope.js';
import { schemas } from '../../src/schemas.js';
import { countReferenceTokens } from '../../src/tokens.js';
import { hasCode, testEmbeddings } from '../../src/testing/contracts.js';
import { setup } from './helpers.js';

it('budgets the final canonical context envelope at an exact boundary', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket({ description: 'Current requirements <|endoftext|> 🧪' });
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      embeddings: testEmbeddings,
      now: () => f.clock.now,
      countReferenceTokens: (text) => text.length,
    });
    const input = { project_id: f.project.id, ticket_id: ticket.id };
    const full = await app.execute(f.worker.id, 'ticket_context', { ...input, max_tokens: 32768 });
    const count = serializeSuccessEnvelope(full).length;
    const exact = await app.execute(f.worker.id, 'ticket_context', { ...input, max_tokens: count });
    assert.equal(serializeSuccessEnvelope(exact).length, count);
    await assert.rejects(
      app.execute(f.worker.id, 'ticket_context', { ...input, max_tokens: count - 1 }),
      (error: any) => error.code === 'CONTEXT_TOO_LARGE' && error.details.required_tokens === count,
    );
    const production = (await f.app.execute(f.worker.id, 'ticket_context', input)) as any;
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(production)) <= 4096);
    assert.equal(production.ticket.description, ticket.description);
  } finally {
    await f.dispose();
  }
});

it('rolls back every claim side effect when mandatory context exceeds its budget', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket({ description: 'x '.repeat(7500) });
    const project = await f.storage.get('projects', f.project.id);
    const job = await f.storage.get('jobs', `ticket:${ticket.id}`);
    await assert.rejects(
      f.call(f.worker.id, 'work_claim', { ticket_id: ticket.id, max_tokens: 512 }),
      (error: any) => {
        assert.equal(error.code, 'CONTEXT_TOO_LARGE');
        assert.equal(error.details.ticket_id, ticket.id);
        assert.ok(error.details.required_tokens > 512);
        assert.deepEqual(
          error.details.retrieval.map((item: any) => item.tool),
          ['ticket_get', 'project_get'],
        );
        return true;
      },
    );
    assert.deepEqual(await f.storage.get('tickets', ticket.id), ticket);
    assert.deepEqual(await f.storage.get('projects', f.project.id), project);
    assert.deepEqual(await f.storage.get('jobs', `ticket:${ticket.id}`), job);
    assert.equal(await f.storage.get('claims', ticket.id), null);
    assert.equal(
      (await f.storage.find('receipts', { where: { project_id: f.project.id, operation: 'work_claim' } }))
        .length,
      0,
    );
    const claimed = (await f.call(f.worker.id, 'work_claim', {
      ticket_id: ticket.id,
      include_context: false,
    })) as any;
    assert.equal(claimed.context_omitted, 'requested');
    assert.equal(claimed.ticket.description, undefined);
    assert.ok(claimed.claim.token);
  } finally {
    await f.dispose();
  }
});

it('returns executable required checkpoint and submission follow-ups, without historical snapshots', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket({ criteria: ['First check.', 'Second check.', 'Third check.'] });
    const claim = await f.claim(ticket.id);
    const checkpoint = (await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      progress: 'x '.repeat(7500),
      decisions: ['Preserve owner validation.'],
    })) as any;
    assert.equal(checkpoint.ticket.revision, checkpoint.checkpoint.ticket_revision);
    assert.equal(checkpoint.checkpoint.body, undefined);
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    })) as any;
    const omitted = context.omitted.find((item: any) => item.section === 'latest_checkpoint');
    assert.equal(omitted.required_before, 'execution');
    const retrieved = (await f.app.execute(f.worker.id, omitted.retrieve_with, omitted.arguments)) as any;
    assert.equal(retrieved.id, checkpoint.checkpoint.id);
    assert.equal(retrieved.ticket_revision, omitted.revision);
    assert.deepEqual(retrieved.metadata.decisions, ['Preserve owner validation.']);
    const current = await f.read(ticket.id);
    const submitted = (await f.call(f.worker.id, 'ticket_submit', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      expected_revision: checkpoint.ticket.revision,
      summary: 'Evidence recorded.',
      evidence: current.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'x '.repeat(1900),
        references: ['https://example.test/evidence'],
      })),
    })) as any;
    const reviewContext = (await f.app.execute(f.reviewer.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    })) as any;
    const evidence = reviewContext.omitted.find((item: any) => item.section === 'submissions');
    assert.equal(evidence.required_before, 'review');
    const history = (await f.app.execute(f.reviewer.id, evidence.retrieve_with, evidence.arguments)) as any;
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].id, submitted.submission.id);
    const detailed = (await f.app.execute(f.reviewer.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      detail: 'full',
    })) as any;
    assert.equal(detailed.submissions[0].requirements_snapshot, undefined);
    const direct = await f.read(ticket.id);
    for (const field of ['notes', 'submissions', 'reviews', 'history'])
      assert.equal(Object.hasOwn(direct, field), false);
  } finally {
    await f.dispose();
  }
});

it('rebuilds authorized fingerprints for state changes and effective lease expiration', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const claimed = await f.claim(ticket.id);
    const input = { project_id: f.project.id, ticket_id: ticket.id };
    const first = (await f.app.execute(f.worker.id, 'ticket_context', input)) as any;
    f.clock.now = new Date(f.clock.now.getTime() + 1000);
    assert.deepEqual(
      await f.app.execute(f.worker.id, 'ticket_context', { ...input, if_none_match: first.fingerprint }),
      { fingerprint: first.fingerprint, not_modified: true },
    );
    const observer = (await f.app.execute(f.other.id, 'ticket_context', input)) as any;
    assert.equal(observer.claim.token, undefined);
    assert.notEqual(observer.fingerprint, first.fingerprint);
    f.clock.now = new Date(f.clock.now.getTime() + 601000);
    const expired = (await f.app.execute(f.worker.id, 'ticket_context', {
      ...input,
      if_none_match: first.fingerprint,
    })) as any;
    assert.equal(expired.not_modified, false);
    assert.equal(expired.claim.expired, true);
    const reclaimed = await f.claim(ticket.id, f.other.id);
    assert.notEqual(reclaimed.claim.token, claimed.claim.token);
    const changed = (await f.app.execute(f.worker.id, 'ticket_context', {
      ...input,
      if_none_match: expired.fingerprint,
    })) as any;
    assert.equal(changed.claim.token, undefined);
    assert.notEqual(changed.fingerprint, expired.fingerprint);
    await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'reader' });
    const roleChanged = (await f.app.execute(f.worker.id, 'ticket_context', {
      ...input,
      if_none_match: changed.fingerprint,
    })) as any;
    assert.notEqual(roleChanged.fingerprint, changed.fingerprint);
    await f.storage.transaction(f.project.id, async (tx) =>
      tx.remove('members', `${f.project.id}:${f.worker.id}`),
    );
    await assert.rejects(
      f.app.execute(f.worker.id, 'ticket_context', { ...input, if_none_match: roleChanged.fingerprint }),
      hasCode('FORBIDDEN'),
    );
  } finally {
    await f.dispose();
  }
});

it('reloads a revoked administrator after entering the project transaction', async () => {
  const f = await setup();
  const transaction = f.storage.transaction.bind(f.storage);
  try {
    const ticket = await f.ticket();
    await transaction('catalog', async (tx) => tx.put('actors', { ...f.outsider, system_admin: true }));
    let revoked = false;
    f.storage.transaction = (scope, work) =>
      transaction(scope, async (tx) => {
        if (scope === f.project.id && !revoked) {
          revoked = true;
          await transaction('catalog', async (catalog) =>
            catalog.put('actors', { ...f.outsider, system_admin: false }),
          );
        }
        return work(tx);
      });
    await assert.rejects(
      f.call(f.outsider.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        priority: 1,
      }),
      hasCode('FORBIDDEN'),
    );
    assert.deepEqual(await f.storage.get('tickets', ticket.id), ticket);
  } finally {
    f.storage.transaction = transaction;
    await f.dispose();
  }
});

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

it('replays legacy claims deterministically without rewriting receipts or renewing credentials', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const input = { project_id: f.project.id, ticket_id: ticket.id, idempotency_key: randomUUID() };
    const claimed = (await f.app.execute(f.worker.id, 'work_claim', input)) as any;
    const receipt = (
      await f.storage.find('receipts', { where: { project_id: f.project.id, operation: 'work_claim' } })
    )[0]!;
    const legacyInput: Record<string, unknown> = { ...schemas.work_claim.parse(input) };
    delete legacyInput.include_context;
    delete legacyInput.max_tokens;
    const legacy = {
      ...receipt,
      input_hash: createHash('sha256').update(canonical(legacyInput)).digest('hex'),
      result: { ticket: await f.storage.get('tickets', ticket.id), claim: claimed.claim },
    };
    await f.storage.transaction(f.project.id, async (tx) => tx.put('receipts', legacy));
    f.clock.now = new Date(f.clock.now.getTime() + 601000);
    await f.claim(ticket.id, f.other.id);
    const replay = (await f.app.execute(f.worker.id, 'work_claim', input)) as any;
    assert.equal(replay.context_omitted, 'legacy_receipt');
    assert.deepEqual(replay.claim, claimed.claim);
    assert.equal(replay.ticket.revision, claimed.ticket.revision);
    assert.equal(
      serializeSuccessEnvelope(replay),
      serializeSuccessEnvelope(await f.app.execute(f.worker.id, 'work_claim', input)),
    );
    assert.deepEqual(await f.storage.get('receipts', receipt.id), legacy);
    await assert.rejects(
      f.app.execute(f.worker.id, 'work_claim', { ...input, max_tokens: 8192 }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    await f.storage.transaction(f.project.id, async (tx) =>
      tx.put('receipts', { ...legacy, result: { unavailable: true } }),
    );
    await assert.rejects(
      f.app.execute(f.worker.id, 'work_claim', input),
      (error: any) => error.code === 'RECEIPT_UNAVAILABLE' && error.details.committed === true,
    );
  } finally {
    await f.dispose();
  }
});

it('keeps token-accounting failures from changing committed mutations', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      embeddings: testEmbeddings,
      referenceTokenMetrics: true,
      countReferenceTokens: () => {
        throw new Error('counter unavailable');
      },
    });
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      idempotency_key: randomUUID(),
      body: 'Committed note.',
    };
    const result = (await app.execute(f.worker.id, 'ticket_note', input)) as any;
    assert.doesNotThrow(() => app.recordReferenceTokens('result', serializeSuccessEnvelope(result)));
    assert.equal(app.metrics.token_accounting_failures, 1);
    assert.deepEqual(await app.execute(f.worker.id, 'ticket_note', input), result);
    assert.equal((await f.storage.find('notes', { where: { ticket_id: ticket.id } })).length, 1);
  } finally {
    await f.dispose();
  }
});

it('keeps a combined claim byte-stable through JSONB replay at its exact budget', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      embeddings: testEmbeddings,
      now: () => f.clock.now,
      countReferenceTokens: (text) => text.length,
    });
    const base = { project_id: f.project.id, ticket_id: ticket.id };
    const first = (await app.execute(f.worker.id, 'work_claim', {
      ...base,
      idempotency_key: randomUUID(),
      max_tokens: 32768,
    })) as any;
    const boundary = serializeSuccessEnvelope(first).length;
    await f.call(f.worker.id, 'work_release', {
      ticket_id: ticket.id,
      claim_token: first.claim.token,
      reason: 'Boundary check.',
    });
    const exactInput = { ...base, idempotency_key: randomUUID(), max_tokens: boundary };
    const exact = (await app.execute(f.worker.id, 'work_claim', exactInput)) as any;
    assert.equal(serializeSuccessEnvelope(exact).length, boundary);
    assert.equal(
      serializeSuccessEnvelope(await app.execute(f.worker.id, 'work_claim', exactInput)),
      serializeSuccessEnvelope(exact),
    );
    await f.call(f.worker.id, 'work_release', {
      ticket_id: ticket.id,
      claim_token: exact.claim.token,
      reason: 'Boundary check.',
    });
    await assert.rejects(
      app.execute(f.worker.id, 'work_claim', {
        ...base,
        idempotency_key: randomUUID(),
        max_tokens: boundary - 1,
      }),
      hasCode('CONTEXT_TOO_LARGE'),
    );
    assert.equal(await f.storage.get('claims', ticket.id), null);
    assert.equal(app.embeddings.metrics.embedding_calls, 0);
  } finally {
    await f.dispose();
  }
});

it('uses the refreshed reviewer kind when a human becomes an agent while queued', async () => {
  const f = await setup('human');
  const transaction = f.storage.transaction.bind(f.storage);
  try {
    const ticket = await f.ticket();
    const claimed = await f.claim(ticket.id);
    const submitted = await f.submit(ticket.id, claimed.claim.token);
    let changed = false;
    f.storage.transaction = (scope, work) =>
      transaction(scope, async (tx) => {
        if (scope === f.project.id && !changed) {
          changed = true;
          await transaction('catalog', async (catalog) =>
            catalog.put('actors', { ...f.reviewer, kind: 'agent' }),
          );
        }
        return work(tx);
      });
    await assert.rejects(
      f.call(f.reviewer.id, 'ticket_review', {
        ticket_id: ticket.id,
        expected_revision: submitted.ticket.revision,
        submission_id: submitted.submission.id,
        decision: 'approve',
        feedback: 'Reviewed.',
      }),
      hasCode('HUMAN_REVIEW_REQUIRED'),
    );
    assert.equal((await f.storage.get('tickets', ticket.id))?.status, 'in_review');
  } finally {
    f.storage.transaction = transaction;
    await f.dispose();
  }
});

it('batches dependency reads and refuses an overflowing mandatory question set', async () => {
  const f = await setup();
  const transaction = f.storage.transaction.bind(f.storage);
  const readSnapshot = f.storage.readSnapshot.bind(f.storage);
  try {
    const ticket = await f.ticket();
    await transaction(f.project.id, async (tx) => {
      for (let index = 0; index < 20; index++) {
        const source = {
          ...ticket,
          id: randomUUID(),
          key: `${f.project.key}-P${index}`,
          status: 'done' as const,
        };
        await tx.put('tickets', source);
        await tx.put('links', {
          id: randomUUID(),
          project_id: f.project.id,
          source_id: source.id,
          target_id: ticket.id,
          kind: 'blocks',
        });
      }
    });
    let ticketGets = 0;
    let questionQueries = 0;
    let overflow = false;
    f.storage.readSnapshot = (work) =>
      readSnapshot(async (tx) =>
        work({
          ...tx,
          get: async (table, id) => {
            if (table === 'tickets') ticketGets++;
            return tx.get(table, id);
          },
          unansweredQuestions: async (...args) => {
            questionQueries++;
            if (overflow && args[2])
              return Array(10001).fill({ id: randomUUID(), body: 'Unanswered blocker.' });
            return tx.unansweredQuestions(...args);
          },
        }),
      );
    const context = (await f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      max_tokens: 32768,
    })) as any;
    assert.equal(context.dependencies.length, 20);
    assert.equal(ticketGets, 1);
    assert.equal(questionQueries, 2);
    overflow = true;
    await assert.rejects(
      f.app.execute(f.worker.id, 'ticket_context', { project_id: f.project.id, ticket_id: ticket.id }),
      hasCode('GRAPH_LIMIT'),
    );
  } finally {
    f.storage.readSnapshot = readSnapshot;
    await f.dispose();
  }
});

it('validates the final mutation receipt before committing writes', async () => {
  const f = await setup();
  const app = f.app as any;
  const mutate = app.mutateTicket.bind(app);
  try {
    const ticket = await f.ticket();
    app.mutateTicket = async (...args: unknown[]) => {
      const result = await mutate(...args);
      return { ...result, ticket: { ...result.ticket, revision: 'invalid' } };
    };
    await assert.rejects(
      f.call(f.worker.id, 'ticket_note', { ticket_id: ticket.id, body: 'Must roll back.' }),
      hasCode('INVALID_RESULT'),
    );
    assert.deepEqual(await f.storage.get('tickets', ticket.id), ticket);
    assert.equal((await f.storage.find('notes', { where: { ticket_id: ticket.id } })).length, 0);
  } finally {
    app.mutateTicket = mutate;
    await f.dispose();
  }
});

it('keeps claim-only recovery compact and enforces budgets before commit and on replay', async () => {
  const f = await setup();
  try {
    const capabilities = Array.from({ length: 30 }, (_, index) => String(index).padEnd(80, '漢'));
    const ticket = await f.ticket({ capabilities, labels: capabilities });
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      capabilities,
      include_context: false,
      idempotency_key: randomUUID(),
    };
    const counted = createApplication({
      storage: f.storage,
      search: f.search,
      embeddings: testEmbeddings,
      countReferenceTokens: () => 5000,
    });
    await assert.rejects(counted.execute(f.worker.id, 'work_claim', input), hasCode('CONTEXT_TOO_LARGE'));
    assert.equal(await f.storage.get('claims', ticket.id), null);
    const result = (await f.app.execute(f.worker.id, 'work_claim', input)) as any;
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(result)) <= 4096);
    assert.equal(result.ticket.capabilities, undefined);
    assert.equal(result.ticket.labels, undefined);
    await assert.rejects(
      counted.execute(f.worker.id, 'work_claim', input),
      (error: any) =>
        error.code === 'RECEIPT_UNAVAILABLE' &&
        error.details.committed === true &&
        error.details.required_tokens === 5000,
    );
    assert.equal((await f.storage.get('claims', ticket.id))?.token, result.claim.token);
  } finally {
    await f.dispose();
  }
});

it('invalidates fingerprints for project requirements, ticket history, and dependency revisions', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const source = await f.ticket();
    const input = { project_id: f.project.id, ticket_id: ticket.id };
    let context = (await f.app.execute(f.worker.id, 'ticket_context', input)) as any;
    const changed = async () => {
      const next = (await f.app.execute(f.worker.id, 'ticket_context', {
        ...input,
        if_none_match: context.fingerprint,
      })) as any;
      assert.equal(next.not_modified, false);
      assert.notEqual(next.fingerprint, context.fingerprint);
      context = next;
    };
    await f.call(f.admin.id, 'project_update', {
      expected_revision: f.project.revision,
      instructions: 'Current project instruction.',
    });
    await changed();
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: context.ticket.revision,
      description: 'Current ticket requirement.',
    });
    await changed();
    await f.call(f.worker.id, 'ticket_note', { ticket_id: ticket.id, body: 'New history entry.' });
    await changed();
    await f.call(f.worker.id, 'ticket_link', {
      source_id: source.id,
      target_id: ticket.id,
      kind: 'related',
      action: 'add',
    });
    await changed();
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: source.id,
      expected_revision: source.revision,
      priority: 1,
    });
    await changed();
    assert.equal(context.project_instructions.text, 'Current project instruction.');
    assert.equal(context.ticket.description, 'Current ticket requirement.');
    assert.equal(context.dependencies[0].ticket.revision, source.revision + 1);
    assert.equal(f.app.embeddings.metrics.embedding_calls, 0);
  } finally {
    await f.dispose();
  }
});

it('requires exact omitted rejection feedback before resumed execution', async () => {
  const f = await setup();
  try {
    const ticket = await f.ticket();
    const claimed = await f.claim(ticket.id);
    const submission = await f.submit(ticket.id, claimed.claim.token);
    const review = (await f.call(f.reviewer.id, 'ticket_review', {
      ticket_id: ticket.id,
      expected_revision: submission.ticket.revision,
      submission_id: submission.submission.id,
      decision: 'request_changes',
      feedback: 'x '.repeat(7500),
    })) as any;
    const resumed = await f.claim(ticket.id, f.other.id);
    const omitted = resumed.context.omitted.find((item: any) => item.section === 'reviews');
    assert.equal(omitted.required_before, 'execution');
    const retrieved = (await f.app.execute(f.other.id, omitted.retrieve_with, omitted.arguments)) as any;
    assert.equal(retrieved.items.length, 1);
    assert.equal(retrieved.items[0].id, review.review.id);
    assert.equal(retrieved.items[0].decision, 'request_changes');
    assert.equal(retrieved.items[0].feedback, 'x '.repeat(7500).trim());
  } finally {
    await f.dispose();
  }
});
