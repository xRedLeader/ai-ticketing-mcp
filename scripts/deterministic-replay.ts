import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { countReferenceTokens } from '../src/tokens.js';
import { aggregateUsage, parseCodexInvocation, usageFields, type Usage } from './real-client-observation.js';
import { revalidateAttempt } from './real-client-revalidation.js';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const reads = new Set([
  'project_get',
  'ticket_context',
  'ticket_get',
  'ticket_history',
  'checkpoint_get',
  'artifact_read',
]);
type Authority = Awaited<ReturnType<typeof revalidateAttempt>> & {
  observation_integrity?: { raw_usage_verified: boolean };
};
type RecordedReport = { [key: string]: any; workflows: { id: string; attempts: any[] }[] };

export function assertComparableReports(baseline: RecordedReport, candidate: RecordedReport) {
  const identity = (report: RecordedReport) => ({
    ...Object.fromEntries(
      [
        'models',
        'effort',
        'efforts',
        'client',
        'client_version',
        'runtime_revision',
        'runtime_hashes',
        'fixture_server_sha256',
        'scenario_contract_sha256',
        'prompt_layout',
        'measurement',
      ].map((key) => [key, report[key] ?? null]),
    ),
    measurement_source_sha256: [
      ...new Set(
        report.workflows.flatMap((workflow) =>
          workflow.attempts.map((attempt) =>
            serializeSuccessEnvelope(attempt.measurement_source_sha256 ?? null),
          ),
        ),
      ),
    ].sort(),
    effective_role_models_efforts: [
      ...new Set(
        report.workflows.flatMap((workflow) =>
          workflow.attempts.flatMap((attempt) =>
            attempt.invocations.map((invocation: any) => {
              const model = invocation.model_requested ?? report.models?.[invocation.role];
              const effort =
                invocation.reasoning_effort ?? report.efforts?.[invocation.role] ?? report.effort;
              assert.ok(
                typeof model === 'string' && typeof effort === 'string',
                'Measured comparisons require explicit recorded role models and efforts.',
              );
              return serializeSuccessEnvelope({ role: invocation.role, model, effort });
            }),
          ),
        ),
      ),
    ].sort(),
  });
  assert.deepEqual(
    identity(candidate),
    identity(baseline),
    'Comparisons require identical recorded models, efforts, runtime, client, fixture, prompt and measurement identities. Model/effort comparisons require separate explicitly budgeted measured runs.',
  );
}

function validateReport(report: RecordedReport) {
  assert.ok(Array.isArray(report.workflows), 'Report must contain recorded workflows.');
  const ids = new Set<string>();
  for (const workflow of report.workflows) {
    assert.ok(typeof workflow.id === 'string' && !ids.has(workflow.id), 'Workflow IDs must be unique.');
    ids.add(workflow.id);
    assert.ok(Array.isArray(workflow.attempts), 'Workflow attempts must be retained.');
    const attempts = new Set<string>();
    for (const attempt of workflow.attempts) {
      assert.ok(typeof attempt.id === 'string' && !attempts.has(attempt.id), 'Attempt IDs must be unique.');
      attempts.add(attempt.id);
      assert.ok(
        ['running', 'failed', 'completed'].includes(attempt.status),
        'Unknown recorded attempt status.',
      );
      assert.ok(Array.isArray(attempt.invocations), 'Attempt invocations must be retained.');
      for (const invocation of attempt.invocations) {
        assert.ok(Array.isArray(invocation.calls), 'Invocation calls must be retained.');
        for (const field of usageFields) {
          const value = invocation.usage?.[field];
          assert.ok(
            value == null || (Number.isSafeInteger(value) && value >= 0),
            `Invalid reported usage: ${field}.`,
          );
        }
      }
    }
  }
}

/** A recommendation over recorded responses; it never substitutes responses in a live client. */
export function replayRetrieval(calls: any[]) {
  const cache = new Map<string, { response: string; completed: number }>();
  const eligibleRead = (call: any) => reads.has(call.tool) && call.envelope?.ok === true && !call.error;
  const barriers = calls.filter((call) => !eligibleRead(call));
  const decisions: {
    call_index: number;
    call_id: string;
    action: 'retain' | 'simulate_cache_hit' | 'simulate_stale_cache_hit';
  }[] = [];
  let requestBytes = 0,
    responseBytes = 0,
    requestTokens = 0,
    responseTokens = 0;
  for (const [index, call] of calls.entries()) {
    assert.ok(
      typeof call.tool === 'string' && typeof call.id === 'string',
      'Recorded calls require tool and ID.',
    );
    const request = serializeSuccessEnvelope({ name: call.tool, arguments: call.arguments });
    const response = serializeSuccessEnvelope({
      result: call.result,
      envelope: call.envelope,
      error: call.error,
    });
    const eligible = eligibleRead(call);
    const prior = cache.get(request);
    const timed =
      Number.isSafeInteger(call.started) &&
      Number.isSafeInteger(call.completed) &&
      call.completed > call.started;
    const hit =
      reads.has(call.tool) &&
      timed &&
      !!prior &&
      prior.completed < call.started &&
      !barriers.some(
        (barrier) =>
          !Number.isSafeInteger(barrier.started) ||
          !Number.isSafeInteger(barrier.completed) ||
          (barrier.started < call.started && barrier.completed > prior.completed),
      );
    const stale = hit && (!eligible || prior!.response !== response);
    decisions.push({
      call_index: index,
      call_id: call.id,
      action: stale ? 'simulate_stale_cache_hit' : hit ? 'simulate_cache_hit' : 'retain',
    });
    if (hit && !stale) {
      const wireRequest = JSON.stringify({ name: call.tool, arguments: call.arguments });
      const envelope = serializeSuccessEnvelope(call.envelope.data);
      requestBytes += Buffer.byteLength(wireRequest);
      responseBytes += Buffer.byteLength(JSON.stringify(call.result ?? call.envelope));
      requestTokens += countReferenceTokens(wireRequest);
      responseTokens += countReferenceTokens(envelope);
    }
    // Unknown operations, failures and mutations are barriers; authority never crosses an invocation.
    if (!eligible) cache.clear();
    else if (timed) cache.set(request, { response, completed: call.completed });
  }
  return {
    policy: 'repeat-read-cache-v1',
    decisions,
    recorded_calls: calls.length,
    simulated_avoided_calls: decisions.filter((item) => item.action === 'simulate_cache_hit').length,
    stale_response_regressions: decisions.filter((item) => item.action === 'simulate_stale_cache_hit'),
    simulated_avoided_request_bytes: requestBytes,
    simulated_avoided_sdk_result_bytes: responseBytes,
    simulated_avoided_request_reference_tokens: requestTokens,
    simulated_avoided_canonical_result_reference_tokens: responseTokens,
  };
}

function acceptedIdentity(authority: Authority | undefined) {
  const target = authority?.target;
  const state = authority?.proofs?.authoritative_state;
  if (
    authority?.effective_status !== 'completed' ||
    authority.observation_integrity?.raw_usage_verified === false ||
    authority.errors.length ||
    !state?.independent_review ||
    state.status !== 'done' ||
    !state.submission_id ||
    !target?.project_id ||
    !target.ticket_id ||
    !target.worker_id ||
    !target.reviewer_id ||
    target.worker_id === target.reviewer_id ||
    !Number.isSafeInteger(target.requirements_revision) ||
    target.requirements_revision < 1 ||
    state.requirements_revision !== target.requirements_revision
  )
    return null;
  return `${target.project_id}/${target.ticket_id}/${target.requirements_revision}`;
}

/** Authority comes only from separate read-only final-state revalidation, never attempt labels. */
export function replayReport(report: RecordedReport, authority: Record<string, Authority> = {}) {
  validateReport(report);
  const workflows = report.workflows.map((workflow) => {
    const accepted = new Set<string>();
    const invocations: any[] = [];
    const attempts = workflow.attempts.map((attempt) => {
      const proof = authority[`${workflow.id}/${attempt.id}`];
      const identity = acceptedIdentity(proof);
      if (identity) accepted.add(identity);
      invocations.push(...attempt.invocations);
      return {
        id: attempt.id,
        original_status: attempt.status,
        original_failure: attempt.failure ?? null,
        authoritative_revalidation: proof ?? null,
        independently_accepted_current_revision: identity,
        invocations: attempt.invocations.map((invocation: any) => ({
          role: invocation.role ?? null,
          original_success: invocation.success ?? null,
          original_errors: invocation.errors ?? [],
          retrieval: replayRetrieval(invocation.calls),
        })),
      };
    });
    const usage = aggregateUsage(
      invocations.map((invocation) => ({
        usage: Object.fromEntries(
          usageFields.map((field) => [field, invocation.usage?.[field] ?? null]),
        ) as Usage,
      })),
    );
    const elapsed = workflow.attempts.map((attempt) => {
      const started = Date.parse(attempt.started_at),
        finished = Date.parse(attempt.finished_at);
      return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
        ? finished - started
        : null;
    });
    const elapsedKnown = elapsed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const elapsedUnknown = elapsed.filter((value) => value === null).length;
    const missingInvocations = workflow.attempts.filter((attempt) => !attempt.invocations.length).length;
    const unverifiedAttempts = attempts.filter(
      (attempt) => attempt.authoritative_revalidation?.observation_integrity?.raw_usage_verified === false,
    ).length;
    const completed = attempts.some(
      (attempt) => attempt.authoritative_revalidation?.effective_status === 'completed',
    );
    const successfulAttempts = attempts.filter(
      (attempt) => attempt.authoritative_revalidation?.effective_status === 'completed',
    ).length;
    const observed = {
      kind: 'observed_actual',
      recorded_successful_completion: workflow.attempts.some((attempt) => attempt.status === 'completed'),
      successful_completion: completed,
      completion_rate: completed ? 1 : 0,
      successful_attempts: successfulAttempts,
      attempt_completion_rate: attempts.length ? successfulAttempts / attempts.length : null,
      independently_accepted_current_revisions: [...accepted],
      accepted_outcomes: accepted.size,
      failed_attempts: workflow.attempts.filter((attempt) => attempt.status === 'failed').length,
      incomplete_attempts: workflow.attempts.filter((attempt) => attempt.status === 'running').length,
      elapsed_ms: {
        known_total: elapsedKnown,
        unknown_attempts: elapsedUnknown,
        unverified_attempts: unverifiedAttempts,
        per_accepted_outcome:
          accepted.size && !elapsedUnknown && !unverifiedAttempts ? elapsedKnown / accepted.size : null,
      },
      usage: Object.fromEntries(
        usageFields.map((field) => [
          field,
          {
            ...usage[field],
            attempts_without_invocation_usage: missingInvocations,
            unverified_attempts: unverifiedAttempts,
            per_accepted_outcome:
              accepted.size &&
              !missingInvocations &&
              !unverifiedAttempts &&
              usage[field]!.unknown_invocations === 0
                ? usage[field]!.known_total / accepted.size
                : null,
          },
        ]),
      ),
    };
    return {
      id: workflow.id,
      attempts,
      observed,
      simulated: {
        kind: 'simulated_policy',
        policy: 'repeat-read-cache-v1',
        avoided_calls: attempts.reduce(
          (sum, attempt) =>
            sum +
            attempt.invocations.reduce(
              (subtotal: number, invocation: any) => subtotal + invocation.retrieval.simulated_avoided_calls,
              0,
            ),
          0,
        ),
        stale_response_regressions: attempts.flatMap((attempt) =>
          attempt.invocations.flatMap((invocation: any) =>
            invocation.retrieval.stale_response_regressions.map((decision: any) => ({
              attempt_id: attempt.id,
              role: invocation.role,
              ...decision,
            })),
          ),
        ),
        completion_rate: null,
        elapsed_ms_per_accepted_outcome: null,
        usage_per_accepted_outcome: null,
        completion_regression_status: 'unmeasured_counterfactual',
      },
    };
  });
  return {
    workflows,
    summary: {
      workflows: workflows.length,
      successful_workflows: workflows.filter((workflow) => workflow.observed.successful_completion).length,
      completion_rate: workflows.length
        ? workflows.filter((workflow) => workflow.observed.successful_completion).length / workflows.length
        : null,
      independently_accepted_current_revisions: workflows.reduce(
        (sum, workflow) => sum + workflow.observed.accepted_outcomes,
        0,
      ),
    },
  };
}

/** Compare measured traces only; policy counterfactuals cannot establish measured improvement. */
export function compareReports(
  baseline: ReturnType<typeof replayReport>,
  candidate: ReturnType<typeof replayReport>,
) {
  const ids = new Set([...baseline.workflows, ...candidate.workflows].map((workflow) => workflow.id));
  return [...ids].map((id) => {
    const before = baseline.workflows.find((workflow) => workflow.id === id)?.observed;
    const after = candidate.workflows.find((workflow) => workflow.id === id)?.observed;
    const regressions: string[] = [],
      unknown: string[] = [];
    if (!before || !after) unknown.push('workflow_missing_from_one_trace');
    else {
      if (after.completion_rate < before.completion_rate) regressions.push('completion_rate');
      if (after.accepted_outcomes < before.accepted_outcomes) regressions.push('accepted_outcomes');
      if (after.failed_attempts > before.failed_attempts) regressions.push('failed_attempts');
      if (after.incomplete_attempts > before.incomplete_attempts) regressions.push('incomplete_attempts');
      if (after.attempt_completion_rate === null || before.attempt_completion_rate === null)
        unknown.push('attempt_completion_rate');
      else if (after.attempt_completion_rate < before.attempt_completion_rate)
        regressions.push('attempt_completion_rate');
      const metrics = [
        [
          'elapsed_ms_per_accepted_outcome',
          before.elapsed_ms.per_accepted_outcome,
          after.elapsed_ms.per_accepted_outcome,
        ],
        ...usageFields.map((field) => [
          `${field}_per_accepted_outcome`,
          before.usage[field]!.per_accepted_outcome,
          after.usage[field]!.per_accepted_outcome,
        ]),
      ] as [string, number | null, number | null][];
      for (const [name, oldValue, newValue] of metrics) {
        if (oldValue === null || newValue === null) unknown.push(name);
        else if (newValue > oldValue) regressions.push(name);
      }
    }
    return { id, baseline: before ?? null, candidate: after ?? null, regressions, unknown };
  });
}

async function loadRecorded(path: string) {
  const bytes = await readFile(path);
  const report = JSON.parse(bytes.toString('utf8'));
  validateReport(report);
  const contractPath = fileURLToPath(new URL('./fixtures/protocol-workflows.json', import.meta.url));
  const contractBytes = await readFile(contractPath);
  assert.equal(
    sha256(contractBytes),
    report.scenario_contract_sha256,
    'Frozen workflow contract hash mismatch.',
  );
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const sources = [
    { path: resolve(path), sha256: sha256(bytes), bytes_base64: bytes.toString('base64') },
    { path: contractPath, sha256: sha256(contractBytes), bytes_base64: contractBytes.toString('base64') },
  ];
  const authority: Record<string, Authority> = {};
  for (const workflow of report.workflows) {
    const definition = contract.workflows.find((item: any) => item.id === workflow.id);
    assert.ok(definition, `Unknown frozen workflow: ${workflow.id}.`);
    for (const attempt of workflow.attempts) {
      authority[`${workflow.id}/${attempt.id}`] = await revalidateAttempt(attempt, definition, contract);
      authority[`${workflow.id}/${attempt.id}`]!.observation_integrity = { raw_usage_verified: true };
      for (const role of ['worker', 'reviewer']) {
        const invocation = attempt.invocations.find((item: any) => item.role === role);
        const source = join(attempt.artifact_directory, `${role}.jsonl`);
        try {
          const raw = await readFile(source);
          sources.push({ path: resolve(source), sha256: sha256(raw), bytes_base64: raw.toString('base64') });
          assert.ok(invocation, 'Raw invocation has no retained report entry.');
          const parsed = parseCodexInvocation(raw.toString('utf8'), invocation.exit_code ?? null);
          // Raw starts, malformed tails and failures stay in sources; no attempt is repaired here.
          assert.deepEqual(parsed.calls, invocation.calls, 'Original report calls differ from raw trace.');
          assert.deepEqual(parsed.usage, invocation.usage, 'Original report usage differs from raw trace.');
        } catch (error) {
          if (!invocation && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          const proof = authority[`${workflow.id}/${attempt.id}`]!;
          proof.effective_status = 'failed';
          proof.observation_integrity!.raw_usage_verified = false;
          proof.errors.push(`Raw trace unavailable or inconsistent: ${String(error)}`);
        }
      }
    }
  }
  return { report, sources, replay: replayReport(report, authority) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      report: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
    },
  });
  assert.ok(
    values.report && values.out,
    'Provide --report RECORDED_REPORT --out NEW_PRIVATE_JSON [--baseline RECORDED_REPORT].',
  );
  const candidate = await loadRecorded(resolve(values.report));
  const baseline = values.baseline ? await loadRecorded(resolve(values.baseline)) : null;
  if (baseline) assertComparableReports(baseline.report, candidate.report);
  const result = {
    version: 1,
    provider_invocations_added: 0,
    policy_activation: 'recommendations_only',
    measurement: {
      observed:
        'Original attempt wall time and reported provider usage, including failed/incomplete attempts.',
      denominator:
        'Distinct authoritative current requirement revisions with passing delivery validation and independent accepted review.',
      elapsed: 'finished_at minus started_at per attempt; missing/interrupted intervals stay unknown.',
      simulated:
        'Repeat allowlisted requests within one invocation and across reads only; cached responses are checked against actual responses, including changed/rejected reads, and mismatches are per-workflow regressions.',
      limitations:
        'Replay establishes no counterfactual completion, elapsed time, provider/model savings, monetary cost or model ranking. Cached input is a subset of input usage, never added again.',
      model_evaluation:
        'Requires explicit budget and separate measured provider runs retaining their original artifacts and limitations; SELF-25 owns sustained private live evaluation.',
    },
    sources: [...candidate.sources, ...(baseline?.sources ?? [])],
    candidate: candidate.replay,
    baseline: baseline?.replay ?? null,
    comparison: baseline ? compareReports(baseline.replay, candidate.replay) : null,
  };
  await writeFile(resolve(values.out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      report: resolve(values.out),
      ...candidate.replay.summary,
      workflows: candidate.replay.workflows.map((workflow) => ({
        id: workflow.id,
        observed: workflow.observed,
        simulated: workflow.simulated,
      })),
      regressions: result.comparison?.filter((workflow) => workflow.regressions.length) ?? null,
      provider_invocations_added: 0,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
