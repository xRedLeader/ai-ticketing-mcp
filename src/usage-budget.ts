import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ensure } from './contracts.js';

const id = z.string().trim().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const workSchema = z.strictObject({ ticket_id: id, requirements_revision: positive });
const allowanceSchema = z.strictObject({
  provider_tokens: positive,
  runtime_ms: positive,
  cost_usd_micros: count.nullable(),
});
const runSchema = z.strictObject({
  run_id: id,
  project_id: id,
  work: z.array(workSchema).min(1).max(10000),
  limits: z.strictObject({
    max_attempts: positive.default(6),
    max_provider_tokens: positive,
    max_runtime_ms: positive.default(6 * 15 * 60 * 1000),
    max_cost_usd_micros: count.nullable().default(null),
    invocation_timeout_ms: positive.max(2147483647).default(15 * 60 * 1000),
  }),
});
const admissionSchema = workSchema.extend({
  attempt_id: id,
  actor_id: id,
  role: z.enum(['worker', 'reviewer', 'approval_review']),
  provider: id,
  model: id,
  retry_of: id.nullable().default(null),
  allowance: allowanceSchema,
});
const usageSchema = z.strictObject({
  input_tokens: count.nullable().default(null),
  cached_input_tokens: count.nullable().default(null),
  cache_write_input_tokens: count.nullable().default(null),
  output_tokens: count.nullable().default(null),
  reasoning_output_tokens: count.nullable().default(null),
});
const settlementSchema = z.strictObject({
  outcome: z.enum(['succeeded', 'failed', 'rejected', 'cancelled']),
  usage: usageSchema.default(() => usageSchema.parse({})),
  usage_source: id.nullable().default(null),
  runtime_ms: count.nullable(),
  provider_retry_count: count.nullable().default(null),
  cost_usd_micros: count.nullable().default(null),
  cost_source: id.nullable().default(null),
  reference_tokens: count.nullable().default(null),
  estimated_provider_tokens: count.nullable().default(null),
  estimated_cost_usd_micros: count.nullable().default(null),
});
// These are trusted-host snapshots, not a runner's assertion that its work passed.
const acceptanceSchema = z.strictObject({
  source: id,
  ticket: z.strictObject({
    id,
    project_id: id,
    requirements_revision: positive,
    status: z.literal('done'),
    approved_submission_id: id,
  }),
  submission: z.strictObject({
    id,
    project_id: id,
    ticket_id: id,
    actor_id: id,
    requirements_revision: positive,
  }),
  review: z.strictObject({
    id,
    project_id: id,
    ticket_id: id,
    submission_id: id,
    actor_id: id,
    decision: z.literal('approve'),
  }),
});

export type UsageBudgetRun = z.input<typeof runSchema>;
export type UsageBudgetAdmission = z.input<typeof admissionSchema>;
export type UsageBudgetSettlement = z.input<typeof settlementSchema>;
export type UsageBudgetAcceptance = z.input<typeof acceptanceSchema>;
type Settlement = z.output<typeof settlementSchema>;
type Attempt = z.output<typeof admissionSchema> & { admitted_at: number; settlement: Settlement | null };
type State = {
  config: z.output<typeof runSchema>;
  attempts: Attempt[];
  accepted: z.output<typeof acceptanceSchema>[];
  attention: string[];
};

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function targetKey(work: { ticket_id: string; requirements_revision: number }) {
  return JSON.stringify([work.ticket_id, work.requirements_revision]);
}
function sum(values: number[]) {
  const total = values.reduce((n, value) => n + value, 0);
  ensure(Number.isSafeInteger(total), 'INVALID_INPUT', 'Accounting total exceeds safe integer precision.');
  return total;
}
function providerTokens(attempt: Attempt) {
  const usage = attempt.settlement?.usage;
  return usage?.input_tokens != null && usage.output_tokens != null
    ? sum([usage.input_tokens, usage.output_tokens])
    : null;
}
function providerTokenLowerBound(attempt: Attempt) {
  const usage = attempt.settlement?.usage;
  return sum([
    Math.max(
      usage?.input_tokens ?? 0,
      sum([usage?.cached_input_tokens ?? 0, usage?.cache_write_input_tokens ?? 0]),
    ),
    Math.max(usage?.output_tokens ?? 0, usage?.reasoning_output_tokens ?? 0),
  ]);
}
function attention(state: State) {
  return [
    ...state.attention,
    ...state.attempts
      .filter(
        (attempt) => !attempt.settlement && Date.now() - attempt.admitted_at >= attempt.allowance.runtime_ms,
      )
      .map((attempt) => `overdue:${attempt.attempt_id}`),
  ];
}
function totals(attempts: Attempt[]) {
  const metric = (read: (attempt: Attempt) => number | null | undefined) => ({
    known_total: sum(attempts.map((attempt) => read(attempt) ?? 0)),
    unknown_invocations: attempts.filter((attempt) => read(attempt) == null).length,
  });
  return {
    invocations: attempts.length,
    in_flight: attempts.filter((attempt) => !attempt.settlement).length,
    succeeded: attempts.filter((attempt) => attempt.settlement?.outcome === 'succeeded').length,
    failed: attempts.filter((attempt) => attempt.settlement?.outcome === 'failed').length,
    rejected: attempts.filter((attempt) => attempt.settlement?.outcome === 'rejected').length,
    cancelled: attempts.filter((attempt) => attempt.settlement?.outcome === 'cancelled').length,
    retries: attempts.filter((attempt) => attempt.retry_of !== null).length,
    provider_usage: {
      ...Object.fromEntries(
        Object.keys(usageSchema.shape).map((field) => [
          field,
          metric((attempt) => attempt.settlement?.usage[field as keyof Settlement['usage']]),
        ]),
      ),
      total_tokens: metric(providerTokens),
      provider_retry_count: metric((attempt) => attempt.settlement?.provider_retry_count),
    },
    runtime_ms: metric((attempt) => attempt.settlement?.runtime_ms),
    billing: { cost_usd_micros: metric((attempt) => attempt.settlement?.cost_usd_micros) },
    reference: { tokens: metric((attempt) => attempt.settlement?.reference_tokens) },
    estimates: {
      provider_tokens: metric((attempt) => attempt.settlement?.estimated_provider_tokens),
      cost_usd_micros: metric((attempt) => attempt.settlement?.estimated_cost_usd_micros),
    },
  };
}
function reservations(state: State) {
  const charged = (read: (attempt: Attempt) => number) => sum(state.attempts.map(read));
  return {
    attempts: state.attempts.length,
    provider_tokens: charged(
      (attempt) =>
        providerTokens(attempt) ??
        Math.max(attempt.allowance.provider_tokens, providerTokenLowerBound(attempt)),
    ),
    runtime_ms: charged((attempt) => attempt.settlement?.runtime_ms ?? attempt.allowance.runtime_ms),
    cost_usd_micros: charged(
      (attempt) => attempt.settlement?.cost_usd_micros ?? attempt.allowance.cost_usd_micros ?? 0,
    ),
  };
}

/** Optional single-host companion. All processes sharing a run must use the same local SQLite file. */
export class UsageBudget {
  protected readonly db: DatabaseSync;

  constructor(path: string) {
    ensure(path.trim() && path !== ':memory:', 'INVALID_INPUT', 'A durable local ledger path is required.');
    const filename = resolve(path);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      if (!existsSync(filename)) closeSync(openSync(filename, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS usage_budget_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  protected transaction<T>(operation: () => T): T {
    if (this.db.isTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  protected read(runId: string): State {
    const row = this.db.prepare('SELECT state FROM usage_budget_runs WHERE id=?').get(id.parse(runId));
    ensure(row, 'NOT_FOUND', 'Usage run not found.');
    return JSON.parse(row.state as string) as State;
  }

  private save(state: State) {
    this.db
      .prepare('UPDATE usage_budget_runs SET state=? WHERE id=?')
      .run(JSON.stringify(state), state.config.run_id);
  }

  protected parseAdmission(input: UsageBudgetAdmission) {
    return admissionSchema.parse(input);
  }

  protected budgetReasons(runId: string, request: ReturnType<UsageBudget['parseAdmission']>) {
    const state = this.read(runId),
      used = reservations(state),
      limits = state.config.limits;
    const reasons = attention(state);
    if (used.attempts >= limits.max_attempts) reasons.push('attempt_limit');
    if (used.provider_tokens + request.allowance.provider_tokens > limits.max_provider_tokens)
      reasons.push('provider_token_limit');
    if (used.runtime_ms + request.allowance.runtime_ms > limits.max_runtime_ms) reasons.push('runtime_limit');
    if (
      limits.max_cost_usd_micros !== null &&
      used.cost_usd_micros + request.allowance.cost_usd_micros! > limits.max_cost_usd_micros
    )
      reasons.push('cost_limit');
    return reasons;
  }

  createRun(input: UsageBudgetRun) {
    const config = runSchema.parse(input);
    ensure(
      new Set(config.work.map(targetKey)).size === config.work.length,
      'INVALID_INPUT',
      'Run work identities must be unique.',
    );
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM usage_budget_runs WHERE id=?').get(config.run_id);
      if (row) {
        ensure(
          same((JSON.parse(row.state as string) as State).config, config),
          'CONFLICT',
          'Run config is immutable.',
        );
        return { created: false };
      }
      const state: State = { config, attempts: [], accepted: [], attention: [] };
      this.db.prepare('INSERT INTO usage_budget_runs VALUES (?,?)').run(config.run_id, JSON.stringify(state));
      return { created: true };
    });
  }

  admit(runId: string, input: UsageBudgetAdmission) {
    const request = admissionSchema.parse(input);
    return this.transaction(() => {
      const state = this.read(runId);
      const previous = state.attempts.find((attempt) => attempt.attempt_id === request.attempt_id);
      if (previous) {
        const { admitted_at: _at, settlement: _settlement, ...original } = previous;
        ensure(same(original, request), 'CONFLICT', 'Attempt identity cannot be changed.');
        return { admitted: true as const, start_allowed: false, attempt: previous };
      }
      ensure(
        state.config.work.some((work) => targetKey(work) === targetKey(request)),
        'INVALID_INPUT',
        'Unknown run work.',
      );
      ensure(
        request.allowance.runtime_ms <= state.config.limits.invocation_timeout_ms,
        'INVALID_INPUT',
        'Runtime allowance exceeds invocation timeout.',
      );
      ensure(
        state.config.limits.max_cost_usd_micros === null || request.allowance.cost_usd_micros !== null,
        'INVALID_INPUT',
        'A cost allowance is required when the monetary budget is enabled.',
      );
      if (request.retry_of !== null) {
        const prior = state.attempts.find((attempt) => attempt.attempt_id === request.retry_of);
        ensure(
          prior?.settlement && targetKey(prior) === targetKey(request) && prior.role === request.role,
          'INVALID_INPUT',
          'A retry must identify a settled attempt for the same work and role.',
        );
      }
      const reasons = this.budgetReasons(runId, request);
      if (reasons.length) {
        state.attention = [...new Set(reasons)];
        this.save(state);
        return {
          admitted: false as const,
          start_allowed: false,
          status: 'needs_attention' as const,
          reasons: state.attention,
        };
      }
      const attempt: Attempt = { ...request, admitted_at: Date.now(), settlement: null };
      state.attempts.push(attempt);
      this.save(state);
      return { admitted: true as const, start_allowed: true, attempt };
    });
  }

  settle(runId: string, attemptId: string, input: UsageBudgetSettlement) {
    const settlement = settlementSchema.parse(input);
    const usage = settlement.usage;
    ensure(
      usage.input_tokens === null ||
        (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0) <= usage.input_tokens,
      'INVALID_INPUT',
      'Cache fields are subsets of inclusive input_tokens.',
    );
    ensure(
      usage.output_tokens === null || (usage.reasoning_output_tokens ?? 0) <= usage.output_tokens,
      'INVALID_INPUT',
      'Reasoning tokens are a subset of inclusive output_tokens.',
    );
    ensure(
      Object.values(usage).every((value) => value === null) || settlement.usage_source !== null,
      'INVALID_INPUT',
      'Known usage requires its observation source.',
    );
    ensure(
      (settlement.cost_usd_micros === null) === (settlement.cost_source === null),
      'INVALID_INPUT',
      'A known monetary cost requires its billing source; an unknown cost has no source.',
    );
    return this.transaction(() => {
      const state = this.read(runId);
      const attempt = state.attempts.find((item) => item.attempt_id === id.parse(attemptId));
      ensure(attempt, 'NOT_FOUND', 'Admitted attempt not found.');
      if (attempt.settlement) {
        ensure(same(attempt.settlement, settlement), 'CONFLICT', 'Settlement is immutable.');
        return { recorded: false };
      }
      attempt.settlement = settlement;
      const tokens = providerTokens(attempt);
      const checks: [string, number | null, number | null][] = [
        ['provider_tokens', tokens, attempt.allowance.provider_tokens],
        ['runtime_ms', settlement.runtime_ms, attempt.allowance.runtime_ms],
        [
          'cost_usd_micros',
          settlement.cost_usd_micros,
          state.config.limits.max_cost_usd_micros === null ? null : attempt.allowance.cost_usd_micros,
        ],
      ];
      for (const [field, value, allowance] of checks) {
        if (allowance === null) continue;
        if (value === null || value > allowance)
          state.attention.push(`${value === null ? 'unknown' : 'overrun'}:${field}:${attemptId}`);
      }
      state.attention = [...new Set(state.attention)];
      reservations(state);
      this.save(state);
      return { recorded: true };
    });
  }

  recordAcceptance(runId: string, input: UsageBudgetAcceptance) {
    const evidence = acceptanceSchema.parse(input);
    return this.transaction(() => {
      const state = this.read(runId);
      const { ticket, submission, review } = evidence;
      const work = { ticket_id: ticket.id, requirements_revision: ticket.requirements_revision };
      ensure(
        ticket.project_id === state.config.project_id &&
          submission.project_id === ticket.project_id &&
          review.project_id === ticket.project_id &&
          submission.ticket_id === ticket.id &&
          review.ticket_id === ticket.id &&
          submission.requirements_revision === ticket.requirements_revision &&
          ticket.approved_submission_id === submission.id &&
          review.submission_id === submission.id &&
          review.actor_id !== submission.actor_id &&
          state.config.work.some((target) => targetKey(target) === targetKey(work)),
        'INVALID_INPUT',
        'Acceptance requires matching current ticket, submission, and independent approving review.',
      );
      const previous = state.accepted.find(
        (item) =>
          item.ticket.id === ticket.id && item.ticket.requirements_revision === ticket.requirements_revision,
      );
      if (previous) {
        ensure(same(previous, evidence), 'CONFLICT', 'Accepted work identity is immutable.');
        return { recorded: false };
      }
      state.accepted.push(evidence);
      this.save(state);
      return { recorded: true };
    });
  }

  report(runId: string) {
    const state = this.read(runId);
    const reasons = attention(state);
    const used = reservations(state);
    const limits = state.config.limits;
    if (used.attempts >= limits.max_attempts) reasons.push('attempt_limit');
    if (used.provider_tokens >= limits.max_provider_tokens) reasons.push('provider_token_limit');
    if (used.runtime_ms >= limits.max_runtime_ms) reasons.push('runtime_limit');
    if (limits.max_cost_usd_micros !== null && used.cost_usd_micros > limits.max_cost_usd_micros)
      reasons.push('cost_limit');
    return {
      schema_version: 1,
      config: state.config,
      status: reasons.length ? 'needs_attention' : 'ready',
      reasons: [...new Set(reasons)],
      budget_charged_or_reserved: used,
      totals: totals(state.attempts),
      by_role: Object.fromEntries(
        [...new Set(state.attempts.map((attempt) => attempt.role))].map((role) => [
          role,
          totals(state.attempts.filter((attempt) => attempt.role === role)),
        ]),
      ),
      work: state.config.work.map((work) => ({
        ...work,
        accepted:
          state.accepted.find(
            (item) =>
              item.ticket.id === work.ticket_id &&
              item.ticket.requirements_revision === work.requirements_revision,
          ) ?? null,
        totals: totals(state.attempts.filter((attempt) => targetKey(attempt) === targetKey(work))),
      })),
      completion: {
        planned: state.config.work.length,
        independently_accepted: state.accepted.length,
        unfinished: state.config.work.length - state.accepted.length,
        denominator: 'unique independently accepted (ticket_id, requirements_revision)',
        provider_tokens_per_accepted:
          state.accepted.length &&
          totals(state.attempts).provider_usage.total_tokens.unknown_invocations === 0
            ? totals(state.attempts).provider_usage.total_tokens.known_total / state.accepted.length
            : null,
      },
      attempts: state.attempts,
      limitations: [
        'Local single-host ledger; every dispatcher for this run must share this file.',
        'Cache fields are subsets of inclusive input; reasoning is a subset of output. Total is input plus output only.',
        'Known costs require billing evidence. Reference counts and estimates are never provider usage or billing.',
        'In-flight allowances remain charged after crashes. No expiry, cancellation, or timeout automatically refunds them.',
        'Allowances are admission estimates, not provider-enforced caps. Already admitted calls can overshoot by their actual excess, with no finite bound unless the client/provider enforces one; an observed overrun stops new admissions.',
        'Acceptance snapshots must come from a trusted authenticated coordination read; the ledger validates consistency, not provenance or reviewer authorization.',
      ],
    };
  }

  /** One callback, after durable admission; replay never invokes it again. No retry or model loop. */
  async runInvocation(
    runId: string,
    request: UsageBudgetAdmission,
    invoke: (signal: AbortSignal) => Promise<Omit<UsageBudgetSettlement, 'runtime_ms'>>,
  ) {
    const admission = this.admit(runId, request);
    if (!admission.admitted || !admission.start_allowed) return admission;
    const started = performance.now();
    let result: Omit<UsageBudgetSettlement, 'runtime_ms'>;
    try {
      result = await invoke(AbortSignal.timeout(admission.attempt.allowance.runtime_ms));
    } catch (error) {
      this.settle(runId, admission.attempt.attempt_id, {
        outcome: 'failed',
        runtime_ms: Math.ceil(performance.now() - started),
      });
      throw error;
    }
    this.settle(runId, admission.attempt.attempt_id, {
      ...result,
      runtime_ms: Math.ceil(performance.now() - started),
    });
    return admission;
  }
}
