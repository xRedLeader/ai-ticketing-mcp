import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../application.js';
import { ExecutionRecipeRegistry } from '../execution-recipes.js';
import { ExecutionCompanion } from '../execution-companion.js';
import { HostCapacity } from '../host-capacity.js';
import { durableExecutionFile, executionProcessIdentity } from '../execution-journal.js';
import type { ExecutionJob, StorageAdapter } from '../contracts.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerExecutionRecoveryContractTests(
  name: string,
  factory: () => Promise<
    ContractAdapters & { runtimeEnv: NodeJS.ProcessEnv; sql: (text: string) => Promise<void> }
  >,
) {
  const check = (title: string, test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} recovery: ${title}`, async () => {
      const f = await setup();
      try {
        await test(f);
      } finally {
        f.capacity.close();
        await f.dispose?.();
        await rm(f.directory, { recursive: true, force: true });
      }
    });
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-recovery-'));
    const marker = join(directory, 'side-effects.txt');
    const config = {
      workspace_roots: [directory],
      recipes: [
        {
          id: 'test',
          project_ids: [f.project.id],
          executable: process.execPath,
          argv: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'); setTimeout(()=>{},1500);`,
          ],
          cwd: directory,
          env: {},
          timeout_ms: 5000,
        },
      ],
    };
    const recipes = new ExecutionRecipeRegistry(config);
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      executionRecipes: recipes.metadata(),
      now: () => f.clock.now,
    });
    const ticket = await f.ticket(),
      claim = await f.claim(ticket.id);
    const receipt = (await app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'test',
      checkpoint: { progress: 'Await durable result.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    const capacityFile = join(directory, 'capacity.sqlite');
    const capacity = new HostCapacity(capacityFile);
    capacity.configureHost('test');
    const options = {
      application: app,
      capacity,
      recipes,
      actor_id: f.admin.id,
      project_id: f.project.id,
      host_id: 'test',
      artifacts_directory: join(directory, 'artifacts'),
    };
    const runId = receipt.run_id as string;
    const view = () =>
      app.execute(f.worker.id, 'run_get', { project_id: f.project.id, run_id: runId }) as Promise<any>;
    const outcome = { exit_code: 0, signal: null, artifacts: ['verified:result'], error_code: null };
    return {
      ...f,
      ...adapters,
      app,
      directory,
      marker,
      config,
      capacityFile,
      capacity,
      options,
      runId,
      view,
      claim,
      ticket,
      outcome,
    };
  }
  check(
    'leases one controller across projects and fences expired ownership and stale process credentials',
    async (f) => {
      const p = (await f.app.execute(f.admin.id, 'project_create', {
        key: `R${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
        name: 'Other project',
        idempotency_key: randomUUID(),
      })) as any;
      const controllers = await Promise.all([
        f.app.acquireExecutionController(f.admin.id, f.project.id, 'one', 1000),
        f.app.acquireExecutionController(f.admin.id, p.id, 'two', 1000),
      ]);
      assert.equal(controllers.filter(Boolean).length, 1);
      const original = controllers.find(Boolean)!;
      const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, original))!;
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        f.runId,
        run.reservation_token!,
        60_000,
        original,
      );
      const before = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
      f.clock.now = new Date(f.clock.now.getTime() + 1001);
      assert.equal(
        await f.app.heartbeatExecutionController(f.admin.id, f.project.id, original, 60_000),
        false,
      );
      assert.equal(
        await f.app.settleExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          run.reservation_token!,
          f.outcome,
          original,
        ),
        false,
      );
      const replacement = (await f.app.acquireExecutionController(f.admin.id, p.id, 'replacement', 60_000))!;
      assert.ok(replacement.generation > original.generation);
      const adopted = (await f.app.adoptExecutionRun(
        f.admin.id,
        f.project.id,
        f.runId,
        replacement,
        60_000,
      ))!;
      assert.deepEqual(adopted.attempt, before.attempt);
      assert.notEqual(adopted.run.reservation_token, run.reservation_token);
      assert.equal(
        await f.app.observeExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          run.reservation_token!,
          before.attempt!.id,
          before.attempt!.process_token,
          original,
          { pid: 1, start_marker: 'old' },
          'running',
        ),
        false,
      );
      assert.equal(
        await f.app.observeExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          adopted.run.reservation_token!,
          before.attempt!.id,
          randomUUID(),
          replacement,
          { pid: 1, start_marker: 'old' },
          'running',
        ),
        false,
      );
      assert.equal(
        await f.app.settleExecutionRun(f.admin.id, f.project.id, f.runId, run.reservation_token!, f.outcome),
        false,
      );
      assert.equal(
        await f.app.recoverExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          adopted.run.reservation_token!,
          adopted.attempt!.id,
          adopted.attempt!.process_token,
          f.outcome,
          replacement,
        ),
        true,
      );
      const view = await f.view();
      assert.equal(view.reconciliation.state, 'completed');
      assert.equal(view.reconciliation.next_step, 'none');
      assert.equal(view.continuation.status, 'satisfied');
      assert.equal((await f.storage.find('execution_attempts')).length, 1);
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.put('execution_attempts', adopted.attempt!)),
        hasCode('CONFLICT'),
      );
      const observation = (await f.storage.find('execution_observations'))[0]!;
      await assert.rejects(f.sql('UPDATE execution_attempts SET ordinal=2'), /immutable/);
      await assert.rejects(f.sql("UPDATE execution_observations SET next_step='none'"), /immutable/);
      await assert.rejects(f.sql('DELETE FROM execution_observations'), /immutable/);
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.put('execution_observations', observation)),
        hasCode('CONFLICT'),
      );
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.remove('execution_attempts', adopted.attempt!.id)),
        hasCode('IMMUTABLE_EXECUTION'),
      );
    },
  );
  for (const replace of [false, true])
    check(
      `${replace ? 'replaced' : 'expired unreplaced'} claim cannot acknowledge or publish a continuation`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'controller',
          60_000,
        ))!;
        const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller))!;
        await f.app.startExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          run.reservation_token!,
          60_000,
          controller,
        );
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
        if (replace) {
          await f.call(f.worker.id, 'work_release', {
            ticket_id: f.ticket.id,
            claim_token: f.claim.claim.token,
            reason: 'Replace ownership.',
          });
          await f.call(f.other.id, 'work_claim', { ticket_id: f.ticket.id });
        } else {
          await f.storage.transaction(f.project.id, async (tx) => {
            const claim = (await tx.get('claims', f.ticket.id))!;
            await tx.put('claims', {
              ...claim,
              expires_at: new Date(f.clock.now.getTime() - 1).toISOString(),
            });
          });
        }
        assert.equal(
          await f.app.observeExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            state.attempt!.id,
            state.attempt!.process_token,
            controller,
            { pid: 1, start_marker: 'fixture' },
            'running',
          ),
          false,
        );
        assert.equal(
          await f.app.heartbeatExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            60_000,
            controller,
          ),
          false,
        );
        assert.equal(
          await f.app.settleExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            f.outcome,
            controller,
          ),
          false,
        );
        assert.equal(
          await f.app.recoverExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            state.attempt!.id,
            state.attempt!.process_token,
            f.outcome,
            controller,
          ),
          true,
        );
        const view = await f.view();
        assert.equal(view.run.status, 'succeeded');
        assert.equal(view.continuation.status, 'failed');
        assert.equal(view.continuation.failure_reason, 'STALE_AUTHORITY');
      },
    );
  for (const bootstrap of [true, false])
    check(
      `${bootstrap ? 'first acquisition' : 'takeover'} waits for a publishing transaction on the controller singleton`,
      async (f) => {
        const controller = bootstrap
          ? undefined
          : (await f.app.acquireExecutionController(f.admin.id, f.project.id, 'original', 1000))!;
        const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller))!;
        await f.app.startExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          run.reservation_token!,
          60_000,
          controller,
        );
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const publishing = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const storage = new Proxy(f.storage, {
          get(target, key) {
            if (key === 'transaction')
              return (scope: string, work: Parameters<StorageAdapter['transaction']>[1]) =>
                target.transaction(scope, (tx) =>
                  work(
                    new Proxy(tx, {
                      get(transaction, field) {
                        if (field === 'compareExecutionRun')
                          return async (previous: ExecutionJob, next: ExecutionJob) => {
                            entered();
                            await gate;
                            return transaction.compareExecutionRun!(previous, next);
                          };
                        const value = Reflect.get(transaction, field);
                        return typeof value === 'function' ? value.bind(transaction) : value;
                      },
                    }),
                  ),
                );
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const app = createApplication({ storage, search: f.search, now: () => f.clock.now });
        const settlement = app.settleExecutionRun(
          f.admin.id,
          f.project.id,
          f.runId,
          run.reservation_token!,
          f.outcome,
          controller,
        );
        await publishing;
        f.clock.now = new Date(f.clock.now.getTime() + 1001);
        let acquired = false;
        const acquisition = f.app
          .acquireExecutionController(f.admin.id, f.project.id, 'replacement', 60_000)
          .then((value) => {
            acquired = true;
            return value;
          });
        await delay(50);
        assert.equal(acquired, false, 'Controller replacement must not interleave with publication.');
        release();
        assert.equal(await settlement, true);
        const replacement = (await acquisition)!;
        assert.ok(replacement);
        assert.equal(
          await f.app.settleExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            f.outcome,
            controller,
          ),
          false,
        );
      },
    );
  check(
    'distinguishes a verified running process from PID reuse and retains unknown side effects',
    async (f) => {
      const controller = (await f.app.acquireExecutionController(
        f.admin.id,
        f.project.id,
        'original',
        60_000,
      ))!;
      const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller))!;
      f.capacity.enqueue('test', {
        queue_id: f.runId,
        run_id: f.runId,
        project_id: f.project.id,
        kind: 'script',
        resources: {},
        timeout_ms: 5000,
        created_at: Date.now(),
      });
      assert.equal(f.capacity.claimNext('test', 'fixture').admitted, true);
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        f.runId,
        run.reservation_token!,
        60_000,
        controller,
      );
      const original = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!,
        attempt = original.attempt!;
      const directory = join(f.options.artifacts_directory, f.runId, attempt.id);
      mkdirSync(directory, { recursive: true });
      const identity = executionProcessIdentity(process.pid);
      assert.ok(identity, 'Test OS must expose process start identity.');
      const journal = {
        run_id: f.runId,
        attempt_id: attempt.id,
        process_token: attempt.process_token,
        recipe_fingerprint: run.recipe_fingerprint,
        identity,
      };
      durableExecutionFile(join(directory, 'process.json'), journal);
      await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
      await new ExecutionCompanion(f.options).runOnce();
      assert.equal((await f.view()).reconciliation.state, 'running');
      assert.equal((await f.view()).reconciliation.next_step, 'wait_for_result');
      await writeFile(
        join(directory, 'process.json'),
        JSON.stringify({ ...journal, identity: { ...identity, start_marker: 'reused-pid' } }),
      );
      await writeFile(f.marker, 'x');
      await new ExecutionCompanion(f.options).runOnce();
      const view = await f.view();
      assert.equal(view.reconciliation.state, 'unresolved');
      assert.equal(view.reconciliation.next_step, 'inspect_side_effects');
      assert.equal(view.continuation.status, 'pending');
      assert.equal(f.capacity.inspect('test').occupied.script, 1);
      assert.equal(await readFile(f.marker, 'utf8'), 'x');
    },
  );
  check('fences actual recipe spawn when the original controller resumes after takeover', async (f) => {
    let resume!: () => void, paused!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const application = new Proxy(f.app, {
      get(target, key) {
        if (key === 'startExecutionRun')
          return async (...args: Parameters<typeof target.startExecutionRun>) => {
            const run = await target.startExecutionRun(...args);
            paused();
            await gate;
            return run;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const original = new ExecutionCompanion({ ...f.options, application }).runOnce();
    try {
      await reached;
      f.clock.now = new Date(f.clock.now.getTime() + 61_000);
      await new ExecutionCompanion(f.options).runOnce();
    } finally {
      resume();
    }
    await assert.rejects(original, /unresolved|ownership lost/);
    assert.equal(existsSync(f.marker), false, 'A stale original must not execute the recipe.');
    const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
    const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
    assert.equal(
      existsSync(join(directory, 'supervisor.json')),
      true,
      'The stale controller actually launched its supervisor.',
    );
    assert.equal(
      existsSync(join(directory, 'dispatch.json')),
      false,
      'The actual spawn boundary denied the stale capability.',
    );
    const view = await f.view();
    assert.equal(view.reconciliation.state, 'unresolved');
    assert.equal(f.capacity.inspect('test').occupied.script, 1);
    assert.equal((await f.storage.find('execution_attempts')).length, 1);
  });
  for (const occupied of [true, false])
    check(
      `drains durable never-started ${occupied ? 'occupied' : 'queued'} capacity after settlement crash`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'original',
          60_000,
        ))!;
        await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller);
        f.capacity.enqueue('test', {
          queue_id: f.runId,
          run_id: f.runId,
          project_id: f.project.id,
          kind: 'script',
          resources: {},
          timeout_ms: 5000,
          created_at: Date.now(),
        });
        if (occupied) assert.equal(f.capacity.claimNext('test', 'original').admitted, true);
        await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
        const application = new Proxy(f.app, {
          get(target, key) {
            if (key === 'recoverExecutionRun')
              return async (...args: Parameters<typeof target.recoverExecutionRun>) => {
                assert.equal(await target.recoverExecutionRun(...args), true);
                throw new Error('Crash after never-started settlement commit.');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await assert.rejects(
          new ExecutionCompanion({ ...f.options, application }).runOnce(),
          /Crash after never-started settlement commit/,
        );
        const before = await f.view();
        assert.equal(before.run.error_code, 'RECOVERED_NOT_DISPATCHED');
        assert.equal(f.capacity.inspect('test').entries[0]!.state, occupied ? 'running' : 'queued');
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
        const proofFile = join(
          f.options.artifacts_directory,
          f.runId,
          state.attempt!.id,
          'never-started.json',
        );
        const proof = JSON.parse(await readFile(proofFile, 'utf8'));
        assert.equal(proof.capacity.execution_token, f.capacity.inspect('test').entries[0]!.execution_token);
        await writeFile(
          proofFile,
          JSON.stringify({
            ...proof,
            capacity: { ...proof.capacity, execution_token: randomUUID() },
          }),
        );
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal(f.capacity.inspect('test').entries[0]!.state, occupied ? 'running' : 'queued');
        await writeFile(proofFile, JSON.stringify(proof));
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
        assert.equal(f.capacity.inspect('test').entries[0]!.state, occupied ? 'settled' : 'cancelled');
        assert.equal(existsSync(f.marker), false);
      },
    );
  for (const cancel of [true, false])
    check(
      `${cancel ? 'cancels' : 'waits without acknowledging running'} before actual spawn while the supervisor awaits its launch transaction`,
      async (f) => {
        let prematureAcknowledgments = 0;
        let resume!: () => void, paused!: () => void, unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          paused = resolve;
        });
        const lockGate = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const lockReached = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const application = new Proxy(f.app, {
          get(target, key) {
            if (key === 'observeExecutionRun')
              return async (...args: Parameters<typeof target.observeExecutionRun>) => {
                if (!existsSync(join(directory, 'process.json'))) prematureAcknowledgments++;
                return target.observeExecutionRun(...args);
              };
            if (key === 'startExecutionRun')
              return async (...args: Parameters<typeof target.startExecutionRun>) => {
                const run = await target.startExecutionRun(...args);
                paused();
                await gate;
                return run;
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const running = new ExecutionCompanion({ ...f.options, application }).runOnce();
        await reached;
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
        const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
        const transaction = f.storage.transaction(f.project.id, async () => {
          locked();
          await lockGate;
        });
        try {
          await lockReached;
          resume();
          for (let i = 0; i < 100 && !existsSync(join(directory, 'supervisor.json')); i++) await delay(50);
          assert.equal(existsSync(join(directory, 'supervisor.json')), true);
          await delay(1000);
          assert.equal(
            prematureAcknowledgments,
            0,
            'A supervisor alone cannot acknowledge a running recipe.',
          );
          if (cancel) durableExecutionFile(join(directory, 'cancel.json'), { reason: 'CANCELLED' });
        } finally {
          resume();
          unlock();
          await transaction;
        }
        if (cancel) {
          await assert.rejects(running, /unresolved/);
          assert.equal(existsSync(f.marker), false);
          assert.equal(existsSync(join(directory, 'dispatch.json')), false);
          assert.equal(existsSync(join(directory, 'result.json')), false);
          assert.equal(f.capacity.inspect('test').occupied.script, 1);
        } else {
          assert.equal(await running, true);
          assert.equal(await readFile(f.marker, 'utf8'), 'x');
          assert.equal((await f.view()).run.status, 'succeeded');
          assert.equal(f.capacity.inspect('test').occupied.script, 0);
        }
      },
    );
  check('recovers exact occupied capacity when admission acknowledgment fails after the claim', async (f) => {
    const application = new Proxy(f.app, {
      get(target, key) {
        if (key === 'admitExecutionRun')
          return async (...args: Parameters<typeof target.admitExecutionRun>) => {
            assert.equal(await target.admitExecutionRun(...args), true);
            throw new Error('Admission acknowledgment failed after capacity claim.');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      new ExecutionCompanion({ ...f.options, application }).runOnce(),
      /Admission acknowledgment failed/,
    );
    assert.equal((await f.view()).run.status, 'reserved');
    assert.equal(f.capacity.inspect('test').occupied.script, 1);
    await new ExecutionCompanion(f.options).runOnce();
    assert.equal((await f.view()).run.error_code, 'RECOVERED_NOT_DISPATCHED');
    assert.equal(f.capacity.inspect('test').occupied.script, 0);
    assert.equal(existsSync(f.marker), false);
  });
  check('rejects never-started settlement once dispatch intent is recorded', async (f) => {
    const controller = (await f.app.acquireExecutionController(
      f.admin.id,
      f.project.id,
      'original',
      60_000,
    ))!;
    const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller))!;
    await f.app.startExecutionRun(
      f.admin.id,
      f.project.id,
      f.runId,
      run.reservation_token!,
      60_000,
      controller,
    );
    const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
    assert.equal(
      await f.app.recoverExecutionRun(
        f.admin.id,
        f.project.id,
        f.runId,
        run.reservation_token!,
        state.attempt!.id,
        state.attempt!.process_token,
        { exit_code: null, signal: null, artifacts: [], error_code: 'RECOVERED_NOT_DISPATCHED' },
        controller,
      ),
      false,
    );
    assert.equal((await f.view()).reconciliation.state, 'unresolved');
  });
  check('ignores unrelated local-script and other-project host entries during terminal lookup', async (f) => {
    const controller = (await f.app.acquireExecutionController(f.admin.id, f.project.id, 'fixture', 60_000))!;
    const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, f.runId, 60_000, controller))!;
    await f.app.settleExecutionRun(
      f.admin.id,
      f.project.id,
      f.runId,
      run.reservation_token!,
      {
        exit_code: null,
        signal: null,
        artifacts: [],
        error_code: 'NOT_STARTED',
      },
      controller,
    );
    await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
    for (const [queue, project] of [
      ['local-check', f.project.id],
      [randomUUID(), randomUUID()],
    ])
      f.capacity.enqueue('test', {
        queue_id: queue!,
        run_id: queue!,
        project_id: project!,
        kind: 'script',
        resources: {},
        timeout_ms: 5000,
        created_at: Date.now(),
      });
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
    assert.deepEqual(
      f.capacity.inspect('test').entries.map((entry) => entry.state),
      ['queued', 'queued'],
    );
  });
  for (const phase of ['dispatch', 'acknowledgment', 'completion'])
    check(`recovers an actual controller crash at ${phase} without replaying side effects`, async (f) => {
      const configFile = join(f.directory, 'recipes.json');
      await writeFile(configFile, JSON.stringify(f.config));
      const child = spawn(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('../../tests/fixtures/execution-crash.ts', import.meta.url)),
          phase,
          f.admin.id,
          f.project.id,
          f.capacityFile,
          f.options.artifacts_directory,
        ],
        {
          env: { ...process.env, ...f.runtimeEnv, EXECUTION_RECIPES_FILE: configFile },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let error = '';
      child.stderr.on('data', (chunk) => {
        error += String(chunk);
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      clearTimeout(deadline);
      assert.equal(code, 93, error);
      const original = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
      assert.ok(original.attempt);
      if (phase !== 'dispatch') {
        const resultFile = join(f.options.artifacts_directory, f.runId, original.attempt.id, 'result.json');
        for (let i = 0; i < 100 && !existsSync(resultFile); i++) await delay(100);
        assert.ok(
          existsSync(resultFile),
          'Detached supervisor must persist completion after controller exit.',
        );
      }
      f.clock.now = new Date(Date.now() + 61_000);
      await new ExecutionCompanion(f.options).runOnce();
      const view = await f.view();
      if (phase === 'dispatch') {
        assert.equal(view.reconciliation.state, 'unresolved');
        assert.equal(view.reconciliation.next_step, 'inspect_side_effects');
        assert.equal(existsSync(f.marker), false);
        assert.equal(f.capacity.inspect('test').occupied.script, 1);
      } else {
        assert.equal(view.reconciliation.state, 'completed');
        assert.equal(view.run.exit_code, 0);
        assert.equal(view.continuation.status, 'satisfied');
        assert.equal(await readFile(f.marker, 'utf8'), 'x');
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
      }
      const observationCount = (await f.storage.find('execution_observations')).length;
      await new ExecutionCompanion(f.options).runOnce();
      assert.equal(
        (await f.storage.find('execution_observations')).length,
        observationCount,
        'Unchanged polling must not append durable observations.',
      );
      assert.equal((await f.storage.find('execution_attempts')).length, 1);
      assert.deepEqual(await f.storage.get('execution_attempts', original.attempt.id), original.attempt);
      if (phase !== 'dispatch') assert.equal(await readFile(f.marker, 'utf8'), 'x');
    });
  check(
    'fences stale capacity admission after a replacement terminalizes the reserved attempt',
    async (f) => {
      let resume!: () => void, paused!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        paused = resolve;
      });
      const application = new Proxy(f.app, {
        get(target, key) {
          if (key === 'admitExecutionRun')
            return async (...args: Parameters<typeof target.admitExecutionRun>) => {
              paused();
              await gate;
              return target.admitExecutionRun(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const original = new ExecutionCompanion({ ...f.options, application }).runOnce();
      try {
        await reached;
        f.clock.now = new Date(f.clock.now.getTime() + 61_000);
        await new ExecutionCompanion(f.options).runOnce();
      } finally {
        resume();
      }
      assert.equal(await original, true);
      assert.equal((await f.view()).run.error_code, 'RECOVERED_NOT_DISPATCHED');
      assert.equal(f.capacity.inspect('test').entries.length, 0);
      assert.equal(existsSync(f.marker), false);
    },
  );
}
