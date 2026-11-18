import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
