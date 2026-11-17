import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { countReferenceTokens } from '../src/tokens.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';

const fixturePath = fileURLToPath(new URL('./fixtures/protocol-workflows.json', import.meta.url));
const baselinePath = fileURLToPath(new URL('./fixtures/protocol-baseline.json', import.meta.url));
const contractText = await readFile(fixturePath, 'utf8');
const contract = JSON.parse(contractText);
const contractHash = createHash('sha256').update(contractText).digest('hex');
const { values } = parseArgs({
  options: { baseline: { type: 'boolean' }, source: { type: 'string' }, output: { type: 'string' } },
});
const baseline = values.baseline === true;
const source = resolve(values.source ?? process.cwd());
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (baseline) {
  assert.equal(sourceCommit, contract.baseline_source, 'Baseline must execute the pinned original source.');
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: source,
      encoding: 'utf8',
    }).trim(),
    '',
    'Baseline tracked source must be clean.',
  );
}
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run the reference benchmark with Node 24.');
assert.ok(countReferenceTokens('<|endoftext|>') > 1, 'User special-token spellings must be ordinary text.');
const databaseUrl = process.env.PROTOCOL_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set PROTOCOL_DATABASE_URL (or TEST_DATABASE_URL) to the disposable test database.');

const load = (path: string) => import(pathToFileURL(join(source, path)).href);
const [{ PostgresStorage, PostgresSearch }, { createApplication }, { createHttpServer }] = await Promise.all([
  load('src/adapters/postgres.ts'),
  load('src/application.ts'),
  load('src/http.ts'),
]);
const schema = `protocol_benchmark_${baseline ? 'baseline' : 'candidate'}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
assert.match(schema, /^protocol_benchmark_(baseline|candidate)_[a-f0-9]{12}$/);
const bootstrap = new pg.Pool({ connectionString: databaseUrl });
await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
await bootstrap.query(`CREATE SCHEMA "${schema}"`);
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
const storage = new PostgresStorage(isolatedUrl.href);
const search = new PostgresSearch(storage.pool);
let now = Date.parse('2030-01-01T00:00:00.000Z');
const embeddingMetrics = { query_calls: 0, document_calls: 0 };
const app = createApplication({
  storage,
  search,
  now: () => new Date(now),
  embeddings: {
    profile: { id: '0123456789abcdef01234567', model: 'deterministic-reference', dimensions: 3 },
    async embed(text: string, purpose: 'query' | 'document') {
      embeddingMetrics[purpose === 'query' ? 'query_calls' : 'document_calls']++;
      return [1, text.includes('access') ? 0.8 : 0.2, 0.3];
    },
  },
});

const uuidFields = new Set([
  'id',
  'project_id',
  'ticket_id',
  'actor_id',
  'created_by',
  'assignee_id',
  'parent_id',
  'criterion_id',
  'submission_id',
  'approved_submission_id',
  'answer_to',
  'source_id',
  'target_id',
  'checkpoint_id',
  'knowledge_id',
  'reference',
  'claim_token',
  'token',
  'idempotency_key',
]);
const timeFields = new Set(['created_at', 'updated_at', 'expires_at', 'observed_at']);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function normalizer() {
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!ids.has(value)) {
      const hex = createHash('sha256')
        .update(`reference-metadata-${ids.size + 1}`)
        .digest('hex');
      ids.set(
        value,
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      );
    }
    return ids.get(value)!;
  };
  const visit = (value: any, key = ''): any => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((field) => [field, visit(value[field], field)]),
      );
    if (typeof value !== 'string') return value;
    if (uuidFields.has(key) && uuidPattern.test(value)) return id(value);
    if (key === 'fingerprint' && /^[a-f0-9]{64}$/.test(value))
      return createHash('sha256').update('reference-fingerprint').digest('hex');
    if (timeFields.has(key) && /^\d{4}-\d\d-\d\dT/.test(value)) return '2030-01-01T00:00:00.000Z';
    if (key === 'resource_uri' && value.startsWith('ticketing://'))
      return value.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, id);
    return value;
  };
  return (value: any) => {
    const normalized = visit(value);
    if (value?.structuredContent && Array.isArray(value.content)) {
      normalized.content = value.content.map((block: any) => {
        if (block.type !== 'text') return visit(block);
        try {
          const parsed = JSON.parse(block.text);
          if (typeof parsed?.ok === 'boolean' && 'data' in parsed)
            return { ...visit(block), text: JSON.stringify(visit(parsed)) };
        } catch {
          /* Non-JSON text is preserved. */
        }
        return visit(block);
      });
    }
    return normalized;
  };
}

const fixedId = (scenario: number, item: number) =>
  `10000000-0000-4000-${(0x8000 + scenario).toString(16)}-${String(item).padStart(12, '0')}`;
const proseEnvelope = JSON.stringify({ ok: true, data: { id: fixedId(1, 1) }, error: null });
assert.equal(normalizer()({ criteria: [{ text: proseEnvelope }] }).criteria[0].text, proseEnvelope);
const sdkEnvelope = { ok: true, data: { id: fixedId(1, 1) }, error: null };
const normalizedSdk = normalizer()({
  structuredContent: sdkEnvelope,
  content: [{ type: 'text', text: JSON.stringify(sdkEnvelope) }],
});
assert.deepEqual(JSON.parse(normalizedSdk.content[0].text), normalizedSdk.structuredContent);
async function seed(workflow: any, scenario: number) {
  const id = (item: number) => fixedId(scenario, item);
  const createdAt = new Date(now - 60_000).toISOString();
  const description =
    workflow.description === 'long'
      ? contract.project.long_description_paragraph.repeat(contract.project.long_description_repetitions)
      : contract.project.description;
  assert.ok(description.length <= 16000);
  const admin = {
    id: id(1),
    issuer: 'reference',
    subject: `admin-${scenario}`,
    name: 'Administrator',
    kind: 'human',
    system_admin: true,
  };
  const worker = {
    ...admin,
    id: id(2),
    subject: `worker-${scenario}`,
    name: 'Worker',
    kind: 'agent',
    system_admin: false,
  };
  const reviewer = {
    ...admin,
    id: id(3),
    subject: `reviewer-${scenario}`,
    name: 'Reviewer',
    system_admin: false,
  };
  const project = {
    id: id(4),
    key: `REF${scenario}`,
    name: contract.project.name,
    instructions: contract.project.instructions,
    policy: workflow.policy,
    revision: 1,
    ticket_seq: workflow.blocking ? 2 : 1,
    event_seq: 0,
    created_at: createdAt,
  };
  const ticket = {
    id: id(5),
    project_id: project.id,
    key: `${project.key}-1`,
    title: contract.project.title,
    description,
    status: 'ready',
    priority: 1,
    revision: 1,
    requirements_revision: 1,
    labels: [],
    capabilities: [],
    assignee_id: null,
    parent_id: null,
    created_by: admin.id,
    approved_submission_id: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await storage.transaction('catalog', async (tx: any) => {
    for (const actor of [admin, worker, reviewer]) await tx.put('actors', actor);
    await tx.put('projects', project);
    for (const [actor, role] of [
      [worker, 'contributor'],
      [reviewer, 'verifier'],
    ])
      await tx.put('members', {
        id: `${project.id}:${actor.id}`,
        project_id: project.id,
        actor_id: actor.id,
        role,
      });
    await tx.put('tickets', ticket);
    await tx.put('criteria', {
      id: id(6),
      project_id: project.id,
      ticket_id: ticket.id,
      text: contract.project.criterion,
      position: 0,
    });
    for (let i = 0; i < workflow.history_comments; i++)
      await tx.put('notes', {
        id: id(100 + i),
        project_id: project.id,
        ticket_id: ticket.id,
        actor_id: worker.id,
        kind: 'comment',
        body: `Historical observation ${i + 1}: ${contract.project.description}`,
        blocking: false,
        answer_to: null,
        metadata: {},
        ticket_revision: 1,
        created_at: createdAt,
      });
    if (workflow.resume_checkpoint)
      await tx.put('notes', {
        id: id(7),
        project_id: project.id,
        ticket_id: ticket.id,
        actor_id: worker.id,
        kind: 'checkpoint',
        body: contract.project.checkpoint_progress,
        blocking: false,
        answer_to: null,
        metadata: {
          remaining: contract.project.checkpoint_remaining,
          decisions: contract.project.checkpoint_decisions,
          references: [],
        },
        ticket_revision: 1,
        created_at: createdAt,
      });
    if (workflow.blocking) {
      await tx.put('tickets', {
        ...ticket,
        id: id(8),
        key: `${project.key}-2`,
        title: 'Prerequisite access boundary',
        priority: 5,
        assignee_id: admin.id,
      });
      await tx.put('links', {
        id: `${id(8)}:${ticket.id}:blocks`,
        project_id: project.id,
        source_id: id(8),
        target_id: ticket.id,
        kind: 'blocks',
      });
      await tx.put('notes', {
        id: id(9),
        project_id: project.id,
        ticket_id: ticket.id,
        actor_id: admin.id,
        kind: 'question',
        body: 'Confirm that the prerequisite access boundary is ready.',
        blocking: true,
        answer_to: null,
        metadata: {},
        ticket_revision: 1,
        created_at: createdAt,
      });
    }
  });
  return { admin, worker, reviewer, project, ticket, description, prerequisiteId: id(8) };
}

async function runWorkflow(workflow: any, scenario: number) {
  now = Date.parse('2030-01-01T00:00:00.000Z');
  const seeded = await seed(workflow, scenario);
  const normalize = normalizer();
  const roleRecords: any[] = [];
  const clients: any[] = [];
  const calls: any[] = [];
  const httpRequests: Record<string, number> = {};
  const delivered: Record<string, boolean> = {
    worker_requirements: false,
    worker_instructions_policy: false,
    worker_blockers_dependencies: false,
    worker_resume_decisions: !workflow.resume_checkpoint,
    reviewer_requirements: !workflow.review,
    reviewer_submission_evidence: !workflow.review,
  };
  const server = createHttpServer(app, {
    publicUrl: 'http://127.0.0.1',
    issuer: 'https://reference.invalid',
    authenticate: async (authorization: string) => {
      const role = authorization === 'Bearer reference-reviewer' ? 'reviewer' : 'worker';
      return { actorId: seeded[role].id, scopes: new Set(['ticketing:read', 'ticketing:write']) };
    },
  });
  server.prependListener('request', (request: any) => {
    const role = request.headers.authorization === 'Bearer reference-reviewer' ? 'reviewer' : 'worker';
    httpRequests[role] = (httpRequests[role] ?? 0) + 1;
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const workflowStarted = performance.now();
  async function connect(role: 'worker' | 'reviewer') {
    const client = new Client({ name: `protocol-reference-${role}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp?profile=${role}`), {
        requestInit: { headers: { Authorization: `Bearer reference-${role}` } },
      }),
    );
    const discovery = await client.listTools();
    const inputCatalog = discovery.tools.map(({ name, description, inputSchema }: any) => ({
      name,
      description,
      inputSchema,
    }));
    roleRecords.push({
      role,
      catalog_tokens: countReferenceTokens(JSON.stringify(normalize(inputCatalog))),
      discovery_sdk_result_tokens: countReferenceTokens(JSON.stringify(normalize(discovery))),
      tool_calls: 0,
    });
    const call = async (name: string, args: any = {}, expectedError?: string) => {
      const request = { name, arguments: args };
      const callStarted = performance.now();
      const result: any = await client.callTool(request);
      const durationMs = performance.now() - callStarted;
      const envelope =
        result.structuredContent ?? JSON.parse(result.content.find((item: any) => item.type === 'text').text);
      const normalizedRequest = JSON.stringify(normalize(request));
      const normalizedResult = JSON.stringify(normalize(result));
      const normalizedEnvelope = normalize(envelope);
      calls.push({
        role,
        operation: name,
        duration_ms: Math.round(durationMs * 100) / 100,
        request_tokens: countReferenceTokens(normalizedRequest),
        sdk_result_tokens: countReferenceTokens(normalizedResult),
        model_result_tokens: countReferenceTokens(
          envelope.ok
            ? serializeSuccessEnvelope(normalizedEnvelope.data)
            : JSON.stringify(normalizedEnvelope),
        ),
        request_sha256: createHash('sha256').update(normalizedRequest).digest('hex'),
        result_sha256: createHash('sha256').update(normalizedResult).digest('hex'),
        error: envelope.error?.code ?? null,
      });
      roleRecords.find((record) => record.role === role).tool_calls++;
      if (expectedError) assert.equal(envelope.error?.code, expectedError, `${workflow.id}/${role}/${name}`);
      else
        assert.equal(envelope.ok, true, `${workflow.id}/${role}/${name}: ${JSON.stringify(envelope.error)}`);
      return envelope.data;
    };
    return { call };
  }
  const key = () => randomUUID();
  async function completeContext(role: 'worker' | 'reviewer', call: any, context: any) {
    assert.ok(
      context?.ticket && Array.isArray(context.criteria),
      `${role} must receive current requirements`,
    );
    for (const omitted of context.omitted ?? []) {
      if (
        !omitted.required_before ||
        omitted.required_before !== (role === 'worker' ? 'execution' : 'review')
      )
        continue;
      assert.ok(
        omitted.arguments && typeof omitted.retrieve_with === 'string',
        'Required omission must provide executable retrieval arguments.',
      );
      const fetched = await call(omitted.retrieve_with, omitted.arguments);
      if (omitted.section === 'latest_checkpoint') context.latest_checkpoint = fetched;
      if (omitted.section === 'submissions') context.submissions = fetched.items;
    }
    if (role === 'worker' && workflow.resume_checkpoint && !context.latest_checkpoint) {
      // The pinned server predates exact omission arguments; its existing history API is paged.
      assert.ok(baseline, 'Candidate must supply a required exact checkpoint retrieval reference.');
      for (let offset = 0; ; offset += 25) {
        const history = await call('ticket_history', {
          project_id: context.ticket.project_id,
          ticket_id: context.ticket.id,
          kind: 'notes',
          limit: 25,
          offset,
        });
        context.latest_checkpoint = history.items.find((item: any) => item.kind === 'checkpoint');
        if (context.latest_checkpoint || history.items.length < 25) break;
      }
    }
    if (role === 'reviewer' && !context.submissions?.length) {
      assert.ok(baseline, 'Candidate must supply a required exact submission retrieval reference.');
      context.submissions = (
        await call('ticket_history', {
          project_id: context.ticket.project_id,
          ticket_id: context.ticket.id,
          kind: 'submissions',
          limit: 1,
        })
      ).items;
    }
    return context;
  }
  function checkWorkerContext(context: any, criterion = contract.project.criterion) {
    assert.equal(
      context.ticket.description,
      seeded.description,
      'Mandatory description must not be truncated.',
    );
    assert.deepEqual(
      context.criteria.map((item: any) => item.text),
      [criterion],
    );
    assert.equal(context.project_instructions.text, contract.project.instructions);
    assert.equal(context.approval_policy, workflow.policy);
    assert.ok(Array.isArray(context.blockers) && Array.isArray(context.dependencies));
    delivered.worker_requirements =
      delivered.worker_instructions_policy =
      delivered.worker_blockers_dependencies =
        true;
    if (workflow.resume_checkpoint) {
      assert.deepEqual(context.latest_checkpoint.metadata.decisions, contract.project.checkpoint_decisions);
      assert.deepEqual(context.latest_checkpoint.metadata.remaining, contract.project.checkpoint_remaining);
      delivered.worker_resume_decisions = true;
    }
  }
  try {
    const worker = await connect('worker');
    const projects = await worker.call('project_list', {});
    const project = projects.projects.find((item: any) => item.name === contract.project.name);
    assert.ok(project, 'Worker discovers the project from its own MCP response.');
    const projectId = project.id;
    if (baseline) await worker.call('project_get', { project_id: projectId });
    let ticketId: string | undefined;
    if (workflow.blocking) {
      const listed = await worker.call('ticket_list', { project_id: projectId, status: 'ready' });
      ticketId = listed.tickets.find((item: any) => item.title === contract.project.title).id;
      await worker.call(
        'work_claim',
        { project_id: projectId, ticket_id: ticketId, idempotency_key: key() },
        'DEPENDENCY_BLOCKED',
      );
      const blockedContext = await completeContext(
        'worker',
        worker.call,
        await worker.call('ticket_context', { project_id: projectId, ticket_id: ticketId, detail: 'brief' }),
      );
      checkWorkerContext(blockedContext);
      assert.ok(blockedContext.blockers.some((item: any) => item.code === 'DEPENDENCY_BLOCKED'));
      const question = blockedContext.blockers.find((item: any) => item.code === 'QUESTION_BLOCKED');
      assert.ok(question, 'Worker receives the blocking question before answering it.');
      await worker.call('ticket_note', {
        project_id: projectId,
        ticket_id: ticketId,
        idempotency_key: key(),
        kind: 'answer',
        answer_to: question.reference,
        body: 'The prerequisite access boundary is confirmed ready.',
      });
      await storage.transaction(projectId, async (tx: any) => {
        const prerequisite = await tx.get('tickets', seeded.prerequisiteId);
        await tx.put('tickets', { ...prerequisite, status: 'done', revision: prerequisite.revision + 1 });
      });
    } else if (baseline) {
      const next = await worker.call('work_next', { project_id: projectId, limit: 1 });
      assert.equal(next.tickets.length, 1);
      ticketId = next.tickets[0].id;
    }
    let claimed = await worker.call('work_claim', {
      project_id: projectId,
      ...(ticketId ? { ticket_id: ticketId } : {}),
      idempotency_key: key(),
    });
    ticketId = claimed.ticket.id;
    let context = await completeContext(
      'worker',
      worker.call,
      claimed.context ??
        (await worker.call('ticket_context', {
          project_id: projectId,
          ticket_id: ticketId,
          detail: 'brief',
        })),
    );
    checkWorkerContext(context);
    assert.deepEqual(context.blockers, []);
    let token = claimed.claim.token;
    let currentTicket = context.ticket;
    let cursor = 0;
    let requiredCriterion = contract.project.criterion;
    for (let interval = 0; interval < 2; interval++) {
      now += 120_000;
      await worker.call('work_heartbeat', {
        project_id: projectId,
        ticket_id: ticketId,
        claim_token: token,
        idempotency_key: key(),
      });
      if (workflow.change && interval === 0) {
        requiredCriterion =
          'The access check also rejects a revoked project member without revealing ticket data.';
        await app.execute(seeded.admin.id, 'ticket_update', {
          project_id: projectId,
          ticket_id: ticketId,
          expected_revision: currentTicket.revision,
          criteria: [requiredCriterion],
          idempotency_key: key(),
        });
        await worker.call(
          'ticket_checkpoint',
          {
            project_id: projectId,
            ticket_id: ticketId,
            claim_token: token,
            idempotency_key: key(),
            progress: 'This checkpoint raced with a requirement change.',
          },
          'CLAIM_EXPIRED',
        );
      }
      const changes = await worker.call('changes_since', { project_id: projectId, cursor });
      cursor = changes.next_cursor;
      if (workflow.change && interval === 0) {
        assert.ok(
          changes.events.some((event: any) => event.entity_id === ticketId),
          'Worker observes the changed ticket through its own changes response.',
        );
        const changedContext = await completeContext(
          'worker',
          worker.call,
          await worker.call('ticket_context', {
            project_id: projectId,
            ticket_id: ticketId,
            detail: 'brief',
          }),
        );
        checkWorkerContext(changedContext, requiredCriterion);
        claimed = await worker.call('work_claim', {
          project_id: projectId,
          ticket_id: ticketId,
          idempotency_key: key(),
        });
        token = claimed.claim.token;
        context = await completeContext(
          'worker',
          worker.call,
          claimed.context ??
            (await worker.call('ticket_context', {
              project_id: projectId,
              ticket_id: ticketId,
              detail: 'brief',
            })),
        );
        checkWorkerContext(context, requiredCriterion);
        currentTicket = context.ticket;
      }
    }
    checkWorkerContext(context, requiredCriterion);
    const checkpoint = await worker.call('ticket_checkpoint', {
      project_id: projectId,
      ticket_id: ticketId,
      claim_token: token,
      idempotency_key: key(),
      progress: contract.project.checkpoint_progress,
      remaining: [],
      decisions: contract.project.checkpoint_decisions,
      references: [contract.project.evidence_reference],
    });
    currentTicket = checkpoint.ticket;
    const evidence = context.criteria.map((criterion: any) => ({
      criterion_id: criterion.id,
      result: 'pass',
      summary: contract.project.evidence_summary,
      references: [contract.project.evidence_reference],
    }));
    await worker.call('ticket_submit', {
      project_id: projectId,
      ticket_id: ticketId,
      claim_token: token,
      expected_revision: currentTicket.revision,
      idempotency_key: key(),
      summary: 'Verified each current access-check criterion.',
      evidence,
    });
    if (workflow.review) {
      const reviewer = await connect('reviewer');
      const visible = await reviewer.call('project_list', {});
      const reviewProject = visible.projects.find((item: any) => item.name === contract.project.name);
      assert.ok(reviewProject);
      if (baseline) await reviewer.call('project_get', { project_id: reviewProject.id });
      const queue = await reviewer.call('ticket_list', { project_id: reviewProject.id, status: 'in_review' });
      assert.equal(queue.tickets.length, 1);
      const reviewContext = await completeContext(
        'reviewer',
        reviewer.call,
        await reviewer.call('ticket_context', {
          project_id: reviewProject.id,
          ticket_id: queue.tickets[0].id,
          detail: 'brief',
        }),
      );
      assert.deepEqual(
        reviewContext.criteria.map((item: any) => item.text),
        [contract.project.criterion],
      );
      assert.equal(reviewContext.project_instructions.text, contract.project.instructions);
      assert.equal(reviewContext.approval_policy, 'independent');
      assert.deepEqual(reviewContext.blockers, []);
      const submission = reviewContext.submissions[0];
      assert.equal(submission.requirements_revision, reviewContext.ticket.requirements_revision);
      assert.notEqual(submission.actor_id, seeded.reviewer.id);
      for (const criterion of reviewContext.criteria) {
        const item = submission.evidence.find((entry: any) => entry.criterion_id === criterion.id);
        assert.equal(item?.summary, contract.project.evidence_summary);
        assert.deepEqual(item.references, [contract.project.evidence_reference]);
      }
      delivered.reviewer_requirements = delivered.reviewer_submission_evidence = true;
      await reviewer.call('ticket_review', {
        project_id: reviewProject.id,
        ticket_id: reviewContext.ticket.id,
        submission_id: submission.id,
        expected_revision: reviewContext.ticket.revision,
        idempotency_key: key(),
        decision: 'approve',
        feedback: 'Independently checked each current criterion against the submitted evidence.',
      });
    }
    assert.equal((await storage.get('tickets', seeded.ticket.id)).status, 'done');
    assert.ok(Object.values(delivered).every(Boolean));
    const catalogTokens = roleRecords.reduce((sum, role) => sum + role.catalog_tokens, 0);
    const requestTokens = calls.reduce((sum, call) => sum + call.request_tokens, 0);
    const resultTokens = calls.reduce((sum, call) => sum + call.sdk_result_tokens, 0);
    const modelResultTokens = calls.reduce((sum, call) => sum + call.model_result_tokens, 0);
    const mandatoryFloor = countReferenceTokens(
      serializeSuccessEnvelope({
        project_instructions: contract.project.instructions,
        approval_policy: workflow.policy,
        description: seeded.description,
        criteria: [requiredCriterion],
        ...(workflow.resume_checkpoint
          ? {
              decisions: contract.project.checkpoint_decisions,
              remaining: contract.project.checkpoint_remaining,
            }
          : {}),
        ...(workflow.review
          ? {
              reviewer: {
                instructions: contract.project.instructions,
                criteria: [requiredCriterion],
                evidence,
              },
            }
          : {}),
      }),
    );
    const durations = calls.map((call) => call.duration_ms).sort((a, b) => a - b);
    return {
      id: workflow.id,
      roles: roleRecords,
      catalog_tokens: catalogTokens,
      request_tokens: requestTokens,
      sdk_result_tokens: resultTokens,
      model_result_tokens: modelResultTokens,
      protocol_tokens: catalogTokens + requestTokens + resultTokens,
      model_view_tokens: catalogTokens + requestTokens + modelResultTokens,
      mandatory_floor_tokens: mandatoryFloor,
      tool_round_trips: calls.length,
      latency_ms: {
        elapsed: Math.round((performance.now() - workflowStarted) * 100) / 100,
        call_p50: durations[Math.floor(durations.length * 0.5)],
        call_p95: durations[Math.ceil(durations.length * 0.95) - 1],
        call_max: durations.at(-1),
      },
      http_requests: httpRequests,
      delivered,
      calls,
    };
  } finally {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

try {
  await storage.migrate();
  await search.configure(app.embeddings.profile);
  const workflows = [];
  for (let i = 0; i < contract.workflows.length; i++)
    workflows.push(await runWorkflow(contract.workflows[i], i + 1));
  const result: any = {
    version: 1,
    mode: baseline ? 'baseline' : 'candidate',
    baseline_source: contract.baseline_source,
    source_commit: sourceCommit,
    scenario_contract_sha256: contractHash,
    tokenizer: contract.tokenizer,
    node: process.version,
    fixture_isolation: 'fresh schema in an explicitly supplied disposable database',
    representation: contract.measurement,
    embedding_provider_invocations: embeddingMetrics,
    workflows,
    total_protocol_tokens: workflows.reduce((sum, workflow) => sum + workflow.protocol_tokens, 0),
    total_model_view_tokens: workflows.reduce((sum, workflow) => sum + workflow.model_view_tokens, 0),
  };
  if (!baseline) {
    const reference = JSON.parse(await readFile(baselinePath, 'utf8'));
    assert.equal(reference.baseline_source, contract.baseline_source);
    assert.equal(
      reference.scenario_contract_sha256,
      contractHash,
      'Frozen baseline and current scenario contract must match.',
    );
    result.reduction = 1 - result.total_protocol_tokens / reference.total_protocol_tokens;
    result.comparison = workflows.map((workflow) => {
      const old = reference.workflows.find((item: any) => item.id === workflow.id);
      assert.ok(old);
      return {
        id: workflow.id,
        baseline_tokens: old.protocol_tokens,
        candidate_tokens: workflow.protocol_tokens,
        reduction: 1 - workflow.protocol_tokens / old.protocol_tokens,
      };
    });
    result.gates = {
      catalog: workflows.every((workflow) =>
        workflow.roles
          .filter((role: any) => role.role === 'worker')
          .every(
            (role: any) =>
              role.catalog_tokens <= contract.measurement.acceptance.worker_input_catalog_max_tokens,
          ),
      ),
      aggregate: result.reduction >= contract.measurement.acceptance.aggregate_min_reduction,
      no_workflow_regression: result.comparison.every(
        (workflow: any) => workflow.candidate_tokens <= workflow.baseline_tokens,
      ),
    };
  }
  const output = resolve(
    values.output ?? (baseline ? baselinePath : '.local/protocol-benchmark-results.json'),
  );
  if (baseline) {
    try {
      await readFile(output);
      throw new Error(
        'Refusing to overwrite a frozen baseline. Choose a new explicit --output to inspect a rerun.',
      );
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        scenario_contract_sha256: contractHash,
        total_protocol_tokens: result.total_protocol_tokens,
        total_model_view_tokens: result.total_model_view_tokens,
        reduction: result.reduction,
        gates: result.gates,
        workflows: workflows.map(
          ({
            id,
            catalog_tokens,
            request_tokens,
            sdk_result_tokens,
            protocol_tokens,
            mandatory_floor_tokens,
            tool_round_trips,
          }) => ({
            id,
            catalog_tokens,
            request_tokens,
            sdk_result_tokens,
            protocol_tokens,
            mandatory_floor_tokens,
            tool_round_trips,
          }),
        ),
      },
      null,
      2,
    ),
  );
  if (!baseline)
    assert.ok(
      Object.values(result.gates).every(Boolean),
      'Protocol reference gates failed; see the written comparison.',
    );
} finally {
  await storage.close();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
  await bootstrap.end();
}
