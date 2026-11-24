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
      createTicket: f.ticket,
      claimTicket: f.claim,
      outcome,
    };
  }
  check('settles recipes that exceed fixed host limits and continues processing the queue', async (f) => {
    f.capacity.configureHost('limited', { cpu_millis: 100, script_timeout_ms: 2000 });
    const recipe = f.config.recipes[0]!;
    const recipes = new ExecutionRecipeRegistry({
      ...f.config,
      recipes: [
        recipe,
        { ...recipe, id: 'oversized', timeout_ms: 2000, resources: { cpu_millis: 101 } },
        { ...recipe, id: 'fits', timeout_ms: 2000, argv: ['-e', ''] },
      ],
    });
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      executionRecipes: recipes.metadata(),
      now: () => f.clock.now,
    });
    const submit = async (recipeId: string) => {
      f.clock.now = new Date(f.clock.now.getTime() + 1);
      const ticket = await f.createTicket();
      const claim = await f.claimTicket(ticket.id);
      const receipt = (await app.execute(f.worker.id, 'run_submit', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        idempotency_key: randomUUID(),
        recipe_id: recipeId,
        checkpoint: { progress: 'Await capacity admission.' },
        completion_condition: { kind: 'exit_code', exit_code: 0 },
      })) as { run_id: string };
      return receipt.run_id;
    };
    const oversized = await submit('oversized');
    const fits = await submit('fits');
    const companion = new ExecutionCompanion({ ...f.options, application: app, recipes, host_id: 'limited' });
    for (const id of [f.runId, oversized]) {
      assert.equal(await companion.runOnce(), true);
      const run = await f.storage.get('execution_jobs', id);
      assert.equal(run?.status, 'failed');
      assert.equal(run.error_code, 'NOT_STARTED');
      const [attempt] = await f.storage.find('execution_attempts', { where: { run_id: id } });
      const proof = JSON.parse(
        await readFile(join(f.options.artifacts_directory, id, attempt!.id, 'never-started.json'), 'utf8'),
      );
      assert.equal(proof.spawned, false);
      assert.equal(proof.capacity, null);
    }
    assert.equal(f.capacity.inspect('limited').entries.length, 0);
    assert.equal(existsSync(f.marker), false);
    assert.equal(await companion.runOnce(), true);
    assert.equal((await f.storage.get('execution_jobs', fits))?.status, 'succeeded');
    assert.equal(f.capacity.inspect('limited').occupied.script, 0);
  });
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
    await assert.rejects(original, /could not be fenced|ownership lost/);
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
        delete proof.capacity.state;
        await writeFile(proofFile, JSON.stringify(proof));
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
        assert.equal(f.capacity.inspect('test').entries[0]!.state, occupied ? 'settled' : 'cancelled');
        assert.equal(existsSync(f.marker), false);
      },
    );
  for (const completed of [false, true])
    check(
      `retains a same-millisecond admission after ${completed ? 'terminal' : 'reserved'} never-started proof`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'fixture',
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
        await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
        if (completed) {
          const application = new Proxy(f.app, {
            get(target, key) {
              if (key === 'recoverExecutionRun')
                return async (...args: Parameters<typeof target.recoverExecutionRun>) => {
                  assert.equal(await target.recoverExecutionRun(...args), true);
                  throw new Error('Crash before capacity cleanup.');
                };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          await assert.rejects(
            new ExecutionCompanion({ ...f.options, application }).runOnce(),
            /Crash before capacity cleanup/,
          );
        }
        const dispatcher = new HostCapacity(f.capacityFile);
        let raced = false;
        const capacity = new Proxy(f.capacity, {
          get(target, key) {
            if (key === 'reconcileNeverStarted')
              return (...args: Parameters<typeof target.reconcileNeverStarted>) => {
                assert.equal(args[0].state, 'queued');
                const originalNow = Date.now;
                try {
                  Date.now = () => args[1];
                  assert.equal(dispatcher.claimNext('test', 'racing-dispatcher').admitted, true);
                  raced = true;
                  return target.reconcileNeverStarted(...args);
                } finally {
                  Date.now = originalNow;
                }
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        try {
          await new ExecutionCompanion({ ...f.options, capacity }).runOnce();
          assert.equal(raced, true);
          assert.equal((await f.view()).run.error_code, 'RECOVERED_NOT_DISPATCHED');
          assert.equal(f.capacity.inspect('test').entries[0]!.state, 'running');
          assert.equal(f.capacity.inspect('test').occupied.script, 1);
          await new ExecutionCompanion(f.options).runOnce();
          assert.equal(f.capacity.inspect('test').occupied.script, 1);
          assert.equal(existsSync(f.marker), false);
        } finally {
          dispatcher.close();
        }
      },
    );

  for (const occupied of [false, true])
    check(
      `repairs a legacy torn never-started proof only while undispatched (${occupied ? 'occupied' : 'queued'})`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'fixture',
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
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
        const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
        mkdirSync(directory, { recursive: true });
        const proofFile = join(directory, 'never-started.json');
        await writeFile(proofFile, '');
        await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
        const application = new Proxy(f.app, {
          get(target, key) {
            if (key === 'recoverExecutionRun')
              return async (...args: Parameters<typeof target.recoverExecutionRun>) => {
                assert.equal(await target.recoverExecutionRun(...args), true);
                throw new Error('Crash after repaired settlement.');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await assert.rejects(
          new ExecutionCompanion({ ...f.options, application }).runOnce(),
          /Crash after repaired settlement/,
        );
        assert.equal(await readFile(proofFile, 'utf8'), '');
        const repairFile = join(directory, 'never-started-recovered.json');
        const repaired = await readFile(repairFile, 'utf8');
        assert.equal(
          JSON.parse(repaired).capacity.execution_token,
          f.capacity.inspect('test').entries[0]!.execution_token,
        );
        await new ExecutionCompanion(f.options).runOnce();
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal(await readFile(proofFile, 'utf8'), '');
        assert.equal(await readFile(repairFile, 'utf8'), repaired);
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
        assert.equal(f.capacity.inspect('test').entries[0]!.state, occupied ? 'settled' : 'cancelled');
        assert.equal(existsSync(f.marker), false);
      },
    );

  for (const settled of [false, true])
    check(
      `completes undispatched recovery with already ${settled ? 'settled' : 'cancelled'} capacity`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'fixture',
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
        if (settled) {
          const claim = f.capacity.claimNext('test', 'fixture');
          assert.equal(claim.admitted, true);
          if (claim.admitted)
            f.capacity.reconcile(claim.lease, {
              source: 'fixture',
              execution_token: claim.request.execution_token!,
              observed_at: Date.now(),
              state: 'never_started',
              script_result: { outcome: 'cancelled', runtime_ms: 0 },
            });
        } else f.capacity.cancel('test', f.runId);
        await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal((await f.view()).run.error_code, 'RECOVERED_NOT_DISPATCHED');
        assert.equal(f.capacity.inspect('test').entries[0]!.state, settled ? 'settled' : 'cancelled');
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
        const proof = JSON.parse(
          await readFile(
            join(f.options.artifacts_directory, f.runId, state.attempt!.id, 'never-started.json'),
            'utf8',
          ),
        );
        assert.equal(proof.capacity, null);
        assert.equal(existsSync(f.marker), false);
      },
    );

  for (const dispatched of [false, true])
    check(
      `does not fabricate a missing proof after ${dispatched ? 'dispatch intent' : 'terminal settlement'}`,
      async (f) => {
        const controller = (await f.app.acquireExecutionController(
          f.admin.id,
          f.project.id,
          'fixture',
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
        assert.equal(f.capacity.claimNext('test', 'original').admitted, true);
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id))[0]!;
        const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
        mkdirSync(directory, { recursive: true });
        await writeFile(join(directory, 'never-started.json'), '');
        if (dispatched) {
          await f.app.startExecutionRun(
            f.admin.id,
            f.project.id,
            f.runId,
            run.reservation_token!,
            60_000,
            controller,
          );
        } else {
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
            true,
          );
        }
        await f.app.releaseExecutionController(f.admin.id, f.project.id, controller);
        await new ExecutionCompanion(f.options).runOnce();
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal(await readFile(join(directory, 'never-started.json'), 'utf8'), '');
        assert.equal(existsSync(join(directory, 'never-started-recovered.json')), false);
        assert.equal(f.capacity.inspect('test').occupied.script, 1);
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
          assert.equal(await running, true);
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

  for (const afterCommit of [false, true])
    check(
      `replays direct NOT_STARTED proof after ${afterCommit ? 'committed' : 'uncommitted'} settlement crash`,
      async (f) => {
        const application = new Proxy(f.app, {
          get(target, key) {
            if (key === 'startExecutionRun')
              return async (...args: Parameters<typeof target.startExecutionRun>) => {
                assert.equal(f.capacity.inspect('test').occupied.script, 1);
                await f.storage.transaction(f.project.id, async (tx) => {
                  const claim = (await tx.get('claims', f.ticket.id))!;
                  await tx.put('claims', {
                    ...claim,
                    expires_at: new Date(f.clock.now.getTime() - 1).toISOString(),
                  });
                });
                return target.startExecutionRun(...args);
              };
            if (key === 'recoverExecutionRun')
              return async (...args: Parameters<typeof target.recoverExecutionRun>) => {
                if (afterCommit) assert.equal(await target.recoverExecutionRun(...args), true);
                throw new Error('Direct no-start settlement crash.');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await assert.rejects(
          new ExecutionCompanion({ ...f.options, application }).runOnce(),
          /Direct no-start settlement crash/,
        );
        const entry = f.capacity.inspect('test').entries[0]!;
        assert.equal(entry.state, 'running');
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
        const file = join(f.options.artifacts_directory, f.runId, state.attempt!.id, 'never-started.json');
        const proof = await readFile(file, 'utf8');
        assert.equal(JSON.parse(proof).error_code, 'NOT_STARTED');
        assert.equal(JSON.parse(proof).capacity.execution_token, entry.execution_token);
        assert.equal(JSON.parse(proof).attempt_id, state.attempt!.id);
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal((await f.view()).run.error_code, 'NOT_STARTED');
        assert.equal((await f.view()).continuation.failure_reason, 'STALE_AUTHORITY');
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
        assert.equal(await readFile(file, 'utf8'), proof);
        assert.equal(existsSync(f.marker), false);
      },
    );

  for (const expired of ['claim', 'run', 'controller', 'blocker'] as const)
    check(
      `journals actual supervisor dispatch rejection for expired ${expired} without native launch`,
      async (f) => {
        const application = new Proxy(f.app, {
          get(target, key) {
            if (key === 'startExecutionRun')
              return async (...args: Parameters<typeof target.startExecutionRun>) => {
                const run = await target.startExecutionRun(...args);
                if (expired === 'blocker')
                  await f.call(f.worker.id, 'ticket_note', {
                    ticket_id: f.ticket.id,
                    kind: 'question',
                    body: 'New launch blocker.',
                    blocking: true,
                  });
                else
                  await f.storage.transaction(f.project.id, async (tx) => {
                    const past = new Date(Date.now() - 1000).toISOString();
                    if (expired === 'claim') {
                      const row = (await tx.get('claims', f.ticket.id))!;
                      await tx.put('claims', { ...row, expires_at: past });
                    } else if (expired === 'run') {
                      const row = (await tx.get('execution_jobs', f.runId))!;
                      assert.equal(await tx.compareExecutionRun!(row, { ...row, locked_until: past }), true);
                    } else {
                      const row = (await tx.get('execution_controllers', 'execution'))!;
                      await tx.put('execution_controllers', { ...row, expires_at: past });
                    }
                  });
                return run;
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const running = new ExecutionCompanion({ ...f.options, application }).runOnce();
        if (expired === 'claim' || expired === 'blocker') assert.equal(await running, true);
        else await assert.rejects(running, /could not be fenced/);
        const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
        const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
        const proof = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
        assert.equal(proof.no_launch, true);
        assert.equal(proof.error_code, 'DISPATCH_REJECTED');
        assert.equal(proof.capacity.execution_token, f.capacity.inspect('test').entries[0]!.execution_token);
        assert.equal(existsSync(join(directory, 'dispatch.json')), false);
        assert.equal(existsSync(join(directory, 'process.json')), false);
        if (expired === 'run') {
          await writeFile(
            join(directory, 'launch.json'),
            JSON.stringify({
              ...proof,
              capacity: { ...proof.capacity, execution_token: randomUUID() },
            }),
          );
          await new ExecutionCompanion(f.options).runOnce();
          assert.equal(f.capacity.inspect('test').occupied.script, 1);
          await writeFile(join(directory, 'launch.json'), JSON.stringify(proof));
        }
        await new ExecutionCompanion(f.options).runOnce();
        assert.equal((await f.view()).run.error_code, 'DISPATCH_REJECTED');
        assert.equal(f.capacity.inspect('test').occupied.script, 0);
        assert.equal(existsSync(f.marker), false);
      },
    );

  check(
    'keeps ambiguous supervisor storage errors unresolved without inventing no-launch proof',
    async (f) => {
      const descriptor = f.storage.executionLaunchStorage!;
      let invalid: typeof descriptor;
      if (descriptor.adapter === 'sqlite')
        invalid = { adapter: 'sqlite', filename: join(f.directory, 'unmigrated.sqlite') };
      else {
        const url = new URL(descriptor.connection_string);
        url.pathname = '/missing_execution_' + randomUUID().replaceAll('-', '');
        invalid = { adapter: 'postgres', connection_string: url.href };
      }
      const storage = new Proxy(f.storage, {
        get(target, key) {
          if (key === 'executionLaunchStorage') return invalid;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const application = new Proxy(f.app, {
        get(target, key) {
          if (key === 'storage') return storage;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      assert.equal(await new ExecutionCompanion({ ...f.options, application }).runOnce(), true);
      const state = (await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [f.runId]))[0]!;
      const directory = join(f.options.artifacts_directory, f.runId, state.attempt!.id);
      for (const name of ['launch.json', 'dispatch.json', 'never-started.json', 'result.json'])
        assert.equal(existsSync(join(directory, name)), false, name);
      await new ExecutionCompanion(f.options).runOnce();
      assert.equal((await f.view()).reconciliation.state, 'unresolved');
      assert.equal(f.capacity.inspect('test').occupied.script, 1);
      assert.equal(existsSync(f.marker), false);
    },
  );

  check('daemon continues in its second slot after timeout leaves first run unresolved', async (f) => {
    const recipes = new ExecutionRecipeRegistry({
      ...f.config,
      recipes: [
        {
          ...f.config.recipes[0],
          timeout_ms: 1000,
          argv: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(f.marker)},'x');setTimeout(()=>{},10000);`,
          ],
        },
        {
          ...f.config.recipes[0],
          id: 'fast',
          timeout_ms: 5000,
          argv: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(f.marker)},'x');`],
        },
      ],
    });
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      executionRecipes: recipes.metadata(),
      now: () => f.clock.now,
    });
    await f.sql(
      `UPDATE execution_jobs SET recipe_fingerprint='${recipes.metadata()[0]!.fingerprint}' WHERE id='${f.runId}'`,
    );
    const created = (await f.call(f.other.id, 'tickets_create', {
      tickets: [
        {
          title: 'Unrelated work after timeout',
          description: 'Uses the free host slot.',
          criteria: ['Completes independently.'],
          status: 'ready',
        },
      ],
    })) as any;
    const otherTicket = created.tickets[0].id;
    const otherClaim = (await f.call(f.other.id, 'work_claim', { ticket_id: otherTicket })) as any;
    f.clock.now = new Date(f.clock.now.getTime() + 1);
    const receipt = (await app.execute(f.other.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: otherTicket,
      claim_token: otherClaim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'fast',
      checkpoint: { progress: 'Second independent run.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    const abort = new AbortController();
    let sawTwoSlots = false;
    const application = new Proxy(app, {
      get(target, key) {
        if (key === 'startExecutionRun')
          return async (...args: Parameters<typeof target.startExecutionRun>) => {
            sawTwoSlots ||= f.capacity.inspect('test').occupied.script === 2;
            return target.startExecutionRun(...args);
          };
        if (key === 'recoverExecutionRun')
          return async (...args: Parameters<typeof target.recoverExecutionRun>) => {
            const result = await target.recoverExecutionRun(...args);
            if (args[2] === receipt.run_id && result) abort.abort();
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const deadline = setTimeout(() => abort.abort(), 10_000);
    try {
      await new ExecutionCompanion({ ...f.options, application, recipes }).run(abort.signal);
    } catch (error) {
      throw new Error(
        JSON.stringify({
          runs: (await f.storage.find('execution_jobs')).map(({ id, status }) => ({ id, status })),
          occupied: f.capacity.inspect('test').occupied,
        }),
        { cause: error },
      );
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(sawTwoSlots, true);
    assert.equal((await f.view()).reconciliation.state, 'unresolved');
    assert.equal((await f.storage.get('execution_jobs', receipt.run_id))!.status, 'succeeded');
    assert.equal(f.capacity.inspect('test').occupied.script, 1);
    assert.equal(await readFile(f.marker, 'utf8'), 'xx');
  });

  check(
    'bounded recovery cursors pass 100 unresolved rows and survive active-set removal, terminalization and mutation',
    async (f) => {
      const original = (await f.storage.get('execution_jobs', f.runId))!;
      const continuation = (await f.storage.get('continuations', original.continuation_id))!;
      const ids = Array.from(
        { length: 205 },
        (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      );
      await f.storage.transaction(f.project.id, async (tx) => {
        for (const id of ids) {
          const continuationId = randomUUID();
          await tx.put('execution_jobs', {
            ...original,
            id,
            continuation_id: continuationId,
            status: id === ids.at(-1) ? 'failed' : 'running',
            reservation_token: randomUUID(),
            locked_until: new Date(Date.now() + 60_000).toISOString(),
            started_at: original.created_at,
            error_code: id === ids.at(-1) ? 'NOT_STARTED' : null,
          });
          await tx.put('continuations', { ...continuation, id: continuationId, run_id: id });
        }
        await tx.put('execution_attempts', {
          id: randomUUID(),
          project_id: f.project.id,
          run_id: ids.at(-1)!,
          previous_attempt_id: null,
          ordinal: 1,
          process_token: randomUUID(),
          created_at: original.created_at,
        });
      });
      for (const id of ids)
        f.capacity.enqueue('test', {
          queue_id: id,
          run_id: id,
          project_id: f.project.id,
          kind: 'script',
          resources: {},
          timeout_ms: 5000,
          created_at: Date.now(),
        });
      const terminal = (
        await f.app.listExecutionReconciliations(f.admin.id, f.project.id, [ids.at(-1)!])
      )[0]!;
      const directory = join(f.options.artifacts_directory, terminal.run.id, terminal.attempt!.id);
      mkdirSync(directory, { recursive: true });
      durableExecutionFile(join(directory, 'never-started.json'), {
        run_id: terminal.run.id,
        attempt_id: terminal.attempt!.id,
        process_token: terminal.attempt!.process_token,
        recipe_fingerprint: original.recipe_fingerprint,
        exit_code: null,
        signal: null,
        artifacts: [],
        error_code: 'NOT_STARTED',
        started_at: 0,
        finished_at: Date.now(),
        cleanup_verified: true,
        spawned: false,
        capacity: {
          host_id: 'test',
          queue_id: terminal.run.id,
          run_id: terminal.run.id,
          project_id: f.project.id,
          state: 'queued',
          execution_token: null,
        },
      });
      const seen = new Set<string>();
      const application = new Proxy(f.app, {
        get(target, key) {
          if (key === 'listExecutionRuns') return async () => [];
          if (key === 'listExecutionReconciliations')
            return async (...args: Parameters<typeof target.listExecutionReconciliations>) => {
              const page = await target.listExecutionReconciliations(...args);
              assert.ok(page.length <= 100);
              return page;
            };
          if (key === 'adoptExecutionRun')
            return async (...args: Parameters<typeof target.adoptExecutionRun>) => {
              seen.add(args[2]);
              return target.adoptExecutionRun(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const companion = new ExecutionCompanion({ ...f.options, application });
      await companion.runOnce();
      assert.equal(seen.size, 100);
      await f.storage.transaction(f.project.id, async (tx) => {
        for (const id of ids.slice(0, 100)) {
          const row = (await tx.get('execution_jobs', id))!;
          assert.equal(await tx.compareExecutionRun!(row, { ...row, status: 'failed' }), true);
        }
      });
      await f.sql(
        `UPDATE execution_jobs SET created_at='${new Date(Date.now() + 1000).toISOString()}' WHERE id IN (${ids
          .slice(0, 100)
          .map((id) => `'${id}'`)
          .join(',')})`,
      );
      await f.storage.transaction(f.project.id, async (tx) => {
        const removed = (await tx.get('execution_jobs', ids[100]!))!;
        assert.equal(await tx.compareExecutionRun!(removed, { ...removed, status: 'failed' }), true);
      });
      f.capacity.cancel('test', ids[100]!);
      await companion.runOnce();
      await companion.runOnce();
      assert.equal(seen.size, 203);
      assert.equal(
        f.capacity.inspect('test').entries.find((entry) => entry.queue_id === terminal.run.id)!.state,
        'cancelled',
      );
      assert.equal(existsSync(f.marker), false);
    },
  );
}
