import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { createHttpServer } from '../src/http.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { countReferenceTokens } from '../src/tokens.js';
import { fixture } from '../src/testing/contracts.js';

it('resumes a fresh SDK worker from complete bounded packets and reachable paginated follow-ups', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-resume-'));
  const adapters = createSqliteAdapters(join(directory, 'resume.sqlite'));
  t.after(async () => {
    await adapters.search.close();
    await adapters.storage.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-resume-'));
    await rm(directory, { recursive: true });
  });
  await adapters.storage.migrate();
  const f = await fixture(adapters);
  const ticket = await f.ticket();
  const claim = await f.claim(ticket.id);
  for (const decision of ['Keep owner validation.', 'Use the existing service.', 'Preserve error handling.'])
    await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      progress: 'Completed earlier investigation. '.repeat(400),
      decisions: [decision],
      references: ['execution:untrusted-checkpoint-reference'],
    });
  const app = createApplication({
    ...adapters,
    now: () => f.clock.now,
    executionRecipes: [{ id: 'verify', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
  });
  const submitted = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'verify',
    checkpoint: {
      progress: 'Waiting on verification. '.repeat(600),
      remaining: ['Inspect authoritative result.'],
    },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  const attemptId = randomUUID();
  const artifact = `execution:${submitted.run_id}:${attemptId}:result`;
  await f.storage.transaction(f.project.id, async (tx) => {
    const run = (await tx.get('execution_jobs', submitted.run_id))!;
    await tx.put('execution_attempts', {
      id: attemptId,
      project_id: f.project.id,
      run_id: run.id,
      previous_attempt_id: null,
      ordinal: 1,
      process_token: 'private-process-credential',
      created_at: f.clock.now.toISOString(),
    });
    assert.equal(
      await tx.compareExecutionRun!(run, {
        ...run,
        status: 'succeeded',
        exit_code: 0,
        finished_at: f.clock.now.toISOString(),
        reservation_token: 'private-reservation-credential',
        artifacts: [
          artifact,
          'execution:untrusted-outcome-reference',
          `execution:${randomUUID()}:${attemptId}:result`,
        ],
      }),
      true,
    );
    const continuation = (await tx.get('continuations', run.continuation_id))!;
    await tx.put('continuations', {
      ...continuation,
      status: 'satisfied',
      settled_at: f.clock.now.toISOString(),
    });
  });
  const before = await f.read(ticket.id);
  await f.call(f.worker.id, 'ticket_update', {
    ticket_id: ticket.id,
    expected_revision: before.ticket.revision,
    description: 'Current requirement: enforce owner scope.',
    criteria: ['Guard owner scope.'],
  });

  const server = createHttpServer(app, {
    publicUrl: 'http://127.0.0.1',
    issuer: 'http://127.0.0.1/issuer',
    authenticate: async () => ({
      actorId: f.other.id,
      scopes: new Set(['ticketing:read', 'ticketing:write']),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'fresh-resume-worker', version: '1.0.0' });
  const received: any[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    const envelope = response.structuredContent as any;
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    assert.equal((response.content[0] as any).text, serializeSuccessEnvelope(envelope.data));
    received.push(envelope.data);
    return envelope.data;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp`)),
    );
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const catalogTokens = countReferenceTokens(
      JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))),
    );
    assert.ok(catalogTokens <= 5000);
    const acquired = await call('work_claim', {
      project_id: f.project.id,
      ticket_id: ticket.key,
      max_tokens: 4096,
      idempotency_key: randomUUID(),
    });
    const claimTokens = countReferenceTokens(serializeSuccessEnvelope(acquired));
    assert.ok(claimTokens <= 4096);
    console.log(JSON.stringify({ resume_catalog_tokens: catalogTokens, resume_claim_tokens: claimTokens }));
    const context = acquired.context;
    assert.equal(context.ticket.description, 'Current requirement: enforce owner scope.');
    assert.equal(context.criteria[0].text, 'Guard owner scope.');
    assert.deepEqual(context.blockers, []);
    assert.ok(context.omitted.some((entry: any) => entry.required_before === 'execution'));
    const checkpoints = [
      ...(context.prior_checkpoints ?? []),
      ...(context.latest_checkpoint ? [context.latest_checkpoint] : []),
    ];
    const executions = [...(context.execution_outcomes ?? [])];
    const changes = [...(context.recent_changes ?? [])];
    for (const omission of context.omitted) {
      assert.ok(names.has(omission.retrieve_with), `Unavailable follow-up ${omission.retrieve_with}`);
      let args = omission.arguments;
      for (;;) {
        const page = await call(omission.retrieve_with, args);
        if (omission.section.startsWith('latest_checkpoint')) checkpoints.push(page);
        if (omission.section.startsWith('prior_checkpoints')) checkpoints.push(...page.items);
        if (omission.section.startsWith('execution_outcomes')) executions.push(...page.items);
        if (omission.section.startsWith('recent_changes')) changes.push(...page.items);
        if (!page.has_more) break;
        assert.ok(page.next_offset > (args.offset ?? 0));
        args = { ...args, offset: page.next_offset };
      }
    }
    // The restarted worker derives every mutation input from received MCP data.
    const decisions = checkpoints.flatMap((note: any) => note.metadata.decisions ?? []);
    assert.deepEqual(
      new Set(decisions),
      new Set(['Keep owner validation.', 'Use the existing service.', 'Preserve error handling.']),
    );
    assert.ok(changes.some((event: any) => event.type === 'ticket.invalidated'));
    assert.ok(changes.every((event: any) => !['ticket.checkpointed', 'run.submitted'].includes(event.type)));
    assert.equal(executions[0].run.status, 'succeeded');
    assert.equal(executions[0].run.exit_code, 0);
    assert.deepEqual(executions[0].run.artifacts, [artifact]);
    assert.equal(executions[0].stale, true);
    const current = await call('ticket_context', {
      project_id: context.ticket.project_id,
      ticket_id: context.ticket.id,
    });
    const unchanged = await call('ticket_context', {
      project_id: context.ticket.project_id,
      ticket_id: context.ticket.id,
      if_none_match: current.fingerprint,
    });
    assert.equal(unchanged.not_modified, true);
    const wire = JSON.stringify(received);
    for (const secret of [claim.claim.token, 'private-process-credential', 'private-reservation-credential'])
      assert.equal(wire.includes(secret), false);
    const checkpoint = await call('ticket_checkpoint', {
      project_id: context.ticket.project_id,
      ticket_id: context.ticket.id,
      claim_token: acquired.claim.token,
      idempotency_key: randomUUID(),
      progress: `Resumed ${context.ticket.description}; inspected ${executions[0].run.id}.`,
      decisions,
    });
    const completed = await call('ticket_submit', {
      project_id: context.ticket.project_id,
      ticket_id: context.ticket.id,
      claim_token: acquired.claim.token,
      idempotency_key: randomUUID(),
      expected_revision: checkpoint.ticket.revision,
      summary: 'Resumed against current requirements and preserved prior decisions.',
      evidence: context.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: `Verified ${criterion.text}`,
        references: [executions[0].run.artifacts[0]],
      })),
    });
    assert.equal(completed.ticket.status, 'in_review');
    const refreshed = await call('ticket_context', {
      project_id: context.ticket.project_id,
      ticket_id: context.ticket.id,
      if_none_match: current.fingerprint,
    });
    assert.equal(refreshed.not_modified, false);
    assert.equal(refreshed.ticket.revision, completed.ticket.revision);
    await f.storage.transaction(f.project.id, (tx) => tx.remove('members', `${f.project.id}:${f.other.id}`));
    for (const [name, args] of [
      [
        'ticket_context',
        {
          project_id: context.ticket.project_id,
          ticket_id: context.ticket.id,
          if_none_match: refreshed.fingerprint,
        },
      ],
      [
        'ticket_history',
        { project_id: context.ticket.project_id, ticket_id: context.ticket.id, kind: 'executions' },
      ],
    ] as const) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal((denied.structuredContent as any).error.code, 'FORBIDDEN');
    }
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
