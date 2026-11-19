import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  parseCodexInvocation,
  validateRole,
  aggregateUsage,
  codexArguments,
  createMaintenanceLedger,
  parsePartialMaintenanceLedger,
} from '../scripts/real-client-observation.js';

const contract = JSON.parse(
  await readFile(new URL('../scripts/fixtures/protocol-workflows.json', import.meta.url), 'utf8'),
);
const workflow = contract.workflows.find((item: any) => item.id === 'short');
const expected: any = {
  workflow,
  contract,
  project: { id: 'project' },
  ticket: { id: 'ticket' },
  description: contract.project.description,
  workerId: 'worker',
  reviewerId: 'reviewer',
};
const context = {
  ticket: { id: 'ticket', description: expected.description, revision: 2, requirements_revision: 1 },
  criteria: [{ id: 'criterion-from-model-response', text: contract.project.criterion }],
  project_instructions: { text: contract.project.instructions },
  approval_policy: 'self',
  blockers: [],
  dependencies: [],
  omitted: [],
};
const progress = `${expected.description} ${contract.project.instructions.split('. ')[0]}. approval_policy=self`;
function trace(entries: { id: string; tool: string; arguments?: any; data?: any; error?: string }[]) {
  const events: any[] = [];
  for (const entry of entries) {
    events.push({
      type: 'item.started',
      item: {
        id: entry.id,
        type: 'mcp_tool_call',
        server: 'ai-ticketing',
        tool: entry.tool,
        arguments: entry.arguments ?? {},
      },
    });
    events.push({
      type: 'item.completed',
      item: {
        id: entry.id,
        type: 'mcp_tool_call',
        server: 'ai-ticketing',
        tool: entry.tool,
        arguments: entry.arguments ?? {},
        result: {
          structured_content: {
            ok: !entry.error,
            data: entry.data ?? null,
            error: entry.error ? { code: entry.error } : null,
          },
        },
        status: 'completed',
      },
    });
  }
  events.push({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 },
  });
  return events;
}
const encode = (events: any[]) => events.map((event) => JSON.stringify(event)).join('\n');
const completed = () =>
  trace([
    {
      id: 'claim',
      tool: 'work_claim',
      data: { ticket: context.ticket, context, claim: { token: 'fixture-token' } },
    },
    {
      id: 'checkpoint',
      tool: 'ticket_checkpoint',
      arguments: { progress, decisions: [] },
      data: { ticket: { id: 'ticket', revision: 3 } },
    },
    {
      id: 'submit',
      tool: 'ticket_submit',
      arguments: {
        evidence: [
          {
            criterion_id: context.criteria[0].id,
            result: 'pass',
            summary: 'Prepared fixture observation.',
            references: ['https://example.test/evidence'],
          },
        ],
      },
      data: { ticket: { id: 'ticket', status: 'done' } },
    },
  ]);

it('parses actual Codex event names and counts cumulative usage once per invocation', () => {
  const events = completed();
  const observation = parseCodexInvocation(encode(events), 0);
  assert.equal(observation.calls.length, 3);
  assert.equal(observation.usage.input_tokens, 100);
  assert.equal(observation.usage.cached_input_tokens, 40);
  assert.equal(observation.usage.cache_write_input_tokens, null);
  assert.equal(validateRole(observation, 'worker', expected).success, true);
  const duplicate = events.slice();
  duplicate.splice(2, 0, events[1]);
  const deduplicated = parseCodexInvocation(encode(duplicate), 0);
  assert.equal(deduplicated.calls.length, 3);
  assert.equal(deduplicated.duplicate_completion_events, 1);
  assert.equal(deduplicated.usage.input_tokens, 100);
});
it('keeps failed invocation usage and unknown or malformed terminal data explicit', () => {
  const failure = parseCodexInvocation(
    encode([
      {
        type: 'turn.failed',
        error: { message: 'Requested model unavailable.' },
        usage: { input_tokens: 12, output_tokens: 2 },
      },
    ]),
    1,
  );
  assert.equal(failure.usage.input_tokens, 12);
  assert.ok(failure.errors.some((error) => error.includes('Requested model unavailable')));
  const absent = parseCodexInvocation('{bad JSON}\n' + encode([{ type: 'turn.started' }]), 1);
  assert.equal(absent.usage.input_tokens, null);
  assert.ok(absent.errors.length >= 3);
  const totals: any = aggregateUsage([failure, parseCodexInvocation(encode(completed()), 0), absent]);
  assert.deepEqual(totals.input_tokens, { known_total: 112, unknown_invocations: 1 });
  assert.deepEqual(totals.cached_input_tokens, { known_total: 40, unknown_invocations: 2 });
});
it('checks required delivery before attempted mutation start rather than completion', () => {
  const events = completed();
  const checkpointStart = events[2];
  events.splice(2, 1);
  events.splice(1, 0, checkpointStart);
  const result = validateRole(parseCodexInvocation(encode(events), 0), 'worker', expected);
  assert.equal(result.success, false);
  assert.ok(result.errors.some((error) => error.includes('ticket_checkpoint started before receiving')));
  events[3].item.result.structured_content = { ok: false, data: null, error: { code: 'CLAIM_EXPIRED' } };
  assert.equal(validateRole(parseCodexInvocation(encode(events), 0), 'worker', expected).success, false);
});
it('does not launder sidecar responses or fixture-only facts into model delivery', () => {
  const events = completed();
  events[1].item.result.structured_content.data = {
    ticket: { id: 'ticket', revision: 2 },
    claim: { token: 'fixture-token' },
  };
  events.unshift({
    consumer: 'maintenance',
    ...trace([{ id: 'sidecar', tool: 'ticket_get', data: context }])[1],
  });
  const observation = parseCodexInvocation(encode(events), 0);
  assert.ok(observation.errors.some((error) => error.includes('Non-model observations')));
  assert.equal(validateRole(observation, 'worker', expected).success, false);
});
it('requires action acknowledgements beyond pre-presentation result logs', () => {
  const events = completed();
  events[2].item.arguments.progress = 'Done without quoting received facts.';
  events[3].item.arguments.progress = events[2].item.arguments.progress;
  const result = validateRole(parseCodexInvocation(encode(events), 0), 'worker', expected);
  assert.equal(result.success, false);
  assert.ok(
    result.errors.some((error) => error.includes('model_requirement_instruction_policy_acknowledgement')),
  );
});
it('fully overrides the live server identity and disables auxiliary tool surfaces', () => {
  const args = codexArguments({
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    cwd: 'C:/temp/empty-model-workspace',
    node: 'C:/node24/node.exe',
    server: 'C:/repo/.local/run/server.mjs',
    config: 'C:/repo/.local/run/worker-fixture.json',
    database: 'C:/repo/.local/run/fixture.sqlite',
    actor: 'new-fixture-actor',
  });
  for (const flag of [
    '--ignore-user-config',
    '--ephemeral',
    '--strict-config',
    'tool_output_token_limit=32768',
  ])
    assert.ok(args.includes(flag));
  for (const feature of ['plugins', 'shell_tool', 'unified_exec'])
    assert.ok(args.some((item, index) => item === '--disable' && args[index + 1] === feature));
  const override = args.find((item) => item.startsWith('mcp_servers='))!;
  for (const value of [
    '"ai-ticketing"',
    'new-fixture-actor',
    'fixture.sqlite',
    '"EMBEDDING_PROVIDER" = "none"',
  ])
    assert.ok(override.includes(value));
  assert.ok(!override.includes('roadmap.sqlite'));
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!args.includes('approval_policy="never"'));
  assert.ok(!override.includes('approval_mode'));
  assert.equal(args.at(-1), '-');
});

it('distinguishes a never-policy denial from an unclassified approval error and keeps review usage unknown', () => {
  const events = trace([{ id: 'claim', tool: 'work_claim' }]);
  events[1].item.result = null;
  events[1].item.error = { message: 'MCP tool call requires approval, but approval policy is never' };
  const denied = parseCodexInvocation(encode(events), 0);
  assert.equal(denied.approval_denials[0].classification, 'client_approval_policy_never_before_review');
  assert.deepEqual(denied.approval_review_usage, { status: 'not_separately_reported_by_cli', usage: null });
  assert.equal(denied.usage.input_tokens, 100);
  events[1].item.error = { message: 'Approval rejected by configured reviewer' };
  assert.equal(
    parseCodexInvocation(encode(events), 0).approval_denials[0].classification,
    'client_approval_error_unclassified',
  );
});

it('retains sidecar records immediately and marks interrupted evidence counts unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-maintenance-test-'));
  const path = join(directory, 'maintenance.jsonl');
  const record = createMaintenanceLedger(path);
  record('wire', {
    consumer: 'maintenance',
    direction: 'outgoing',
    message: { id: 1, method: 'tools/call' },
  });
  record('call', { consumer: 'maintenance', operation: 'work_heartbeat', error: 'interrupted' });
  assert.throws(() => createMaintenanceLedger(path), /EEXIST/);
  const recovered = parsePartialMaintenanceLedger((await readFile(path, 'utf8')) + '{partial');
  assert.equal(recovered.wire.length, 1);
  assert.equal(recovered.calls.length, 1);
  assert.equal(recovered.evidence_complete, false);
  assert.equal(recovered.reference, null);
  assert.equal(recovered.rpc_round_trips, null);
  assert.equal(recovered.errors.length, 1);
  assert.equal(parsePartialMaintenanceLedger('').completed_intervals, null);
});

it('requires the reviewer to receive current evidence through its own model channel', () => {
  const reviewExpected = { ...expected, workflow: { ...workflow, policy: 'independent', review: true } };
  const evidence = {
    id: 'actual-submission',
    actor_id: 'worker',
    requirements_revision: 1,
    ticket_revision: 3,
    evidence: [
      {
        criterion_id: context.criteria[0].id,
        result: 'pass',
        summary: 'Prepared owner and outsider observations.',
        references: ['https://example.test/evidence'],
      },
    ],
  };
  const reviewContext = { ...context, approval_policy: 'independent', submissions: [evidence] };
  const events = trace([
    { id: 'context', tool: 'ticket_context', data: reviewContext },
    {
      id: 'review',
      tool: 'ticket_review',
      arguments: {
        submission_id: evidence.id,
        feedback: `Checked ${context.criteria[0].id} at https://example.test/evidence`,
      },
      data: { ticket: { id: 'ticket', status: 'done' } },
    },
  ]);
  assert.equal(
    validateRole(parseCodexInvocation(encode(events), 0), 'reviewer', reviewExpected).success,
    true,
  );
  events[1].item.result.structured_content.data = { ...reviewContext, submissions: [] };
  const rejected = validateRole(parseCodexInvocation(encode(events), 0), 'reviewer', reviewExpected);
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.includes('current_submission_evidence')));
});

it('requires complete exact reviewer evidence and all review omission pages before acceptance', () => {
  const reviewExpected = { ...expected, workflow: { ...workflow, policy: 'independent', review: true } };
  const submission = {
    id: 'submission',
    actor_id: 'worker',
    requirements_revision: 1,
    ticket_revision: 3,
    evidence: [
      {
        criterion_id: context.criteria[0].id,
        result: 'pass',
        summary: 'Observed both responses.',
        references: ['https://example.test/evidence'],
      },
    ],
  };
  const args = { project_id: 'project', ticket_id: 'ticket', kind: 'reviews', limit: 1 };
  const review = {
    id: 'review',
    tool: 'ticket_review',
    arguments: {
      submission_id: submission.id,
      decision: 'approve',
      feedback: `Checked ${context.criteria[0].id} at https://example.test/evidence`,
    },
    data: {},
  };
  const packet = {
    ...context,
    approval_policy: 'independent',
    submissions: [submission],
    omitted: [{ retrieve_with: 'ticket_history', arguments: args, required_before: 'review' }],
  };
  const check = (entries: any[]) =>
    validateRole(parseCodexInvocation(encode(trace(entries)), 0), 'reviewer', reviewExpected);
  const received = [{ id: 'context', tool: 'ticket_context', data: packet }];
  assert.equal(check([...received, review]).success, false);
  const first = {
    id: 'page1',
    tool: 'ticket_history',
    arguments: args,
    data: { items: [{ id: 'rejection', decision: 'request_changes' }], has_more: true },
  };
  assert.equal(check([...received, first, review]).success, false);
  const terminal = {
    id: 'page2',
    tool: 'ticket_history',
    arguments: { ...args, offset: 1 },
    data: { items: [], has_more: false },
  };
  assert.equal(check([...received, first, terminal, review]).success, true);
  assert.equal(
    check([...received, { ...terminal, arguments: { ...terminal.arguments, kind: 'notes' } }, review])
      .success,
    false,
  );
  for (const evidence of [
    [],
    [submission.evidence[0], submission.evidence[0]],
    [{ ...submission.evidence[0], summary: '' }],
    [{ ...submission.evidence[0], references: [''] }],
    [{ ...submission.evidence[0], result: 'fail' }],
  ])
    assert.equal(
      check([
        { ...received[0], data: { ...packet, omitted: [], submissions: [{ ...submission, evidence }] } },
        review,
      ]).success,
      false,
    );
  assert.equal(
    check([{ ...received[0], data: { fingerprint: 'cached-worker-success', not_modified: true } }, review])
      .success,
    false,
  );
  assert.equal(
    check([
      {
        ...received[0],
        data: { ...packet, omitted: [], review_blockers: [{ code: 'GITHUB_EVIDENCE_UNVERIFIED' }] },
      },
      review,
    ]).success,
    false,
  );
});

it('requires all exact native artifact bytes with stable size and hashes, retaining unavailable evidence', () => {
  const reviewExpected = { ...expected, workflow: { ...workflow, policy: 'independent', review: true } };
  const artifact =
    'execution:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:result';
  const bytes = Buffer.from(
    JSON.stringify({
      exit_code: 0,
      verification: {
        status: 'passed',
        error_code: null,
        cleanup_verified: true,
        steps: [{ status: 'passed', exit_code: 0, signal: null, error_code: null, blocked_by: [] }],
      },
    }),
  );
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const args = { project_id: 'project', artifact_id: artifact, offset: 0, length: 65536, max_tokens: 8192 };
  const submission = {
    id: 'submission',
    actor_id: 'worker',
    requirements_revision: 1,
    ticket_revision: 3,
    evidence: [
      {
        criterion_id: context.criteria[0].id,
        result: 'pass',
        summary: 'Worker reports success.',
        references: [artifact],
      },
    ],
  };
  const initial = {
    id: 'context',
    tool: 'ticket_context',
    data: {
      ...context,
      approval_policy: 'independent',
      submissions: [submission],
      omitted: [{ retrieve_with: 'artifact_read', arguments: args, required_before: 'review' }],
    },
  };
  const review = {
    id: 'review',
    tool: 'ticket_review',
    arguments: {
      submission_id: submission.id,
      decision: 'approve',
      feedback: `Checked ${context.criteria[0].id} at ${artifact}`,
    },
    data: {},
  };
  const page = (offset: number, end: number) => ({
    id: `artifact-${offset}`,
    tool: 'artifact_read',
    arguments: { ...args, offset },
    data: {
      artifact_id: artifact,
      status: 'available',
      size_bytes: bytes.length,
      total_bytes: bytes.length,
      omitted_bytes: 0,
      truncated: false,
      sha256: hash(bytes),
      range: {
        offset,
        returned_length: end - offset,
        data: bytes.subarray(offset, end).toString('base64'),
        sha256: hash(bytes.subarray(offset, end)),
        complete: true,
      },
    },
  });
  const check = (entries: any[]) =>
    validateRole(parseCodexInvocation(encode(trace(entries)), 0), 'reviewer', reviewExpected);
  assert.equal(check([initial, page(0, 8), review]).success, false);
  assert.equal(check([initial, page(0, 8), page(8, bytes.length), review]).success, true);
  const failed = page(0, bytes.length),
    failure = Buffer.from('{"exit_code":7,"verification":{"status":"failed"}}');
  failed.data = {
    ...failed.data,
    size_bytes: failure.length,
    total_bytes: failure.length,
    sha256: hash(failure),
    range: {
      ...failed.data.range,
      returned_length: failure.length,
      data: failure.toString('base64'),
      sha256: hash(failure),
    },
  };
  assert.equal(check([initial, failed, review]).success, false);
  const wrong = page(8, bytes.length);
  wrong.data.sha256 = '0'.repeat(64);
  assert.equal(check([initial, page(0, 8), wrong, review]).success, false);
  const unavailable = {
    id: 'missing',
    tool: 'artifact_read',
    arguments: args,
    data: { artifact_id: artifact, status: 'expired' },
  };
  assert.equal(check([initial, unavailable, review]).success, false);
  assert.equal(
    check([
      initial,
      unavailable,
      { ...review, arguments: { ...review.arguments, decision: 'request_changes' } },
    ]).success,
    true,
  );
});

it('refuses independent acceptance of missing, stale, failed or wrong-origin exact GitHub checks', () => {
  const reviewExpected = { ...expected, workflow: { ...workflow, policy: 'independent', review: true } };
  const sha = 'a'.repeat(40);
  const submission = {
    id: 'submission',
    actor_id: 'worker',
    requirements_revision: 1,
    ticket_revision: 3,
    evidence: [
      {
        criterion_id: context.criteria[0].id,
        result: 'pass',
        summary: 'Observed both responses.',
        references: ['https://example.test/evidence'],
      },
    ],
  };
  const github = {
    repository: 'owner/repo',
    pull_request_number: 7,
    status: 'passed',
    stale: false,
    requirements_revision: 1,
    head_sha: sha,
    observed_head_sha: sha,
    checks: [
      {
        app_id: 42,
        required_app_id: 42,
        run_id: 123,
        head_sha: sha,
        status: 'completed',
        conclusion: 'success',
      },
    ],
  };
  const check = (evidence: any) =>
    validateRole(
      parseCodexInvocation(
        encode(
          trace([
            {
              id: 'context',
              tool: 'ticket_context',
              data: {
                ...context,
                ticket: { ...context.ticket, github_pull_request: { repository: 'owner/repo', number: 7 } },
                approval_policy: 'independent',
                submissions: [submission],
                github_evidence: evidence,
              },
            },
            {
              id: 'review',
              tool: 'ticket_review',
              arguments: {
                submission_id: submission.id,
                decision: 'approve',
                feedback: `Checked ${context.criteria[0].id} at https://example.test/evidence`,
              },
              data: {},
            },
          ]),
        ),
        0,
      ),
      'reviewer',
      reviewExpected,
    );
  assert.equal(check(github).success, true);
  for (const evidence of [
    undefined,
    { ...github, stale: true },
    { ...github, status: 'failed' },
    { ...github, checks: [] },
    { ...github, observed_head_sha: 'b'.repeat(40) },
    { ...github, requirements_revision: 2 },
    { ...github, checks: [{ ...github.checks[0], app_id: 99 }] },
    { ...github, checks: [{ ...github.checks[0], head_sha: 'b'.repeat(40) }] },
    { ...github, checks: [{ ...github.checks[0], conclusion: 'failure' }] },
  ])
    assert.equal(check(evidence).success, false);
});

it('derives native reads from exact submission history without a packet and reconciles the actual report', () => {
  const reviewExpected = { ...expected, workflow: { ...workflow, policy: 'independent', review: true } };
  const artifact =
    'execution:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:result';
  const submission = {
    id: 'submission',
    ticket_id: 'ticket',
    project_id: 'project',
    actor_id: 'worker',
    requirements_revision: 1,
    ticket_revision: 3,
    evidence: [
      {
        criterion_id: context.criteria[0].id,
        result: 'pass',
        summary: 'Worker claims every step passed.',
        references: [artifact],
      },
    ],
  };
  const readArgs = { project_id: 'project', artifact_id: artifact, offset: 0, length: 65536 };
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const passed = {
    exit_code: 0,
    signal: null,
    error_code: null,
    verification: {
      status: 'passed',
      error_code: null,
      cleanup_verified: true,
      steps: [{ status: 'passed', exit_code: 0, signal: null, error_code: null, blocked_by: [] }],
    },
  };
  const read = (report: any, offset = 0, end?: number) => {
    const bytes = Buffer.from(JSON.stringify(report)),
      range = bytes.subarray(offset, end ?? bytes.length);
    return {
      id: `artifact-${offset}`,
      tool: 'artifact_read',
      arguments: { ...readArgs, offset },
      data: {
        artifact_id: artifact,
        status: 'available',
        size_bytes: bytes.length,
        total_bytes: bytes.length,
        truncated: false,
        omitted_bytes: 0,
        sha256: hash(bytes),
        range: { offset, returned_length: range.length, data: range.toString('base64'), sha256: hash(range) },
      },
    };
  };
  const initial = [
    {
      id: 'project',
      tool: 'project_get',
      data: {
        project: { id: 'project', instructions: contract.project.instructions, policy: 'independent' },
      },
    },
    {
      id: 'ticket',
      tool: 'ticket_get',
      data: { ticket: context.ticket, criteria: context.criteria, blockers: [], links: [] },
    },
    {
      id: 'submission',
      tool: 'ticket_history',
      arguments: { project_id: 'project', ticket_id: 'ticket', kind: 'submissions', item_id: submission.id },
      data: { items: [submission] },
    },
  ];
  const review = {
    id: 'review',
    tool: 'ticket_review',
    arguments: {
      submission_id: submission.id,
      decision: 'approve',
      feedback: `Checked ${context.criteria[0].id} at ${artifact}`,
    },
    data: {},
  };
  const check = (entries: any[]) =>
    validateRole(parseCodexInvocation(encode(trace(entries)), 0), 'reviewer', reviewExpected);
  const missing = check([...initial, review]);
  assert.equal(missing.success, false);
  assert.ok(missing.proofs[0].missing.includes('submitted_artifact_bytes'));
  assert.equal(check([...initial, read(passed, 0, 8), review]).success, false);
  assert.equal(check([...initial, read(passed, 0, 8), read(passed, 8), review]).success, true);
  assert.equal(check([initial[0], initial[1], read(passed), initial[2], review]).success, false);
  for (const report of [
    { ...passed, exit_code: 7 },
    { ...passed, verification: { ...passed.verification, cleanup_verified: false } },
    { ...passed, verification: { ...passed.verification, status: 'failed' } },
    {
      ...passed,
      verification: {
        ...passed.verification,
        steps: [{ ...passed.verification.steps[0], status: 'failed', exit_code: 7 }],
      },
    },
    { ...passed, verification: { ...passed.verification, steps: [] } },
  ]) {
    const rejected = check([...initial, read(report), review]);
    assert.equal(rejected.success, false);
    assert.deepEqual(rejected.proofs[0].artifacts.unverified, [artifact]);
  }
  const failure = read({ ...passed, exit_code: 7 });
  assert.equal(
    check([
      ...initial,
      failure,
      { ...review, arguments: { ...review.arguments, decision: 'request_changes' } },
    ]).success,
    true,
  );
  const corrupt = read(passed);
  corrupt.data.range.sha256 = '0'.repeat(64);
  assert.equal(check([...initial, corrupt, review]).success, false);
  const foreign = read(passed);
  foreign.arguments.project_id = 'other-project';
  assert.equal(check([...initial, foreign, review]).success, false);
});

it('counts identical mutation retries separately from repeated reads and fresh keys', () => {
  const events = trace([
    {
      id: 'one',
      tool: 'work_heartbeat',
      arguments: { idempotency_key: 'same-key', claim_token: 'token' },
      error: 'INTERNAL_ERROR',
    },
    {
      id: 'two',
      tool: 'work_heartbeat',
      arguments: { idempotency_key: 'same-key', claim_token: 'token' },
      data: {},
    },
    {
      id: 'three',
      tool: 'work_heartbeat',
      arguments: { idempotency_key: 'fresh-key', claim_token: 'token' },
      data: {},
    },
    { id: 'read1', tool: 'ticket_context', arguments: { ticket_id: 'ticket' }, data: {} },
    { id: 'read2', tool: 'ticket_context', arguments: { ticket_id: 'ticket' }, data: {} },
  ]);
  const observation = parseCodexInvocation(encode(events), 0);
  assert.equal(observation.identical_mutation_retries, 1);
  assert.equal(observation.provider_retry_count, null);
  assert.equal(observation.calls.length, 5);
});

it('checks the authoritative stored long description after production trims fixture input', () => {
  const input = contract.project.long_description_paragraph.repeat(
    contract.project.long_description_repetitions,
  );
  const ticket = { ...context.ticket, description: input.trim() };
  assert.notEqual(input, ticket.description);
  const longExpected = { ...expected, ticket, description: ticket.description };
  const events = completed();
  events[1].item.result.structured_content.data = {
    ticket,
    context: { ...context, ticket },
    claim: { token: 'fixture-token' },
  };
  const last = 'Preserve useful error handling and avoid disclosing project data when access is denied.';
  events[2].item.arguments.progress = `${last} ${contract.project.instructions.split('. ')[0]}. approval_policy=self`;
  assert.equal(validateRole(parseCodexInvocation(encode(events), 0), 'worker', longExpected).success, true);
  assert.equal(
    validateRole(parseCodexInvocation(encode(events), 0), 'worker', { ...longExpected, description: input })
      .success,
    false,
  );
});

it('retains consumed resume facts when a new checkpoint replaces the latest checkpoint', () => {
  const resumeExpected = { ...expected, workflow: { ...workflow, resume_checkpoint: true } };
  const initial = {
    ticket_id: 'ticket',
    ticket_revision: 1,
    metadata: {
      decisions: contract.project.checkpoint_decisions,
      remaining: contract.project.checkpoint_remaining,
    },
  };
  const entries: any[] = [
    {
      id: 'claim',
      tool: 'work_claim',
      data: {
        ticket: context.ticket,
        context: { ...context, latest_checkpoint: initial },
        claim: { token: 'fixture-token' },
      },
    },
    {
      id: 'checkpoint',
      tool: 'ticket_checkpoint',
      arguments: { progress, decisions: contract.project.checkpoint_decisions },
      data: { ticket: { id: 'ticket', revision: 3 } },
    },
    {
      id: 'refreshed',
      tool: 'ticket_context',
      data: {
        ...context,
        latest_checkpoint: {
          ...initial,
          ticket_revision: 3,
          metadata: {
            decisions: contract.project.checkpoint_decisions,
            remaining: ['Submit current evidence.'],
          },
        },
      },
    },
    {
      id: 'submit',
      tool: 'ticket_submit',
      arguments: { evidence: [{ criterion_id: context.criteria[0].id }] },
      data: { ticket: { id: 'ticket', status: 'done' } },
    },
  ];
  assert.equal(
    validateRole(parseCodexInvocation(encode(trace(entries)), 0), 'worker', resumeExpected).success,
    true,
  );
  entries[0].data.context.latest_checkpoint = null as any;
  assert.equal(
    validateRole(parseCodexInvocation(encode(trace(entries)), 0), 'worker', resumeExpected).success,
    false,
  );
});

it('keeps target facts across prerequisite reads and never substitutes other-ticket facts', () => {
  const blockedContext = {
    ...context,
    blockers: [{ code: 'QUESTION_BLOCKED', reference: 'actual-question' }],
    dependencies: [{ source_id: 'prerequisite' }],
  };
  const unrelated = {
    ticket: { ...context.ticket, id: 'prerequisite', description: 'Other requirements.' },
    criteria: [{ id: 'other-criterion', text: 'Other criterion.' }],
    blockers: [],
    links: [],
  };
  const events = completed();
  events[1].item.result.structured_content.data.context = blockedContext;
  const extra = trace([
    { id: 'prerequisite', tool: 'ticket_get', data: unrelated },
    {
      id: 'answer',
      tool: 'ticket_note',
      arguments: { kind: 'answer', answer_to: 'actual-question' },
      data: { ticket: { id: 'ticket', revision: 3 } },
    },
  ]).slice(0, -1);
  events.splice(2, 0, ...extra);
  const scopedExpected = { ...expected, prerequisiteId: 'prerequisite' };
  assert.equal(validateRole(parseCodexInvocation(encode(events), 0), 'worker', scopedExpected).success, true);
  events[1].item.result.structured_content.data = {
    ticket: unrelated.ticket,
    context: { ...blockedContext, ticket: unrelated.ticket },
    claim: { token: 'fixture-token' },
  };
  const rejected = validateRole(parseCodexInvocation(encode(events), 0), 'worker', scopedExpected);
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.includes('requirements')));
});

it('invalidates stale requirement facts when a newer revision is observed without its full contents', () => {
  const events = completed();
  events.splice(
    2,
    0,
    ...trace([
      {
        id: 'new-revision',
        tool: 'ticket_get',
        data: { ticket: { id: 'ticket', requirements_revision: 2, revision: 4 } },
      },
    ]).slice(0, -1),
  );
  const rejected = validateRole(parseCodexInvocation(encode(events), 0), 'worker', expected);
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.includes('requirements')));
});

it('accepts an exact checkpoint_get follow-up identified by checkpoint ID and returned ticket ownership', () => {
  const events = completed();
  const note = {
    id: 'checkpoint-from-omission',
    project_id: 'project',
    ticket_id: 'ticket',
    ticket_revision: 1,
    metadata: {
      decisions: contract.project.checkpoint_decisions,
      remaining: contract.project.checkpoint_remaining,
    },
  };
  events.splice(
    2,
    0,
    ...trace([
      {
        id: 'follow-up',
        tool: 'checkpoint_get',
        arguments: { project_id: 'project', checkpoint_id: note.id },
        data: note,
      },
    ]).slice(0, -1),
  );
  events[4].item.arguments.decisions = contract.project.checkpoint_decisions;
  const resumeExpected = { ...expected, workflow: { ...workflow, resume_checkpoint: true } };
  assert.equal(validateRole(parseCodexInvocation(encode(events), 0), 'worker', resumeExpected).success, true);
  events[3].item.result.structured_content.data = { ...note, ticket_id: 'other-ticket' };
  assert.equal(
    validateRole(parseCodexInvocation(encode(events), 0), 'worker', resumeExpected).success,
    false,
  );
});

it('never carries old blockers or resume evidence into a newer requirement revision', () => {
  const events = completed();
  const initial = {
    ticket_id: 'ticket',
    ticket_revision: 1,
    metadata: {
      decisions: contract.project.checkpoint_decisions,
      remaining: contract.project.checkpoint_remaining,
    },
  };
  events[1].item.result.structured_content.data.context = { ...context, latest_checkpoint: initial };
  const replacement = {
    ...context,
    ticket: { ...context.ticket, requirements_revision: 2, revision: 4 },
    criteria: [],
  };
  events.splice(
    2,
    0,
    ...trace([
      { id: 'replacement', tool: 'ticket_get', data: { ticket: replacement.ticket } },
      { id: 'old-context', tool: 'ticket_context', data: { ...context, latest_checkpoint: initial } },
    ]).slice(0, -1),
  );
  const result = validateRole(parseCodexInvocation(encode(events), 0), 'worker', {
    ...expected,
    workflow: { ...workflow, resume_checkpoint: true },
  });
  assert.equal(result.success, false);
  assert.ok(
    result.proofs.every(
      (proof) =>
        proof.missing.includes('requirements') &&
        proof.missing.includes('blockers_dependencies') &&
        proof.missing.includes('resume_decisions'),
    ),
  );
});
