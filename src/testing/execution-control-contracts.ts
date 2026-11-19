import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../application.js';
import { ExecutionCompanion } from '../execution-companion.js';
import { ExecutionRecipeRegistry } from '../execution-recipes.js';
import { HostCapacity } from '../host-capacity.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerExecutionControlContractTests(
  name: string,
  factory: () => Promise<ContractAdapters>,
) {
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-controls-'));
    const recipes = new ExecutionRecipeRegistry({
      workspace_roots: [directory],
      recipes: [
        {
          id: 'test',
          project_ids: [f.project.id],
          executable: process.execPath,
          argv: ['-e', 'process.exit(0)'],
          cwd: directory,
          env: {},
        },
      ],
    });
    const app = createApplication({
      ...adapters,
      executionRecipes: recipes.metadata(),
      now: () => f.clock.now,
    });
    async function submit() {
      const ticket = await f.ticket(),
        claim = await f.claim(ticket.id);
      const result = (await app.execute(f.worker.id, 'run_submit', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        idempotency_key: randomUUID(),
        recipe_id: 'test',
        checkpoint: { progress: 'Retain progress.' },
        completion_condition: { kind: 'exit_code', exit_code: 0 },
      })) as any;
      return result.run_id as string;
    }
    const capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
    capacity.configureHost('test', { script_slots: 1 });
    const options = {
      application: app,
      recipes,
      capacity,
      actor_id: f.admin.id,
      project_id: f.project.id,
      host_id: 'test',
      artifacts_directory: join(directory, 'artifacts'),
    };
    const runId = await submit();
    const state = async (id = runId) =>
      (await app.listExecutionReconciliations(f.admin.id, f.project.id, [id]))[0]!;
    const view = () =>
      app.execute(f.worker.id, 'run_get', { project_id: f.project.id, run_id: runId }) as Promise<any>;
    return { ...f, ...adapters, app, directory, capacity, options, submit, runId, state, view };
  }
  const check = (title: string, test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} controls: ${title}`, async () => {
      const f = await setup();
      try {
        await test(f);
      } finally {
        f.capacity.close();
        await f.dispose?.();
        await rm(f.directory, { recursive: true, force: true });
      }
    });
  check(
    'durably pauses admissions across controller replacement and drains admitted work within host limits',
    async (f) => {
      const { app, runId } = f,
        actor = f.admin.id,
        project = f.project.id;
      let controller = (await app.acquireExecutionController(actor, project, 'first', 60_000))!;
      await assert.rejects(app.setExecutionAdmissions(f.worker.id, project, true), hasCode('FORBIDDEN'));
      const pause = await app.setExecutionAdmissions(actor, project, true);
      assert.deepEqual(await app.setExecutionAdmissions(actor, project, true), pause);
      assert.equal(await app.reserveExecutionRun(actor, project, runId, 60_000, controller), null);
      await app.releaseExecutionController(actor, project, controller);
      controller = (await app.acquireExecutionController(actor, project, 'restart', 60_000))!;
      assert.equal(await app.reserveExecutionRun(actor, project, runId, 60_000, controller), null);
      assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
      await app.setExecutionAdmissions(actor, project, false);
      const run = (await app.reserveExecutionRun(actor, project, runId, 60_000, controller))!;
      let admission: ReturnType<HostCapacity['claimNext']>;
      assert.equal(
        await app.admitExecutionRun(actor, project, runId, run.reservation_token!, controller, () => {
          f.capacity.enqueue('test', {
            kind: 'script',
            queue_id: runId,
            run_id: runId,
            project_id: project,
            created_at: Date.now(),
          });
          admission = f.capacity.claimNext('test', 'owner', { kind: 'script', queue_ids: [runId] });
        }),
        true,
      );
      assert.equal(admission!.admitted, true);
      await app.setExecutionAdmissions(actor, project, true);
      await app.startExecutionRun(actor, project, runId, run.reservation_token!, 60_000, controller);
      const state = await f.state();
      let dispatched = 0;
      assert.equal(
        await app.dispatchExecutionRun(
          actor,
          project,
          runId,
          run.reservation_token!,
          state.attempt!.id,
          state.attempt!.process_token,
          run.recipe_fingerprint,
          controller,
          () => {
            dispatched++;
          },
        ),
        true,
      );
      assert.equal(dispatched, 1);
      const second = await f.submit();
      assert.equal(await app.reserveExecutionRun(actor, project, second, 60_000, controller), null);
      assert.equal(f.capacity.inspect('test').occupied.script, 1);
      assert.equal(
        await app.recoverExecutionRun(
          actor,
          project,
          runId,
          run.reservation_token!,
          state.attempt!.id,
          state.attempt!.process_token,
          { exit_code: 0, signal: null, artifacts: [], error_code: null },
          controller,
        ),
        true,
      );
      assert.equal((await f.state()).run.status, 'succeeded');
      await app.releaseExecutionController(actor, project, controller);
    },
  );
  check('cancels queued work idempotently without launching or losing checkpoint/claim data', async (f) => {
    const actor = f.admin.id,
      project = f.project.id;
    await assert.rejects(f.app.cancelExecutionRun(f.worker.id, project, f.runId), hasCode('FORBIDDEN'));
    const before = await f.view();
    const cancellation = await f.app.cancelExecutionRun(actor, project, f.runId);
    assert.equal(cancellation.process_state, 'never_started');
    assert.equal(cancellation.effects_state, 'not_started');
    assert.deepEqual(await f.app.cancelExecutionRun(actor, project, f.runId), cancellation);
    const after = await f.view();
    assert.equal(after.run.error_code, 'CANCELLED_NOT_STARTED');
    assert.equal(after.continuation.status, 'failed');
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.ok(await f.storage.get('claims', before.run.ticket_id));
    assert.equal((await f.state()).attempt, null);
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
  });
  check(
    'recovers reserved cancellation across the terminal-before-capacity-release gap without dispatch',
    async (f) => {
      const actor = f.admin.id,
        project = f.project.id;
      const controller = (await f.app.acquireExecutionController(actor, project, 'first', 60_000))!;
      const run = (await f.app.reserveExecutionRun(actor, project, f.runId, 60_000, controller))!;
      await f.app.admitExecutionRun(actor, project, f.runId, run.reservation_token!, controller, () => {
        f.capacity.enqueue('test', {
          kind: 'script',
          queue_id: f.runId,
          run_id: f.runId,
          project_id: project,
          created_at: Date.now(),
        });
        assert.equal(
          f.capacity.claimNext('test', 'first', { kind: 'script', queue_ids: [f.runId] }).admitted,
          true,
        );
      });
      const original = await f.state();
      await f.app.cancelExecutionRun(actor, project, f.runId);
      assert.equal(f.capacity.inspect('test').occupied.script, 1);
      assert.equal(
        await f.app.startExecutionRun(actor, project, f.runId, run.reservation_token!, 60_000, controller),
        null,
      );
      await f.app.releaseExecutionController(actor, project, controller);
      await new ExecutionCompanion(f.options).runOnce();
      assert.equal(f.capacity.inspect('test').occupied.script, 0);
      assert.deepEqual((await f.state()).attempt, original.attempt);
      const proof = JSON.parse(
        await readFile(
          join(f.directory, 'artifacts', f.runId, original.attempt!.id, 'never-started.json'),
          'utf8',
        ),
      );
      assert.equal(proof.error_code, 'CANCELLED_NOT_STARTED');
      assert.equal(proof.capacity.execution_token, f.capacity.inspect('test').entries[0]!.execution_token);
      await new ExecutionCompanion(f.options).runOnce();
      assert.equal(f.capacity.inspect('test').occupied.script, 0);
    },
  );
  check(
    'retains requested cancellation and exact attempt fences across restart until external exit/effects are evidenced',
    async (f) => {
      const actor = f.admin.id,
        project = f.project.id,
        app = f.app;
      const first = (await app.acquireExecutionController(actor, project, 'first', 60_000))!;
      const run = (await app.reserveExecutionRun(actor, project, f.runId, 60_000, first))!;
      await app.startExecutionRun(actor, project, f.runId, run.reservation_token!, 60_000, first);
      const original = await f.state();
      const cancellation = await app.cancelExecutionRun(actor, project, f.runId);
      assert.equal(cancellation.process_state, 'requested');
      assert.deepEqual(await app.cancelExecutionRun(actor, project, f.runId), cancellation);
      assert.equal(
        await app.dispatchExecutionRun(
          actor,
          project,
          f.runId,
          run.reservation_token!,
          original.attempt!.id,
          original.attempt!.process_token,
          run.recipe_fingerprint,
          first,
          () => {
            assert.fail('Cancelled launch');
          },
        ),
        false,
      );
      await assert.rejects(
        app.reconcileExecutionCancellation(actor, project, f.runId, 'Unverified'),
        hasCode('CONFLICT'),
      );
      await app.releaseExecutionController(actor, project, first);
      await new ExecutionCompanion(f.options).runOnce();
      const unresolved = await f.view();
      assert.equal(unresolved.reconciliation.state, 'unresolved');
      assert.equal(unresolved.reconciliation.next_step, 'inspect_side_effects');
      assert.equal(unresolved.reconciliation.cancellation.process_state, 'unresolved');
      assert.deepEqual((await f.state()).attempt, original.attempt);
      const evidence = {
        process_exit_confirmed: true as const,
        effects_reconciled: true as const,
        outcome: { exit_code: null, signal: null, artifacts: ['external:receipt'], error_code: 'CANCELLED' },
        note: 'External scheduler confirmed job exit; receipt external:receipt records the partial effect. No rollback.',
      };
      const resolved = await new ExecutionCompanion(f.options).reconcileCancellation(f.runId, evidence);
      assert.equal(resolved.process_state, 'exit_confirmed');
      assert.equal(resolved.effects_state, 'reconciled');
      const after = await f.view();
      assert.equal(after.run.status, 'failed');
      assert.deepEqual(after.run.artifacts, ['external:receipt']);
      assert.equal(after.reconciliation.state, 'completed');
      assert.equal(after.continuation.status, 'failed');
      assert.deepEqual(
        await new ExecutionCompanion(f.options).reconcileCancellation(f.runId, evidence),
        resolved,
      );
      await assert.rejects(
        new ExecutionCompanion(f.options).reconcileCancellation(f.runId, {
          ...evidence,
          outcome: { ...evidence.outcome, exit_code: 7 },
        }),
        hasCode('CONFLICT'),
      );
      await assert.rejects(
        app.reconcileExecutionCancellation(actor, project, f.runId, 'Different account'),
        hasCode('CONFLICT'),
      );
      assert.deepEqual((await f.state()).attempt, original.attempt);
      assert.ok((await f.storage.find('execution_observations', { where: { run_id: f.runId } })).length >= 3);
    },
  );
}
