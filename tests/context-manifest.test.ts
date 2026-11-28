import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createContextManifest } from '../examples/context-manifest.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { createHttpServer } from '../src/http.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { countReferenceTokens } from '../src/tokens.js';
import { fixture, hasCode } from '../src/testing/contracts.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-manifest-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  const clients: Client[] = [];
  const sessions = new WeakMap<Client, { actor: string; profile: string }>();
  t.after(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await adapters.search.close();
    await adapters.storage.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-manifest-'));
    await rm(directory, { recursive: true });
  });
  await adapters.storage.migrate();
  const f = await fixture(adapters);
  const ticket = await f.ticket();
  const claim = await f.claim(ticket.id);
  for (let index = 0; index < 4; index++)
    await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      progress: 'Preserve this investigation and every exact prior decision. '.repeat(220),
      decisions: [`Decision ${index}: preserve the owner check.`],
    });
  const app = createApplication({
    ...adapters,
    now: () => f.clock.now,
    executionRecipes: [{ id: 'verify', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
    executionArtifacts: { directory, ttl_ms: 1000 },
  });
  const submitted = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'verify',
    checkpoint: { progress: 'Read exact verification evidence before continuing. '.repeat(250) },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  const run = (await app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60000))!;
  await app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60000);
  const attempt = (await adapters.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
  const path = join(directory, run.id, attempt.id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(Array.from({ length: 1300 }, (_, i) => (i * 103 + Math.floor(i / 7)) % 256));
  const artifactId = `execution:${run.id}:${attempt.id}:stdout`;
  await writeFile(join(path, 'stdout.log'), bytes, { mode: 0o600 });
  await writeFile(
    join(path, 'result.json'),
    JSON.stringify({
      run_id: run.id,
      attempt_id: attempt.id,
      process_token: attempt.process_token,
      recipe_fingerprint: run.recipe_fingerprint,
      finished_at: f.clock.now.getTime(),
      bytes: { stdout: bytes.length },
      total_bytes: { stdout: bytes.length },
      sha256: { stdout: createHash('sha256').update(bytes).digest('hex') },
    }),
    { mode: 0o600 },
  );
  await app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
    exit_code: 0,
    signal: null,
    error_code: null,
    artifacts: [artifactId],
  });
  const calls: { client: Client; name: string; arguments: any; data: any; tokens: number }[] = [];
  const server = createHttpServer(app, {
    publicUrl: 'http://127.0.0.1',
    issuer: 'http://127.0.0.1/issuer',
    authenticate: async (authorization) => ({
      actorId: authorization === 'Bearer reviewer' ? f.reviewer.id : f.worker.id,
      scopes: new Set(['ticketing:read', 'ticketing:write']),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connect = async (client?: Client, profile = 'executor', actor = 'worker') => {
    if (!client) {
      client = new Client({ name: 'manifest-test', version: '1.0.0' });
      clients.push(client);
      const callTool = client.callTool.bind(client);
      const instrumented = client;
      client.callTool = async (request, ...rest) => {
        const response = await callTool(request, ...rest);
        calls.push({
          client: instrumented,
          name: request.name,
          arguments: request.arguments,
          data: (response.structuredContent as any)?.data,
          tokens:
            countReferenceTokens(JSON.stringify(request)) + countReferenceTokens(JSON.stringify(response)),
        });
        return response;
      };
    }
    const session = { actor, profile };
    sessions.set(client, session);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp?profile=${profile}`),
        {
          fetch: async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            target.searchParams.set('profile', session.profile);
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${session.actor}`);
            return fetch(target, { ...init, headers });
          },
        },
      ),
    );
    return client;
  };
  return {
    ...f,
    app,
    ticket,
    initialClaim: claim,
    bytes,
    path,
    artifactId,
    calls,
    connect,
    sessions,
    input: { project_id: f.project.id, ticket_id: ticket.id, max_tokens: 1200 },
    artifactInput: {
      project_id: f.project.id,
      artifact_id: artifactId,
      length: bytes.length,
      max_tokens: 512,
    },
  };
}

async function queuedRuns(f: Awaited<ReturnType<typeof setup>>, count: number) {
  const runs: string[] = [];
  for (let index = 0; index < count; index++) {
    f.clock.now = new Date(f.clock.now.getTime() + 1);
    const submitted = (await f.app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: f.ticket.id,
      claim_token: f.initialClaim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'verify',
      checkpoint: { progress: `Queued verification ${index}.` },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    runs.push(submitted.run_id);
  }
  return runs;
}

function executionRows(packet: any): any[] {
  return [
    ...(packet.context.execution_outcomes ?? []),
    ...packet.retrieved.flatMap((page: any) => (page.arguments.kind === 'executions' ? page.data.items : [])),
  ];
}

for (const count of [2, 12])
  it(`invalidates retained brief execution history when an older of ${count} queued runs is cancelled`, async (t) => {
    const f = await setup(t);
    const runs = await queuedRuns(f, count);
    const manifest = createContextManifest(await f.connect());
    const first = await manifest.context(f.input, 'execution');
    assert.equal(first.complete, true);
    assert.equal(executionRows(first).find((item) => item.run.id === runs[0])?.run.status, 'queued');
    assert.equal(executionRows(first).length, count + 1);
    await f.app.cancelExecutionRun(f.admin.id, f.project.id, runs[0]!);
    const current = await manifest.context(f.input, 'execution');
    assert.equal(current.complete, true);
    assert.notEqual(current.context.fingerprint, first.context.fingerprint);
    assert.equal(executionRows(current).find((item) => item.run.id === runs[0])?.run.status, 'failed');
    assert.equal(
      serializeSuccessEnvelope(current),
      serializeSuccessEnvelope(await createContextManifest(await f.connect()).context(f.input, 'execution')),
    );
    const before = f.calls.length;
    assert.deepEqual(await manifest.context(f.input, 'execution'), current);
    assert.equal(f.calls.length, before + 1);
    const conditional = (await f.app.execute(f.worker.id, 'ticket_context', {
      ...f.input,
      if_none_match: first.context.fingerprint,
    })) as any;
    assert.equal(conditional.not_modified, false, 'Plain conditional readers must also invalidate.');
  });

it('invalidates deep execution history on reservation and start without relying on ticket events', async (t) => {
  const f = await setup(t);
  const [oldest] = await queuedRuns(f, 12);
  const manifest = createContextManifest(await f.connect());
  let packet = await manifest.context(f.input, 'execution');
  const project = (await f.storage.get('projects', f.project.id))!;
  const reserved = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, oldest!, 60000))!;
  for (const expected of ['reserved', 'running']) {
    if (expected === 'running')
      await f.app.startExecutionRun(f.admin.id, f.project.id, oldest!, reserved.reservation_token!, 60000);
    const current = await manifest.context(f.input, 'execution');
    assert.notEqual(current.context.fingerprint, packet.context.fingerprint);
    assert.equal(executionRows(current).find((item) => item.run.id === oldest)?.run.status, expected);
    assert.equal(current.complete, true);
    packet = current;
  }
  assert.equal((await f.storage.get('projects', f.project.id))!.event_seq, project.event_seq);
});

it('rejects a deep execution transition during required recovery and retries without retained material', async (t) => {
  const f = await setup(t);
  const [oldest] = await queuedRuns(f, 12);
  const client = await f.connect();
  const callTool = client.callTool.bind(client);
  let changed = false;
  client.callTool = async (request, ...rest) => {
    const response = await callTool(request, ...rest);
    if (
      !changed &&
      request.name === 'ticket_history' &&
      request.arguments?.kind === 'executions' &&
      (response.structuredContent as any).data.items.some((item: any) => item.run.id === oldest)
    ) {
      changed = true;
      await f.app.reserveExecutionRun(f.admin.id, f.project.id, oldest!, 60000);
    }
    return response;
  };
  const manifest = createContextManifest(client);
  await assert.rejects(manifest.context(f.input, 'execution'), hasCode('CONTEXT_CHANGED'));
  assert.equal(changed, true);
  assert.equal(f.calls.at(-1)!.name, 'ticket_context');
  assert.equal(f.calls.at(-1)!.data.not_modified, false);
  const before = f.calls.length;
  const packet = await manifest.context(f.input, 'execution');
  assert.equal(f.calls[before]!.arguments.if_none_match, undefined);
  assert.equal(executionRows(packet).find((item) => item.run.id === oldest)?.run.status, 'reserved');
});

it('keeps execution fingerprints local to the ticket and rechecks the live owner authority and lease', async (t) => {
  const f = await setup(t);
  await queuedRuns(f, 2);
  const read = (fingerprint?: string) =>
    f.app.execute(f.other.id, 'ticket_context', {
      ...f.input,
      ...(fingerprint ? { if_none_match: fingerprint } : {}),
    }) as Promise<any>;
  const first = await read();
  await f.call(f.worker.id, 'tickets_create', {
    tickets: [
      { title: 'Unrelated work', description: 'Separate ticket.', criteria: ['Verify unrelated work.'] },
    ],
  });
  assert.equal((await read(first.fingerprint)).not_modified, true);
  await f.app.execute(f.admin.id, 'member_set', {
    project_id: f.project.id,
    actor_id: f.worker.id,
    role: 'reader',
    idempotency_key: randomUUID(),
  });
  const revoked = await read(first.fingerprint);
  assert.equal(revoked.not_modified, false);
  await f.storage.transaction(f.project.id, (tx) => tx.put('actors', { ...f.worker, system_admin: true }));
  assert.equal((await read(revoked.fingerprint)).not_modified, false);
  await f.storage.transaction(f.project.id, (tx) => tx.put('actors', f.worker));
  await f.app.execute(f.admin.id, 'member_set', {
    project_id: f.project.id,
    actor_id: f.worker.id,
    role: 'contributor',
    idempotency_key: randomUUID(),
  });
  assert.equal((await read()).fingerprint, first.fingerprint);
  f.clock.now = new Date(Date.parse(f.initialClaim.claim.expires_at) + 1);
  assert.equal((await read(first.fingerprint)).not_modified, false);
});

it('uses bounded histogram pages when an execution adapter has no optimized summary', async (t) => {
  const f = await setup(t);
  const source = (await f.storage.find('execution_jobs', { limit: 1 }))[0]!;
  const continuation = (await f.storage.get('continuations', source.continuation_id))!;
  const oldest = randomUUID();
  await f.storage.transaction(f.project.id, async (tx) => {
    for (let index = 0; index < 1000; index++) {
      const runId = index ? randomUUID() : oldest;
      const continuationId = randomUUID();
      await tx.put('execution_jobs', {
        ...source,
        id: runId,
        continuation_id: continuationId,
        status: 'queued',
        reservation_token: null,
        locked_until: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
        artifacts: [],
        created_at: '2000-01-01T00:00:00.000Z',
      });
      await tx.put('continuations', {
        ...continuation,
        id: continuationId,
        run_id: runId,
        status: 'pending',
        settled_at: null,
      });
    }
  });
  assert.deepEqual(await f.storage.executionStatusCounts!(f.project.id, f.ticket.id), {
    queued: 1000,
    succeeded: 1,
  });
  const offsets: number[] = [];
  const readSnapshot = f.storage.readSnapshot.bind(f.storage);
  f.storage.readSnapshot = (work) =>
    readSnapshot((reader) => {
      const fallback = { ...reader };
      delete fallback.executionStatusCounts;
      fallback.find = (table, query) => {
        if (table === 'execution_jobs' && query?.limit === 1000) offsets.push(query.offset ?? 0);
        return reader.find(table, query);
      };
      return work(fallback);
    });
  const first = (await f.app.execute(f.worker.id, 'ticket_context', f.input)) as any;
  assert.deepEqual(offsets, [0, 1000]);
  await f.app.cancelExecutionRun(f.admin.id, f.project.id, oldest);
  const changed = (await f.app.execute(f.worker.id, 'ticket_context', {
    ...f.input,
    if_none_match: first.fingerprint,
  })) as any;
  assert.equal(changed.not_modified, false);
  assert.deepEqual(offsets, [0, 1000, 0, 1000]);
});

it('leaves required reviewer artifact bytes explicit and outside retained packets', async (t) => {
  const f = await setup(t);
  const args = { project_id: f.project.id, ticket_id: f.ticket.id };
  const current = (await f.app.execute(f.worker.id, 'ticket_get', args)) as any;
  await f.app.execute(f.worker.id, 'ticket_submit', {
    ...args,
    idempotency_key: randomUUID(),
    claim_token: f.initialClaim.claim.token,
    expected_revision: current.ticket.revision,
    summary: 'Read the exact submitted evidence.',
    evidence: current.criteria.map(({ id }: { id: string }) => ({
      criterion_id: id,
      result: 'pass',
      summary: 'Submitted verification output.',
      references: [f.artifactId],
    })),
  });
  const client = await f.connect(undefined, 'reviewer', 'reviewer');
  const manifest = createContextManifest(client);
  const packet = await manifest.context(args, 'review');
  assert.equal(packet.complete, false);
  assert.deepEqual(
    packet.pending.map((item) => item.arguments.artifact_id),
    [f.artifactId],
  );
  assert.equal(
    f.calls.some((call) => call.name === 'artifact_read'),
    false,
  );
  const pages = await manifest.artifact(packet.pending[0]!.arguments);
  assert.deepEqual(Buffer.concat(pages.map((page) => Buffer.from(page.range.data, 'base64'))), f.bytes);
  f.calls.length = 0;
  assert.equal((await manifest.context(args, 'review')).complete, false);
  assert.equal(f.calls[0]!.arguments.if_none_match, undefined);
});

it('recovers every required legacy history page before retaining a review packet', async (t) => {
  const f = await setup(t);
  for (let index = 0; index < 15; index++)
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: f.ticket.id,
      kind: 'question',
      body: `Open reviewer question ${index}.`,
    });
  const client = await f.connect(undefined, 'reviewer', 'reviewer');
  const manifest = createContextManifest(client);
  const args = { project_id: f.project.id, ticket_id: f.ticket.id };
  const packet = await manifest.context(args, 'review');
  assert.equal(packet.complete, true);
  const notes = new Set(
    [
      ...((packet.context.open_questions ?? []) as { body: string }[]),
      ...packet.retrieved.flatMap((page) =>
        page.arguments.kind === 'notes' ? (page.data as { items: { body: string }[] }).items : [],
      ),
    ].map((note) => note.body),
  );
  assert.equal(notes.size, 15);
  f.calls.length = 0;
  assert.deepEqual(await manifest.context(args, 'review'), packet);
  assert.equal(f.calls.length, 1);
});

it('delivers exact retained context and all required pages after an authorized conditional read', async (t) => {
  const f = await setup(t);
  const client = await f.connect();
  const manifest = createContextManifest(client);
  const first = await manifest.context(f.input, 'execution');
  assert.ok(first.context.omitted.some((item) => item.required_before === 'execution'));
  assert.ok(first.retrieved.some((item) => item.operation === 'checkpoint_get'));
  const decisions = first.retrieved.flatMap((item: any) =>
    [item.data, ...(item.data.items ?? [])].flatMap((note: any) => note.metadata?.decisions ?? []),
  );
  assert.deepEqual(
    new Set(decisions),
    new Set([0, 1, 2, 3].map((i) => `Decision ${i}: preserve the owner check.`)),
  );
  const cold = f.calls.slice();
  assert.equal(cold[0]!.arguments.if_none_match, undefined);
  assert.equal(
    first.retrieved.length,
    cold.length - 2,
    'Every required fetch is recorded in workflow usage.',
  );
  const canonical = serializeSuccessEnvelope(first);
  assert.equal(cold.at(-1)!.name, 'ticket_context');
  assert.equal(
    cold.at(-1)!.data.not_modified,
    true,
    'Multi-call recovery rechecks the final authorized fingerprint.',
  );
  first.context.ticket.description = 'Caller mutation must not replace retained requirements.';
  const warm = await manifest.context(f.input, 'execution');
  assert.equal(serializeSuccessEnvelope(warm), canonical);
  assert.equal(f.calls.length, cold.length + 1);
  assert.equal(f.calls.at(-1)!.data.not_modified, true);
  assert.equal(f.calls.at(-1)!.arguments.if_none_match, warm.context.fingerprint);
  const warmTokens = f.calls.at(-1)!.tokens;
  const coldTokens = cold.reduce((sum, call) => sum + call.tokens, 0);
  assert.ok(warmTokens < coldTokens);
  console.log(
    JSON.stringify({
      manifest_context_cold_calls: cold.length,
      manifest_context_warm_calls: 1,
      manifest_context_cold_protocol_tokens: coldTokens,
      manifest_context_warm_protocol_tokens: warmTokens,
    }),
  );

  const before = f.calls.length;
  const fresh = createContextManifest(await f.connect());
  const freshPacket = await fresh.context(f.input, 'execution');
  assert.equal(f.calls[before]!.arguments.if_none_match, undefined);
  assert.equal(serializeSuccessEnvelope(freshPacket), canonical);
  assert.equal(f.calls.length - before, cold.length);
  await client.close();
  await f.connect(client);
  const reconnect = f.calls.length;
  assert.equal(serializeSuccessEnvelope(await manifest.context(f.input, 'execution')), canonical);
  assert.equal(f.calls[reconnect]!.arguments.if_none_match, undefined);
  assert.equal(f.calls.length - reconnect, cold.length);

  await client.close();
  await f.connect(client, 'reviewer', 'reviewer');
  const reviewer = f.calls.length;
  const reviewed = await manifest.context(f.input, 'review');
  assert.equal(f.calls[reviewer]!.arguments.if_none_match, undefined);
  assert.notEqual(reviewed.context.fingerprint, warm.context.fingerprint);
});

for (const change of ['bearer', 'transient_bearer', 'profile', 'role', 'requirements'] as const)
  it(`rejects ${change} changes during required context recovery without returning the old owner token`, async (t) => {
    const f = await setup(t);
    const client = await f.connect();
    const session = f.sessions.get(client)!;
    const originalTransport = client.transport;
    const originalInstructions = client.getInstructions();
    const member = (await f.storage.get('members', `${f.project.id}:${f.worker.id}`))!;
    const callTool = client.callTool.bind(client);
    let switched = false;
    client.callTool = async (request, ...rest) => {
      const response = await callTool(request, ...rest);
      if (!switched && request.name === 'ticket_context') {
        switched = true;
        const context = (response.structuredContent as any).data;
        assert.equal(context.claim.token, f.initialClaim.claim.token);
        if (change === 'bearer' || change === 'transient_bearer') session.actor = 'reviewer';
        if (change === 'profile') session.profile = 'full';
        if (change === 'role')
          await f.storage.transaction(f.project.id, (tx) => tx.put('members', { ...member, role: 'reader' }));
        if (change === 'requirements')
          await f.call(f.worker.id, 'ticket_update', {
            ticket_id: f.ticket.id,
            expected_revision: context.ticket.revision,
            description: 'Requirements changed while recovering required evidence.',
          });
      } else if (change === 'transient_bearer') session.actor = 'worker';
      return response;
    };
    const manifest = createContextManifest(client);
    await assert.rejects(manifest.context(f.input, 'execution'), hasCode('CONTEXT_CHANGED'));
    assert.equal(client.transport, originalTransport);
    assert.equal(client.getInstructions(), originalInstructions);
    if (change === 'transient_bearer') {
      assert.equal(session.actor, 'worker');
      assert.notEqual(f.calls[0]!.data.authorization_binding, f.calls[1]!.data.authorization_binding);
    }
    if (change === 'requirements') {
      assert.equal(f.calls.at(-1)!.name, 'ticket_context');
      assert.equal(f.calls.at(-1)!.data.not_modified, false);
    }
    client.callTool = callTool;
    session.actor = 'reviewer';
    const reviewer = await client.callTool({ name: 'ticket_context', arguments: f.input });
    assert.equal((reviewer.structuredContent as any).data.claim?.token, undefined);
    assert.equal(
      (reviewer.structuredContent as any).data.authorization_binding,
      undefined,
      'Ordinary reads do not opt in.',
    );
    session.actor = 'worker';
    session.profile = 'executor';
    await f.storage.transaction(f.project.id, (tx) => tx.put('members', member));
    const start = f.calls.length;
    await manifest.context(f.input, 'execution');
    assert.equal(
      f.calls[start]!.arguments.if_none_match,
      undefined,
      'Failed recovery clears retained state.',
    );
  });

it('rechecks revisions, checkpoint identities, access and mutation fences instead of trusting a manifest', async (t) => {
  const f = await setup(t);
  const client = await f.connect();
  const manifest = createContextManifest(client);
  const first = await manifest.context(f.input, 'execution');
  const active = f.initialClaim;
  const checkpoint = (await f.call(f.worker.id, 'ticket_checkpoint', {
    ticket_id: f.ticket.id,
    claim_token: active.claim.token,
    progress: 'New checkpoint replaces the previously retained exact version. '.repeat(200),
    decisions: ['Use the newest checkpoint.'],
  })) as any;
  const changed = await manifest.context(f.input, 'execution');
  assert.notEqual(changed.context.fingerprint, first.context.fingerprint);
  assert.ok(changed.retrieved.some((item: any) => item.data.id === checkpoint.checkpoint.id));
  await f.call(f.worker.id, 'ticket_update', {
    ticket_id: f.ticket.id,
    expected_revision: checkpoint.ticket.revision,
    description: 'Current revision requires an independent owner check.',
  });
  const stale = await client.callTool({
    name: 'ticket_submit',
    arguments: {
      project_id: f.project.id,
      ticket_id: f.ticket.id,
      claim_token: active.claim.token,
      expected_revision: checkpoint.ticket.revision,
      idempotency_key: randomUUID(),
      summary: 'Stale retained context cannot authorize this mutation.',
      evidence: (await f.read(f.ticket.id)).criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Old result.',
        references: ['https://example.test/old'],
      })),
    },
  });
  assert.equal((stale.structuredContent as any).error.code, 'VERSION_CONFLICT');
  const current = await manifest.context(f.input, 'execution');
  assert.equal(current.context.ticket.description, 'Current revision requires an independent owner check.');
  const member = (await f.storage.get('members', `${f.project.id}:${f.worker.id}`))!;
  await f.storage.transaction(f.project.id, (tx) => tx.remove('members', member.id));
  await assert.rejects(manifest.context(f.input, 'execution'), hasCode('FORBIDDEN'));
  await f.storage.transaction(f.project.id, (tx) => tx.put('members', member));
  const reauthorized = f.calls.length;
  const restored = await manifest.context(f.input, 'execution');
  assert.equal(f.calls[reauthorized]!.arguments.if_none_match, undefined);
  assert.equal(serializeSuccessEnvelope(restored), serializeSuccessEnvelope(current));
});

it('retains exact artifact bytes, counts budgeted pages, and refetches missing or changed material', async (t) => {
  const f = await setup(t);
  const manifest = createContextManifest(await f.connect());
  const first = await manifest.artifact(f.artifactInput);
  for (const call of f.calls)
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(call.data)) <= f.artifactInput.max_tokens);
  assert.ok(first.length > 1, 'A small response budget requires actual byte-range calls.');
  assert.deepEqual(Buffer.concat(first.map((page) => Buffer.from(page.range.data, 'base64'))), f.bytes);
  assert.equal(f.calls.length, first.length);
  const coldTokens = f.calls.reduce((sum, call) => sum + call.tokens, 0);
  const exact = serializeSuccessEnvelope(first);
  first[0]!.range.data = 'corrupt caller copy';
  const reused = await manifest.artifact(f.artifactInput);
  assert.equal(serializeSuccessEnvelope(reused), exact);
  assert.equal(f.calls.at(-1)!.arguments.length, 0);
  assert.ok(f.calls.at(-1)!.tokens < coldTokens);
  console.log(
    JSON.stringify({
      manifest_artifact_cold_calls: first.length,
      manifest_artifact_warm_calls: 1,
      manifest_artifact_cold_protocol_tokens: coldTokens,
      manifest_artifact_warm_protocol_tokens: f.calls.at(-1)!.tokens,
    }),
  );
  manifest.forget();
  const missingLocal = f.calls.length;
  await manifest.artifact(f.artifactInput);
  assert.equal(f.calls[missingLocal]!.arguments.length, f.bytes.length);
  assert.equal(f.calls.length - missingLocal, first.length);

  const member = (await f.storage.get('members', `${f.project.id}:${f.worker.id}`))!;
  await f.storage.transaction(f.project.id, (tx) => tx.remove('members', member.id));
  await assert.rejects(manifest.artifact(f.artifactInput), hasCode('FORBIDDEN'));
  await f.storage.transaction(f.project.id, (tx) => tx.put('members', member));
  const restored = f.calls.length;
  await manifest.artifact(f.artifactInput);
  assert.equal(f.calls[restored]!.arguments.length, f.bytes.length);

  const replacement = Buffer.from('new artifact bytes with a different size');
  await writeFile(join(f.path, 'stdout.log'), replacement);
  const journal = JSON.parse(await readFile(join(f.path, 'result.json'), 'utf8'));
  journal.bytes.stdout = journal.total_bytes.stdout = replacement.length;
  journal.sha256.stdout = createHash('sha256').update(replacement).digest('hex');
  await writeFile(join(f.path, 'result.json'), JSON.stringify(journal));
  const changed = f.calls.length;
  const refreshed = await manifest.artifact(f.artifactInput);
  assert.deepEqual(Buffer.from(refreshed[0]!.range.data, 'base64'), replacement);
  assert.deepEqual(
    f.calls.slice(changed).map((call) => call.arguments.length),
    [0, f.bytes.length],
  );
  assert.equal(refreshed[0]!.range.unavailable_reason, 'past_end');
  await rm(join(f.path, 'stdout.log'));
  const missing = f.calls.length;
  const unavailable = await manifest.artifact(f.artifactInput);
  assert.equal(unavailable[0]!.status, 'missing');
  assert.equal(unavailable[0]!.range.data, '');
  assert.deepEqual(
    f.calls.slice(missing).map((call) => call.arguments.length),
    [0, f.bytes.length],
  );
  await writeFile(join(f.path, 'stdout.log'), replacement);
  const back = f.calls.length;
  await manifest.artifact(f.artifactInput);
  assert.equal(f.calls[back]!.arguments.length, f.bytes.length);
});

it('refetches for actual same-transport bearer, profile and role changes and rejects mixed-actor pages', async (t) => {
  const f = await setup(t);
  const client = await f.connect();
  const session = f.sessions.get(client)!;
  const transport = client.transport;
  const instructions = client.getInstructions();
  const manifest = createContextManifest(client);
  let pages = await manifest.artifact(f.artifactInput);
  const reread = async () => {
    const previous = pages;
    const start = f.calls.length;
    pages = await manifest.artifact(f.artifactInput);
    assert.equal(client.transport, transport);
    assert.equal(client.getInstructions(), instructions);
    assert.deepEqual(
      f.calls.slice(start, start + 2).map((call) => call.arguments.length),
      [0, f.bytes.length],
    );
    assert.equal(f.calls.length - start, pages.length + 1, 'Every full reread is counted.');
    assert.notEqual(pages[0]!.authorization_binding, previous[0]!.authorization_binding);
    assert.deepEqual(Buffer.concat(pages.map((page) => Buffer.from(page.range.data, 'base64'))), f.bytes);
  };
  session.actor = 'reviewer';
  await reread();
  session.profile = 'full';
  await reread();
  const member = (await f.storage.get('members', `${f.project.id}:${f.reviewer.id}`))!;
  await f.storage.transaction(f.project.id, (tx) => tx.put('members', { ...member, role: 'reader' }));
  await reread();

  manifest.forget();
  session.actor = 'worker';
  const callTool = client.callTool.bind(client);
  let switched = false;
  client.callTool = async (request, ...rest) => {
    const response = await callTool(request, ...rest);
    if (!switched && request.name === 'artifact_read') {
      switched = true;
      session.actor = 'reviewer';
    }
    return response;
  };
  await assert.rejects(manifest.artifact(f.artifactInput), hasCode('INVALID_RESPONSE'));
  client.callTool = callTool;
  const start = f.calls.length;
  pages = await manifest.artifact(f.artifactInput);
  assert.equal(
    f.calls[start]!.arguments.length,
    f.bytes.length,
    'Mixed-actor pages cannot leave a cache hit.',
  );
  assert.deepEqual(Buffer.concat(pages.map((page) => Buffer.from(page.range.data, 'base64'))), f.bytes);
});

it('rejects mismatched checkpoint revisions and corrupt artifact pages without retaining partial proof', async (t) => {
  const f = await setup(t);
  const client = await f.connect();
  const callTool = client.callTool.bind(client);
  let corrupt: 'checkpoint' | 'artifact' | 'binding' | undefined = 'checkpoint';
  client.callTool = async (request, ...rest) => {
    const response = await callTool(request, ...rest);
    const data = (response.structuredContent as any)?.data;
    if (corrupt === 'checkpoint' && request.name === 'checkpoint_get') data.ticket_revision++;
    if (corrupt === 'artifact' && request.name === 'artifact_read' && request.arguments?.length)
      data.range.data = Buffer.from('corrupt bytes').toString('base64');
    if (corrupt === 'binding' && request.name === 'artifact_read') delete data.authorization_binding;
    return response;
  };
  const manifest = createContextManifest(client);
  await assert.rejects(manifest.context(f.input, 'execution'), hasCode('INVALID_RESPONSE'));
  corrupt = undefined;
  const retry = f.calls.length;
  await manifest.context(f.input, 'execution');
  assert.equal(f.calls[retry]!.arguments.if_none_match, undefined);
  corrupt = 'artifact';
  await assert.rejects(manifest.artifact(f.artifactInput), hasCode('INVALID_RESPONSE'));
  corrupt = 'binding';
  await assert.rejects(manifest.artifact(f.artifactInput), hasCode('INVALID_RESPONSE'));
  corrupt = undefined;
  const full = f.calls.length;
  const pages = await manifest.artifact(f.artifactInput);
  assert.equal(f.calls[full]!.arguments.length, f.bytes.length);
  assert.deepEqual(Buffer.concat(pages.map((page) => Buffer.from(page.range.data, 'base64'))), f.bytes);

  client.callTool = async (request, ...rest) => {
    const response = await callTool(request, ...rest);
    await client.close();
    await f.connect(client, 'reviewer', 'reviewer');
    return response;
  };
  await assert.rejects(manifest.context(f.input, 'execution'), hasCode('CONNECTION_CHANGED'));
  client.callTool = callTool;
  const switched = f.calls.length;
  await manifest.context(f.input, 'review');
  assert.equal(f.calls[switched]!.arguments.if_none_match, undefined);
});
