import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../application.js';
import type { ExecutionOutcome, StorageAdapter } from '../contracts.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerExecutionContractTests(
  name: string,
  factory: () => Promise<ContractAdapters & { reopen: () => Promise<ContractAdapters> }>,
) {
  const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} execution: ${title}`, async () => {
      const f = await setup();
      try {
        await work(f);
      } finally {
        await f.dispose?.();
      }
    });
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const recipe = { id: 'verified-script', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] };
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      now: () => f.clock.now,
      executionRecipes: [recipe],
    });
    const ticket = await f.ticket();
    const claim = await f.claim(ticket.id);
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: recipe.id,
      checkpoint: { progress: 'Waiting for registered validation.', remaining: ['Inspect result.'] },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    };
    const submit = (overrides = {}) =>
      app.execute(f.worker.id, 'run_submit', { ...input, ...overrides }) as Promise<any>;
    const get = (runId: string, actorId = f.worker.id) =>
      app.execute(actorId, 'run_get', { project_id: f.project.id, run_id: runId }) as Promise<any>;
    return { ...f, ...adapters, app, recipe, ticket, claim, input, submit, get };
  }
  const outcome: ExecutionOutcome = {
    exit_code: 0,
    signal: null,
    artifacts: ['execution:result'],
    error_code: null,
  };
  check('waits without retaining a transaction and returns bounded authorized run status', async (f) => {
    const receipt = await f.submit();
    const input = { project_id: f.project.id, run_id: receipt.run_id, timeout_ms: 0 };
    assert.deepEqual(await f.app.execute(f.worker.id, 'run_wait', input), await f.get(receipt.run_id));
    for (const extra of [{ timeout_ms: 30001 }, { command: 'untrusted' }])
      await assert.rejects(
        f.app.execute(f.worker.id, 'run_wait', { ...input, ...extra }),
        hasCode('INVALID_INPUT'),
      );
    const started = performance.now();
    const bounded = (await f.app.execute(f.worker.id, 'run_wait', { ...input, timeout_ms: 60 })) as any;
    assert.ok(performance.now() - started >= 50);
    assert.equal(bounded.run.status, 'queued');
    const waiting = f.app.execute(f.worker.id, 'run_wait', { ...input, timeout_ms: 3000 });
    await delay(25);
    await f.app.cancelExecutionRun(f.admin.id, f.project.id, receipt.run_id);
    const completed = (await waiting) as any;
    assert.equal(completed.run.status, 'failed');
    assert.equal(completed.run.error_code, 'CANCELLED_NOT_STARTED');
    assert.deepEqual(completed, await f.get(receipt.run_id));
  });
  check('reauthorizes each wait snapshot after project access is revoked', async (f) => {
    const receipt = await f.submit();
    const waiting = assert.rejects(
      f.app.execute(f.worker.id, 'run_wait', {
        project_id: f.project.id,
        run_id: receipt.run_id,
        timeout_ms: 3000,
      }),
      hasCode('FORBIDDEN'),
    );
    await delay(25);
    await f.app.execute(f.admin.id, 'member_set', {
      project_id: f.project.id,
      actor_id: f.worker.id,
      role: 'none',
      idempotency_key: randomUUID(),
    });
    await waiting;
  });
  check('the trusted companion renews only live authorized claims across the original lease', async (f) => {
    const receipt = await f.submit();
    const controller = (await f.app.acquireExecutionController(
      f.admin.id,
      f.project.id,
      'companion',
      3600000,
    ))!;
    try {
      const run = (await f.app.reserveExecutionRun(
        f.admin.id,
        f.project.id,
        receipt.run_id,
        60000,
        controller,
      ))!;
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        run.id,
        run.reservation_token!,
        60000,
        controller,
      );
      const originalExpiry = f.claim.claim.expires_at;
      for (let step = 0; step < 25; step++) {
        f.clock.now = new Date(f.clock.now.getTime() + 30000);
        assert.equal(
          await f.app.heartbeatExecutionRun(
            f.admin.id,
            f.project.id,
            run.id,
            run.reservation_token!,
            60000,
            controller,
          ),
          true,
        );
      }
      assert.ok(f.clock.now.toISOString() > originalExpiry);
      assert.ok((await f.storage.get('claims', f.ticket.id))!.expires_at > f.clock.now.toISOString());
      assert.equal(
        await f.app.settleExecutionRun(
          f.admin.id,
          f.project.id,
          run.id,
          run.reservation_token!,
          outcome,
          controller,
        ),
        true,
      );
      const current = await f.read(f.ticket.id);
      const submitted = (await f.call(f.worker.id, 'ticket_submit', {
        ticket_id: f.ticket.id,
        claim_token: f.claim.claim.token,
        expected_revision: current.ticket.revision,
        summary: 'Verified execution result.',
        evidence: current.criteria.map((criterion: any) => ({
          criterion_id: criterion.id,
          result: 'pass',
          summary: 'Exact run succeeded.',
          references: [`run:${run.id}`],
        })),
      })) as any;
      assert.equal(submitted.ticket.status, 'in_review');
    } finally {
      await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
    }
  });
  check('companion heartbeats cannot renew revoked or expired worker authority', async (f) => {
    const receipt = await f.submit();
    const controller = (await f.app.acquireExecutionController(
      f.admin.id,
      f.project.id,
      'companion',
      3600000,
    ))!;
    try {
      const run = (await f.app.reserveExecutionRun(
        f.admin.id,
        f.project.id,
        receipt.run_id,
        3600000,
        controller,
      ))!;
      const original = await f.storage.get('claims', f.ticket.id);
      await f.app.execute(f.admin.id, 'member_set', {
        project_id: f.project.id,
        actor_id: f.worker.id,
        role: 'reader',
        idempotency_key: randomUUID(),
      });
      assert.equal(
        await f.app.heartbeatExecutionRun(
          f.admin.id,
          f.project.id,
          run.id,
          run.reservation_token!,
          60000,
          controller,
        ),
        false,
      );
      assert.deepEqual(await f.storage.get('claims', f.ticket.id), original);
      await f.app.execute(f.admin.id, 'member_set', {
        project_id: f.project.id,
        actor_id: f.worker.id,
        role: 'contributor',
        idempotency_key: randomUUID(),
      });
      f.clock.now = new Date(f.clock.now.getTime() + 600001);
      assert.equal(
        await f.app.heartbeatExecutionRun(
          f.admin.id,
          f.project.id,
          run.id,
          run.reservation_token!,
          60000,
          controller,
        ),
        false,
      );
      assert.deepEqual(await f.storage.get('claims', f.ticket.id), original);
    } finally {
      await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
    }
  });
  check('cancels through strict admin receipts and reauthorizes identical retries', async (f) => {
    const receipt = await f.submit();
    const input = { project_id: f.project.id, run_id: receipt.run_id, idempotency_key: randomUUID() };
    await assert.rejects(f.app.execute(f.worker.id, 'run_cancel', input), hasCode('FORBIDDEN'));
    await f.app.execute(f.admin.id, 'member_set', {
      project_id: f.project.id,
      actor_id: f.other.id,
      role: 'admin',
      idempotency_key: randomUUID(),
    });
    const cancelled = (await f.app.execute(f.other.id, 'run_cancel', input)) as any;
    assert.deepEqual(await f.app.execute(f.other.id, 'run_cancel', input), cancelled);
    assert.deepEqual(
      Object.keys(cancelled).sort(),
      ['run_id', 'project_id', 'requested_at', 'process_state', 'effects_state', 'retrieval'].sort(),
    );
    assert.equal(cancelled.process_state, 'never_started');
    assert.equal(cancelled.effects_state, 'not_started');
    assert.equal((await f.get(receipt.run_id)).checkpoint.body, f.input.checkpoint.progress);
    assert.ok(await f.storage.get('claims', f.ticket.id));
    await assert.rejects(
      f.app.execute(f.other.id, 'run_cancel', { ...input, run_id: randomUUID() }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    const foreign = (await f.app.execute(f.admin.id, 'project_create', {
      idempotency_key: randomUUID(),
      key: 'C' + randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(),
      name: 'Other project',
      reviewer_actor_id: f.reviewer.id,
    })) as any;
    await assert.rejects(
      f.app.execute(f.admin.id, 'run_cancel', { ...input, project_id: foreign.id }),
      hasCode('NOT_FOUND'),
    );
    await f.app.execute(f.admin.id, 'member_set', {
      project_id: f.project.id,
      actor_id: f.other.id,
      role: 'contributor',
      idempotency_key: randomUUID(),
    });
    await assert.rejects(f.app.execute(f.other.id, 'run_cancel', input), hasCode('FORBIDDEN'));
  });

  check(
    'atomically stores checkpoint, separate job, continuation and one immutable compact retry receipt',
    async (f) => {
      const [receipt, retry] = await Promise.all([f.submit(), f.submit()]);
      assert.deepEqual(retry, receipt);
      assert.ok(JSON.stringify(receipt).length < 1000);
      const jobs = await f.storage.find('execution_jobs', { where: { project_id: f.project.id } });
      const continuations = await f.storage.find('continuations', { where: { project_id: f.project.id } });
      assert.equal(jobs.length, 1);
      assert.equal(continuations.length, 1);
      const view = await f.get(receipt.run_id);
      assert.equal(view.checkpoint.body, f.input.checkpoint.progress);
      assert.deepEqual(view.checkpoint.metadata.remaining, ['Inspect result.']);
      assert.equal(view.continuation.status, 'pending');
      assert.equal(view.continuation.run_id, view.run.id);
      assert.equal('claim_token' in view.run, false);
      assert.equal('reservation_token' in view.run, false);
      assert.ok(
        (await f.storage.find('jobs', { where: { project_id: f.project.id } })).every(
          (job) => !('recipe_id' in job),
        ),
      );
      await f.call(f.worker.id, 'work_release', {
        ticket_id: f.ticket.id,
        claim_token: f.claim.claim.token,
        reason: 'Disconnecting.',
      });
      const reopened = createApplication({ storage: f.storage, search: f.search });
      assert.deepEqual(await reopened.execute(f.worker.id, 'run_submit', f.input), receipt);
      await assert.rejects(f.submit({ recipe_id: 'changed' }), hasCode('IDEMPOTENCY_CONFLICT'));
      await f.app.execute(f.admin.id, 'member_set', {
        project_id: f.project.id,
        actor_id: f.worker.id,
        role: 'reader',
        idempotency_key: randomUUID(),
      });
      await assert.rejects(f.submit(), hasCode('FORBIDDEN'));
    },
  );
  check('rolls back all submission records when receipt persistence fails', async (f) => {
    const storage = new Proxy(f.storage, {
      get(target, property) {
        if (property === 'transaction')
          return (scope: string, work: Parameters<StorageAdapter['transaction']>[1]) =>
            target.transaction(scope, (tx) =>
              work(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key === 'put')
                      return async (table: string, value: any) => {
                        if (table === 'receipts') throw new Error('receipt persistence failed');
                        return transaction.put(table as any, value);
                      };
                    const value = Reflect.get(transaction, key);
                    return typeof value === 'function' ? value.bind(transaction) : value;
                  },
                }),
              ),
            );
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createApplication({ storage, search: f.search, executionRecipes: [f.recipe] });
    await assert.rejects(app.execute(f.worker.id, 'run_submit', f.input), /receipt persistence failed/);
    for (const table of ['execution_jobs', 'continuations', 'notes'] as const)
      assert.equal((await f.storage.find(table, { where: { project_id: f.project.id } })).length, 0);
    assert.equal((await f.storage.get('tickets', f.ticket.id))!.revision, f.claim.ticket.revision);
  });
  check(
    'rejects recipes, untrusted command fields, stale claims and out-of-project reads without writes',
    async (f) => {
      await assert.rejects(f.submit({ recipe_id: 'unregistered' }), hasCode('RECIPE_NOT_AUTHORIZED'));
      await assert.rejects(f.submit({ claim_token: randomUUID() }), hasCode('CLAIM_EXPIRED'));
      for (const extra of [
        { argv: ['unsafe'] },
        { env: { SECRET: 'unsafe' } },
        { executable: 'unsafe' },
        { completion_condition: { kind: 'expression', expression: 'unsafe' } },
        { completion_condition: { kind: 'exit_code', exit_code: 256 } },
      ])
        await assert.rejects(f.submit(extra), hasCode('INVALID_INPUT'));
      const unauthorized = createApplication({
        storage: f.storage,
        search: f.search,
        executionRecipes: [{ ...f.recipe, project_ids: [randomUUID()] }],
      });
      await assert.rejects(
        unauthorized.execute(f.worker.id, 'run_submit', f.input),
        hasCode('RECIPE_NOT_AUTHORIZED'),
      );
      assert.equal(
        (await f.storage.find('execution_jobs', { where: { project_id: f.project.id } })).length,
        0,
      );
      const receipt = await f.submit();
      await assert.rejects(f.get(receipt.run_id, f.outsider.id), hasCode('FORBIDDEN'));
      const other = await fixture({ storage: f.storage, search: f.search });
      await assert.rejects(
        f.app.execute(other.worker.id, 'run_get', { project_id: other.project.id, run_id: receipt.run_id }),
        hasCode('NOT_FOUND'),
      );
      await assert.rejects(f.app.listExecutionRuns(f.outsider.id, f.project.id), hasCode('FORBIDDEN'));
      await assert.rejects(f.app.listExecutionRuns(f.worker.id, f.project.id), hasCode('FORBIDDEN'));
      await assert.rejects(
        f.app.reserveExecutionRun(f.worker.id, f.project.id, receipt.run_id, 60_000),
        hasCode('FORBIDDEN'),
      );
    },
  );
  check('fences duplicate reservations and terminal writes while the claim is current', async (f) => {
    const receipt = await f.submit();
    assert.deepEqual(
      (await f.app.listExecutionRuns(f.admin.id, f.project.id)).map((run) => run.id),
      [receipt.run_id],
    );
    const reservations = await Promise.all(
      [1, 2].map(() => f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000)),
    );
    assert.equal(reservations.filter(Boolean).length, 1);
    const run = reservations.find(Boolean)!;
    assert.equal(await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, randomUUID(), 60_000), null);
    assert.ok(
      await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
    );
    assert.equal(
      await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, randomUUID(), outcome),
      false,
    );
    assert.equal(
      await f.app.heartbeatExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
      true,
    );
    assert.equal(
      await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
      true,
    );
    assert.equal(
      await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
      true,
    );
    assert.equal(
      await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
        ...outcome,
        exit_code: 1,
      }),
      false,
    );
    const view = await f.get(run.id);
    assert.equal(view.run.status, 'succeeded');
    assert.equal(view.continuation.status, 'satisfied');
    assert.deepEqual(view.run.artifacts, outcome.artifacts);
    assert.deepEqual(await f.submit(), receipt);
  });
  check(
    'preserves an authoritative result after requirements change and fails only its continuation',
    async (f) => {
      const receipt = await f.submit();
      const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
      await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000);
      const ticket = (await f.read(f.ticket.id)).ticket;
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        criteria: ['Changed acceptance.'],
      });
      assert.equal(
        await f.app.heartbeatExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
        true,
      );
      assert.equal(
        await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
        true,
      );
      const view = await f.get(run.id);
      assert.equal(view.run.exit_code, 0);
      assert.equal(view.run.status, 'succeeded');
      assert.equal(view.stale, true);
      assert.equal(view.continuation.status, 'failed');
      assert.equal(view.continuation.failure_reason, 'STALE_AUTHORITY');
      assert.deepEqual(await f.submit(), receipt);
    },
  );
  check(
    'never reclaims an expired reservation or accepts stale ownership after claim replacement',
    async (f) => {
      const receipt = await f.submit();
      const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 1000))!;
      f.clock.now = new Date(f.clock.now.getTime() + 1001);
      assert.equal(await f.app.reserveExecutionRun(f.admin.id, f.project.id, run.id, 60_000), null);
      assert.equal(
        await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
        null,
      );
      assert.equal(
        await f.app.heartbeatExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
        false,
      );
      assert.equal(
        await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
        false,
      );
      const next = await f.submit({ idempotency_key: randomUUID() });
      await f.call(f.worker.id, 'work_release', {
        ticket_id: f.ticket.id,
        claim_token: f.claim.claim.token,
        reason: 'Replace owner.',
      });
      await f.call(f.other.id, 'work_claim', { ticket_id: f.ticket.id });
      assert.equal(await f.app.reserveExecutionRun(f.admin.id, f.project.id, next.run_id, 60_000), null);
      assert.equal((await f.get(run.id)).run.status, 'reserved');
    },
  );
  check(
    'rejects recipe drift before spawn, persists pre-spawn errors and protects execution history',
    async (f) => {
      const receipt = await f.submit();
      const changed = createApplication({
        storage: f.storage,
        search: f.search,
        executionRecipes: [{ ...f.recipe, fingerprint: 'b'.repeat(64) }],
      });
      const run = (await changed.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
      assert.equal(
        await changed.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
        null,
      );
      const failed = { exit_code: null, signal: null, artifacts: [], error_code: 'RECIPE_CHANGED' };
      assert.equal(
        await changed.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, failed),
        true,
      );
      const view = await f.get(run.id);
      assert.equal(view.run.status, 'failed');
      assert.equal(view.run.error_code, 'RECIPE_CHANGED');
      assert.equal(view.continuation.status, 'failed');
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.put('execution_jobs', run)),
        hasCode('CONFLICT'),
      );
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.remove('execution_jobs', run.id)),
        hasCode('IMMUTABLE_EXECUTION'),
      );
      assert.equal(
        await f.storage.transaction(f.project.id, (tx) =>
          tx.compareExecutionRun!(run, { ...run, status: 'running' }),
        ),
        false,
      );
      await assert.rejects(
        f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
          ...outcome,
          artifacts: Array(51).fill('too many'),
        }),
        hasCode('INVALID_INPUT'),
      );
    },
  );
  check('paginates past a full page of stale jobs to discover later eligible work', async (f) => {
    for (let i = 0; i < 100; i++) await f.submit({ idempotency_key: randomUUID() });
    await f.call(f.worker.id, 'work_release', {
      ticket_id: f.ticket.id,
      claim_token: f.claim.claim.token,
      reason: 'Old ownership ended.',
    });
    const claimed = (await f.call(f.worker.id, 'work_claim', { ticket_id: f.ticket.id })) as any;
    f.clock.now = new Date(f.clock.now.getTime() + 1);
    const current = await f.submit({ idempotency_key: randomUUID(), claim_token: claimed.claim.token });
    assert.deepEqual(
      (await f.app.listExecutionRuns(f.admin.id, f.project.id)).map((run) => run.id),
      [current.run_id],
    );
  });
  check(
    'rechecks blockers before spawning and records results when a blocker arrives during execution',
    async (f) => {
      const receipt = await f.submit();
      const question = async () =>
        (
          (await f.call(f.worker.id, 'ticket_note', {
            ticket_id: f.ticket.id,
            kind: 'question',
            body: 'Resolve before execution.',
            blocking: true,
          })) as any
        ).note.id;
      const answer = (answerTo: string) =>
        f.call(f.other.id, 'ticket_note', {
          ticket_id: f.ticket.id,
          kind: 'answer',
          body: 'Resolved.',
          answer_to: answerTo,
        });
      const before = await question();
      await assert.rejects(f.submit({ idempotency_key: randomUUID() }), hasCode('DEPENDENCY_BLOCKED'));
      assert.deepEqual(await f.app.listExecutionRuns(f.admin.id, f.project.id), []);
      assert.equal(await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000), null);
      await answer(before);
      const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
      const reserved = await question();
      assert.equal(
        await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
        null,
      );
      await answer(reserved);
      assert.ok(
        await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000),
      );
      await question();
      assert.equal(
        await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
        true,
      );
      assert.equal((await f.get(run.id)).continuation.failure_reason, 'STALE_AUTHORITY');
    },
  );
  check('fences an accepted execution when the ticket is assigned to another worker', async (f) => {
    const receipt = await f.submit();
    const ticket = (await f.read(f.ticket.id)).ticket;
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: ticket.revision,
      assignee_id: f.other.id,
    });
    assert.equal(await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000), null);
  });
  check('records terminal results when blocker enumeration exceeds the graph limit', async (f) => {
    const receipt = await f.submit();
    const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
    await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000);
    const storage = new Proxy(f.storage, {
      get(target, property) {
        if (property === 'transaction')
          return (scope: string, work: Parameters<StorageAdapter['transaction']>[1]) =>
            target.transaction(scope, (tx) =>
              work(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key === 'unansweredQuestions') return async () => Array(10001).fill({});
                    const value = Reflect.get(transaction, key);
                    return typeof value === 'function' ? value.bind(transaction) : value;
                  },
                }),
              ),
            );
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createApplication({ storage, search: f.search, now: () => f.clock.now });
    assert.equal(
      await app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
      true,
    );
    const view = await f.get(run.id);
    assert.equal(view.run.exit_code, 0);
    assert.equal(view.continuation.failure_reason, 'STALE_AUTHORITY');
  });
  check(
    'preserves exact receipts, checkpoints, jobs and terminal continuations after adapter restart',
    async (f) => {
      const receipt = await f.submit();
      const submitted = await f.get(receipt.run_id);
      const restarted = await f.reopen();
      const app = createApplication({
        storage: restarted.storage,
        search: restarted.search,
        executionRecipes: [f.recipe],
        now: () => f.clock.now,
      });
      assert.deepEqual(await app.execute(f.worker.id, 'run_submit', f.input), receipt);
      assert.deepEqual(
        await app.execute(f.worker.id, 'run_get', { project_id: f.project.id, run_id: receipt.run_id }),
        submitted,
      );
      const run = (await app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
      await app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60_000);
      assert.equal(
        await app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, outcome),
        true,
      );
      const completed = await app.execute(f.worker.id, 'run_get', {
        project_id: f.project.id,
        run_id: run.id,
      });
      const again = await f.reopen();
      const fresh = createApplication({ storage: again.storage, search: again.search });
      assert.deepEqual(await fresh.execute(f.worker.id, 'run_submit', f.input), receipt);
      assert.deepEqual(
        await fresh.execute(f.worker.id, 'run_get', { project_id: f.project.id, run_id: run.id }),
        completed,
      );
      assert.equal(await fresh.reserveExecutionRun(f.admin.id, f.project.id, run.id, 60_000), null);
    },
  );
}
