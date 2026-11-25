import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import {
  assertComparableReports,
  compareReports,
  replayReport,
  replayRetrieval,
} from '../scripts/deterministic-replay.js';
import { parseCodexInvocation, usageFields } from '../scripts/real-client-observation.js';

const contract = JSON.parse(
  await readFile(new URL('../scripts/fixtures/protocol-workflows.json', import.meta.url), 'utf8'),
);
const read = (id: string, revision = 1, at = 0): any => ({
  id,
  tool: 'ticket_context',
  arguments: { project_id: 'project', ticket_id: 'ticket' },
  started: at,
  completed: at + 1,
  result: { structured_content: { ok: true, data: { requirements_revision: revision }, error: null } },
  envelope: { ok: true, data: { requirements_revision: revision }, error: null },
  error: null,
});
const usage = (value: number | null) => Object.fromEntries(usageFields.map((field) => [field, value]));
function report(id = contract.workflows[0].id, duration = 100, tokens: number | null = 10): any {
  return {
    models: { worker: 'fixture-model', reviewer: 'fixture-reviewer' },
    effort: 'high',
    workflows: [
      {
        id,
        attempts: [
          {
            id: 'attempt',
            status: 'completed',
            started_at: '2026-11-24T00:00:00.000Z',
            finished_at: new Date(Date.parse('2026-11-24T00:00:00.000Z') + duration).toISOString(),
            invocations: [
              {
                role: 'worker',
                success: true,
                errors: [],
                usage: usage(tokens),
                calls: [read('one'), read('two', 1, 2)],
              },
            ],
          },
        ],
      },
    ],
  };
}
function authority(id = contract.workflows[0].id, revision = 1): any {
  return {
    [`${id}/attempt`]: {
      attempt_id: 'attempt',
      effective_status: 'completed',
      errors: [],
      target: {
        project_id: 'project',
        ticket_id: 'ticket',
        requirements_revision: revision,
        worker_id: 'worker',
        reviewer_id: 'reviewer',
      },
      proofs: {
        authoritative_state: {
          status: 'done',
          requirements_revision: revision,
          submission_id: 'submission',
          independent_review: true,
        },
      },
    },
  };
}

it('replays identical reads deterministically and keeps exact original observations', () => {
  const source = report();
  const before = JSON.stringify(source);
  const frozen = (value: any) => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      Object.values(value).forEach(frozen);
    }
  };
  frozen(source);
  const one = replayReport(source, authority());
  assert.deepEqual(one, replayReport(source, authority()));
  assert.equal(JSON.stringify(source), before);
  assert.equal(one.workflows[0]!.simulated.avoided_calls, 1);
  assert.equal(one.workflows[0]!.observed.accepted_outcomes, 1);
  assert.equal(one.workflows[0]!.observed.elapsed_ms.per_accepted_outcome, 100);
  assert.equal(one.workflows[0]!.observed.usage.input_tokens!.per_accepted_outcome, 10);
  assert.equal(one.workflows[0]!.simulated.completion_rate, null);
  assert.equal(one.workflows[0]!.simulated.usage_per_accepted_outcome, null);
});

it('reports stale or rejected cached reads and invalidates across mutations, unknown operations and invocations', () => {
  const rejected = {
    ...read('denied', 1, 4),
    envelope: { ok: false, data: null, error: { code: 'ACCESS_DENIED' } },
  };
  const result = replayRetrieval([read('one'), read('changed', 2, 2), rejected]);
  assert.equal(result.simulated_avoided_calls, 0);
  assert.deepEqual(
    result.stale_response_regressions.map((item) => item.call_id),
    ['changed', 'denied'],
  );
  for (const tool of ['ticket_checkpoint', 'future_tool']) {
    const barrier = { ...read('barrier', 1, 2), tool };
    assert.equal(replayRetrieval([read('one'), barrier, read('two', 1, 4)]).simulated_avoided_calls, 0);
  }
  const source = report();
  source.workflows[0].attempts[0].invocations = [
    { role: 'worker', usage: usage(1), calls: [read('one')] },
    { role: 'reviewer', usage: usage(1), calls: [read('two')] },
  ];
  assert.equal(replayReport(source).workflows[0]!.simulated.avoided_calls, 0);
});

it('requires a completed prior response and rejects overlapping mutation or unknown timing', () => {
  const concurrent = [
    { ...read('two', 1, 1), completed: 2 },
    { ...read('one'), completed: 3 },
  ];
  assert.equal(replayRetrieval(concurrent).simulated_avoided_calls, 0);
  const overlappingMutation = [
    read('one'),
    read('two', 1, 3),
    { ...read('write', 1, 2), tool: 'ticket_checkpoint', completed: 6 },
  ];
  assert.equal(replayRetrieval(overlappingMutation).simulated_avoided_calls, 0);
  assert.equal(
    replayRetrieval([read('one'), { ...read('two', 1, 2), started: undefined }]).simulated_avoided_calls,
    0,
  );
});

it('retains failed, incomplete and rejected observations and never turns unknown usage into zero', () => {
  const source = report();
  source.workflows[0].attempts.push(
    {
      id: 'failed',
      status: 'failed',
      failure: 'approval rejected',
      started_at: '2026-11-24T00:00:01Z',
      finished_at: '2026-11-24T00:00:02Z',
      invocations: [
        {
          role: 'worker',
          success: false,
          errors: ['approval rejected'],
          usage: usage(null),
          calls: [{ ...read('rejected'), envelope: { ok: false, error: { code: 'APPROVAL_DENIED' } } }],
        },
      ],
    },
    { id: 'partial', status: 'running', invocations: [] },
  );
  const row = replayReport(source, authority()).workflows[0]!;
  assert.equal(row.attempts.length, 3);
  assert.equal(row.attempts[1]!.original_failure, 'approval rejected');
  assert.equal(row.observed.failed_attempts, 1);
  assert.equal(row.observed.incomplete_attempts, 1);
  assert.equal(row.observed.elapsed_ms.unknown_attempts, 1);
  assert.equal(row.observed.elapsed_ms.per_accepted_outcome, null);
  assert.equal(row.observed.usage.input_tokens!.known_total, 10);
  assert.equal(row.observed.usage.input_tokens!.unknown_invocations, 1);
  assert.equal(row.observed.usage.input_tokens!.attempts_without_invocation_usage, 1);
  assert.equal(row.observed.usage.input_tokens!.per_accepted_outcome, null);
  const partial = parseCodexInvocation(
    '{"type":"item.started","item":{"id":"unfinished","type":"mcp_tool_call","server":"ai-ticketing","tool":"ticket_context"}}\n{"type":',
    null,
  );
  assert.ok(partial.errors.length);
  assert.equal(partial.usage.input_tokens, null);
});

it('requires authoritative current revisions and independent acceptance rather than completed labels', () => {
  const source = report();
  assert.equal(replayReport(source).workflows[0]!.observed.accepted_outcomes, 0);
  for (const alter of [
    (proof: any) => proof.proofs.authoritative_state.requirements_revision++,
    (proof: any) => (proof.proofs.authoritative_state.independent_review = false),
    (proof: any) => (proof.target.reviewer_id = proof.target.worker_id),
    (proof: any) => (proof.effective_status = 'failed'),
    (proof: any) => proof.errors.push('missing evidence'),
  ]) {
    const proofs = authority();
    alter(Object.values(proofs)[0]);
    assert.equal(replayReport(source, proofs).workflows[0]!.observed.accepted_outcomes, 0);
  }
});

it('does not average unverified failed-attempt usage over a different accepted attempt', () => {
  const source = report();
  source.workflows[0].attempts.push({
    ...structuredClone(source.workflows[0].attempts[0]),
    id: 'failed',
    status: 'failed',
    failure: 'raw usage mismatch',
  });
  const proofs = authority();
  proofs[`${contract.workflows[0].id}/failed`] = {
    ...structuredClone(Object.values(proofs)[0] as any),
    effective_status: 'failed',
    errors: ['Raw usage differs'],
    observation_integrity: { raw_usage_verified: false },
  };
  const row = replayReport(source, proofs).workflows[0]!.observed;
  assert.equal(row.accepted_outcomes, 1);
  assert.equal(row.usage.input_tokens!.known_total, 20);
  assert.equal(row.usage.input_tokens!.unverified_attempts, 1);
  assert.equal(row.usage.input_tokens!.per_accepted_outcome, null);
  assert.equal(row.elapsed_ms.per_accepted_outcome, null);
});

it('shows every workflow regression even when another workflow improves', () => {
  const baseline = report('short', 100, 10),
    candidate = report('short', 200, 20);
  baseline.workflows.push(report('review', 1000, 100).workflows[0]);
  candidate.workflows.push(report('review', 100, 10).workflows[0]);
  const proofs = { ...authority('short'), ...authority('review') };
  const rows = compareReports(replayReport(baseline, proofs), replayReport(candidate, proofs));
  assert.ok(
    rows.find((row) => row.id === 'short')!.regressions.includes('input_tokens_per_accepted_outcome'),
  );
  assert.ok(rows.find((row) => row.id === 'short')!.regressions.includes('elapsed_ms_per_accepted_outcome'));
  assert.deepEqual(rows.find((row) => row.id === 'review')!.regressions, []);
  const unknown = compareReports(replayReport(baseline), replayReport(candidate));
  assert.ok(unknown[0]!.unknown.includes('input_tokens_per_accepted_outcome'));
});

it('rejects malformed provider usage at the trace boundary', () => {
  const source = report();
  source.workflows[0].attempts[0].invocations[0].usage.input_tokens = -1;
  assert.throws(() => replayReport(source), /Invalid reported usage/);
});

it('flags added failures even when eventual completion is unchanged and usage is unknown', () => {
  const baseline = report('review'),
    candidate = report('review', 100, null);
  candidate.workflows[0].attempts.push(
    { id: 'rejected', status: 'failed', invocations: [] },
    { id: 'interrupted', status: 'running', invocations: [] },
  );
  const rows = compareReports(
    replayReport(baseline, authority('review')),
    replayReport(candidate, authority('review')),
  );
  assert.equal(rows[0]!.candidate!.completion_rate, 1);
  assert.ok(rows[0]!.regressions.includes('failed_attempts'));
  assert.ok(rows[0]!.regressions.includes('incomplete_attempts'));
  assert.ok(rows[0]!.regressions.includes('attempt_completion_rate'));
});

it('rejects different effective role effort and workload identities even when model names match', () => {
  const baseline = report();
  assertComparableReports(baseline, report());
  for (const alter of [
    (source: any) => (source.effort = 'xhigh'),
    (source: any) => (source.efforts = { worker: 'xhigh' }),
    (source: any) => (source.workflows[0].attempts[0].invocations[0].reasoning_effort = 'xhigh'),
    (source: any) => (source.runtime_revision = 'different-runtime'),
    (source: any) => (source.client_version = 'different-client'),
    (source: any) => (source.fixture_server_sha256 = 'different-fixture'),
    (source: any) => (source.prompt_layout = 'different-prompt'),
    (source: any) => (source.measurement = { scope: 'different-scope' }),
    (source: any) =>
      (source.workflows[0].attempts[0].measurement_source_sha256 = { prefix: 'different-source' }),
  ]) {
    const source = report();
    alter(source);
    assert.throws(() => assertComparableReports(baseline, source), /identical recorded models, efforts/);
  }
});

it('writes exact source snapshots without overwriting outputs and exposes no provider option', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deterministic-replay-'));
  const options = {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '' },
  } as const;
  const source = join(directory, 'source.json'),
    destination = join(directory, 'replay.json');
  const contractBytes = await readFile(
    new URL('../scripts/fixtures/protocol-workflows.json', import.meta.url),
  );
  const original =
    JSON.stringify({
      workflows: [],
      scenario_contract_sha256: createHash('sha256').update(contractBytes).digest('hex'),
    }) + '\n';
  await writeFile(source, original);
  try {
    const args = [
      '--import',
      'tsx',
      'scripts/deterministic-replay.ts',
      '--report',
      source,
      '--out',
      destination,
    ];
    const run = spawnSync(process.execPath, args, options);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(await readFile(destination, 'utf8'));
    assert.equal(result.provider_invocations_added, 0);
    assert.equal(result.policy_activation, 'recommendations_only');
    assert.equal(Buffer.from(result.sources[0].bytes_base64, 'base64').toString('utf8'), original);
    assert.equal(await readFile(source, 'utf8'), original);
    const output = await readFile(destination, 'utf8');
    assert.notEqual(spawnSync(process.execPath, args, options).status, 0);
    assert.equal(await readFile(destination, 'utf8'), output);
    const rejected = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/deterministic-replay.ts', '--model', 'fixture'],
      options,
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unknown option '--model'/);
  } finally {
    await unlink(source);
    await unlink(destination).catch(() => {});
    await rmdir(directory);
  }
});
