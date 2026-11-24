import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../application.js';
import { BranchDispatcher, type BranchDispatchRequest } from '../branch-dispatch.js';
import { ClientCapabilities } from '../client-capabilities.js';
import { HostCapacity } from '../host-capacity.js';
import type { ContinuationInvocation, Ticket } from '../contracts.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerBranchDispatchContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-branches-'));
    const clients = new ClientCapabilities({
      clients: [
        {
          id: 'fixture',
          actor_ids: [f.worker.id],
          project_ids: [f.project.id],
          operating_system: 'fixture',
          tools: [],
          environments: ['fixture'],
          models: [{ id: 'fixture', efforts: [] }],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    const app = createApplication({ ...adapters, now: () => f.clock.now, clientCapabilities: clients });
    const capacityFile = join(directory, 'capacity.sqlite');
    const capacity = new HostCapacity(capacityFile, clients);
    capacity.configureHost('host', { agent_slots: 2 });
    const tickets = await Promise.all([f.ticket(), f.ticket(), f.ticket()]);
    const budget = randomUUID();
    capacity.createRun({
      run_id: budget,
      project_id: f.project.id,
      work: tickets.map((ticket) => ({
        ticket_id: ticket.id,
        requirements_revision: ticket.requirements_revision,
      })),
      limits: { max_attempts: 8, max_provider_tokens: 10_000, max_runtime_ms: 600_000 },
    });
    const requests: BranchDispatchRequest[] = [];
    for (const ticket of tickets) {
      const claimed = (await app.execute(f.worker.id, 'work_claim', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        idempotency_key: randomUUID(),
      })) as any;
      requests.push({
        ticket_id: ticket.id,
        claim_token: claimed.claim.token,
        budget_run_id: budget,
        provider: 'fixture',
        allowance: { provider_tokens: 100, runtime_ms: 60_000, cost_usd_micros: null },
      });
    }
    const calls: ContinuationInvocation[] = [];
    const dispatcher = (
      otherCapacity = capacity,
      launch = (_: unknown, invocation: ContinuationInvocation): undefined => {
        calls.push(invocation);
      },
    ) =>
      new BranchDispatcher({
        application: app,
        capacity: otherCapacity,
        actor_id: f.worker.id,
        project_id: f.project.id,
        host_id: 'host',
        launch,
      });
    const settle = (
      invocation: ContinuationInvocation,
      outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
    ) =>
      dispatcher().reconcile(invocation, {
        source: 'independent-fixture-supervisor',
        execution_token: invocation.execution_token,
        observed_at: Date.now(),
        state: 'terminated',
        settlement: {
          outcome,
          runtime_ms: 1,
          usage_source: 'fixture',
          usage: { input_tokens: 1, output_tokens: 1 },
          cost_usd_micros: 0,
          cost_source: 'fixture',
        },
      });
    const link = (source: Ticket, target: Ticket) =>
      f.call(f.worker.id, 'ticket_link', {
        source_id: source.id,
        target_id: target.id,
        kind: 'blocks',
        action: 'add',
      });
    async function accept(ticket: Ticket, request: BranchDispatchRequest) {
      const submitted = await f.submit(ticket.id, request.claim_token);
      await f.call(f.reviewer.id, 'ticket_review', {
        ticket_id: ticket.id,
        submission_id: submitted.submission.id,
        expected_revision: submitted.ticket.revision,
        decision: 'approve',
        feedback: 'Independent evidence accepted.',
      });
      return (await f.storage.get('submissions', submitted.submission.id))!;
    }
    return {
      ...f,
      app,
      tickets,
      requests,
      capacity,
      capacityFile,
      clients,
      calls,
      dispatcher,
      settle,
      link,
      accept,
      async dispose() {
        capacity.close();
        await adapters.dispose?.();
        assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('ticketing-branches-'));
        await rm(directory, { recursive: true });
      },
    };
  }

  it(`${name}: dispatches independent native claims concurrently within durable host capacity`, async () => {
    const f = await setup();
    const peer = new HostCapacity(f.capacityFile, f.clients);
    try {
      const results = await Promise.all([
        f.dispatcher().runOnce(f.requests),
        f.dispatcher(peer).runOnce(f.requests),
      ]);
      assert.equal(f.calls.length, 2);
      assert.equal(new Set(f.calls.map((call) => call.queue_id)).size, 2);
      assert.equal(f.capacity.inspect('host').occupied.agent, 2);
      assert.equal(results.flat().filter((result) => result.state === 'running').length, 2);
      await f.settle(f.calls[0]!);
      await f.dispatcher(peer).runOnce([f.requests[2]!]);
      assert.equal(f.calls.length, 3);
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.remove('branch_dispatches', f.tickets[0]!.id)),
        hasCode('IMMUTABLE_BRANCH_DISPATCH'),
      );
      assert.equal(f.capacity.inspect('host').occupied.agent, 2);
      await f.dispatcher().runOnce([f.requests[0]!]);
      assert.equal(f.calls.length, 3);
    } finally {
      peer.close();
      await f.dispose();
    }
  });

  it(`${name}: joins exact accepted current results, never process success, cancellation or stale approval`, async () => {
    const f = await setup();
    try {
      const integration = await f.ticket();
      await f.link(f.tickets[0]!, integration);
      await f.link(f.tickets[1]!, integration);
      await assert.rejects(f.link(integration, f.tickets[0]!), hasCode('DEPENDENCY_CYCLE'));
      await assert.rejects(f.claim(integration.id), hasCode('DEPENDENCY_BLOCKED'));
      await f.dispatcher().runOnce(f.requests.slice(0, 2));
      await f.settle(f.calls[0]!);
      await f.settle(f.calls[1]!, 'failed');
      assert.equal((await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id)).ready, false);
      const proof = await f.accept(f.tickets[0]!, f.requests[0]!);
      await f.accept(f.tickets[1]!, f.requests[1]!);
      const accepted = await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id);
      assert.equal(accepted.ready, true);
      assert.equal(
        accepted.branches.find((branch) => branch.ticket_id === f.tickets[0]!.id)?.submission_id,
        proof.id,
      );
      assert.deepEqual(
        accepted.branches.find((branch) => branch.ticket_id === f.tickets[0]!.id)?.evidence,
        proof.evidence,
      );
      await assert.rejects(
        f.app.getDependencyJoin(f.outsider.id, f.project.id, integration.id),
        hasCode('FORBIDDEN'),
      );
      await f.storage.transaction(f.project.id, async (tx) => {
        const ticket = (await tx.get('tickets', f.tickets[0]!.id))!;
        await tx.put('tickets', { ...ticket, requirements_revision: ticket.requirements_revision + 1 });
      });
      const stale = await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id);
      assert.equal(stale.ready, false);
      assert.equal(
        stale.branches.find((branch) => branch.ticket_id === f.tickets[0]!.id)?.state,
        'superseded',
      );
      assert.notEqual(stale.identity, accepted.identity);
      const second = (await f.read(f.tickets[1]!.id)).ticket;
      await f.call(f.worker.id, 'ticket_transition', {
        ticket_id: second.id,
        expected_revision: second.revision,
        status: 'cancelled',
        reason: 'Cancel branch.',
      });
      assert.equal(
        (await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id)).branches.find(
          (branch) => branch.ticket_id === second.id,
        )?.state,
        'cancelled',
      );
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: requires accepted children at the dispatch fence and exposes rejected retry state`, async () => {
    const f = await setup();
    try {
      const parent = f.tickets[0]!,
        child = f.tickets[1]!;
      const current = (await f.read(child.id)).ticket;
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: child.id,
        expected_revision: current.revision,
        parent_id: parent.id,
      });
      // Parent and child invalidation deliberately revoke both original claims.
      for (const index of [0, 1]) {
        const receipt = (await f.app.execute(f.worker.id, 'work_claim', {
          project_id: f.project.id,
          ticket_id: f.tickets[index]!.id,
          idempotency_key: randomUUID(),
        })) as any;
        f.requests[index] = { ...f.requests[index]!, claim_token: receipt.claim.token };
      }
      const result = await f.dispatcher().runOnce([f.requests[0]!]);
      assert.equal(result[0]?.code, 'DEPENDENCY_BLOCKED');
      assert.equal(f.calls.length, 0);
      const submission = await f.submit(child.id, f.requests[1]!.claim_token);
      await f.call(f.reviewer.id, 'ticket_review', {
        ticket_id: child.id,
        submission_id: submission.submission.id,
        expected_revision: submission.ticket.revision,
        decision: 'request_changes',
        feedback: 'Fix branch before joining.',
      });
      const join = await f.app.getDependencyJoin(f.worker.id, f.project.id, parent.id);
      assert.equal(join.branches[0]?.relationship, 'child');
      assert.equal(join.branches[0]?.state, 'failed');
      assert.equal(join.branches[0]?.retryable, true);
      assert.equal(join.ready, false);
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: fences stale claims, changed join plans and uncertain launch replays`, async () => {
    const f = await setup();
    try {
      const wrong = await f.dispatcher().runOnce([{ ...f.requests[0]!, claim_token: randomUUID() }]);
      assert.equal(wrong[0]?.code, 'CLAIM_EXPIRED');
      const changed = await f.dispatcher().runOnce([{ ...f.requests[0]!, join_identity: '0'.repeat(64) }]);
      assert.equal(changed[0]?.code, 'JOIN_CHANGED');
      assert.equal(f.calls.length, 0);
      let launches = 0;
      const uncertain = f.dispatcher(f.capacity, () => {
        launches++;
        throw new Error('Provider acknowledgement lost.');
      });
      assert.equal((await uncertain.runOnce([f.requests[0]!]))[0]?.code, 'LAUNCH_UNCERTAIN');
      assert.equal((await f.dispatcher().runOnce([f.requests[0]!]))[0]?.code, 'LAUNCH_UNCERTAIN');
      assert.equal(launches, 1);
      assert.equal(f.calls.length, 0);
      assert.equal(f.capacity.inspect('host').occupied.agent, 1);
      f.clock.now = new Date(f.clock.now.getTime() + 600_001);
      assert.equal((await f.dispatcher().runOnce([f.requests[1]!]))[0]?.code, 'CLAIM_EXPIRED');
      assert.equal(f.capacity.inspect('host').occupied.agent, 1);
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: fences different ledgers and replacement claims until exact predecessor reconciliation`, async () => {
    const f = await setup();
    const peer = new HostCapacity(join(dirname(f.capacityFile), 'peer.sqlite'), f.clients);
    const peerCalls: ContinuationInvocation[] = [];
    peer.configureHost('peer');
    peer.createRun(f.capacity.report(f.requests[0]!.budget_run_id).config);
    const peerDispatcher = new BranchDispatcher({
      application: f.app,
      capacity: peer,
      actor_id: f.worker.id,
      project_id: f.project.id,
      host_id: 'peer',
      launch: (_, invocation) => {
        peerCalls.push(invocation);
      },
    });
    try {
      assert.notEqual(peer.identity, f.capacity.identity);
      const results = await Promise.all([
        f.dispatcher().runOnce([f.requests[0]!]),
        peerDispatcher.runOnce([f.requests[0]!]),
      ]);
      assert.equal(f.calls.length + peerCalls.length, 1);
      assert.ok(results.flat().some((result) => result.code === 'BRANCH_OWNERSHIP_CHANGED'));
      let directLaunches = 0;
      await assert.rejects(
        f.app.dispatchClientExecution(
          f.worker.id,
          f.project.id,
          f.requests[0]!.ticket_id,
          f.requests[0]!.claim_token,
          () => {
            directLaunches++;
          },
        ),
        hasCode('BRANCH_PREDECESSOR_UNRESOLVED'),
      );
      f.clock.now = new Date(f.clock.now.getTime() + 600_001);
      const claim = (await f.app.execute(f.worker.id, 'work_claim', {
        project_id: f.project.id,
        ticket_id: f.requests[0]!.ticket_id,
        idempotency_key: randomUUID(),
      })) as any;
      const retry = { ...f.requests[0]!, claim_token: claim.claim.token };
      assert.equal((await f.dispatcher().runOnce([retry]))[0]?.code, 'BRANCH_PREDECESSOR_UNRESOLVED');
      assert.equal((await peerDispatcher.runOnce([retry]))[0]?.code, 'BRANCH_PREDECESSOR_UNRESOLVED');
      await assert.rejects(
        f.app.dispatchClientExecution(f.worker.id, f.project.id, retry.ticket_id, retry.claim_token, () => {
          directLaunches++;
        }),
        hasCode('BRANCH_PREDECESSOR_UNRESOLVED'),
      );
      assert.equal(directLaunches, 0);
      const invocation = f.calls[0] ?? peerCalls[0]!;
      const winner = f.calls.length ? f.dispatcher() : peerDispatcher;
      await winner.reconcile(invocation, {
        source: 'fixture-supervisor',
        execution_token: invocation.execution_token,
        observed_at: Date.now(),
        state: 'terminated',
        settlement: {
          outcome: 'failed',
          runtime_ms: 1,
          usage_source: 'fixture',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      assert.equal(
        (await winner.runOnce([{ ...retry, retry_of: invocation.queue_id }]))[0]?.state,
        'running',
      );
      assert.equal(f.calls.length + peerCalls.length, 2);
    } finally {
      peer.close();
      await f.dispose();
    }
  });

  it(`${name}: recovers admission and launch commit crashes without launching twice`, async () => {
    for (const failureState of ['starting', 'running']) {
      const f = await setup();
      const original = f.storage.transaction.bind(f.storage);
      let fail = true;
      f.storage.transaction = (scope, work) =>
        original(scope, (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'put')
                  return async (table: string, value: any) => {
                    if (fail && table === 'branch_dispatches' && value.dispatch.state === failureState) {
                      fail = false;
                      throw new Error('Fixture commit failed.');
                    }
                    return target.put(table as any, value);
                  };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        );
      try {
        assert.equal((await f.dispatcher().runOnce([f.requests[0]!]))[0]?.code, 'DISPATCH_VALIDATION_FAILED');
        assert.equal(f.calls.length, failureState === 'running' ? 1 : 0);
        if (failureState === 'starting') {
          f.clock.now = new Date(f.clock.now.getTime() + 600_001);
          const claimed = (await f.app.execute(f.worker.id, 'work_claim', {
            project_id: f.project.id,
            ticket_id: f.requests[0]!.ticket_id,
            idempotency_key: randomUUID(),
          })) as any;
          const retry = { ...f.requests[0]!, claim_token: claimed.claim.token };
          assert.equal((await f.dispatcher().runOnce([retry]))[0]?.code, 'BRANCH_PREDECESSOR_UNRESOLVED');
          assert.equal(
            (await f.storage.get('branch_dispatches', retry.ticket_id))?.dispatch.invocation,
            null,
          );
          const native = f.capacity
            .inspect('host')
            .entries.find((entry) => entry.admission?.ticket_id === retry.ticket_id)!;
          const invocation = {
            host_id: 'host',
            queue_id: native.queue_id,
            execution_token: native.execution_token!,
          };
          await f.settle(invocation, 'failed');
          assert.equal(
            (await f.dispatcher().runOnce([{ ...retry, retry_of: invocation.queue_id }]))[0]?.state,
            'running',
          );
          assert.equal(f.calls.length, 1);
          continue;
        }
        const recovered = (await f.dispatcher().runOnce([f.requests[0]!]))[0]!;
        assert.equal(
          recovered.code,
          failureState === 'starting' ? 'ADMISSION_UNCERTAIN' : 'LAUNCH_ALREADY_ADMITTED',
        );
        assert.ok(recovered.invocation);
        assert.equal(f.calls.length, failureState === 'running' ? 1 : 0);
        await f.settle(recovered.invocation!, 'failed');
        assert.equal((await f.dispatcher().runOnce([f.requests[0]!]))[0]?.state, 'settled');
        assert.equal(f.calls.length, failureState === 'running' ? 1 : 0);
      } finally {
        f.storage.transaction = original;
        await f.dispose();
      }
    }
  });

  it(`${name}: retires only never-admitted stale queues and preserves running predecessors`, async () => {
    const f = await setup();
    try {
      await f.dispatcher().runOnce(f.requests);
      const old = f.requests[2]!;
      const oldQueue = `branch:${old.ticket_id}:${old.claim_token}`;
      assert.equal(
        f.capacity.inspect('host').entries.find((entry) => entry.queue_id === oldQueue)?.state,
        'queued',
      );
      await f.call(f.worker.id, 'work_release', {
        ticket_id: old.ticket_id,
        claim_token: old.claim_token,
        reason: 'Retry admission.',
      });
      const claimed = (await f.app.execute(f.worker.id, 'work_claim', {
        project_id: f.project.id,
        ticket_id: old.ticket_id,
        idempotency_key: randomUUID(),
      })) as any;
      const retry = { ...old, claim_token: claimed.claim.token };
      await f.dispatcher().runOnce([retry]);
      assert.equal(
        f.capacity.inspect('host').entries.find((entry) => entry.queue_id === oldQueue)?.state,
        'cancelled',
      );
      assert.equal(f.capacity.inspect('host').occupied.agent, 2);
      await assert.rejects(
        f.dispatcher().reconcileNeverAdmitted(f.requests[0]!),
        hasCode('BRANCH_PREDECESSOR_UNRESOLVED'),
      );
      await f.settle(f.calls[0]!);
      assert.equal((await f.dispatcher().runOnce([retry]))[0]?.state, 'running');
      assert.equal(f.calls.length, 3);
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: inspects pending joins without execution support on legacy adapters`, async () => {
    const f = await setup();
    try {
      const target = await f.ticket();
      await f.link(f.tickets[0]!, target);
      const storage = new Proxy(f.storage, {
        get(object, property) {
          if (property === 'executionRuns' || property === 'branchDispatches') return undefined;
          if (property === 'readSnapshot')
            return (work: any) =>
              object.readSnapshot((reader) =>
                work(
                  new Proxy(reader, {
                    get(source, key) {
                      if (key === 'find')
                        return (table: string, query: any) => {
                          assert.notEqual(table, 'execution_jobs');
                          return source.find(table as any, query);
                        };
                      const value = Reflect.get(source, key);
                      return typeof value === 'function' ? value.bind(source) : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(object, property);
          return typeof value === 'function' ? value.bind(object) : value;
        },
      });
      const legacy = createApplication({ storage, search: f.search });
      assert.equal(
        (await legacy.getDependencyJoin(f.worker.id, f.project.id, target.id)).branches[0]?.state,
        'pending',
      );
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: projects failed and cancelled native outcomes until current branch evidence is accepted`, async () => {
    const f = await setup();
    try {
      const integration = await f.ticket();
      await f.link(f.tickets[0]!, integration);
      await f.dispatcher().runOnce([f.requests[0]!]);
      await f.settle(f.calls[0]!, 'failed');
      const failed = await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id);
      assert.equal(failed.branches[0]?.state, 'failed');
      assert.equal(failed.branches[0]?.retryable, true);
      assert.equal(failed.ready, false);
      await f.call(f.worker.id, 'work_release', {
        ticket_id: f.tickets[0]!.id,
        claim_token: f.requests[0]!.claim_token,
        reason: 'Retry failed invocation.',
      });
      const claim = (await f.app.execute(f.worker.id, 'work_claim', {
        project_id: f.project.id,
        ticket_id: f.tickets[0]!.id,
        idempotency_key: randomUUID(),
      })) as any;
      const retry = { ...f.requests[0]!, claim_token: claim.claim.token, retry_of: f.calls[0]!.queue_id };
      await f.dispatcher().runOnce([retry]);
      await f.settle(f.calls[1]!, 'cancelled');
      const cancelled = await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id);
      assert.equal(cancelled.branches[0]?.state, 'cancelled');
      assert.equal(cancelled.branches[0]?.retryable, true);
      assert.equal(cancelled.ready, false);
      await f.accept(f.tickets[0]!, retry);
      assert.equal((await f.app.getDependencyJoin(f.worker.id, f.project.id, integration.id)).ready, true);
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: blocks branch and direct launches while a managed continuation is unresolved`, async () => {
    const f = await setup();
    try {
      const ticket = f.tickets[0]!,
        token = randomUUID();
      await f.app.registerWakeCondition(f.admin.id, f.project.id, {
        ticket_id: ticket.id,
        condition: { kind: 'events', types: ['ticket.note_added'] },
      });
      await f.storage.transaction(f.project.id, async (tx) => {
        const row = (await tx.get('wake_conditions', ticket.id))!;
        await tx.put('wake_conditions', {
          ...row,
          active: {
            generation: 1,
            token,
            reasons: [],
            through_cursor: row.cursor,
            created_at: f.clock.now.toISOString(),
            dispatch: {
              state: 'starting',
              code: null,
              invocation: { host_id: 'other', queue_id: 'other-invocation', execution_token: randomUUID() },
              identity: 'fixture',
              admission_uncertain: true,
            },
          },
        });
      });
      assert.equal(
        (await f.dispatcher().runOnce([f.requests[0]!]))[0]?.code,
        'CONTINUATION_PREDECESSOR_UNRESOLVED',
      );
      await assert.rejects(
        f.app.dispatchClientExecution(
          f.worker.id,
          f.project.id,
          ticket.id,
          f.requests[0]!.claim_token,
          () => {
            throw new Error('Must not launch.');
          },
        ),
        hasCode('CONTINUATION_PREDECESSOR_UNRESOLVED'),
      );
      assert.equal(f.calls.length, 0);
      assert.equal(f.capacity.inspect('host').occupied.agent, 0);
    } finally {
      await f.dispose();
    }
  });

  it(`${name}: repeats claim and budget checks after durable reservation before native launch`, async () => {
    for (const change of ['claim', 'budget']) {
      const f = await setup();
      const original = f.storage.transaction.bind(f.storage);
      let armed = true;
      f.storage.transaction = async (scope, work) => {
        const result: any = await original(scope, work);
        if (armed && result?.state === 'starting') {
          armed = false;
          if (change === 'claim') f.clock.now = new Date(f.clock.now.getTime() + 600_001);
          else {
            const request = f.requests[1]!;
            const claim = (await f.storage.get('claims', request.ticket_id))!;
            f.capacity.enqueue('host', {
              queue_id: 'other-budget-attempt',
              run_id: request.budget_run_id,
              kind: 'agent',
              created_at: Date.now(),
              execution: claim.execution,
              admission: {
                attempt_id: 'other-budget-attempt',
                actor_id: f.worker.id,
                ticket_id: request.ticket_id,
                requirements_revision: f.tickets[1]!.requirements_revision,
                provider: request.provider,
                model: claim.execution!.model,
                role: 'worker',
                allowance: request.allowance,
              },
            });
            const other = f.capacity.claimNext('host', 'fixture-observer', {
              kind: 'agent',
              queue_ids: ['other-budget-attempt'],
            });
            assert.ok(other.admitted);
            f.capacity.reconcile(other.lease, {
              source: 'fixture-supervisor',
              execution_token: other.request.execution_token!,
              observed_at: Date.now(),
              state: 'terminated',
              settlement: {
                outcome: 'failed',
                runtime_ms: 60_001,
                usage_source: 'fixture',
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            });
          }
        }
        return result;
      };
      try {
        const result = (await f.dispatcher().runOnce([f.requests[0]!]))[0]!;
        assert.equal(result.code, change === 'claim' ? 'CLAIM_EXPIRED' : 'BUDGET_CHANGED');
        assert.equal(f.calls.length, 0);
        assert.equal(result.state, 'settled');
        assert.ok(result.invocation);
        assert.equal(f.capacity.inspect('host').occupied.agent, 0);
        const fence = await f.storage.get('branch_dispatches', f.tickets[0]!.id);
        assert.equal(fence?.dispatch.state, 'completed');
      } finally {
        f.storage.transaction = original;
        await f.dispose();
      }
    }
  });

  it(`${name}: launches independently reserved tickets sharing one budget`, async () => {
    const f = await setup();
    const peer = new HostCapacity(f.capacityFile, f.clients);
    try {
      const results = await Promise.all([
        f.dispatcher().runOnce([f.requests[0]!]),
        f.dispatcher(peer).runOnce([f.requests[1]!]),
      ]);
      assert.deepEqual(
        results.flat().map(({ state }) => state),
        ['running', 'running'],
      );
      assert.equal(f.calls.length, 2);
      assert.equal(f.capacity.inspect('host').occupied.agent, 2);
    } finally {
      peer.close();
      await f.dispose();
    }
  });

  it(`${name}: allows a project admin to reconcile exact exit after worker access is revoked`, async () => {
    const f = await setup();
    try {
      const [result] = await f.dispatcher().runOnce([f.requests[0]!]);
      assert.equal(result?.state, 'running');
      const invocation = result.invocation!;
      await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'none' });
      await assert.rejects(f.settle(invocation), hasCode('FORBIDDEN'));
      assert.equal(f.capacity.inspect('host').occupied.agent, 1);
      const admin = new BranchDispatcher({
        application: f.app,
        capacity: f.capacity,
        actor_id: f.admin.id,
        project_id: f.project.id,
        host_id: 'host',
        launch: () => undefined,
      });
      const observation = {
        source: 'fixture',
        execution_token: invocation.execution_token,
        observed_at: Date.now(),
        state: 'terminated' as const,
        settlement: {
          outcome: 'succeeded' as const,
          runtime_ms: 1,
          usage_source: 'fixture',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      await assert.rejects(
        admin.reconcile(invocation, { ...observation, execution_token: randomUUID() }),
        hasCode('CONFLICT'),
      );
      assert.equal(await admin.reconcile(invocation, observation), true);
      assert.equal(await admin.reconcile(invocation, observation), true);
      assert.equal(f.capacity.inspect('host').occupied.agent, 0);
      const fence = await f.storage.get('branch_dispatches', f.tickets[0]!.id);
      assert.equal(fence?.dispatch.state, 'completed');
    } finally {
      await f.dispose();
    }
  });
}
