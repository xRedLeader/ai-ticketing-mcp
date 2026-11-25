import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideModelRoute,
  routingCapabilities,
  routingWorkflows,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingEvaluation,
} from '../src/model-routing.js';
import { UsageBudget } from '../src/usage-budget.js';
import {
  runModelRoute,
  verifyRoutingEvaluation,
  verifyRoutingStudyBudget,
} from '../scripts/model-routing.js';

const hash = 'a'.repeat(64);
const environment = {
  runtime_revision: 'revision',
  runtime_sha256: hash,
  client_version: 'codex test',
  scenario_contract_sha256: hash,
  fixture_server_sha256: hash,
  measurement_source_sha256: { 'benchmark.ts': hash },
};
function policy(): ModelRoutingPolicy {
  return {
    revision: 'routing-1',
    enabled: true,
    baseline_route: 'pinned',
    scope: 'protocol-workflows-v1',
    reviewer: { model: 'fixed-reviewer', effort: 'xhigh' },
    environment,
    routes: [
      {
        id: 'pinned',
        provider: 'openai',
        model: 'worker',
        effort: 'xhigh',
        capabilities: [...routingCapabilities],
        evaluation: { report: 'baseline.json', sha256: hash },
      },
      {
        id: 'candidate',
        provider: 'openai',
        model: 'worker',
        effort: 'high',
        capabilities: [...routingCapabilities],
        evaluation: { report: 'candidate.json', sha256: hash },
      },
    ],
    minimum_token_reduction: 0.1,
  };
}
const request = { route_id: 'candidate', required_capabilities: ['coordination_claim'] };
function evaluations(): Record<string, RoutingEvaluation> {
  const evaluation = (report: string, effort: string, input: number): RoutingEvaluation => ({
    report,
    sha256: hash,
    environment,
    reviewer: { model: 'fixed-reviewer', effort: 'xhigh' },
    route: { model: 'worker', effort },
    workflow_ids: [...routingWorkflows],
    completed_workflows: 6,
    failed_attempts: 1,
    invocations: 8,
    usage: {
      input_tokens: { known_total: input, unknown_invocations: 0 },
      output_tokens: { known_total: 10, unknown_invocations: 0 },
      cached_input_tokens: { known_total: 0, unknown_invocations: 8 },
    },
    workflow_usage: Object.fromEntries(
      routingWorkflows.map((workflow) => [
        workflow,
        {
          input_tokens: { known_total: input, unknown_invocations: 0 },
          output_tokens: { known_total: 10, unknown_invocations: 0 },
        },
      ]),
    ),
    study_budget: { run_id: 'study', database: 'study.sqlite', attempts: [] },
    monetary_cost: { status: 'unavailable', usd: null },
    approval_review_usage: { status: 'not_separately_reported_by_cli', usage: null },
    attempts: [],
  });
  return {
    pinned: evaluation('baseline.json', 'xhigh', 100),
    candidate: evaluation('candidate.json', 'high', 70),
  };
}

it('requires explicit allowlisted route and honors model, effort, capability, and enablement constraints', () => {
  assert.equal(decideModelRoute(policy(), request, evaluations()).status, 'eligible');
  for (const [change, reason] of [
    [{ route_id: 'other' }, 'route_not_allowlisted'],
    [{ model_pin: 'other' }, 'model_pin_mismatch'],
    [{ effort_pin: 'xhigh' }, 'effort_pin_mismatch'],
    [{ required_capabilities: ['general_coding'] }, 'capability_not_evaluated_by_scope'],
  ] as [Partial<ModelRoutingRequest>, string][])
    assert.ok(decideModelRoute(policy(), { ...request, ...change }, evaluations()).reasons.includes(reason));
  assert.ok(
    decideModelRoute({ ...policy(), enabled: false }, request, evaluations()).reasons.includes(
      'alternate_routing_disabled',
    ),
  );
  assert.equal(
    decideModelRoute(policy(), { ...request, route_id: 'pinned', effort_pin: 'xhigh' }).status,
    'eligible',
  );
  assert.equal(decideModelRoute(policy(), request).status, 'denied');
  const unsupported = policy();
  unsupported.routes[1]!.provider = 'other-provider' as any;
  assert.throws(() => decideModelRoute(unsupported, request, evaluations()));
});

it('gates promotion on matched artifacts, representative completion, failures, and observed usage', () => {
  const cases: [string, (evaluation: RoutingEvaluation) => void][] = [
    [
      'evaluation_environment_mismatch:candidate',
      (item) => {
        item.environment = { ...environment, client_version: 'old' };
      },
    ],
    [
      'fixed_reviewer_mismatch:candidate',
      (item) => {
        item.reviewer = { ...item.reviewer, effort: 'low' };
      },
    ],
    [
      'evaluation_route_mismatch:candidate',
      (item) => {
        item.route.effort = 'xhigh';
      },
    ],
    [
      'representative_completion_missing:candidate',
      (item) => {
        item.workflow_ids.pop();
        item.completed_workflows--;
      },
    ],
    [
      'failed_attempts_regressed',
      (item) => {
        item.failed_attempts++;
      },
    ],
    [
      'provider_usage_unknown:candidate:input_tokens',
      (item) => {
        item.usage.input_tokens!.unknown_invocations++;
      },
    ],
    [
      'reported_token_reduction_not_met',
      (item) => {
        item.usage.input_tokens!.known_total = 100;
      },
    ],
    [
      'workflow_provider_tokens_regressed:short',
      (item) => {
        item.workflow_usage.short!.input_tokens!.known_total = 101;
      },
    ],
    [
      'verified_evaluation_missing:candidate',
      (item) => {
        item.sha256 = 'b'.repeat(64);
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const evidence = evaluations();
    mutate(evidence.candidate!);
    assert.ok(decideModelRoute(policy(), request, evidence).reasons.includes(reason), reason);
  }
  const decision = decideModelRoute(policy(), request, evaluations());
  assert.equal(decision.policy_revision, 'routing-1');
  assert.equal(decision.evaluations.candidate!.usage.cached_input_tokens!.unknown_invocations, 8);
  assert.deepEqual(decision.evaluations.candidate!.monetary_cost, { status: 'unavailable', usd: null });
  assert.equal(decision.evaluations.candidate!.approval_review_usage.usage, null);
});

it('rejects altered pinned artifacts before trusting a report completion flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-artifact-'));
  try {
    const report = join(directory, 'report.json');
    await writeFile(report, JSON.stringify({ completed_workflows: 6 }));
    await assert.rejects(
      verifyRoutingEvaluation({ report, sha256: hash }),
      /Pinned evaluation report changed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withBudget(
  limit: number,
  operation: (budget: UsageBudget, database: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'routing-budget-'));
  const budget = new UsageBudget(join(directory, 'usage.sqlite'));
  try {
    budget.createRun({
      run_id: 'run',
      project_id: 'project',
      work: [
        { ticket_id: 'ticket', requirements_revision: 1 },
        { ticket_id: 'arm:short', requirements_revision: 1 },
      ],
      limits: { max_provider_tokens: limit },
    });
    await operation(budget, join(directory, 'usage.sqlite'));
  } finally {
    budget.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const admission = {
  attempt_id: 'attempt',
  ticket_id: 'ticket',
  requirements_revision: 1,
  actor_id: 'worker',
  allowance: { provider_tokens: 100, runtime_ms: 1000, cost_usd_micros: null },
};
const baselineRequest = { route_id: 'pinned', required_capabilities: ['coordination_claim'] };

it('qualifies only retained study admissions matching role, identity, raw usage, and immutable snapshot', async () => {
  await withBudget(1000, async (budget, database) => {
    const request = {
      ...admission,
      attempt_id: 'arm:attempt:worker',
      ticket_id: 'arm:short',
      model: 'worker',
      provider: 'openai',
      role: 'worker' as const,
    };
    const admitted = budget.admit('run', request);
    assert.ok(admitted.admitted);
    budget.settle('run', request.attempt_id, {
      outcome: 'succeeded',
      usage: { input_tokens: 20, output_tokens: 10 },
      usage_source: 'worker.jsonl',
      runtime_ms: 10,
    });
    const report = {
      run: 'arm',
      budget_configuration: { database, run_id: 'run', invocation_token_allowance: 100 },
      invocation_timeout_ms: 1000,
      budget_usage: budget.report('run'),
    };
    const invocation = {
      attempt_id: request.attempt_id,
      ticket_id: request.ticket_id,
      actor_id: request.actor_id,
      role: request.role,
      model: request.model,
      usage: report.budget_usage.attempts[0]!.settlement!.usage,
      usage_source: 'worker.jsonl',
      outcome: 'succeeded',
      started_at: new Date(admitted.attempt.admitted_at - 1).toISOString(),
      finished_at: new Date(admitted.attempt.admitted_at + 100).toISOString(),
    };
    assert.equal(verifyRoutingStudyBudget(report, [invocation]).attempts.length, 1);
    assert.throws(
      () => verifyRoutingStudyBudget({ ...report, budget_configuration: null }, [invocation]),
      /explicit durable study budget/,
    );
    assert.throws(
      () => verifyRoutingStudyBudget(report, [{ ...invocation, model: 'different' }]),
      /model mismatch/,
    );
    assert.throws(
      () => verifyRoutingStudyBudget(report, [{ ...invocation, usage: { input_tokens: 1 } }]),
      /Ledger usage/,
    );
    budget.admit('run', { ...request, attempt_id: 'arm:omitted:worker' });
    assert.throws(() => verifyRoutingStudyBudget(report, [invocation]), /omitted/);
  });
});

it('budget denial never starts the client sentinel and has no fallback', async () => {
  await withBudget(50, async (budget) => {
    let launched = false;
    const result = await runModelRoute(policy(), baselineRequest, budget, 'run', admission, async () => {
      launched = true;
      throw new Error('sentinel must not run');
    });
    assert.equal(launched, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.invocation, 'not_started');
    assert.ok(result.reasons.includes('budget_denied'));
    assert.equal(result.budget.totals.invocations, 0);
  });
});

it('launches once after admission and retains unobserved usage and failed calls', async () => {
  await withBudget(1000, async (budget) => {
    let launched = 0;
    const invoke = async () => {
      launched++;
      return {
        outcome: 'succeeded' as const,
        usage: { input_tokens: 20, output_tokens: 10 },
        usage_source: 'client.jsonl',
      };
    };
    const first = await runModelRoute(policy(), baselineRequest, budget, 'run', admission, invoke);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.budget.attempts[0]!.settlement!.usage.cached_input_tokens, null);
    assert.equal(first.budget.totals.billing.cost_usd_micros.unknown_invocations, 1);
    const repeated = await runModelRoute(policy(), baselineRequest, budget, 'run', admission, invoke);
    assert.equal(repeated.status, 'denied');
    assert.equal(launched, 1);
    const failed = await runModelRoute(
      policy(),
      baselineRequest,
      budget,
      'run',
      { ...admission, attempt_id: 'failed' },
      async () => {
        throw new Error('provider failed');
      },
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.budget.totals.failed, 1);
    assert.equal(failed.budget.totals.provider_usage.total_tokens.unknown_invocations, 1);
  });
});
