import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { getEncoding } from 'js-tiktoken';
import { modelReview, ReviewLaunchError } from '../examples/review-dispatch.mjs';
import { createApplication } from '../src/application.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createMcpServer } from '../src/mcp.js';
import { fixture } from '../src/testing/contracts.js';
import { createReviewFixture } from './fixtures/review-fixture.mjs';
import {
  inspectReviewPacket,
  mockReviewDecision,
  reconstructReviewInput,
  scoreReviewDecision,
} from './review-benchmark.mjs';

export const lifecycleScenarios = ['missing-evidence', 'comment-blocker', 'wrong-header', 'provider-retry'];
const encoding = getEncoding('o200k_base');
const tokens = (text) => encoding.encode(text, [], []).length;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clock = new Date('2030-01-01T00:00:00.000Z');

export async function discoverLifecycleTools(client, required) {
  const names = new Set();
  const seen = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools) names.add(tool.name);
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seen.has(cursor), 'Tool discovery must not repeat a pagination cursor.');
      seen.add(cursor);
    }
  } while (cursor);
  for (const operation of required)
    assert.ok(names.has(operation), `Required lifecycle operation was not discovered: ${operation}`);
  return [...names];
}

async function connect(app, actor, profile, events, stage) {
  const server = createMcpServer(
    app,
    { actorId: actor.id, scopes: new Set(['ticketing:read', 'ticketing:write']) },
    profile,
  );
  const client = new Client({ name: `synthetic-lifecycle-${profile}`, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const operations = new Map();
  const instrument = (transport, direction) => {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      const operation =
        direction === 'request'
          ? (message.params?.name ?? message.method)
          : (operations.get(message.id) ?? message.method);
      if (direction === 'request' && message.id !== undefined) operations.set(message.id, operation);
      events.push({
        boundary: 'mcp',
        direction,
        role: profile,
        stage: stage.current,
        operation,
        body: JSON.stringify(message),
      });
      return send(message, options);
    };
  };
  instrument(clientTransport, 'request');
  instrument(serverTransport, 'response');
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await discoverLifecycleTools(
    client,
    profile === 'worker'
      ? ['work_claim', 'ticket_get', 'ticket_submit', 'ticket_checkpoint']
      : ['ticket_get', 'ticket_history', 'ticket_review'],
  );
  return {
    async call(operation, input) {
      const response = await client.callTool({ name: operation, arguments: input });
      assert.equal(response.structuredContent?.ok, true, JSON.stringify(response.structuredContent?.error));
      return response.structuredContent.data;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function provision(path, template) {
  const adapters = createSqliteAdapters(path);
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    f.clock.now = clock;
    const ticket = await f.ticket({
      title: template.review.detail.ticket.title,
      description: template.review.detail.ticket.description,
      criteria: template.review.detail.criteria.map((criterion) => criterion.description),
    });
    return { ticketId: ticket.id, projectId: f.project.id, worker: f.worker, reviewer: f.reviewer };
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
  }
}

function expectedFor(scenario) {
  return createReviewFixture(scenario === 'provider-retry' ? 'comment-blocker' : scenario);
}

async function runArm(directory, base, identities, scenario, arm, model) {
  const initial = expectedFor(scenario);
  const repaired = createReviewFixture('pass');
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  for (const file of initial.files) await writeFile(join(directory, file.reference), file.text);
  const database = join(directory, 'ticketing.sqlite');
  await copyFile(base, database);
  const adapters = createSqliteAdapters(database);
  const app = createApplication({ ...adapters, now: () => clock });
  const events = [];
  const stages = [];
  const repairs = [];
  const coverageReports = [];
  const stage = { current: 'connect' };
  const started = performance.now();
  let worker;
  let reviewer;
  let retryInjected = false;
  const project = { project_id: identities.projectId, ticket_id: identities.ticketId };
  const config = {
    workspace: directory,
    evidenceRoot,
    apiKey: 'offline-lifecycle-mock-only',
    reviewModel: model,
    reviewPacketFormat: arm === 'baseline' ? 'full' : 'compact',
    reportEvidenceCoverage: (criteria) => coverageReports.push({ phase: stage.current, criteria }),
    ...(arm === 'baseline' ? { reviewEvidencePreflight: false } : {}),
  };
  const mutate = (client, operation, input) =>
    client.call(operation, { ...project, idempotency_key: randomUUID(), ...input });
  try {
    worker = await connect(app, identities.worker, 'worker', events, stage);
    reviewer = await connect(app, identities.reviewer, 'reviewer', events, stage);
    for (const phase of ['deficient', 'repaired']) {
      const phaseStarted = performance.now();
      stage.current = phase;
      const expected = phase === 'deficient' ? initial.expected : repaired.expected;
      const claim = await mutate(worker, 'work_claim', {});
      if (phase === 'repaired') {
        for (const file of repaired.files) {
          if (initial.files.find((old) => old.reference === file.reference)?.text === file.text) continue;
          await writeFile(join(directory, file.reference), file.text);
          repairs.push({
            reference: file.reference,
            bytes: Buffer.byteLength(file.text),
            sha256: hash(file.text),
          });
        }
        await mutate(worker, 'ticket_checkpoint', {
          claim_token: claim.claim.token,
          progress: `Synthetic fixture repair wrote ${repairs.map((repair) => `${repair.reference} (${repair.bytes} bytes, sha256 ${repair.sha256})`).join(', ')}. Resubmit and independently verify every criterion.`,
        });
      }
      const current = await worker.call('ticket_get', project);
      const evidence = current.criteria.map((criterion, index) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: repaired.review.submission.evidence[index].summary,
        references: repaired.review.submission.evidence[index].references,
      }));
      const submitted = await mutate(worker, 'ticket_submit', {
        claim_token: claim.claim.token,
        expected_revision: current.ticket.revision,
        summary: repaired.review.submission.summary,
        evidence,
      });
      assert.equal(submitted.ticket.status, 'in_review');
      const detail = await reviewer.call('ticket_get', project);
      const history = await reviewer.call('ticket_history', {
        ...project,
        kind: 'submissions',
        item_id: submitted.submission.id,
      });
      const submission = history.items.find((item) => item.id === submitted.submission.id);
      assert.ok(submission, 'Reviewer must retrieve the actual current submitted evidence.');
      const requests = [];
      let result;
      let failures = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await modelReview(config, { detail, submission }, async (url, init) => {
            assert.equal(url, 'https://api.openai.com/v1/responses');
            const body = String(init.body);
            const request = JSON.parse(body);
            assert.deepEqual(request.tools, []);
            assert.equal(request.store, false);
            assert.equal(request.model, model);
            assert.doesNotMatch(body, /offline-lifecycle-mock-only/);
            const assessment = inspectReviewPacket(request.input);
            assert.deepEqual(
              assessment,
              expected,
              'Mock provider independently interprets the delivered facts.',
            );
            const fail = scenario === 'provider-retry' && phase === 'deficient' && !retryInjected;
            retryInjected ||= fail;
            const responseBody = JSON.stringify(
              fail
                ? { error: { type: 'rate_limit_error', message: 'Synthetic retryable launch failure.' } }
                : {
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        content: [
                          { type: 'output_text', text: JSON.stringify(mockReviewDecision(assessment)) },
                        ],
                      },
                    ],
                  },
            );
            const status = fail ? 429 : 200;
            events.push({
              boundary: 'provider-mock',
              direction: 'request',
              stage: phase,
              operation: 'responses',
              body,
            });
            events.push({
              boundary: 'provider-mock',
              direction: 'response',
              stage: phase,
              operation: 'responses',
              status,
              body: responseBody,
            });
            requests.push({
              status,
              reconstructedInput: reconstructReviewInput(request.input),
              request_sha256: hash(body),
              response_sha256: hash(responseBody),
            });
            return new Response(responseBody, { status, headers: { 'Content-Type': 'application/json' } });
          });
          break;
        } catch (error) {
          assert.ok(
            error instanceof ReviewLaunchError && error.code === 'RATE_LIMITED' && attempt === 1,
            String(error),
          );
          failures++;
        }
      }
      assert.equal(result.decision, expected.decision);
      const preflight = requests.length === 0;
      if (preflight) {
        assert.equal(arm, 'candidate');
        assert.equal(scenario, 'missing-evidence');
        assert.equal(phase, 'deficient');
        const missingCriterion = detail.criteria.find((criterion) =>
          criterion.text.startsWith('AUTH-SCOPE:'),
        );
        assert.ok(missingCriterion);
        assert.match(result.feedback, new RegExp(missingCriterion.id));
        assert.match(result.feedback, /missing|unavailable|not found|absent|no cited receipt.*available/i);
        assert.deepEqual(coverageReports.find((report) => report.phase === phase)?.criteria, [
          { criterion_id: missingCriterion.id, statuses: ['missing'] },
        ]);
      } else {
        assert.deepEqual(scoreReviewDecision(result, expected), { pass: true, errors: [] });
      }
      if (result.decision === 'approve') {
        assert.equal(phase, 'repaired', 'An invalid initial ticket cannot be finalized.');
        assert.deepEqual(inspectReviewPacket(requests.at(-1).reconstructedInput), repaired.expected);
      }
      const recorded = await mutate(reviewer, 'ticket_review', {
        expected_revision: detail.ticket.revision,
        submission_id: submission.id,
        decision: result.decision,
        feedback: result.feedback,
      });
      assert.equal(recorded.ticket.status, phase === 'repaired' ? 'done' : 'ready');
      if (phase === 'repaired')
        assert.equal(
          (await adapters.storage.get('tickets', identities.ticketId)).approved_submission_id,
          submission.id,
        );
      stages.push({
        phase,
        decision: result.decision,
        feedback: result.feedback,
        preflight,
        evidence_coverage: coverageReports
          .filter((report) => report.phase === phase)
          .flatMap((report) => report.criteria),
        retryable_launch_failures: failures,
        requests,
        submission_id: submission.id,
        observed_offline_stage_ms: Number((performance.now() - phaseStarted).toFixed(3)),
      });
    }
    stage.current = 'verify-final';
    const final = await reviewer.call('ticket_get', project);
    assert.equal(final.ticket.status, 'done');
    assert.equal(
      (await adapters.storage.get('tickets', identities.ticketId)).approved_submission_id,
      stages.at(-1).submission_id,
    );
    return {
      arm,
      scenario,
      events,
      stages,
      repairs,
      correct_finalized_tickets: 1,
      observed_offline_lifecycle_ms: performance.now() - started,
    };
  } finally {
    await worker?.close();
    await reviewer?.close();
    await adapters.search.close();
    await adapters.storage.close();
  }
}

export async function captureReviewLifecyclePair(scenario, { model = 'gpt-5-mini' } = {}) {
  assert.ok(lifecycleScenarios.includes(scenario), `Unknown lifecycle scenario: ${scenario}`);
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-review-lifecycle-'));
  try {
    const base = join(directory, 'base.sqlite');
    const identities = await provision(base, createReviewFixture('pass'));
    const baseline = await runArm(join(directory, 'baseline'), base, identities, scenario, 'baseline', model);
    const candidate = await runArm(
      join(directory, 'candidate'),
      base,
      identities,
      scenario,
      'candidate',
      model,
    );
    for (const phase of ['deficient', 'repaired']) {
      const before = baseline.stages.find((entry) => entry.phase === phase).requests;
      const after = candidate.stages.find((entry) => entry.phase === phase).requests;
      if (after.length)
        assert.equal(
          after.at(-1).reconstructedInput,
          before.at(-1).reconstructedInput,
          'Both model paths receive byte-identical original facts.',
        );
    }
    assert.deepEqual(baseline.repairs, candidate.repairs, 'Both arms perform the same actual repair.');
    return { scenario, baseline, candidate };
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('synthetic-review-lifecycle-'));
    await rm(target, { recursive: true, force: true });
  }
}

function summarize(arm) {
  const groups = {};
  for (const event of arm.events) {
    const key = `${event.boundary}/${event.operation}/${event.direction}`;
    groups[key] ??= { messages: 0, bytes: 0, reference_tokens: 0 };
    groups[key].messages++;
    groups[key].bytes += Buffer.byteLength(event.body);
    groups[key].reference_tokens += tokens(event.body);
  }
  const all = Object.values(groups);
  const count = (boundary, direction, operation) =>
    arm.events.filter(
      (event) =>
        event.boundary === boundary &&
        event.direction === direction &&
        (!operation || event.operation === operation),
    ).length;
  return {
    correct_finalized_tickets: arm.correct_finalized_tickets,
    submitted_evidence_requests: count('mcp', 'request', 'ticket_submit'),
    retrieved_submission_evidence_requests: count('mcp', 'request', 'ticket_history'),
    tool_discovery_requests: count('mcp', 'request', 'tools/list'),
    ticket_detail_requests: count('mcp', 'request', 'ticket_get'),
    recorded_review_requests: count('mcp', 'request', 'ticket_review'),
    rejected_submissions: arm.stages.filter((entry) => entry.decision === 'request_changes').length,
    preflight_rejections: arm.stages.filter((entry) => entry.preflight).length,
    model_requests: count('provider-mock', 'request'),
    model_responses: count('provider-mock', 'response'),
    retryable_launch_failures: arm.stages.reduce((sum, entry) => sum + entry.retryable_launch_failures, 0),
    retries: arm.stages.reduce((sum, entry) => sum + Math.max(0, entry.requests.length - 1), 0),
    repair_checkpoint_requests: count('mcp', 'request', 'ticket_checkpoint'),
    repair_files_written: arm.repairs,
    wire_messages: all.reduce((sum, group) => sum + group.messages, 0),
    wire_bytes: all.reduce((sum, group) => sum + group.bytes, 0),
    wire_reference_tokens: all.reduce((sum, group) => sum + group.reference_tokens, 0),
    reference_tokens_per_correctly_finalized_ticket:
      all.reduce((sum, group) => sum + group.reference_tokens, 0) / arm.correct_finalized_tickets,
    observed_offline_lifecycle_ms: Number(arm.observed_offline_lifecycle_ms.toFixed(3)),
    provider_usage: null,
    uncached_provider_tokens: null,
    provider_latency_ms: null,
    repair_generation_provider_tokens: null,
    groups,
    stages: arm.stages.map(({ requests, submission_id: _submissionId, ...entry }) => ({
      ...entry,
      requests: requests.map(({ reconstructedInput: _input, ...request }) => request),
    })),
  };
}

export async function runReviewLifecycleBenchmark(options = {}) {
  const workflows = [];
  for (const scenario of lifecycleScenarios) {
    const pair = await captureReviewLifecyclePair(scenario, options);
    const baseline = summarize(pair.baseline);
    const candidate = summarize(pair.candidate);
    assert.ok(
      candidate.wire_reference_tokens < baseline.wire_reference_tokens,
      `${scenario}: measured lifecycle reference tokens must improve`,
    );
    workflows.push({
      scenario,
      baseline,
      candidate,
      saved_reference_tokens: baseline.wire_reference_tokens - candidate.wire_reference_tokens,
      saved_percent: Number(
        ((1 - candidate.wire_reference_tokens / baseline.wire_reference_tokens) * 100).toFixed(2),
      ),
    });
  }
  const total = (arm) => {
    const correct = workflows.reduce((sum, workflow) => sum + workflow[arm].correct_finalized_tickets, 0);
    const reference = workflows.reduce((sum, workflow) => sum + workflow[arm].wire_reference_tokens, 0);
    return {
      correct_finalized_tickets: correct,
      wire_reference_tokens: reference,
      reference_tokens_per_correctly_finalized_ticket: reference / correct,
      model_requests: workflows.reduce((sum, workflow) => sum + workflow[arm].model_requests, 0),
    };
  };
  return {
    mode: 'offline-deterministic-ticket-lifecycle',
    model: options.model ?? 'gpt-5-mini',
    tokenizer:
      'js-tiktoken/o200k_base; every serialized actual MCP transport message and mock Responses request/response body; ordinary special-token text',
    comparison:
      'Baseline full packet with evidence preflight explicitly disabled; candidate compact packet with production evidence preflight default. Both clone the same provisioned SQLite ticket and perform the same deficient submission, repair, resubmission, and independent verifier transition to done.',
    approval:
      'A simulated authorized verifier records approval only after the independent fixture oracle checks every current criterion and the correct latest submission is approved. Model recommendation alone does not finalize a ticket.',
    limitations: [
      'No provider calls: deterministic mock verdicts are not model-quality or live semantic-parity evidence.',
      'This runner calls modelReview directly with a fixture-controlled single launch retry and simulated authorized verifier. It does not exercise the scanReviews ledger, heartbeat, retry backoff/limits, stale fences or advisory approval handoff; production dispatcher tests cover those controls.',
      'MCP counts serialize the actual in-memory JSON-RPC messages, including duplicated text/structured results, initialization and every tools/list discovery page once per worker/reviewer connection; HTTP/stdio framing is outside this runner.',
      'Offline wall time includes actual SQLite, packet encoding and deterministic mock work; it is not provider latency.',
      'Fixture repair is an actual local file write plus a real MCP checkpoint, not a model-generated implementation. Its bytes are reported separately; provider repair-generation cost remains unknown.',
      'Provisioning is outside the measured ticket lifecycle. Actual app-generated claim, submission and review UUIDs can slightly vary MCP reference overhead between arms; model paths are checked to preserve byte-identical original facts.',
      'Reference payload tokens are not billed or uncached provider usage. No provider usage or latency is inferred.',
    ],
    workflows,
    totals: { baseline: total('baseline'), candidate: total('candidate') },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const report = JSON.stringify(await runReviewLifecycleBenchmark(), null, 2) + '\n';
  if (values.output) {
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, report);
  }
  process.stdout.write(report);
}
