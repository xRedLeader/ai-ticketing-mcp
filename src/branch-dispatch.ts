import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Application } from './application.js';
import {
  DomainError,
  ensure,
  type ClientSelection,
  type ContinuationInvocation,
  type DependencyJoin,
} from './contracts.js';
import { HostCapacity, type HostCapacityObservation } from './host-capacity.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.strictObject({
  ticket_id: z.uuid(),
  claim_token: z.uuid(),
  budget_run_id: id,
  provider: id,
  allowance: z.strictObject({
    provider_tokens: positive,
    runtime_ms: positive,
    cost_usd_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  retry_of: id.optional(),
  join_identity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type BranchDispatchRequest = z.input<typeof requestSchema>;
export interface BranchDispatchContext {
  actor_id: string;
  ticket_id: string;
  requirements_revision: number;
  execution: ClientSelection;
  join: DependencyJoin;
}
export interface BranchDispatchResult {
  ticket_id: string;
  state: 'waiting' | 'running' | 'settled' | 'needs_attention';
  code: string | null;
  invocation: ContinuationInvocation | null;
}
export interface BranchDispatcherOptions {
  application: Pick<Application, 'dispatchBranchExecution' | 'completeBranchExecution' | 'getBranchDispatch'>;
  capacity: HostCapacity;
  actor_id: string;
  project_id: string;
  host_id: string;
  /** Operator-installed synchronous launcher; branch text grants no executable authority. */
  launch: (context: BranchDispatchContext, invocation: ContinuationInvocation) => undefined;
}
const queueId = (input: Pick<BranchDispatchRequest, 'ticket_id' | 'claim_token'>) =>
  `branch:${input.ticket_id}:${input.claim_token}`;

/** Native claims own work; ticket-store admission fences one invocation across hosts and claim generations. */
export class BranchDispatcher {
  private readonly owner = randomUUID();
  constructor(private readonly options: BranchDispatcherOptions) {}

  async runOnce(raw: readonly BranchDispatchRequest[]): Promise<BranchDispatchResult[]> {
    const requests = z.array(requestSchema).min(1).max(128).parse(raw);
    const { application, capacity, actor_id: actor, project_id: project, host_id: host } = this.options;
    const results: BranchDispatchResult[] = [];
    for (const input of requests) {
      const queue = queueId(input);
      let budgetSnapshot: string;
      try {
        const previous = await application.getBranchDispatch(
          actor,
          project,
          input.ticket_id,
          input.claim_token,
        );
        if (
          previous &&
          previous.claim_token !== input.claim_token &&
          previous.dispatch.state !== 'completed' &&
          previous.capacity_id === capacity.identity &&
          previous.host_id === host &&
          !previous.dispatch.invocation
        ) {
          try {
            await this.reconcileNeverAdmitted({
              ...input,
              claim_token: previous.claim_token,
              budget_run_id: previous.budget_run_id,
            });
          } catch {
            /* Preserve a predecessor whose native admission cannot be disproved. */
          }
        }
        const dispatch = await application.dispatchBranchExecution(
          actor,
          project,
          input.ticket_id,
          input.claim_token,
          { capacity_id: capacity.identity, host_id: host, budget_run_id: input.budget_run_id },
          ({ execution, join }) => {
            const budget = capacity.report(input.budget_run_id);
            ensure(
              budget.config.project_id === project,
              'INVALID_REFERENCE',
              'Budget belongs to another project.',
            );
            // Only a validated current native claim may retire its exact never-admitted predecessors.
            for (const entry of capacity.inspect(host).entries) {
              if (
                entry.state === 'queued' &&
                entry.admission?.ticket_id === input.ticket_id &&
                entry.project_id === project &&
                entry.queue_id.startsWith(`branch:${input.ticket_id}:`) &&
                entry.queue_id !== queue &&
                !capacity
                  .report(entry.run_id)
                  .attempts.some((attempt) => attempt.attempt_id === entry.admission!.attempt_id)
              )
                capacity.cancel(host, entry.queue_id);
            }
            capacity.enqueue(host, {
              queue_id: queue,
              run_id: input.budget_run_id,
              kind: 'agent',
              created_at:
                capacity.inspect(host).entries.find((entry) => entry.queue_id === queue)?.created_at ??
                Date.now(),
              execution,
              admission: {
                attempt_id: queue,
                actor_id: actor,
                ticket_id: input.ticket_id,
                requirements_revision: join.requirements_revision,
                provider: input.provider,
                model: execution.model,
                role: 'worker',
                allowance: input.allowance,
                retry_of: input.retry_of,
              },
            });
            const admitted = capacity.claimNext(host, this.owner, { kind: 'agent', queue_ids: [queue] });
            if (!admitted.admitted) {
              const reason = admitted.reasons.find((entry) => entry.queue_id === queue)?.reason;
              const attention =
                capacity.report(input.budget_run_id).status === 'needs_attention' ||
                reason?.startsWith('unsupported_execution:');
              return {
                state: attention ? ('needs_attention' as const) : ('waiting' as const),
                code: attention ? (reason ?? 'BUDGET_NEEDS_ATTENTION') : 'HOST_CAPACITY',
              };
            }
            budgetSnapshot = JSON.stringify(capacity.report(input.budget_run_id));
            return {
              state: 'starting',
              invocation: {
                host_id: host,
                queue_id: queue,
                execution_token: admitted.request.execution_token!,
              },
            };
          },
          ({ execution, join }, invocation) => {
            const entry = capacity
              .inspect(host)
              .entries.find((candidate) => candidate.queue_id === invocation.queue_id);
            ensure(
              entry?.state === 'running' &&
                entry.execution_token === invocation.execution_token &&
                entry.lease?.owner_id === this.owner &&
                entry.project_id === project &&
                entry.run_id === input.budget_run_id,
              'CONFLICT',
              'Branch capacity ownership changed.',
            );
            capacity.heartbeat(entry.lease);
            ensure(
              JSON.stringify(capacity.report(input.budget_run_id)) === budgetSnapshot,
              'BUDGET_CHANGED',
              'Budget changed before launch.',
            );
            return this.options.launch(
              {
                actor_id: actor,
                ticket_id: input.ticket_id,
                requirements_revision: join.requirements_revision,
                execution,
                join,
              },
              invocation,
            );
          },
          (record) => {
            const entry = capacity.inspect(host).entries.find((candidate) => candidate.queue_id === queue);
            const budget = capacity.report(input.budget_run_id);
            ensure(
              budget.config.project_id === project,
              'INVALID_REFERENCE',
              'Budget belongs to another project.',
            );
            if (!entry || entry.state === 'queued' || entry.state === 'cancelled') {
              ensure(
                !budget.attempts.some((attempt) => attempt.attempt_id === queue),
                'CONFLICT',
                'Budget attempt lacks its exact capacity identity.',
              );
              return null;
            }
            ensure(
              entry.kind === 'agent' &&
                entry.project_id === project &&
                entry.run_id === input.budget_run_id &&
                entry.admission?.attempt_id === queue &&
                entry.admission.actor_id === record.actor_id &&
                entry.admission.ticket_id === record.id &&
                entry.admission.requirements_revision === record.requirements_revision &&
                entry.execution_token,
              'CONFLICT',
              'Branch admission identity changed.',
            );
            return { host_id: host, queue_id: queue, execution_token: entry.execution_token };
          },
          input.join_identity,
        );
        results.push({
          ticket_id: input.ticket_id,
          state:
            dispatch.state === 'completed'
              ? 'settled'
              : dispatch.state === 'starting'
                ? 'needs_attention'
                : dispatch.state,
          code: dispatch.state === 'starting' ? 'LAUNCH_ALREADY_ADMITTED' : dispatch.code,
          invocation: dispatch.invocation,
        });
      } catch (error) {
        const entry = capacity.inspect(host).entries.find((candidate) => candidate.queue_id === queue);
        if (
          entry?.state === 'queued' &&
          entry.project_id === project &&
          entry.run_id === input.budget_run_id &&
          entry.admission?.attempt_id === queue &&
          !capacity.report(input.budget_run_id).attempts.some((attempt) => attempt.attempt_id === queue)
        )
          capacity.cancel(host, queue);
        results.push({
          ticket_id: input.ticket_id,
          state: 'needs_attention',
          code: error instanceof DomainError ? error.code : 'DISPATCH_VALIDATION_FAILED',
          invocation: null,
        });
      }
    }
    return results;
  }

  /** Independent supervisor/provider exit proof, never a worker-authored completion. */
  async reconcile(invocation: ContinuationInvocation, observation: HostCapacityObservation) {
    const { application, capacity, actor_id: actor, project_id: project, host_id: host } = this.options;
    const entry = capacity
      .inspect(host)
      .entries.find((candidate) => candidate.queue_id === invocation.queue_id);
    const [, ticket, token] = invocation.queue_id.split(':');
    ensure(
      invocation.host_id === host &&
        ticket &&
        token &&
        invocation.queue_id === queueId({ ticket_id: ticket, claim_token: token }) &&
        entry?.kind === 'agent' &&
        entry.project_id === project &&
        entry.admission?.ticket_id === ticket &&
        entry.admission.actor_id === actor &&
        entry.lease &&
        entry.execution_token === invocation.execution_token &&
        observation.execution_token === invocation.execution_token,
      'CONFLICT',
      'Exit proof belongs to another branch invocation.',
    );
    capacity.reconcile(entry.lease, observation);
    return application.completeBranchExecution(
      actor,
      project,
      ticket,
      token,
      { capacity_id: capacity.identity, host_id: host, budget_run_id: entry.run_id },
      (record) => {
        const settled = capacity
          .inspect(host)
          .entries.find((candidate) => candidate.queue_id === invocation.queue_id);
        const outcome = settled?.observation?.settlement?.outcome;
        return settled?.state === 'settled' &&
          settled.execution_token === invocation.execution_token &&
          settled.admission?.actor_id === record.actor_id &&
          settled.admission.requirements_revision === record.requirements_revision &&
          settled.admission.ticket_id === record.id &&
          settled.run_id === record.budget_run_id &&
          outcome
          ? { invocation, outcome }
          : null;
      },
    );
  }

  async reconcileNeverAdmitted(raw: BranchDispatchRequest) {
    const input = requestSchema.parse(raw);
    const { application, capacity, actor_id: actor, project_id: project, host_id: host } = this.options;
    const queue = queueId(input);
    return application.completeBranchExecution(
      actor,
      project,
      input.ticket_id,
      input.claim_token,
      { capacity_id: capacity.identity, host_id: host, budget_run_id: input.budget_run_id },
      (record) => {
        const entry = capacity.inspect(host).entries.find((candidate) => candidate.queue_id === queue);
        const budget = capacity.report(input.budget_run_id);
        if (
          record.dispatch.invocation ||
          budget.config.project_id !== project ||
          budget.attempts.some((attempt) => attempt.attempt_id === queue)
        )
          return null;
        if (!entry) return { invocation: null, outcome: 'cancelled' };
        if (
          !['queued', 'cancelled'].includes(entry.state) ||
          entry.project_id !== project ||
          entry.run_id !== input.budget_run_id ||
          entry.admission?.ticket_id !== input.ticket_id ||
          entry.admission.actor_id !== record.actor_id ||
          entry.admission.requirements_revision !== record.requirements_revision ||
          entry.admission.attempt_id !== queue
        )
          return null;
        if (entry.state === 'queued') capacity.cancel(host, queue);
        return { invocation: null, outcome: 'cancelled' };
      },
    );
  }
}
