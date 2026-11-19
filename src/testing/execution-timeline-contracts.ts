import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../application.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';
import { countReferenceTokens } from '../tokens.js';
import { serializeSuccessEnvelope } from '../envelope.js';
import type { ExecutionLocalStatus } from '../contracts.js';

export function registerExecutionTimelineContractTests(
  name: string,
  factory: () => Promise<ContractAdapters>,
) {
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters),
      ticket = await f.ticket(),
      claim = await f.claim(ticket.id);
    const options = {
      ...adapters,
      now: () => f.clock.now,
      executionRecipes: [{ id: 'test', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
    };
    const app = createApplication(options);
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'test',
      checkpoint: { progress: 'PRIVATE_TRANSCRIPT_SECRET' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    };
    const receipt = (await app.execute(f.worker.id, 'run_submit', input)) as any;
    const view = (extra = {}, application = app) =>
      application.execute(f.worker.id, 'run_timeline', {
        project_id: f.project.id,
        run_id: receipt.run_id,
        ...extra,
      }) as Promise<any>;
    return { ...f, ...adapters, app, options, ticket, claim, input, runId: receipt.run_id as string, view };
  }
  const check = (title: string, test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} timeline: ${title}`, async () => {
      const f = await setup();
      try {
        await test(f);
      } finally {
        await f.dispose?.();
      }
    });

  check(
    'explains paused/stale queued work and exposes current authoritative revisions without content',
    async (f) => {
      let view = await f.view();
      assert.equal(view.waiting_reason, 'awaiting_dispatch');
      assert.equal(view.local_status, null);
      assert.equal(view.attempt, null);
      assert.deepEqual(view.entries, []);
      await f.app.setExecutionAdmissions(f.admin.id, f.project.id, true);
      view = await f.view();
      assert.equal(view.waiting_reason, 'admissions_paused');
      assert.equal(view.next_wake.condition, 'admissions_resume');
      await f.app.setExecutionAdmissions(f.admin.id, f.project.id, false);
      const ticket = (await f.read(f.ticket.id)).ticket;
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: f.ticket.id,
        expected_revision: ticket.revision,
        criteria: ['Changed acceptance.'],
      });
      view = await f.view();
      assert.equal(view.authority_current, false);
      assert.equal(view.waiting_reason, 'stale_authority');
      assert.equal(view.run.requirements_revision, 1);
      assert.equal(view.current_revision.requirements, 2);
      assert.match(view.next_wake.action, /cancel stale work/);
      assert.ok(Object.values(view.metrics).every((value) => typeof value === 'number'));
      assert.ok(!JSON.stringify(view).includes('PRIVATE_TRANSCRIPT_SECRET'));
    },
  );
  check(
    'retains immutable attempt/sequence identity across restart, retry, takeover and cancellation',
    async (f) => {
      const actor = f.admin.id,
        project = f.project.id,
        app = f.app;
      assert.equal(((await app.execute(f.worker.id, 'run_submit', f.input)) as any).run_id, f.runId);
      const first = (await app.acquireExecutionController(actor, project, 'PRIVATE_OWNER_SECRET', 60_000))!;
      const run = (await app.reserveExecutionRun(actor, project, f.runId, 60_000, first))!;
      await app.startExecutionRun(actor, project, f.runId, run.reservation_token!, 60_000, first);
      const original = (await app.listExecutionReconciliations(actor, project, [f.runId]))[0]!;
      const attempt = original.attempt!;
      await app.observeExecutionRun(
        actor,
        project,
        f.runId,
        run.reservation_token!,
        attempt.id,
        attempt.process_token,
        first,
        { pid: 123, start_marker: 'PRIVATE_PROCESS_SECRET' },
        'running',
      );
      const page = await f.view({ limit: 1 });
      assert.equal(page.entries[0].sequence, 1);
      assert.equal(page.page.has_more, true);
      assert.equal(page.waiting_reason, 'awaiting_process_result');
      assert.equal(page.next_wake.at, null);
      await app.releaseExecutionController(actor, project, first);
      const second = (await app.acquireExecutionController(
        actor,
        project,
        'PRIVATE_REPLACEMENT_SECRET',
        60_000,
      ))!;
      const adopted = (await app.adoptExecutionRun(actor, project, f.runId, second, 60_000))!;
      const fresh = createApplication(f.options);
      let view = await f.view({ after_sequence: page.page.next_after_sequence }, fresh);
      assert.equal(view.attempt.id, attempt.id);
      assert.equal(view.ownership.controller_generation, second.generation);
      assert.deepEqual(
        view.entries.map((entry: any) => entry.sequence),
        [2, 3],
      );
      await app.cancelExecutionRun(actor, project, f.runId);
      assert.equal((await f.view()).waiting_reason, 'cancellation_requested');
      await app.observeExecutionRun(
        actor,
        project,
        f.runId,
        adopted.run.reservation_token!,
        attempt.id,
        attempt.process_token,
        second,
        null,
        'unresolved',
      );
      view = await f.view();
      assert.equal(view.waiting_reason, 'process_exit_unconfirmed');
      await app.recoverExecutionRun(
        actor,
        project,
        f.runId,
        adopted.run.reservation_token!,
        attempt.id,
        attempt.process_token,
        {
          exit_code: null,
          signal: 'PRIVATE_SIGNAL_SECRET',
          artifacts: ['PRIVATE_ARTIFACT_SECRET'],
          error_code: 'PRIVATE_ERROR_SECRET',
        },
        second,
      );
      view = await f.view();
      assert.equal(view.waiting_reason, 'effects_unresolved');
      assert.equal(view.next_wake.condition, 'operator_reconciliation');
      assert.equal(view.continuation.status, 'failed');
      await app.reconcileExecutionCancellation(actor, project, f.runId, 'PRIVATE_RECONCILIATION_SECRET');
      view = await f.view({}, fresh);
      assert.equal(view.state, 'completed');
      assert.equal(view.next_wake.condition, 'none');
      assert.equal(view.attempt.id, attempt.id);
      const serialized = JSON.stringify(view);
      for (const secret of [
        first.token,
        second.token,
        attempt.process_token,
        run.claim_token,
        run.reservation_token!,
        adopted.run.reservation_token!,
        'PRIVATE_',
      ])
        assert.ok(!serialized.includes(secret), secret);
      await app.releaseExecutionController(actor, project, second);
    },
  );
  check('pages an append-only timeline within the full-envelope budget and always advances', async (f) => {
    const actor = f.admin.id,
      project = f.project.id,
      app = f.app;
    const controller = (await app.acquireExecutionController(actor, project, 'owner', 60_000))!;
    const run = (await app.reserveExecutionRun(actor, project, f.runId, 60_000, controller))!;
    await app.startExecutionRun(actor, project, f.runId, run.reservation_token!, 60_000, controller);
    const attempt = (await app.listExecutionReconciliations(actor, project, [f.runId]))[0]!.attempt!;
    for (let i = 0; i < 38; i++)
      await app.observeExecutionRun(
        actor,
        project,
        f.runId,
        run.reservation_token!,
        attempt.id,
        attempt.process_token,
        controller,
        null,
        i % 2 ? 'running' : 'unresolved',
      );
    const first = await f.view({ limit: 1, max_tokens: 32768 });
    const maxTokens = Math.max(512, countReferenceTokens(serializeSuccessEnvelope(first)) + 64);
    let after = 0,
      more = true;
    const sequences: number[] = [];
    while (more) {
      const view = await f.view(
        { after_sequence: after, limit: 50, max_tokens: maxTokens },
        createApplication(f.options),
      );
      assert.ok(countReferenceTokens(serializeSuccessEnvelope(view)) <= maxTokens);
      assert.ok(view.page.next_after_sequence > after);
      sequences.push(...view.entries.map((entry: any) => entry.sequence));
      after = view.page.next_after_sequence;
      more = view.page.has_more;
    }
    assert.deepEqual(
      sequences,
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    await assert.rejects(f.view({ max_tokens: 512 }), hasCode('CONTEXT_TOO_LARGE'));
    await app.releaseExecutionController(actor, project, controller);
  });
  check(
    'authorizes the exact project before observing local state and rejects caller-owned paths',
    async (f) => {
      let reads = 0;
      const app = createApplication({
        ...f.options,
        executionStatus: {
          observe(project, run) {
            assert.equal(project, f.project.id);
            assert.equal(run, f.runId);
            reads++;
            return null;
          },
        },
      });
      const other = await fixture({ storage: f.storage, search: f.search });
      await assert.rejects(
        app.execute(other.worker.id, 'run_timeline', { project_id: f.project.id, run_id: f.runId }),
        hasCode('FORBIDDEN'),
      );
      await assert.rejects(
        app.execute(other.worker.id, 'run_timeline', { project_id: other.project.id, run_id: f.runId }),
        hasCode('NOT_FOUND'),
      );
      await assert.rejects(f.view({ ledger: 'PRIVATE_PATH' }, app), hasCode('INVALID_INPUT'));
      await assert.rejects(f.view({ limit: 51 }, app), hasCode('INVALID_INPUT'));
      assert.equal(reads, 0);
      await f.view({}, app);
      assert.equal(reads, 1);
    },
  );
  check(
    'distinguishes observed capacity/budget waits, process deadlines and terminal capacity reconciliation',
    async (f) => {
      const deadline = new Date(f.clock.now.getTime() + 5000).toISOString();
      const local: ExecutionLocalStatus = {
        observed_at: f.clock.now.toISOString(),
        capacity: {
          state: 'queued',
          reason: null,
          lease_expires_at: null,
          timeout_at: null,
        },
        budget: null,
      };
      const app = createApplication({ ...f.options, executionStatus: { observe: () => local } });
      assert.equal((await f.view({}, app)).waiting_reason, 'awaiting_dispatch');
      local.capacity!.reason = 'capacity';
      assert.equal((await f.view({}, app)).next_wake.condition, 'capacity_change');
      local.budget = {
        status: 'needs_attention',
        basis: 'charged_or_reserved',
        remaining: {
          attempts: 0,
          provider_tokens: 100,
          runtime_ms: 1000,
          cost_usd_micros: null,
        },
        unknown_usage_invocations: 1,
        in_flight: 0,
      };
      assert.equal((await f.view({}, app)).waiting_reason, 'budget_attention');
      const actor = f.admin.id,
        project = f.project.id;
      const controller = (await app.acquireExecutionController(actor, project, 'owner', 60_000))!;
      const run = (await app.reserveExecutionRun(actor, project, f.runId, 60_000, controller))!;
      await app.startExecutionRun(actor, project, f.runId, run.reservation_token!, 60_000, controller);
      const attempt = (await app.listExecutionReconciliations(actor, project, [f.runId]))[0]!.attempt!;
      await app.observeExecutionRun(
        actor,
        project,
        f.runId,
        run.reservation_token!,
        attempt.id,
        attempt.process_token,
        controller,
        null,
        'running',
      );
      local.capacity = { state: 'running', reason: null, lease_expires_at: deadline, timeout_at: deadline };
      assert.equal((await f.view({}, app)).next_wake.at, deadline);
      local.capacity.state = 'reconciling';
      local.capacity.reason = 'lease_expired';
      assert.equal((await f.view({}, app)).waiting_reason, 'capacity_reconciliation');
      await app.recoverExecutionRun(
        actor,
        project,
        f.runId,
        run.reservation_token!,
        attempt.id,
        attempt.process_token,
        { exit_code: 0, signal: null, artifacts: [], error_code: null },
        controller,
      );
      local.capacity.state = 'running';
      let view = await f.view({}, app);
      assert.equal(view.state, 'completed');
      assert.equal(view.next_wake.condition, 'companion_reconciliation');
      local.capacity.state = 'settled';
      view = await f.view({}, app);
      assert.equal(view.waiting_reason, 'completed');
      assert.equal(view.next_wake.condition, 'none');
      await app.releaseExecutionController(actor, project, controller);
    },
  );
}
