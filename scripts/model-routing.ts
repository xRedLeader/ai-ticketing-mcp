import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UsageBudget, type UsageBudgetAdmission, type UsageBudgetSettlement } from '../src/usage-budget.js';
import {
  decideModelRoute,
  modelRoutingPolicySchema,
  modelRoutingRequestSchema,
  routingWorkflows,
  type ModelRoute,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingEvaluation,
} from '../src/model-routing.js';
import { aggregateUsage, parseCodexInvocation } from './real-client-observation.js';
import { revalidateAttempt } from './real-client-revalidation.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const repo = fileURLToPath(new URL('..', import.meta.url));
type StudyInvocation = {
  attempt_id: string;
  ticket_id: string;
  actor_id: string;
  role: string;
  model: string;
  usage: unknown;
  usage_source: string;
  outcome: string;
  started_at: string;
  finished_at: string;
};
/** The report snapshot is compared with the retained durable ledger, never an in-memory assertion. */
export function verifyRoutingStudyBudget(report: any, invocations: StudyInvocation[]) {
  assert.ok(
    report.budget_configuration && report.budget_usage,
    'Qualifying evaluations require an explicit durable study budget.',
  );
  assert.match(report.run, /^[a-zA-Z0-9_-]+$/);
  const configuration = report.budget_configuration;
  const db = new DatabaseSync(resolve(configuration.database), { readOnly: true });
  let state: any;
  try {
    const row = db.prepare('SELECT state FROM usage_budget_runs WHERE id=?').get(configuration.run_id);
    assert.ok(row, 'Study budget run is missing.');
    state = JSON.parse(row.state as string);
  } finally {
    db.close();
  }
  assert.deepEqual(state.config, report.budget_usage.config, 'Immutable study budget configuration changed.');
  assert.deepEqual(state.attention, [], 'Study budget requires attention; promotion is stopped.');
  const attempts = state.attempts.filter((attempt: any) => attempt.attempt_id.startsWith(`${report.run}:`));
  assert.deepEqual(
    attempts.map((attempt: any) => attempt.attempt_id).sort(),
    invocations.map((invocation) => invocation.attempt_id).sort(),
    'A study admission was omitted from raw invocation accounting.',
  );
  for (const invocation of invocations) {
    const attempt = attempts.find((item: any) => item.attempt_id === invocation.attempt_id);
    assert.deepEqual(
      attempt,
      report.budget_usage.attempts.find((item: any) => item.attempt_id === invocation.attempt_id),
      'The report budget snapshot changed.',
    );
    for (const field of ['ticket_id', 'actor_id', 'role', 'model'] as const)
      assert.equal(attempt[field], invocation[field], `Budget ${field} mismatch.`);
    assert.equal(attempt.provider, 'openai');
    assert.equal(attempt.requirements_revision, 1);
    assert.equal(attempt.allowance.provider_tokens, configuration.invocation_token_allowance);
    assert.equal(attempt.allowance.runtime_ms, report.invocation_timeout_ms);
    assert.equal(attempt.allowance.cost_usd_micros, null);
    assert.ok(
      attempt.admitted_at >= Date.parse(invocation.started_at) &&
        attempt.admitted_at <= Date.parse(invocation.finished_at),
    );
    assert.ok(attempt.settlement, 'An evaluation admission is still unsettled.');
    assert.equal(attempt.settlement.outcome, invocation.outcome);
    assert.deepEqual(
      attempt.settlement.usage,
      invocation.usage,
      'Ledger usage must include each actual failed and successful call.',
    );
    assert.equal(attempt.settlement.usage_source, invocation.usage_source);
    assert.ok(Number.isSafeInteger(attempt.settlement.runtime_ms) && attempt.settlement.runtime_ms >= 0);
  }
  return { run_id: configuration.run_id, database: configuration.database, attempts };
}
async function treeHashes(directory: string) {
  const hashes: Record<string, string> = {};
  async function visit(path: string, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      assert.ok(!entry.isSymbolicLink(), 'Evaluation runtime cannot contain symbolic links.');
      if (entry.isDirectory()) await visit(join(path, entry.name), `${prefix}${entry.name}/`);
      else hashes[prefix + entry.name] = sha256(await readFile(join(path, entry.name)));
    }
  }
  await visit(directory);
  return hashes;
}

/** Reads every raw invocation, failed attempt, and read-only fixture proof; never calls a provider. */
export async function verifyRoutingEvaluation(reference: {
  report: string;
  sha256: string;
}): Promise<RoutingEvaluation> {
  const text = await readFile(reference.report, 'utf8');
  assert.equal(sha256(text), reference.sha256, 'Pinned evaluation report changed.');
  const report = JSON.parse(text),
    root = dirname(resolve(reference.report));
  assert.equal(report.client, 'Codex CLI');
  assert.equal(typeof report.client_version, 'string');
  assert.ok(
    report.budget_configuration && report.budget_usage,
    'Qualifying evaluations require an explicit durable study budget.',
  );
  const contractText = await readFile(join(repo, 'scripts/fixtures/protocol-workflows.json'), 'utf8');
  const contract = JSON.parse(contractText);
  assert.equal(
    sha256(contractText),
    report.scenario_contract_sha256,
    'The representative workflow contract changed.',
  );
  assert.deepEqual(report.workflows.map((workflow: any) => workflow.id).sort(), [...routingWorkflows].sort());
  assert.equal(sha256(await readFile(join(root, 'server.mjs'))), report.fixture_server_sha256);
  const runtime = await treeHashes(join(root, 'runtime'));
  assert.deepEqual(runtime, report.runtime_hashes, 'The pinned runtime changed.');
  const measurement = Object.fromEntries(
    await Promise.all(
      ['real-client-benchmark.ts', 'real-client-observation.ts', 'real-client-prefix.ts'].map(
        async (name) => [name, sha256(await readFile(join(repo, 'scripts', name)))],
      ),
    ),
  );
  const attempts: RoutingEvaluation['attempts'] = [];
  const invocations: any[] = [];
  const studyInvocations: StudyInvocation[] = [];
  const workflowUsage: RoutingEvaluation['workflow_usage'] = {};
  let completed = 0,
    failed = 0;
  const referencedDirectories = new Set<string>();
  for (const workflow of report.workflows) {
    const workflowInvocations: any[] = [];
    assert.ok(workflow.attempts.length > 0, `No attempts for ${workflow.id}.`);
    let workflowCompleted = false;
    for (const attempt of workflow.attempts) {
      assert.ok(
        ['completed', 'failed'].includes(attempt.status),
        'Running or unknown attempts cannot qualify.',
      );
      assert.deepEqual(
        attempt.measurement_source_sha256,
        measurement,
        'Evaluation measurement code does not match this verifier.',
      );
      const directory = resolve(attempt.artifact_directory);
      assert.equal(dirname(directory), root, 'Attempt artifacts must remain with their original report.');
      assert.ok(!referencedDirectories.has(directory), 'Attempt artifacts cannot be counted twice.');
      referencedDirectories.add(directory);
      const roles = new Set<string>();
      for (const original of attempt.invocations) {
        assert.ok(['worker', 'reviewer'].includes(original.role) && !roles.has(original.role));
        roles.add(original.role);
        const request = JSON.parse(await readFile(join(directory, `${original.role}-request.json`), 'utf8'));
        const effort = report.efforts?.[original.role] ?? report.effort;
        assert.equal(request.requested_model, report.models[original.role]);
        assert.equal(request.reasoning_effort, effort);
        assert.equal(original.model_requested, request.requested_model);
        assert.equal(original.reasoning_effort, effort);
        assert.equal(request.arguments.filter((value: string) => value === '--model').length, 1);
        assert.equal(request.arguments[request.arguments.indexOf('--model') + 1], request.requested_model);
        assert.deepEqual(
          request.arguments.filter((value: string) => value.startsWith('model_reasoning_effort=')),
          [`model_reasoning_effort=${JSON.stringify(effort)}`],
        );
        const observed = parseCodexInvocation(
          await readFile(join(directory, `${original.role}.jsonl`), 'utf8'),
          original.exit_code ?? null,
        );
        assert.deepEqual(
          observed.usage,
          original.usage,
          'Failed and successful usage must match the raw client observations.',
        );
        invocations.push(observed);
        workflowInvocations.push(observed);
        const fixture = JSON.parse(await readFile(join(directory, `${original.role}-fixture.json`), 'utf8'));
        studyInvocations.push({
          attempt_id: `${report.run}:${attempt.id}:${original.role}`,
          ticket_id: `${report.run}:${workflow.id}`,
          actor_id: fixture.actorId,
          role: original.role,
          model: report.models[original.role],
          usage: observed.usage,
          usage_source: join(directory, `${original.role}.jsonl`),
          outcome: original.success ? 'succeeded' : 'failed',
          started_at: attempt.started_at,
          finished_at: attempt.finished_at,
        });
      }
      for (const name of await readdir(directory))
        if (name === 'worker.jsonl' || name === 'reviewer.jsonl')
          assert.ok(roles.has(name.split('.')[0]!), 'A raw invocation was omitted from the report.');
      const checked = await revalidateAttempt(
        attempt,
        contract.workflows.find((item: any) => item.id === workflow.id),
        contract,
      );
      assert.ok(
        attempt.status !== 'completed' || checked.effective_status === 'completed',
        `Completed attempt failed authoritative revalidation: ${checked.errors.join('; ')}`,
      );
      if (attempt.status === 'failed' || checked.effective_status === 'failed') failed++;
      if (checked.effective_status === 'completed') workflowCompleted = true;
      attempts.push({
        id: attempt.id,
        workflow: workflow.id,
        original_status: attempt.status,
        effective_status: checked.effective_status,
        errors: checked.errors,
        artifact_sha256: checked.artifact_sha256,
      });
    }
    if (workflowCompleted) completed++;
    workflowUsage[workflow.id] = aggregateUsage(workflowInvocations);
  }
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && routingWorkflows.some((workflow) => entry.name.startsWith(`${workflow}-`)))
      assert.ok(
        referencedDirectories.has(join(root, entry.name)),
        'An attempt directory was omitted from the report.',
      );
  const usage = aggregateUsage(invocations);
  const studyBudget = verifyRoutingStudyBudget(report, studyInvocations);
  assert.deepEqual(
    usage,
    report.usage,
    'Aggregate usage must include every failed and successful invocation.',
  );
  assert.equal(
    sha256(await readFile(reference.report)),
    reference.sha256,
    'Report changed during verification.',
  );
  return {
    ...reference,
    environment: {
      runtime_revision: report.runtime_revision,
      runtime_sha256: sha256(JSON.stringify(runtime)),
      client_version: report.client_version,
      scenario_contract_sha256: report.scenario_contract_sha256,
      fixture_server_sha256: report.fixture_server_sha256,
      measurement_source_sha256: measurement,
    },
    reviewer: { model: report.models.reviewer, effort: report.efforts?.reviewer ?? report.effort },
    route: { model: report.models.worker, effort: report.efforts?.worker ?? report.effort },
    workflow_ids: report.workflows.map((workflow: any) => workflow.id),
    completed_workflows: completed,
    failed_attempts: failed,
    invocations: invocations.length,
    usage,
    workflow_usage: workflowUsage,
    study_budget: studyBudget,
    monetary_cost: report.monetary_cost,
    approval_review_usage: { status: 'not_separately_reported_by_cli', usage: null },
    attempts,
  };
}

/** Optional host companion: explicit route, verified artifacts, durable admission, one launch. */
export async function runModelRoute(
  policyInput: ModelRoutingPolicy,
  requestInput: ModelRoutingRequest,
  budget: UsageBudget,
  runId: string,
  admission: Omit<UsageBudgetAdmission, 'model' | 'provider' | 'role'>,
  invoke: (route: ModelRoute, signal: AbortSignal) => Promise<Omit<UsageBudgetSettlement, 'runtime_ms'>>,
) {
  const policy = modelRoutingPolicySchema.parse(policyInput),
    request = modelRoutingRequestSchema.parse(requestInput);
  const evaluations: Record<string, RoutingEvaluation> = {},
    verificationErrors: string[] = [];
  if (request.route_id !== policy.baseline_route) {
    for (const id of new Set([policy.baseline_route, request.route_id])) {
      const reference = policy.routes.find((route) => route.id === id)?.evaluation;
      if (!reference) continue;
      try {
        evaluations[id] = await verifyRoutingEvaluation(reference);
      } catch (error) {
        verificationErrors.push(`${id}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const decision = decideModelRoute(policy, request, evaluations);
  if (decision.status !== 'eligible')
    return {
      ...decision,
      verification_errors: verificationErrors,
      budget: budget.report(runId),
      invocation: 'not_started',
    };
  const route = decision.selected_route!;
  try {
    const admitted = await budget.runInvocation(
      runId,
      { ...admission, model: route.model, provider: route.provider, role: 'worker' },
      (signal) => invoke(route, signal),
    );
    const report = budget.report(runId);
    const outcome = report.attempts.find((attempt) => attempt.attempt_id === admission.attempt_id)?.settlement
      ?.outcome;
    const status = !admitted.start_allowed
      ? ('denied' as const)
      : outcome === 'succeeded'
        ? ('succeeded' as const)
        : ('failed' as const);
    return {
      ...decision,
      status,
      reasons: [
        ...decision.reasons,
        ...(!admitted.start_allowed
          ? [admitted.admitted ? 'attempt_already_admitted' : 'budget_denied']
          : outcome !== 'succeeded'
            ? ['invocation_did_not_succeed']
            : []),
      ],
      verification_errors: verificationErrors,
      budget_admission: admitted,
      budget: report,
      invocation: admitted.start_allowed ? 'settled' : 'not_started',
    };
  } catch (error) {
    return {
      ...decision,
      status: 'failed' as const,
      reasons: [...decision.reasons, 'invocation_failed'],
      verification_errors: verificationErrors,
      error: error instanceof Error ? error.message : String(error),
      budget: budget.report(runId),
      invocation: 'failed',
    };
  }
}
