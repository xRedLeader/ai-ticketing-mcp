import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ensure } from './contracts.js';
import { ClientCapabilities, clientSelectionSchema } from './client-capabilities.js';
import {
  UsageBudget,
  type UsageBudgetAdmission,
  type UsageBudgetSettlement,
  type UsageBudgetRun,
  type UsageBudgetAcceptance,
} from './usage-budget.js';

const id = z.string().trim().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const timestamp = count;
export const HOST_CAPACITY_LIMIT = 'HOST_CAPACITY_LIMIT';
const resources = z.strictObject({ cpu_millis: count.default(0), memory_bytes: count.default(0) });
const hostSchema = z.strictObject({
  agent_slots: positive.default(2),
  script_slots: positive.default(2),
  cpu_millis: positive.nullable().default(null),
  memory_bytes: positive.nullable().default(null),
  lease_ms: positive.max(2147483647).default(60_000),
  script_timeout_ms: positive.max(2147483647).default(30 * 60_000),
});
const queueSchema = z.strictObject({
  queue_id: id,
  run_id: id,
  kind: z.enum(['agent', 'script']),
  resources: resources.default(() => resources.parse({})),
  priority: positive.max(5).default(3),
  created_at: timestamp,
  policy: z.enum(['priority_age', 'unblocking']).default('priority_age'),
  unfinished_dependents: count.default(0),
  eligible: z.boolean().default(true),
  execution: clientSelectionSchema.optional(),
});
const leaseSchema = z.strictObject({
  host_id: id,
  queue_id: id,
  owner_id: id,
  generation: positive,
  token: z.uuid(),
});
const observationSchema = z.strictObject({
  source: id,
  execution_token: z.uuid(),
  observed_at: timestamp,
  state: z.enum(['terminated', 'never_started']),
});
const neverStartedSchema = z.strictObject({
  host_id: id,
  queue_id: id,
  run_id: id,
  project_id: id,
  state: z.enum(['queued', 'running', 'reconciling']),
  execution_token: z.uuid().nullable(),
});
export type HostCapacityNeverStartedProof = z.output<typeof neverStartedSchema>;

export type HostCapacityLimits = z.input<typeof hostSchema>;
export type HostCapacityRequest = z.input<typeof queueSchema> &
  (
    | { kind: 'agent'; admission: UsageBudgetAdmission }
    | { kind: 'script'; project_id: string; timeout_ms?: number }
  );
export type HostCapacityLease = z.output<typeof leaseSchema>;
export type HostCapacityClaimScope = { kind: 'agent' | 'script'; queue_ids: readonly string[] };
export type HostCapacityObservation = z.input<typeof observationSchema> & {
  settlement?: UsageBudgetSettlement;
  script_result?: { outcome: 'succeeded' | 'failed' | 'cancelled'; runtime_ms: number | null };
};
type Entry = z.output<typeof queueSchema> & {
  project_id: string;
  admission: ReturnType<CapacityLedger['parseAdmission']> | null;
  timeout_ms: number;
  state: 'queued' | 'running' | 'reconciling' | 'settled' | 'cancelled';
  lease: HostCapacityLease | null;
  lease_until: number | null;
  admitted_at: number | null;
  execution_token: string | null;
  reason: string | null;
  observation: HostCapacityObservation | null;
};
type Host = {
  config: z.output<typeof hostSchema>;
  revision: number;
  service: number;
  projects: Record<string, number>;
  entries: Entry[];
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const occupied = (entry: Entry) => entry.state === 'running' || entry.state === 'reconciling';
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Trusted local host boundary; all dispatchers for a physical host must share this SQLite file. */
class CapacityLedger extends UsageBudget {
  readonly identity: string;
  constructor(
    path: string,
    private readonly clients?: ClientCapabilities,
  ) {
    super(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS host_capacity (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS host_capacity_identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
    );
    this.db.prepare('INSERT OR IGNORE INTO host_capacity_identity(id,value) VALUES(1,?)').run(randomUUID());
    this.identity = this.db.prepare('SELECT value FROM host_capacity_identity WHERE id=1').get()!
      .value as string;
  }

  configureHost(hostId: string, input: HostCapacityLimits = {}) {
    const host = id.parse(hostId),
      config = hostSchema.parse(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM host_capacity WHERE id=?').get(host);
      if (row) {
        ensure(
          same((JSON.parse(row.state as string) as Host).config, config),
          'CONFLICT',
          'Host config is immutable.',
        );
        return { created: false };
      }
      const state: Host = { config, revision: 0, service: 0, projects: {}, entries: [] };
      this.db.prepare('INSERT INTO host_capacity VALUES (?,?)').run(host, JSON.stringify(state));
      return { created: true };
    });
  }

  private host(hostId: string): Host {
    const row = this.db.prepare('SELECT state FROM host_capacity WHERE id=?').get(id.parse(hostId));
    ensure(row, 'NOT_FOUND', 'Host capacity not found.');
    return JSON.parse(row.state as string) as Host;
  }

  private saveHost(hostId: string, host: Host) {
    ensure(Number.isSafeInteger(++host.revision), 'CONFLICT', 'Host revision exhausted.');
    this.db
      .prepare('UPDATE host_capacity SET state=? WHERE id=?')
      .run(JSON.stringify(host), id.parse(hostId));
  }

  private expire(host: Host, now: number) {
    for (const entry of host.entries) {
      if (entry.state === 'running' && entry.lease_until! <= now) {
        entry.state = 'reconciling';
        entry.reason = 'lease_expired';
      }
    }
  }

  enqueue(hostId: string, input: HostCapacityRequest) {
    const {
      admission: rawAdmission,
      project_id: rawProject,
      timeout_ms: rawTimeout,
      ...raw
    } = input as z.input<typeof queueSchema> & {
      admission?: UsageBudgetAdmission;
      project_id?: string;
      timeout_ms?: number;
    };
    const request = queueSchema.parse(raw);
    const admission = request.kind === 'agent' ? this.parseAdmission(rawAdmission!) : null;
    ensure(
      request.kind === 'agent'
        ? rawProject === undefined && rawTimeout === undefined
        : rawAdmission === undefined,
      'INVALID_INPUT',
      'Agent and script inputs cannot be mixed.',
    );
    return this.transaction(() => {
      const host = this.host(hostId),
        run = admission ? this.read(request.run_id) : null;
      const project = run?.config.project_id ?? id.parse(rawProject);
      ensure(
        request.kind === 'agent' || !request.execution,
        'INVALID_INPUT',
        'Client execution choices apply only to agent work.',
      );
      if (request.kind === 'agent') {
        ensure(
          !request.execution || this.clients,
          'CLIENT_REGISTRY_REQUIRED',
          'Configure the operator client registry before agent admission.',
        );
        ensure(
          !this.clients || request.execution,
          'CLIENT_SELECTION_REQUIRED',
          'Match a live authorized work claim before agent admission.',
        );
        const reasons =
          request.execution && this.clients
            ? this.clients.verify(
                request.execution,
                admission!.actor_id,
                project,
                admission!.model,
                admission!.requirements_revision,
                Date.now(),
              )
            : [];
        ensure(
          !reasons.length,
          'UNSUPPORTED_EXECUTION',
          'Agent admission requires the exact fresh registered client selection.',
          { reasons },
        );
      }
      const timeout =
        admission?.allowance.runtime_ms ?? positive.parse(rawTimeout ?? host.config.script_timeout_ms);
      ensure(
        admission || timeout <= host.config.script_timeout_ms,
        'INVALID_INPUT',
        'Script timeout exceeds the host limit.',
        {
          reason: HOST_CAPACITY_LIMIT,
        },
      );
      ensure(
        (['cpu_millis', 'memory_bytes'] as const).every(
          (field) => host.config[field] === null || request.resources[field] <= host.config[field]!,
        ),
        'INVALID_INPUT',
        'Request can never fit configured host resources.',
        { reason: HOST_CAPACITY_LIMIT },
      );
      ensure(
        !host.entries.some(
          (entry) =>
            entry.state === 'queued' && entry.project_id === project && entry.policy !== request.policy,
        ),
        'CONFLICT',
        'Queued work in a project must use one scheduling policy.',
      );
      if (admission && run) {
        ensure(
          run.config.work.some(
            (work) =>
              work.ticket_id === admission.ticket_id &&
              work.requirements_revision === admission.requirements_revision,
          ),
          'INVALID_INPUT',
          'Unknown run work.',
        );
        ensure(
          admission.allowance.runtime_ms <= run.config.limits.invocation_timeout_ms,
          'INVALID_INPUT',
          'Runtime allowance exceeds invocation timeout.',
        );
        ensure(
          run.config.limits.max_cost_usd_micros === null || admission.allowance.cost_usd_micros !== null,
          'INVALID_INPUT',
          'A cost allowance is required when monetary budget is enabled.',
        );
      }
      if (admission?.retry_of != null && run) {
        const prior = run.attempts.find((attempt) => attempt.attempt_id === admission.retry_of);
        ensure(
          prior?.settlement &&
            prior.ticket_id === admission.ticket_id &&
            prior.requirements_revision === admission.requirements_revision &&
            prior.role === admission.role,
          'INVALID_INPUT',
          'Retry requires settled work of the same role.',
        );
      }
      const previous = host.entries.find((entry) => entry.queue_id === request.queue_id);
      if (previous) {
        const {
          project_id: _project,
          timeout_ms: _timeout,
          state: _state,
          lease: _lease,
          lease_until: _until,
          admitted_at: _at,
          execution_token: _execution,
          reason: _reason,
          observation: _observation,
          ...original
        } = previous;
        ensure(same(original, { ...request, admission }), 'CONFLICT', 'Queue identity is immutable.');
        ensure(
          previous.project_id === project && previous.timeout_ms === timeout,
          'CONFLICT',
          'Queue execution identity is immutable.',
        );
        return { enqueued: false, start_allowed: false };
      }
      // One budget attempt must never consume two host slots, even across configured hosts.
      if (admission && run) {
        const hosts = this.db.prepare('SELECT state FROM host_capacity').all();
        ensure(
          !hosts.some((row) =>
            (JSON.parse(row.state as string) as Host).entries.some(
              (entry) =>
                entry.run_id === request.run_id && entry.admission?.attempt_id === admission.attempt_id,
            ),
          ),
          'CONFLICT',
          'Attempt is already queued.',
        );
        ensure(
          !run.attempts.some((attempt) => attempt.attempt_id === admission.attempt_id),
          'CONFLICT',
          'Attempt was already admitted.',
        );
      }
      host.entries.push({
        ...request,
        admission,
        project_id: project,
        timeout_ms: timeout,
        state: 'queued',
        lease: null,
        lease_until: null,
        admitted_at: null,
        execution_token: null,
        reason: null,
        observation: null,
      });
      this.saveHost(hostId, host);
      return { enqueued: true, start_allowed: false };
    });
  }

  setEligible(hostId: string, queueId: string, eligible: boolean) {
    z.boolean().parse(eligible);
    return this.transaction(() => {
      const host = this.host(hostId),
        entry = this.entry(host, queueId);
      ensure(entry.state === 'queued', 'CONFLICT', 'Only queued eligibility can change.');
      entry.eligible = eligible;
      this.saveHost(hostId, host);
    });
  }

  private entry(host: Host, queueId: string) {
    const entry = host.entries.find((item) => item.queue_id === id.parse(queueId));
    ensure(entry, 'NOT_FOUND', 'Queue entry not found.');
    return entry;
  }

  private fenced(host: Host, input: HostCapacityLease) {
    const lease = leaseSchema.parse(input),
      entry = this.entry(host, lease.queue_id);
    ensure(same(entry.lease, lease), 'CONFLICT', 'Stale execution ownership.');
    return entry;
  }

  private fits(host: Host, candidate: Entry) {
    const active = host.entries.filter(occupied);
    if (
      active.filter((entry) => entry.kind === candidate.kind).length >= host.config[`${candidate.kind}_slots`]
    )
      return false;
    return (['cpu_millis', 'memory_bytes'] as const).every((field) => {
      const limit = host.config[field];
      return (
        limit === null ||
        active.reduce((remaining, entry) => remaining - entry.resources[field], limit) >=
          candidate.resources[field]
      );
    });
  }

  claimNext(hostId: string, ownerId: string, scope?: HostCapacityClaimScope) {
    const owner = id.parse(ownerId);
    const filter =
      scope === undefined
        ? undefined
        : z
            .strictObject({
              kind: z.enum(['agent', 'script']),
              queue_ids: z.array(id).max(128),
            })
            .parse(scope);
    return this.transaction(() => {
      const host = this.host(hostId),
        before = JSON.stringify(host),
        now = Date.now();
      this.expire(host, now);
      const waiting = host.entries.filter(
        (entry) => entry.state === 'queued' && entry.eligible && (!filter || entry.kind === filter.kind),
      );
      const served = (project: string) =>
        Object.hasOwn(host.projects, project) ? host.projects[project]! : 0;
      const projects = [...new Set(waiting.map((entry) => entry.project_id))].sort(
        (a, b) => served(a) - served(b) || compareId(a, b),
      );
      const blockedKinds = new Set<string>(),
        blockedResources = new Set<string>();
      for (const project of projects) {
        const candidates = waiting
          .filter((entry) => entry.project_id === project)
          .sort((a, b) => {
            const age = (entry: Entry) => entry.created_at <= now - 86_400_000;
            return (
              a.priority - b.priority ||
              (a.policy === 'unblocking'
                ? Number(age(b)) - Number(age(a)) ||
                  (!age(a) ? b.unfinished_dependents - a.unfinished_dependents : 0)
                : 0) ||
              a.created_at - b.created_at ||
              compareId(a.admission?.ticket_id ?? a.queue_id, b.admission?.ticket_id ?? b.queue_id) ||
              compareId(a.queue_id, b.queue_id)
            );
          });
        for (const entry of candidates) {
          if (entry.kind === 'agent' && (this.clients || entry.execution)) {
            const reasons =
              this.clients && entry.execution
                ? this.clients.verify(
                    entry.execution,
                    entry.admission!.actor_id,
                    entry.project_id,
                    entry.admission!.model,
                    entry.admission!.requirements_revision,
                    now,
                  )
                : [{ code: this.clients ? 'CLIENT_SELECTION_REQUIRED' : 'CLIENT_REGISTRY_REQUIRED' }];
            if (reasons.length) {
              entry.reason = `unsupported_execution:${reasons[0]!.code}`;
              continue;
            }
          }
          const reasons = entry.admission ? this.budgetReasons(entry.run_id, entry.admission) : [];
          if (reasons.length) {
            this.admit(entry.run_id, entry.admission!);
            entry.reason = `needs_attention:${reasons.join(',')}`;
            continue;
          }
          if (
            blockedKinds.has(entry.kind) ||
            (['cpu_millis', 'memory_bytes'] as const).some(
              (field) => blockedResources.has(field) && entry.resources[field] > 0,
            )
          ) {
            entry.reason = 'fair_capacity_wait';
            continue;
          }
          if (!this.fits(host, entry)) {
            entry.reason = 'capacity';
            const active = host.entries.filter(occupied);
            if (
              active.filter((item) => item.kind === entry.kind).length >= host.config[`${entry.kind}_slots`]
            )
              blockedKinds.add(entry.kind);
            for (const field of ['cpu_millis', 'memory_bytes'] as const) {
              const limit = host.config[field];
              if (
                limit !== null &&
                active.reduce((remaining, item) => remaining - item.resources[field], limit) <
                  entry.resources[field]
              )
                blockedResources.add(field);
            }
            continue;
          }
          if (filter && !filter.queue_ids.includes(entry.queue_id)) {
            if (JSON.stringify(host) !== before) this.saveHost(hostId, host);
            return {
              admitted: false as const,
              start_allowed: false as const,
              status: 'waiting' as const,
              revision: host.revision,
              retry_after_ms: 1000,
              reasons: [{ queue_id: entry.queue_id, reason: 'dispatch_scope' }],
            };
          }
          if (entry.admission) {
            const admission = this.admit(entry.run_id, entry.admission);
            ensure(
              admission.admitted && admission.start_allowed,
              'CONFLICT',
              'Budget attempt was admitted outside this queue.',
            );
          }
          entry.state = 'running';
          entry.admitted_at = now;
          entry.lease_until = now + Math.min(host.config.lease_ms, entry.timeout_ms);
          entry.lease = {
            host_id: id.parse(hostId),
            queue_id: entry.queue_id,
            owner_id: owner,
            generation: 1,
            token: randomUUID(),
          };
          entry.execution_token = randomUUID();
          entry.reason = null;
          ensure(Number.isSafeInteger(++host.service), 'CONFLICT', 'Host service counter exhausted.');
          Object.defineProperty(host.projects, project, {
            value: host.service,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          this.saveHost(hostId, host);
          return {
            admitted: true as const,
            start_allowed: true as const,
            lease: entry.lease,
            request: entry,
            revision: host.revision,
          };
        }
      }
      if (JSON.stringify(host) !== before) this.saveHost(hostId, host);
      return {
        admitted: false as const,
        start_allowed: false as const,
        status: 'waiting' as const,
        revision: host.revision,
        retry_after_ms: 1000,
        reasons: waiting.map((entry) => ({ queue_id: entry.queue_id, reason: entry.reason })),
      };
    });
  }

  heartbeat(input: HostCapacityLease) {
    const lease = leaseSchema.parse(input);
    return this.transaction(() => {
      const host = this.host(lease.host_id),
        now = Date.now();
      this.expire(host, now);
      const entry = this.fenced(host, lease);
      ensure(entry.state === 'running', 'CONFLICT', 'Execution requires reconciliation.');
      entry.lease_until = Math.min(now + host.config.lease_ms, entry.admitted_at! + entry.timeout_ms);
      this.saveHost(lease.host_id, host);
      return { lease_until: entry.lease_until };
    });
  }

  cancel(hostId: string, queueId: string) {
    return this.transaction(() => {
      const host = this.host(hostId),
        entry = this.entry(host, queueId);
      if (entry.state === 'queued') entry.state = 'cancelled';
      else if (occupied(entry)) {
        entry.state = 'reconciling';
        entry.reason = 'cancel_requested';
      }
      this.saveHost(hostId, host);
      return { state: entry.state };
    });
  }

  /** Explicit supervisor takeover after restart. It fences the former owner; it never launches again. */
  takeOver(hostId: string, queueId: string, expectedGeneration: number, ownerId: string) {
    positive.parse(expectedGeneration);
    const owner = id.parse(ownerId);
    return this.transaction(() => {
      const host = this.host(hostId),
        entry = this.entry(host, queueId);
      ensure(
        occupied(entry) && entry.lease?.generation === expectedGeneration,
        'CONFLICT',
        'Stale recovery generation.',
      );
      entry.state = 'reconciling';
      entry.reason = 'restart_reconciliation';
      entry.lease = {
        host_id: id.parse(hostId),
        queue_id: entry.queue_id,
        owner_id: owner,
        generation: expectedGeneration + 1,
        token: randomUUID(),
      };
      positive.parse(entry.lease.generation);
      this.saveHost(hostId, host);
      return { lease: entry.lease, execution_token: entry.execution_token, start_allowed: false };
    });
  }

  /** Supply an independent trusted supervisor/provider observation, never worker-authored completion. */
  reconcile(input: HostCapacityLease, inputObservation: HostCapacityObservation) {
    const lease = leaseSchema.parse(input);
    const { settlement, script_result, ...raw } = inputObservation,
      observation = observationSchema.parse(raw);
    return this.transaction(() => {
      const host = this.host(lease.host_id),
        entry = this.fenced(host, lease);
      ensure(
        observation.execution_token === entry.execution_token,
        'CONFLICT',
        'Observation belongs to another execution.',
      );
      ensure(
        observation.observed_at >= entry.admitted_at! && observation.observed_at <= Date.now(),
        'INVALID_INPUT',
        'Observation time is outside execution lifetime.',
      );
      if (entry.state === 'settled') {
        ensure(same(entry.observation, inputObservation), 'CONFLICT', 'Reconciliation is immutable.');
        return { released: false };
      }
      ensure(occupied(entry), 'CONFLICT', 'Execution is not occupied.');
      if (entry.admission) {
        ensure(
          settlement && script_result === undefined,
          'INVALID_INPUT',
          'Agent reconciliation requires a usage settlement.',
        );
      } else {
        ensure(
          script_result && settlement === undefined,
          'INVALID_INPUT',
          'Script reconciliation requires only its process result.',
        );
        z.strictObject({
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          runtime_ms: count.nullable(),
        }).parse(script_result);
      }
      if (observation.state === 'never_started' && entry.admission) {
        ensure(settlement, 'INVALID_INPUT', 'Agent settlement required.');
        ensure(
          settlement.outcome === 'cancelled' &&
            settlement.runtime_ms === 0 &&
            settlement.usage?.input_tokens === 0 &&
            settlement.usage?.output_tokens === 0,
          'INVALID_INPUT',
          'Never-started execution requires observed zero usage and cancelled outcome.',
        );
      }
      if (observation.state === 'never_started' && !entry.admission)
        ensure(
          script_result?.outcome === 'cancelled' && script_result.runtime_ms === 0,
          'INVALID_INPUT',
          'Never-started script requires zero runtime and cancelled outcome.',
        );
      if (entry.admission) this.settle(entry.run_id, entry.admission.attempt_id, settlement!);
      entry.state = 'settled';
      entry.observation = inputObservation;
      entry.reason = null;
      this.saveHost(lease.host_id, host);
      return { released: true };
    });
  }

  reconcileNeverStarted(input: HostCapacityNeverStartedProof, observedAt: number) {
    const proof = neverStartedSchema.parse(input);
    timestamp.parse(observedAt);
    return this.transaction(() => {
      const host = this.host(proof.host_id);
      const entry = host.entries.find((entry) => entry.queue_id === proof.queue_id);
      if (
        !entry ||
        entry.kind !== 'script' ||
        entry.run_id !== proof.run_id ||
        entry.project_id !== proof.project_id ||
        entry.execution_token !== proof.execution_token ||
        (proof.state === 'queued' ? proof.execution_token !== null : proof.execution_token === null) ||
        !(entry.state === proof.state || (proof.state === 'running' && entry.state === 'reconciling'))
      )
        return { released: false };
      if (entry.state === 'queued') {
        this.cancel(proof.host_id, proof.queue_id);
        return { released: true };
      }
      return this.reconcile(entry.lease!, {
        source: 'execution-companion-recovery',
        execution_token: proof.execution_token!,
        observed_at: observedAt,
        state: 'never_started',
        script_result: { outcome: 'cancelled', runtime_ms: 0 },
      });
    });
  }

  inspect(hostId: string) {
    return this.transaction(() => {
      const host = this.host(hostId),
        before = JSON.stringify(host);
      this.expire(host, Date.now());
      if (JSON.stringify(host) !== before) this.saveHost(hostId, host);
      const active = host.entries.filter(occupied);
      return {
        ...host,
        occupied: {
          agent: active.filter((entry) => entry.kind === 'agent').length,
          script: active.filter((entry) => entry.kind === 'script').length,
          cpu_millis: active.reduce((n, entry) => n + entry.resources.cpu_millis, 0),
          memory_bytes: active.reduce((n, entry) => n + entry.resources.memory_bytes, 0),
        },
      };
    });
  }

  /** Durable revision checks with asynchronous exponential backoff, including changes from other processes. */
  async waitForChange(
    hostId: string,
    revision: number,
    options: { signal?: AbortSignal; timeout_ms?: number } = {},
  ) {
    count.parse(revision);
    const timeout = positive.max(60_000).parse(options.timeout_ms ?? 30_000),
      started = performance.now();
    let backoff = 100;
    while (true) {
      options.signal?.throwIfAborted();
      const current = this.inspect(hostId).revision;
      if (current !== revision) return { changed: true, revision: current };
      const remaining = timeout - (performance.now() - started);
      if (remaining <= 0) return { changed: false, revision: current };
      await delay(Math.min(backoff, remaining), undefined, { signal: options.signal });
      backoff = Math.min(backoff * 2, 1000);
    }
  }
}

/** Capacity-managed dispatch surface: raw UsageBudget admission and settlement are intentionally private. */
export class HostCapacity {
  private readonly ledger: CapacityLedger;
  constructor(path: string, clients?: ClientCapabilities) {
    this.ledger = new CapacityLedger(path, clients);
  }
  get identity() {
    return this.ledger.identity;
  }
  close() {
    this.ledger.close();
  }
  createRun(input: UsageBudgetRun) {
    return this.ledger.createRun(input);
  }
  report(runId: string) {
    return this.ledger.report(runId);
  }
  recordAcceptance(runId: string, input: UsageBudgetAcceptance) {
    return this.ledger.recordAcceptance(runId, input);
  }
  configureHost(hostId: string, input: HostCapacityLimits = {}) {
    return this.ledger.configureHost(hostId, input);
  }
  enqueue(hostId: string, input: HostCapacityRequest) {
    return this.ledger.enqueue(hostId, input);
  }
  setEligible(hostId: string, queueId: string, eligible: boolean) {
    return this.ledger.setEligible(hostId, queueId, eligible);
  }
  claimNext(hostId: string, ownerId: string, scope?: HostCapacityClaimScope) {
    return this.ledger.claimNext(hostId, ownerId, scope);
  }
  heartbeat(lease: HostCapacityLease) {
    return this.ledger.heartbeat(lease);
  }
  cancel(hostId: string, queueId: string) {
    return this.ledger.cancel(hostId, queueId);
  }
  takeOver(hostId: string, queueId: string, generation: number, ownerId: string) {
    return this.ledger.takeOver(hostId, queueId, generation, ownerId);
  }
  reconcile(lease: HostCapacityLease, observation: HostCapacityObservation) {
    return this.ledger.reconcile(lease, observation);
  }
  reconcileNeverStarted(proof: HostCapacityNeverStartedProof, observedAt: number) {
    return this.ledger.reconcileNeverStarted(proof, observedAt);
  }
  inspect(hostId: string) {
    return this.ledger.inspect(hostId);
  }
  waitForChange(hostId: string, revision: number, options?: { signal?: AbortSignal; timeout_ms?: number }) {
    return this.ledger.waitForChange(hostId, revision, options);
  }
}
