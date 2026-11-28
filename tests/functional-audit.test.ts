import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { it, type TestContext } from 'node:test';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import type { Reader, StorageAdapter } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { profileOperations } from '../src/profiles.js';
import { countReferenceTokens } from '../src/tokens.js';
import { fixture } from '../src/testing/contracts.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-functional-audit-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  t.after(async () => {
    await adapters.search.close();
    await adapters.storage.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-functional-audit-'));
    await rm(directory, { recursive: true });
  });
  await adapters.storage.migrate();
  return { ...(await fixture(adapters)), adapters };
}

async function finish(f: Awaited<ReturnType<typeof setup>>, ticketId: string) {
  const claim = await f.claim(ticketId);
  const submitted = await f.submit(ticketId, claim.claim.token);
  await f.call(f.reviewer.id, 'ticket_review', {
    ticket_id: ticketId,
    submission_id: submitted.submission.id,
    expected_revision: submitted.ticket.revision,
    decision: 'approve',
    feedback: 'Independently checked.',
  });
}

it('treats existing links and absent removals as no-ops across completed and claimed dependents', async (t) => {
  const f = await setup(t);
  const source = await f.ticket();
  const target = await f.ticket();
  const downstream = await f.ticket();
  const link = (sourceId: string, targetId: string, action = 'add') =>
    f.call(f.worker.id, 'ticket_link', {
      source_id: sourceId,
      target_id: targetId,
      kind: 'blocks',
      action,
    });
  await link(source.id, target.id);
  await link(target.id, downstream.id);
  await finish(f, source.id);
  await finish(f, target.id);
  const claim = await f.claim(downstream.id);
  const before = await Promise.all([f.read(target.id), f.read(downstream.id)]);
  const project = await f.storage.get('projects', f.project.id);
  await link(source.id, target.id);
  await link(target.id, downstream.id);
  await link(source.id, downstream.id, 'remove');
  assert.deepEqual(await Promise.all([f.read(target.id), f.read(downstream.id)]), before);
  assert.equal((await f.storage.get('claims', downstream.id))?.token, claim.claim.token);
  assert.deepEqual(await f.storage.get('projects', f.project.id), project);
});

it('keeps criterion IDs, approvals and dependent claims for unchanged requirements', async (t) => {
  const f = await setup(t);
  const source = await f.ticket({ criteria: ['Permit the owner.', 'Reject outsiders.'] });
  const downstream = await f.ticket();
  await f.call(f.worker.id, 'ticket_link', {
    source_id: source.id,
    target_id: downstream.id,
    kind: 'blocks',
    action: 'add',
  });
  await finish(f, source.id);
  await f.claim(downstream.id);
  const before = await f.read(source.id);
  const dependent = await f.read(downstream.id);
  await f.call(f.worker.id, 'ticket_update', {
    ticket_id: source.id,
    expected_revision: before.ticket.revision,
    title: before.ticket.title,
    description: before.ticket.description,
    parent_id: before.ticket.parent_id,
    criteria: before.criteria.map((criterion: any) => criterion.text),
  });
  const unchanged = await f.read(source.id);
  assert.deepEqual(unchanged.criteria, before.criteria);
  assert.equal(unchanged.ticket.requirements_revision, before.ticket.requirements_revision);
  assert.equal(unchanged.ticket.approved_submission_id, before.ticket.approved_submission_id);
  assert.equal(unchanged.ticket.status, 'done');
  assert.deepEqual(await f.read(downstream.id), dependent);
  await f.call(f.worker.id, 'ticket_update', {
    ticket_id: source.id,
    expected_revision: unchanged.ticket.revision,
    criteria: [...before.criteria].reverse().map((criterion: any) => criterion.text),
  });
  const changed = await f.read(source.id);
  assert.equal(changed.ticket.requirements_revision, before.ticket.requirements_revision + 1);
  assert.equal(changed.ticket.status, 'ready');
  assert.notEqual(changed.criteria[0].id, before.criteria[0].id);
  assert.equal((await f.read(downstream.id)).claim, null);
});

it('reads ticket requirements and criteria from the same snapshot during concurrent updates', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket();
  const before = await f.read(ticket.id);
  let changed = false;
  const wrap = (reader: Reader) =>
    new Proxy(reader, {
      get(target, key) {
        if (key === 'get')
          return async (...args: Parameters<Reader['get']>) => {
            const value = await target.get(...args);
            if (args[0] === 'tickets' && args[1] === ticket.id && !changed) {
              changed = true;
              await f.call(f.worker.id, 'ticket_update', {
                ticket_id: ticket.id,
                expected_revision: ticket.revision,
                description: 'New requirements.',
                criteria: ['New criterion.'],
              });
            }
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const storage = new Proxy(wrap(f.storage), {
    get(target, key) {
      if (key === 'readSnapshot')
        return (work: (reader: Reader) => Promise<unknown>) =>
          f.storage.readSnapshot((reader) => work(wrap(reader)));
      return Reflect.get(target, key);
    },
  }) as StorageAdapter;
  const app = createApplication({ storage, search: f.search });
  const result = await app.execute(f.worker.id, 'ticket_get', {
    project_id: f.project.id,
    ticket_id: ticket.id,
  });
  assert.equal(changed, true);
  assert.deepEqual(result, before);
  assert.equal((await f.read(ticket.id)).criteria[0].text, 'New criterion.');
});

it('keeps conditional fingerprints for unrelated events while detecting relevant context changes', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket();
  const other = await f.ticket();
  const input = { project_id: f.project.id, ticket_id: ticket.id, detail: 'brief' };
  const context = (extra = {}) =>
    f.app.execute(f.worker.id, 'ticket_context', { ...input, ...extra }) as Promise<any>;
  let packet = await context();
  await f.call(f.worker.id, 'ticket_note', { ticket_id: other.id, body: 'Unrelated comment.' });
  await f.ticket();
  assert.equal((await context({ if_none_match: packet.fingerprint })).not_modified, true);
  const expectChanged = async () => {
    const next = await context({ if_none_match: packet.fingerprint });
    assert.equal(next.not_modified, false);
    assert.notEqual(next.fingerprint, packet.fingerprint);
    packet = next;
  };
  const claim = await f.claim(ticket.id);
  await expectChanged();
  await f.call(f.worker.id, 'ticket_checkpoint', {
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    progress: 'Relevant checkpoint.',
  });
  await expectChanged();
  await f.call(f.worker.id, 'ticket_note', {
    ticket_id: ticket.id,
    kind: 'question',
    body: 'Relevant open question.',
  });
  await expectChanged();
  const project = (await f.storage.get('projects', f.project.id))!;
  await f.call(f.admin.id, 'project_update', {
    expected_revision: project.revision,
    instructions: 'Updated project guidance.',
  });
  await expectChanged();
  await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
  await expectChanged();
});

it('retains run checkpoints that exceed the byte count but fit the response token budget', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket();
  const claim = await f.claim(ticket.id);
  const app = createApplication({
    ...f.adapters,
    now: () => f.clock.now,
    executionRecipes: [{ id: 'verify', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
  });
  const submitted = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'verify',
    checkpoint: { progress: 'Verification completed successfully. '.repeat(160) },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  const result = (await app.execute(f.worker.id, 'run_get', {
    project_id: f.project.id,
    run_id: submitted.run_id,
    max_tokens: 4096,
  })) as any;
  assert.ok(result.checkpoint);
  assert.ok(Buffer.byteLength(JSON.stringify(result.checkpoint)) > 4096);
  assert.ok(countReferenceTokens(serializeSuccessEnvelope(result)) <= 4096);
  assert.equal(
    result.omitted.some((item: any) => item.section === 'checkpoint'),
    false,
  );
});

it('provides reviewer oversize recovery with reachable current evidence and a supported retry', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket({ description: 'Review current requirements carefully. '.repeat(150) });
  const claim = await f.claim(ticket.id);
  const submitted = await f.submit(ticket.id, claim.claim.token);
  let failure: any;
  await assert.rejects(
    f.app.execute(
      f.reviewer.id,
      'ticket_context',
      {
        project_id: f.project.id,
        ticket_id: ticket.id,
        max_tokens: 512,
      },
      'reviewer',
      true,
    ),
    (error: any) => {
      assert.equal(error.code, 'CONTEXT_TOO_LARGE');
      assert.doesNotMatch(error.message, /claim|idempotency/);
      failure = error.details;
      return true;
    },
  );
  const retry = failure.retrieval.find((entry: any) => entry.tool === 'ticket_context');
  assert.equal(retry.arguments.max_tokens, Math.min(32768, failure.required_tokens + 64));
  assert.ok(retry.arguments.max_tokens <= 32768);
  let evidence: any;
  for (const retrieval of failure.retrieval) {
    assert.ok(profileOperations.reviewer.includes(retrieval.tool));
    const result = (await f.app.execute(
      f.reviewer.id,
      retrieval.tool,
      retrieval.arguments,
      'reviewer',
      true,
    )) as any;
    if (retrieval.tool === 'ticket_history' && retrieval.arguments.kind === 'submissions')
      evidence = result.items;
  }
  assert.equal(evidence[0].id, submitted.submission.id);
  assert.equal(evidence[0].evidence[0].references[0], 'https://example.test/evidence');
});

it('avoids unsupported reviewer retries when mandatory requirements exceed maximum context', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket({
    criteria: Array.from({ length: 40 }, (_, index) => `${index} ${'requirement '.repeat(80)}`),
  });
  const app = createApplication({ ...f.adapters, countReferenceTokens: (text) => text.length });
  await assert.rejects(
    app.execute(
      f.reviewer.id,
      'ticket_context',
      {
        project_id: f.project.id,
        ticket_id: ticket.id,
        max_tokens: 32768,
      },
      'reviewer',
    ),
    (error: any) => {
      assert.equal(error.code, 'CONTEXT_TOO_LARGE');
      assert.ok(error.details.required_tokens > 32768);
      assert.equal(
        error.details.retrieval.some((entry: any) => entry.tool === 'ticket_context'),
        false,
      );
      assert.ok(error.details.retrieval.some((entry: any) => entry.tool === 'ticket_get'));
      return true;
    },
  );
});

it('keeps oversized reviewer recovery compact with hundreds of native evidence references', async (t) => {
  const f = await setup(t);
  const ticket = await f.ticket({ criteria: Array.from({ length: 15 }, (_, i) => `Criterion ${i}.`) });
  const claim = await f.claim(ticket.id);
  const app = createApplication({
    ...f.adapters,
    now: () => f.clock.now,
    executionRecipes: [{ id: 'verify', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
  });
  const submittedRun = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'verify',
    checkpoint: { progress: 'Evidence preparation.' },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  const submitted = await f.submit(ticket.id, claim.claim.token);
  const references: string[] = [];
  await f.storage.transaction(f.project.id, async (tx) => {
    const run = (await tx.get('execution_jobs', submittedRun.run_id))!;
    const continuation = (await tx.get('continuations', run.continuation_id))!;
    for (let ordinal = 1; ordinal <= 100; ordinal++) {
      const id = randomUUID();
      const runId = ordinal === 1 ? run.id : randomUUID();
      const continuationId = ordinal === 1 ? continuation.id : randomUUID();
      const artifacts = ['stdout', 'stderr', 'result'].map((kind) => `execution:${runId}:${id}:${kind}`);
      const completed = {
        ...run,
        id: runId,
        continuation_id: continuationId,
        status: 'succeeded' as const,
        exit_code: 0,
        finished_at: f.clock.now.toISOString(),
        artifacts,
      };
      if (ordinal === 1) assert.equal(await tx.compareExecutionRun!(run, completed), true);
      else {
        await tx.put('execution_jobs', completed);
        await tx.put('continuations', {
          ...continuation,
          id: continuationId,
          run_id: runId,
          status: 'satisfied',
          settled_at: f.clock.now.toISOString(),
        });
      }
      await tx.put('execution_attempts', {
        id,
        project_id: f.project.id,
        run_id: runId,
        previous_attempt_id: null,
        ordinal: 1,
        process_token: randomUUID(),
        created_at: f.clock.now.toISOString(),
      });
      references.push(...artifacts);
    }
    const submission = (await tx.get('submissions', submitted.submission.id))!;
    await tx.put('submissions', {
      ...submission,
      evidence: submission.evidence.map((item, index) => ({
        ...item,
        references: references.slice(index * 20, (index + 1) * 20),
      })),
    });
  });
  let failure: any;
  await assert.rejects(
    app.execute(
      f.reviewer.id,
      'ticket_context',
      {
        project_id: f.project.id,
        ticket_id: ticket.id,
        max_tokens: 512,
      },
      'reviewer',
      true,
    ),
    (error: any) => {
      assert.equal(error.code, 'CONTEXT_TOO_LARGE');
      failure = error.details;
      return true;
    },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(failure)) < 4096);
  const artifacts = failure.retrieval.filter((entry: any) => entry.tool === 'artifact_read');
  assert.equal(artifacts.length, 1);
  await app.execute(f.reviewer.id, 'artifact_read', artifacts[0].arguments, 'reviewer', true);
  const history = failure.retrieval.find(
    (entry: any) => entry.tool === 'ticket_history' && entry.arguments.kind === 'submissions',
  );
  assert.equal(history.arguments.item_id, submitted.submission.id);
  const evidence = (await app.execute(
    f.reviewer.id,
    history.tool,
    history.arguments,
    'reviewer',
    true,
  )) as any;
  assert.deepEqual(
    evidence.items[0].evidence.flatMap((item: any) => item.references),
    references,
  );
});

it('reports changes_since has_more only when an additional event exists', async (t) => {
  const f = await setup(t);
  const cursor = (await f.storage.get('projects', f.project.id))!.event_seq;
  await f.ticket();
  await f.ticket();
  const read = (after = cursor) =>
    f.app.execute(f.worker.id, 'changes_since', {
      project_id: f.project.id,
      cursor: after,
      limit: 2,
    }) as Promise<any>;
  const final = await read();
  assert.equal(final.events.length, 2);
  assert.equal(final.has_more, false);
  await f.ticket();
  const first = await read();
  assert.equal(first.events.length, 2);
  assert.equal(first.has_more, true);
  const last = await read(first.next_cursor);
  assert.equal(last.events.length, 1);
  assert.equal(last.has_more, false);
  const empty = await read(last.next_cursor);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.next_cursor, last.next_cursor);
  assert.equal(empty.has_more, false);
});
