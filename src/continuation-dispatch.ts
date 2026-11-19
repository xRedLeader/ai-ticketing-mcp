import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Application } from './application.js';
import {
  ensure,
  type ContinuationDispatchContext,
  type ContinuationInvocation,
  type WakeFence,
} from './contracts.js';
import { HostCapacity, type HostCapacityObservation } from './host-capacity.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.strictObject({
  ticket_id: z.uuid(),
  predecessor: z.strictObject({ host_id: id, queue_id: id, execution_token: z.uuid() }),
  budget_run_id: id,
  provider: id,
  allowance: z.strictObject({
    provider_tokens: positive,
    runtime_ms: positive,
    cost_usd_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
});
export type ContinuationDispatchRequest = z.input<typeof requestSchema>;
export interface ContinuationDispatcherOptions {
  application: Pick<
    Application,
    | 'evaluateWakeConditions'
    | 'getWakeCondition'
    | 'claimWakeDecision'
    | 'dispatchWakeContinuation'
    | 'completeWakeContinuation'
  >;
  capacity: HostCapacity;
  actor_id: string;
  project_id: string;
  host_id: string;
  /** Operator-installed synchronous launcher; ticket/checkpoint text supplies no executable authority. */
  launch: (context: ContinuationDispatchContext, invocation: ContinuationInvocation) => undefined;
}

/** Explicit trusted-host seam. No provider, command, retry, polling model or autonomous loop. */
export class ContinuationDispatcher {
  private readonly owner = randomUUID();
  constructor(private readonly options: ContinuationDispatcherOptions) {}

  async runOnce(raw: ContinuationDispatchRequest) {
    const input = requestSchema.parse(raw);
    const { application: app, capacity, actor_id: actor, project_id: project, host_id: host } = this.options;
    await app.evaluateWakeConditions(actor, project);
    const row = await app.getWakeCondition(actor, project, input.ticket_id);
    const decision =
      row.active ??
      (await app.claimWakeDecision(actor, project, {
        ticket_id: row.ticket_id,
        expected_generation: row.generation,
      }));
    if (!decision) return { state: 'waiting' as const, code: 'CONDITION_PENDING' };
    const fence = { ticket_id: row.ticket_id, generation: decision.generation, token: decision.token };
    let budgetSnapshot: string;
    const predecessor = (context: ContinuationDispatchContext) => {
      const entry = capacity
        .inspect(input.predecessor.host_id)
        .entries.find((entry) => entry.queue_id === input.predecessor.queue_id);
      ensure(
        entry?.kind === 'agent' &&
          entry.project_id === project &&
          entry.run_id === input.budget_run_id &&
          entry.execution_token === input.predecessor.execution_token &&
          entry.admission?.ticket_id === context.ticket_id &&
          entry.admission.requirements_revision === context.requirements_revision &&
          entry.admission.actor_id === context.actor_id,
        'PREDECESSOR_IDENTITY_CHANGED',
        'Predecessor capacity identity does not match continuation work.',
      );
      return entry.state === 'settled' && entry.observation?.execution_token === entry.execution_token;
    };
    const dispatch = await app.dispatchWakeContinuation(
      actor,
      project,
      fence,
      (context) => {
        if (!predecessor(context)) return { state: 'waiting', code: 'PREDECESSOR_RUNNING' };
        const budget = capacity.report(input.budget_run_id);
        ensure(
          budget.config.project_id === project,
          'INVALID_REFERENCE',
          'Budget belongs to another project.',
        );
        if (budget.status === 'needs_attention')
          return { state: 'needs_attention', code: 'BUDGET_NEEDS_ATTENTION' };
        const queue = `continuation:${context.continuation_id}:${decision.generation}`;
        capacity.enqueue(host, {
          queue_id: queue,
          run_id: input.budget_run_id,
          kind: 'agent',
          created_at: Date.parse(decision.created_at),
          execution: context.execution,
          admission: {
            attempt_id: queue,
            actor_id: context.actor_id,
            ticket_id: context.ticket_id,
            requirements_revision: context.requirements_revision,
            provider: input.provider,
            model: context.execution.model,
            role: 'worker',
            allowance: input.allowance,
          },
        });
        const admitted = capacity.claimNext(host, this.owner, { kind: 'agent', queue_ids: [queue] });
        if (!admitted.admitted) {
          const reason = admitted.reasons.find((reason) => reason.queue_id === queue)?.reason;
          const unsupported = reason?.startsWith('unsupported_execution:');
          const attention = capacity.report(input.budget_run_id).status === 'needs_attention';
          return {
            state: unsupported || attention ? 'needs_attention' : 'waiting',
            code: unsupported
              ? 'UNSUPPORTED_EXECUTION'
              : attention
                ? 'BUDGET_NEEDS_ATTENTION'
                : 'HOST_CAPACITY',
          };
        }
        budgetSnapshot = JSON.stringify(capacity.report(input.budget_run_id));
        return {
          state: 'starting',
          invocation: { host_id: host, queue_id: queue, execution_token: admitted.request.execution_token! },
        };
      },
      (context, invocation) => {
        ensure(predecessor(context), 'PREDECESSOR_UNRESOLVED', 'Predecessor exit proof changed.');
        const entry = capacity.inspect(host).entries.find((entry) => entry.queue_id === invocation.queue_id);
        ensure(
          entry?.state === 'running' &&
            entry.execution_token === invocation.execution_token &&
            entry.lease?.owner_id === this.owner &&
            entry.project_id === project &&
            entry.run_id === input.budget_run_id,
          'CONFLICT',
          'Continuation capacity ownership changed.',
        );
        ensure(
          JSON.stringify(capacity.report(input.budget_run_id)) === budgetSnapshot,
          'BUDGET_CHANGED',
          'Budget changed after continuation admission.',
        );
        capacity.heartbeat(entry.lease);
        return this.options.launch(context, invocation);
      },
    );
    if (
      dispatch.state === 'needs_attention' &&
      !dispatch.invocation &&
      row.condition.kind === 'continuation'
    ) {
      const queue = `continuation:${row.condition.continuation_id}:${decision.generation}`;
      const queued = capacity.inspect(host).entries.find((entry) => entry.queue_id === queue);
      if (queued?.state === 'queued' && queued.project_id === project) capacity.cancel(host, queue);
    }
    return { ...dispatch, fence };
  }

  /** Independent supervisor/provider proof, never worker-authored completion or a lease timeout. */
  async reconcile(fence: WakeFence, observation: HostCapacityObservation) {
    const { application: app, capacity, actor_id: actor, project_id: project, host_id: host } = this.options;
    const row = await app.getWakeCondition(actor, project, fence.ticket_id);
    ensure(
      row.active?.generation === fence.generation && row.active.token === fence.token,
      'VERSION_CONFLICT',
      'Continuation wake ownership changed.',
    );
    const invocation = row.active.dispatch?.invocation;
    ensure(
      invocation?.host_id === host && invocation.execution_token === observation.execution_token,
      'CONFLICT',
      'Exit proof belongs to another continuation invocation.',
    );
    const entry = capacity.inspect(host).entries.find((entry) => entry.queue_id === invocation.queue_id);
    ensure(
      entry?.kind === 'agent' &&
        entry.project_id === project &&
        entry.lease &&
        entry.execution_token === invocation.execution_token,
      'CONFLICT',
      'Continuation invocation is unavailable.',
    );
    capacity.reconcile(entry.lease, observation);
    return app.completeWakeContinuation(actor, project, fence, (expected) => {
      const settled = capacity.inspect(host).entries.find((entry) => entry.queue_id === expected.queue_id);
      return (
        expected.host_id === host &&
        settled?.state === 'settled' &&
        settled.execution_token === expected.execution_token &&
        !!settled.observation
      );
    });
  }
}
