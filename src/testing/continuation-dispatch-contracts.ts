import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../application.js';
import { ClientCapabilities } from '../client-capabilities.js';
import { ContinuationDispatcher } from '../continuation-dispatch.js';
import { HostCapacity } from '../host-capacity.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';
import type { ContinuationInvocation, WakeFence } from '../contracts.js';

export function registerContinuationDispatchContractTests(
  name: string,
  factory: () => Promise<ContractAdapters>,
) {
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-continuation-'));
    const clients = new ClientCapabilities({
      clients: [
        {
          id: 'benign-fixture',
          actor_ids: [f.worker.id],
          project_ids: [f.project.id],
          operating_system: 'fixture',
          tools: [],
          environments: ['local-fake'],
          models: [{ id: 'fake-model', efforts: [] }],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    const options = {
      ...adapters,
      now: () => f.clock.now,
      clientCapabilities: clients,
      executionRecipes: [{ id: 'fixture', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
      executionArtifacts: { directory },
    };
    const app = createApplication(options);
    const ticket = await f.ticket();
    const claimed = (await app.execute(f.worker.id, 'work_claim', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      idempotency_key: randomUUID(),
    })) as any;
    const submitted = (await app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claimed.claim.token,
      recipe_id: 'fixture',
      checkpoint: { progress: 'Wait for fixture result; this text is not executable.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
      idempotency_key: randomUUID(),
    })) as any;
    const reserved = (await app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60_000))!;
    assert.ok(
      await app.startExecutionRun(f.admin.id, f.project.id, reserved.id, reserved.reservation_token!, 60_000),
    );
    const attempt = (await app.listExecutionReconciliations(f.admin.id, f.project.id, [reserved.id]))[0]!
      .attempt!;
    const artifacts = join(directory, reserved.id, attempt.id);
    await mkdir(artifacts, { recursive: true });
    const outcome = {
      run_id: reserved.id,
      attempt_id: attempt.id,
      exit_code: 0,
      signal: null,
      error_code: null,
    };
    const bytes = JSON.stringify(outcome) + '\n';
    await writeFile(join(artifacts, 'outcome.json'), bytes);
    await writeFile(
      join(artifacts, 'result.json'),
      JSON.stringify({
        ...outcome,
        process_token: attempt.process_token,
        recipe_fingerprint: reserved.recipe_fingerprint,
        cleanup_verified: true,
        finished_at: Date.now(),
        sha256: {
          result: createHash('sha256').update(bytes).digest('hex'),
        },
      }),
    );
    const capacityFile = join(directory, 'capacity.sqlite');
    let capacity = new HostCapacity(capacityFile, clients);
    capacity.configureHost('host', { agent_slots: 1 });
    const allowance = { provider_tokens: 100, runtime_ms: 60_000, cost_usd_micros: null };
    const budgetRun = randomUUID();
    capacity.createRun({
      run_id: budgetRun,
      project_id: f.project.id,
      work: [{ ticket_id: ticket.id, requirements_revision: ticket.requirements_revision }],
      limits: { max_attempts: 5, max_provider_tokens: 1000, max_runtime_ms: 600_000 },
    });
    capacity.enqueue('host', {
      queue_id: 'predecessor',
      run_id: budgetRun,
      kind: 'agent',
      created_at: 0,
      execution: claimed.claim.execution,
      admission: {
        attempt_id: 'predecessor',
        actor_id: f.worker.id,
        ticket_id: ticket.id,
        requirements_revision: ticket.requirements_revision,
        role: 'worker',
        provider: 'fake',
        model: 'fake-model',
        allowance,
      },
    });
    const predecessor = capacity.claimNext('host', 'original-worker');
    assert.ok(predecessor.admitted);
    const request = {
      ticket_id: ticket.id,
      budget_run_id: budgetRun,
      provider: 'fake',
      allowance,
      predecessor: {
        host_id: 'host',
        queue_id: 'predecessor',
        execution_token: predecessor.request.execution_token!,
      },
    };
    let calls = 0;
    const launch = (_context: unknown, _invocation: ContinuationInvocation): undefined => {
      calls++;
    };
    const dispatcher = (launchCallback = launch, application = app) =>
      new ContinuationDispatcher({
        application,
        capacity,
        actor_id: f.admin.id,
        project_id: f.project.id,
        host_id: 'host',
        launch: launchCallback,
      });
    const register = (deadline?: string) =>
      app.registerWakeCondition(f.admin.id, f.project.id, {
        ticket_id: ticket.id,
        condition: { kind: 'continuation', continuation_id: submitted.continuation_id },
        deadline,
      });
    const settleScript = (exit_code = 0) =>
      app.settleExecutionRun(f.admin.id, f.project.id, reserved.id, reserved.reservation_token!, {
        exit_code,
        signal: null,
        error_code: null,
        artifacts: [`execution:${reserved.id}:${attempt.id}:result`],
      });
    const settlement = {
      outcome: 'succeeded' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
      usage_source: 'independent-fake-supervisor',
      runtime_ms: 1,
    };
    const exitPredecessor = () =>
      capacity.reconcile(predecessor.lease, {
        source: 'independent-fake-supervisor',
        execution_token: request.predecessor.execution_token,
        observed_at: Date.now(),
        state: 'terminated',
        settlement,
      });
    const get = () => app.getWakeCondition(f.admin.id, f.project.id, ticket.id);
    const restart = () => {
      capacity.close();
      capacity = new HostCapacity(capacityFile, clients);
      return dispatcher(launch, createApplication(options));
    };
    return {
      ...f,
      app,
      ticket,
      artifacts,
      capacity: () => capacity,
      request,
      register,
      settleScript,
      exitPredecessor,
      dispatcher,
      get,
      restart,
      calls: () => calls,
      settlement,
      async dispose() {
        capacity.close();
        await adapters.dispose?.();
        assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('ticketing-continuation-'));
        await rm(directory, { recursive: true });
      },
    };
  }
  const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} continuation dispatch: ${title}`, async () => {
      const f = await setup();
      try {
        await work(f);
      } finally {
        await f.dispose();
      }
    });

  check(
    'waits through early settlement and restart, launches once, and requires exact trusted exit',
    async (f) => {
      await f.register();
      assert.equal((await f.dispatcher().runOnce(f.request)).code, 'CONDITION_PENDING');
      await f.settleScript();
      const waiting = await f.dispatcher().runOnce(f.request);
      assert.equal(waiting.code, 'PREDECESSOR_RUNNING');
      const generation = (await f.get()).generation;
      assert.equal((await f.restart().runOnce(f.request)).code, 'PREDECESSOR_RUNNING');
      assert.equal(f.calls(), 0);
      assert.equal((await f.get()).generation, generation);
      f.exitPredecessor();
      const attempts = await Promise.all([
        f.dispatcher().runOnce(f.request),
        f.dispatcher().runOnce(f.request),
      ]);
      assert.ok(attempts.every((result) => result.state === 'starting' || result.state === 'running'));
      assert.equal(f.calls(), 1);
      const active = (await f.get()).active!;
      const fence = { ticket_id: f.ticket.id, generation: active.generation, token: active.token };
      await assert.rejects(
        f.app.finishWakeDecision(f.admin.id, f.project.id, fence),
        hasCode('WAKE_PENDING'),
      );
      assert.equal((await f.restart().runOnce(f.request)).state, 'running');
      assert.equal(f.calls(), 1);
      const invocation = active.dispatch!.invocation!;
      const proof = {
        source: 'independent-fake-supervisor',
        execution_token: invocation.execution_token,
        observed_at: Date.now(),
        state: 'terminated' as const,
        settlement: f.settlement,
      };
      await assert.rejects(
        f.dispatcher().reconcile(fence, { ...proof, execution_token: randomUUID() }),
        hasCode('CONFLICT'),
      );
      assert.equal(f.capacity().inspect('host').occupied.agent, 1);
      assert.equal(await f.dispatcher().reconcile(fence, proof), true);
      assert.equal(await f.dispatcher().reconcile(fence, proof), true);
      assert.equal((await f.get()).active!.dispatch!.state, 'completed');
      assert.equal(f.capacity().inspect('host').occupied.agent, 0);
      assert.equal(await f.app.finishWakeDecision(f.admin.id, f.project.id, fence), true);
      assert.equal((await f.dispatcher().runOnce(f.request)).code, 'CONDITION_PENDING');
      assert.equal(f.calls(), 1);
    },
  );

  check('holds satisfied generations through capacity saturation', async (f) => {
    await f.settleScript();
    await f.register();
    f.exitPredecessor();
    const capacity = f.capacity();
    capacity.configureHost('other');
    // An unrelated agent occupies the only destination slot.
    const previous = capacity.inspect('host').entries[0]!;
    capacity.enqueue('host', {
      queue_id: 'busy',
      run_id: f.request.budget_run_id,
      kind: 'agent',
      created_at: 0,
      execution: previous.execution!,
      admission: { ...previous.admission!, attempt_id: 'busy' },
    });
    const busy = capacity.claimNext('host', 'other-worker');
    assert.ok(busy.admitted);
    assert.equal((await f.dispatcher().runOnce(f.request)).code, 'HOST_CAPACITY');
    assert.equal((await f.restart().runOnce(f.request)).state, 'waiting');
    assert.equal(f.calls(), 0);
    f.capacity().reconcile(busy.lease, {
      source: 'independent-fake-supervisor',
      execution_token: busy.request.execution_token!,
      observed_at: Date.now(),
      state: 'terminated',
      settlement: f.settlement,
    });
    assert.equal((await f.dispatcher().runOnce(f.request)).state, 'running');
    assert.equal(f.calls(), 1);
  });

  check(
    'evaluates a requested continuation beyond the first registration page without a sweep',
    async (f) => {
      await f.settleScript();
      await f.register();
      f.exitPredecessor();
      await f.storage.transaction(f.project.id, async (tx) => {
        const registration = (await tx.get('wake_conditions', f.ticket.id))!;
        for (let index = 0; index < 100; index++) {
          const hex = (BigInt(`0x${f.ticket.id.replaceAll('-', '')}`) - BigInt(index + 1))
            .toString(16)
            .padStart(32, '0');
          const id = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
          assert.ok(id < f.ticket.id);
          await tx.put('tickets', { ...f.ticket, id, key: `${f.project.key}-${index + 1000}` });
          await tx.put('wake_conditions', {
            ...registration,
            id,
            ticket_id: id,
            condition: { kind: 'events', types: ['ticket.note_added'] },
          });
        }
      });
      const first = await f.app.evaluateWakeConditions(f.admin.id, f.project.id);
      assert.equal(first.evaluated, 100);
      assert.equal(first.has_more, true);
      assert.deepEqual((await f.get()).pending, []);
      await assert.rejects(
        f.app.evaluateWakeConditions(f.admin.id, f.project.id, {
          ticket_id: f.ticket.id,
          after: first.next_cursor,
        }),
        hasCode('INVALID_INPUT'),
      );
      assert.equal((await f.dispatcher().runOnce(f.request)).state, 'running');
      assert.equal(f.calls(), 1);
    },
  );

  for (const failure of [
    'deadline',
    'requirements',
    'authorization',
    'capabilities',
    'approval',
    'artifact',
    'budget',
  ] as const)
    check(`persists ${failure} needs_attention without invocation`, async (f) => {
      await f.settleScript();
      await f.register(
        failure === 'deadline' ? new Date(f.clock.now.getTime() - 1).toISOString() : undefined,
      );
      f.exitPredecessor();
      if (failure === 'requirements') {
        const current = await f.read(f.ticket.id);
        await f.call(f.worker.id, 'ticket_update', {
          ticket_id: f.ticket.id,
          expected_revision: current.ticket.revision,
          description: 'Changed requirements.',
        });
      }
      if (failure === 'authorization')
        await f.app.execute(f.admin.id, 'member_set', {
          project_id: f.project.id,
          actor_id: f.worker.id,
          role: 'reader',
          idempotency_key: randomUUID(),
        });
      if (failure === 'capabilities') {
        const current = await f.read(f.ticket.id);
        await f.call(f.worker.id, 'ticket_update', {
          ticket_id: f.ticket.id,
          expected_revision: current.ticket.revision,
          capabilities: ['unsupported-tool'],
        });
      }
      if (failure === 'approval')
        await f.call(f.worker.id, 'ticket_note', {
          ticket_id: f.ticket.id,
          kind: 'question',
          body: 'Operator approval is required.',
          blocking: true,
        });
      if (failure === 'artifact') {
        const path = join(f.artifacts, 'outcome.json');
        const original = await readFile(path, 'utf8');
        await writeFile(path, original.replace('"exit_code":0', '"exit_code":1'));
      }
      if (failure === 'budget') {
        const capacity = f.capacity(),
          prior = capacity.inspect('host').entries[0]!;
        capacity.enqueue('host', {
          queue_id: 'unknown-usage',
          run_id: f.request.budget_run_id,
          kind: 'agent',
          created_at: 0,
          execution: prior.execution!,
          admission: { ...prior.admission!, attempt_id: 'unknown-usage' },
        });
        const admitted = capacity.claimNext('host', 'fixture');
        assert.ok(admitted.admitted);
        capacity.reconcile(admitted.lease, {
          source: 'independent-fake-supervisor',
          execution_token: admitted.request.execution_token!,
          observed_at: Date.now(),
          state: 'terminated',
          settlement: { outcome: 'failed', runtime_ms: null },
        });
      }
      const result = await f.dispatcher().runOnce(f.request);
      assert.equal(result.state, 'needs_attention');
      const active = (await f.get()).active!;
      assert.equal(active.dispatch!.invocation, null);
      assert.equal((await f.restart().runOnce(f.request)).state, 'needs_attention');
      assert.equal((await f.get()).active!.generation, active.generation);
      assert.equal(f.calls(), 0);
    });

  check(
    'retains launch uncertainty across restart and reconciles only independent no-start proof',
    async (f) => {
      await f.settleScript();
      await f.register();
      f.exitPredecessor();
      let calls = 0;
      const result = await f
        .dispatcher(() => {
          calls++;
          throw new Error('Fake launcher connection lost.');
        })
        .runOnce(f.request);
      assert.equal(result.state, 'needs_attention');
      assert.equal(result.code, 'LAUNCH_UNCERTAIN');
      assert.equal(calls, 1);
      assert.equal((await f.restart().runOnce(f.request)).state, 'needs_attention');
      assert.equal(f.calls(), 0);
      assert.equal(f.capacity().inspect('host').occupied.agent, 1);
      const active = (await f.get()).active!;
      const fence: WakeFence = { ticket_id: f.ticket.id, generation: active.generation, token: active.token };
      await f.dispatcher().reconcile(fence, {
        source: 'independent-fake-supervisor',
        execution_token: active.dispatch!.invocation!.execution_token,
        observed_at: Date.now(),
        state: 'never_started',
        settlement: {
          outcome: 'cancelled',
          runtime_ms: 0,
          usage_source: 'independent-fake-supervisor',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      assert.equal((await f.get()).active!.dispatch!.state, 'completed');
      assert.equal(f.capacity().inspect('host').occupied.agent, 0);
    },
  );

  for (const boundary of ['crash', 'artifact_changed'] as const)
    check(`never relaunches when ${boundary} occurs after committed intent`, async (f) => {
      await f.settleScript();
      await f.register();
      f.exitPredecessor();
      const transaction = f.storage.transaction.bind(f.storage);
      let injected = false;
      f.storage.transaction = async (scope, work) => {
        const result = await transaction(scope, work);
        if (!injected && (result as any)?.state === 'starting') {
          injected = true;
          if (boundary === 'crash') throw new Error('Simulated disconnect after committed intent.');
          const path = join(f.artifacts, 'outcome.json');
          await writeFile(path, (await readFile(path, 'utf8')).replace('"exit_code":0', '"exit_code":1'));
        }
        return result;
      };
      try {
        if (boundary === 'crash')
          await assert.rejects(f.dispatcher().runOnce(f.request), /Simulated disconnect/);
        else assert.equal((await f.dispatcher().runOnce(f.request)).code, 'INVALID_ARTIFACT');
      } finally {
        f.storage.transaction = transaction;
      }
      const active = (await f.get()).active!;
      assert.equal(active.dispatch!.state, boundary === 'crash' ? 'starting' : 'needs_attention');
      assert.equal(f.calls(), 0);
      assert.equal(f.capacity().inspect('host').occupied.agent, 1);
      assert.equal((await f.restart().runOnce(f.request)).state, active.dispatch!.state);
      assert.equal(f.calls(), 0);
      assert.equal((await f.get()).generation, active.generation);
    });

  for (const expired of [false, true])
    check(
      `recovers exact admission after ticket rollback with ${expired ? 'expired' : 'current'} worker claim`,
      async (f) => {
        await f.settleScript();
        await f.register();
        f.exitPredecessor();
        const transaction = f.storage.transaction.bind(f.storage);
        let injected = false;
        f.storage.transaction = (scope, work) =>
          transaction(scope, async (tx) => {
            const result = await work(tx);
            if (!injected && (result as any)?.state === 'starting') {
              injected = true;
              throw new Error('Simulated rollback after capacity admission before ticket commit.');
            }
            return result;
          });
        try {
          await assert.rejects(f.dispatcher().runOnce(f.request), /Simulated rollback after capacity/);
        } finally {
          f.storage.transaction = transaction;
        }
        const before = (await f.get()).active!;
        assert.equal(before.dispatch, undefined);
        const occupied = f
          .capacity()
          .inspect('host')
          .entries.find((entry) => entry.state === 'running')!;
        assert.ok(occupied.execution_token);
        const charged = f.capacity().report(f.request.budget_run_id).budget_charged_or_reserved;
        assert.equal(charged.attempts, 2);
        if (expired) f.clock.now = new Date(f.clock.now.getTime() + 3_600_000);
        const fresh = f.restart();
        const recovered = await Promise.all([fresh.runOnce(f.request), f.dispatcher().runOnce(f.request)]);
        assert.ok(
          recovered.every(
            (result) => result.state === 'needs_attention' && result.code === 'ADMISSION_UNCERTAIN',
          ),
        );
        const active = (await f.get()).active!;
        assert.equal(active.generation, before.generation);
        assert.equal(active.dispatch!.invocation!.queue_id, occupied.queue_id);
        assert.equal(active.dispatch!.invocation!.execution_token, occupied.execution_token);
        assert.equal(f.calls(), 0);
        assert.deepEqual(f.capacity().report(f.request.budget_run_id).budget_charged_or_reserved, charged);
        assert.equal((await f.dispatcher().runOnce(f.request)).code, 'ADMISSION_UNCERTAIN');
        const fence = { ticket_id: f.ticket.id, generation: active.generation, token: active.token };
        await assert.rejects(
          f.app.finishWakeDecision(f.admin.id, f.project.id, fence),
          hasCode('WAKE_PENDING'),
        );
        const proof = {
          source: 'independent-fake-supervisor',
          execution_token: occupied.execution_token!,
          observed_at: Date.now(),
          state: 'never_started' as const,
          settlement: {
            outcome: 'cancelled' as const,
            runtime_ms: 0,
            usage_source: 'independent-fake-supervisor',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        await Promise.all([f.dispatcher().reconcile(fence, proof), f.dispatcher().reconcile(fence, proof)]);
        assert.equal((await f.get()).active!.dispatch!.state, 'completed');
        assert.equal(f.capacity().inspect('host').occupied.agent, 0);
        assert.equal(f.calls(), 0);
      },
    );
}
