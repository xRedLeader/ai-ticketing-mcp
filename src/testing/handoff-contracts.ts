import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication } from '../application.js';
import { ClientCapabilities } from '../client-capabilities.js';
import { DomainError } from '../contracts.js';
import { createHttpServer } from '../http.js';
import { readOperations, schemas, type Operation } from '../schemas.js';
import { countReferenceTokens } from '../tokens.js';
import { serializeSuccessEnvelope } from '../envelope.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerHandoffContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  async function setup(t: import('node:test').TestContext, pinned = false) {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const clientCapabilities = pinned
      ? new ClientCapabilities({
          clients: [
            {
              id: 'source-only',
              actor_ids: [f.worker.id],
              project_ids: [f.project.id],
              operating_system: 'linux',
              tools: ['git'],
              environments: ['local'],
              models: [{ id: 'pinned-model', efforts: ['high'] }],
              expires_at: new Date(f.clock.now.getTime() + 600000).toISOString(),
            },
            {
              id: 'recipient',
              actor_ids: [f.other.id],
              project_ids: [f.project.id],
              operating_system: 'linux',
              tools: ['git'],
              environments: ['local'],
              models: [{ id: 'other-model', efforts: ['low'] }],
              expires_at: new Date(f.clock.now.getTime() + 600000).toISOString(),
            },
          ],
        })
      : undefined;
    const options = {
      ...adapters,
      now: () => f.clock.now,
      executionRecipes: [{ id: 'verify', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
      clientCapabilities,
    };
    const app = createApplication(options);
    const clients: Client[] = [];
    const received = new Map<string, unknown[]>();
    const servers: ReturnType<typeof createHttpServer>[] = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (adapters.dispose) await adapters.dispose();
      else {
        await adapters.search.close();
        await adapters.storage.close();
      }
    });
    const listen = async (application = app) => {
      const server = createHttpServer(application, {
        publicUrl: 'http://127.0.0.1',
        issuer: 'https://handoff.invalid',
        authenticate: async (authorization) => ({
          actorId: authorization!.slice('Bearer '.length),
          scopes: new Set(['ticketing:read', 'ticketing:write']),
        }),
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    };
    const base = await listen();
    const connect = async (actorId: string, url = base) => {
      const client = new Client({ name: `handoff-${name}`, version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${actorId}` } },
        }),
      );
      const call = async (operation: Operation, args: Record<string, unknown> = {}): Promise<any> => {
        const result = await client.callTool({
          name: operation,
          arguments: {
            project_id: f.project.id,
            ...(!readOperations.has(operation) ? { idempotency_key: randomUUID() } : {}),
            ...args,
          },
        });
        const envelope = result.structuredContent as any;
        received.set(actorId, [...(received.get(actorId) ?? []), envelope]);
        if (!envelope.ok)
          throw new DomainError(envelope.error.code, envelope.error.message, envelope.error.details);
        return envelope.data;
      };
      return { client, call };
    };
    const source = await connect(f.worker.id);
    const recipient = await connect(f.other.id);
    const ticket = await f.ticket(
      pinned ? { execution_hints: { client_id: 'source-only', model: 'pinned-model', effort: 'high' } } : {},
    );
    const claimKey = randomUUID();
    const claimArgs = { ticket_id: ticket.id, idempotency_key: claimKey };
    const claimed = await source.call('work_claim', claimArgs);
    const offer = (changes: Record<string, unknown> = {}) =>
      source.call('ticket_checkpoint', {
        ticket_id: ticket.id,
        claim_token: claimed.claim.token,
        progress: 'Preserve the earlier investigation and exact workspace identity. '.repeat(220),
        remaining: ['Finish the owner check and independently verify every current criterion.'],
        decisions: ['Keep the current trust boundary.'],
        references: [],
        handoff: { recipient_id: f.other.id, workspace_id: 'run-1-attempt-1', commit: 'a'.repeat(40) },
        ...changes,
      });
    const acknowledge = (checkpoint: string, changes: Record<string, unknown> = {}) =>
      recipient.call('work_claim', {
        ticket_id: ticket.id,
        handoff_checkpoint_id: checkpoint,
        max_tokens: 1600,
        ...changes,
      });
    return {
      ...f,
      app,
      options,
      source,
      recipient,
      createTicket: f.ticket,
      ticket,
      claimed,
      claimArgs,
      offer,
      acknowledge,
      connect,
      listen,
      received,
      base,
    };
  }

  it(`${name} handoff: preserves one owner through offer, budget rollback and interrupted acknowledgment`, async (t) => {
    const f = await setup(t);
    const heartbeat = {
      ticket_id: f.ticket.id,
      claim_token: f.claimed.claim.token,
      idempotency_key: randomUUID(),
    };
    await f.source.call('work_heartbeat', heartbeat);
    const offered = await f.offer();
    const generation = (await f.storage.get('claim_handoffs', offered.checkpoint.id))!;
    const before = await f.storage.get('claims', f.ticket.id);
    const view = await f.recipient.call('ticket_context', { ticket_id: f.ticket.id });
    assert.equal(view.claim.actor_id, f.worker.id);
    assert.equal(view.claim.token, undefined);
    await assert.rejects(
      f.recipient.call('work_claim', { ticket_id: f.ticket.id }),
      hasCode('NOT_CLAIMABLE'),
    );
    await assert.rejects(
      f.acknowledge(offered.checkpoint.id, { max_tokens: 512 }),
      hasCode('CONTEXT_TOO_LARGE'),
    );
    assert.deepEqual(await f.storage.get('claims', f.ticket.id), before);
    const receipts = await f.storage.find('receipts', {
      where: { actor_id: f.other.id, project_id: f.project.id },
    });
    assert.equal(receipts.length, 0);

    const key = randomUUID();
    const taken = await f.acknowledge(offered.checkpoint.id, { idempotency_key: key });
    assert.notEqual(taken.claim.token, f.claimed.claim.token);
    assert.equal(taken.claim.actor_id, f.other.id);
    assert.equal(taken.handoff.checkpoint_id, offered.checkpoint.id);
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(taken)) <= 1600);
    assert.equal(taken.context.ticket.description, f.ticket.description);
    const { tools } = await f.recipient.client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    assert.ok(
      countReferenceTokens(
        JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ),
      ) <= 5000,
    );
    const required = taken.context.omitted.filter((item: any) => item.required_before === 'execution');
    assert.ok(
      required.some(
        (item: any) =>
          item.retrieve_with === 'checkpoint_get' && item.arguments.checkpoint_id === offered.checkpoint.id,
      ),
    );
    const material: any[] = [];
    for (const omission of required) {
      assert.ok(names.has(omission.retrieve_with));
      let args = omission.arguments;
      for (;;) {
        const page = await f.recipient.call(omission.retrieve_with, args);
        material.push(page);
        if (!page.has_more) break;
        assert.ok(page.next_offset > (args.offset ?? 0));
        args = { ...args, offset: page.next_offset };
      }
    }
    const checkpoint = material.find((item) => item.id === offered.checkpoint.id);
    assert.deepEqual(checkpoint.metadata.handoff, {
      recipient_id: f.other.id,
      workspace_id: 'run-1-attempt-1',
      commit: 'a'.repeat(40),
    });
    assert.deepEqual(checkpoint.metadata.remaining, [
      'Finish the owner check and independently verify every current criterion.',
    ]);
    const wire = JSON.stringify(f.received.get(f.other.id));
    assert.equal(wire.includes(f.claimed.claim.token), false);
    assert.equal(wire.includes(generation.source_claim_hash), false);

    await f.recipient.client.close();
    const restarted = await f.connect(f.other.id, await f.listen(createApplication(f.options)));
    assert.deepEqual(
      await restarted.call('work_claim', {
        ticket_id: f.ticket.id,
        handoff_checkpoint_id: offered.checkpoint.id,
        max_tokens: 1600,
        idempotency_key: key,
      }),
      taken,
    );
    assert.equal((await f.storage.find('claims', { where: { ticket_id: f.ticket.id } })).length, 1);
    assert.equal((await f.storage.get('claims', f.ticket.id))!.token, taken.claim.token);
    await assert.rejects(f.source.call('work_claim', f.claimArgs), hasCode('HANDOFF_STALE'));
    await assert.rejects(f.source.call('work_heartbeat', heartbeat), hasCode('HANDOFF_STALE'));
    const progress = await restarted.call('ticket_checkpoint', {
      ticket_id: f.ticket.id,
      claim_token: taken.claim.token,
      progress: 'Recipient now publishes the authoritative progress.',
    });
    const recipientHeartbeat = {
      ticket_id: f.ticket.id,
      claim_token: taken.claim.token,
      idempotency_key: randomUUID(),
    };
    await restarted.call('work_heartbeat', recipientHeartbeat);
    await assert.rejects(
      f.source.call('ticket_submit', {
        ticket_id: f.ticket.id,
        claim_token: f.claimed.claim.token,
        expected_revision: progress.ticket.revision,
        summary: 'Old owner cannot publish evidence.',
        evidence: taken.context.criteria.map((criterion: any) => ({
          criterion_id: criterion.id,
          result: 'pass',
          summary: 'Old evidence.',
          references: ['https://example.test/old'],
        })),
      }),
      hasCode('CLAIM_EXPIRED'),
    );
    for (const operation of ['ticket_checkpoint', 'work_release'] as const)
      await assert.rejects(
        f.source.call(operation, {
          ticket_id: f.ticket.id,
          claim_token: f.claimed.claim.token,
          ...(operation === 'ticket_checkpoint'
            ? { progress: 'Old publication.' }
            : { reason: 'Old release.' }),
        }),
        hasCode('CLAIM_EXPIRED'),
      );
    await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'reader' });
    await assert.rejects(
      restarted.call('work_claim', {
        ticket_id: f.ticket.id,
        handoff_checkpoint_id: offered.checkpoint.id,
        max_tokens: 1600,
        idempotency_key: key,
      }),
      hasCode('FORBIDDEN'),
    );
    await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'contributor' });
    await restarted.call('work_release', {
      ticket_id: f.ticket.id,
      claim_token: taken.claim.token,
      reason: 'Deliberate recipient release.',
    });
    await assert.rejects(restarted.call('work_heartbeat', recipientHeartbeat), hasCode('HANDOFF_STALE'));
    await assert.rejects(
      restarted.call('work_claim', {
        ticket_id: f.ticket.id,
        handoff_checkpoint_id: offered.checkpoint.id,
        max_tokens: 1600,
        idempotency_key: key,
      }),
      hasCode('HANDOFF_STALE'),
    );
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) => tx.put('claim_handoffs', generation)),
      hasCode('CONFLICT'),
    );
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) => tx.remove('claim_handoffs', generation.id)),
      hasCode('IMMUTABLE_HANDOFF'),
    );
  });

  it(`${name} handoff: includes exact handoff material inline when the budget permits`, async (t) => {
    const f = await setup(t);
    const offered = await f.offer({
      progress: 'The exact workspace and remaining responsibility are ready.',
    });
    const taken = await f.acknowledge(offered.checkpoint.id, { max_tokens: 32768 });
    assert.equal(taken.context.latest_checkpoint.id, offered.checkpoint.id);
    assert.equal(taken.context.latest_checkpoint.metadata.handoff.workspace_id, 'run-1-attempt-1');
    assert.equal(taken.context.latest_checkpoint.metadata.handoff.commit, 'a'.repeat(40));
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(taken)) <= 32768);
  });

  it(`${name} handoff: serializes recipient acknowledgment against old-owner publication`, async (t) => {
    const f = await setup(t);
    const offered = await f.offer();
    const [publication, acknowledgment] = await Promise.allSettled([
      f.source.call('ticket_checkpoint', {
        ticket_id: f.ticket.id,
        claim_token: f.claimed.claim.token,
        progress: 'Source publication races acknowledgment.',
      }),
      f.acknowledge(offered.checkpoint.id),
    ]);
    assert.equal(
      Number(publication.status === 'fulfilled') + Number(acknowledgment.status === 'fulfilled'),
      1,
    );
    const current = (await f.storage.get('claims', f.ticket.id))!;
    if (acknowledgment.status === 'fulfilled') {
      assert.equal(current.actor_id, f.other.id);
      assert.equal(current.token, acknowledgment.value.claim.token);
      assert.equal(publication.status, 'rejected');
      assert.equal((publication as PromiseRejectedResult).reason.code, 'CLAIM_EXPIRED');
    } else {
      assert.equal(acknowledgment.reason.code, 'HANDOFF_STALE');
      assert.equal(current.token, f.claimed.claim.token);
    }
  });

  it(`${name} handoff: allows only one generation across simultaneous acknowledgments`, async (t) => {
    const f = await setup(t);
    const offered = await f.offer();
    const results = await Promise.allSettled([
      f.acknowledge(offered.checkpoint.id),
      f.acknowledge(offered.checkpoint.id),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failed.reason.code, 'HANDOFF_STALE');
    const success = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
    assert.equal((await f.storage.get('claims', f.ticket.id))!.token, success.value.claim.token);
  });

  for (const change of [
    'release',
    'requirements',
    'source_revoked',
    'recipient_revoked',
    'checkpoint',
    'expiry',
    'blocker',
  ] as const)
    it(`${name} handoff: rejects ${change} changes without replacing ownership`, async (t) => {
      const f = await setup(t);
      const offered = await f.offer();
      const planner = await f.connect(f.worker.id, `${f.base}?profile=planner`);
      if (change === 'release')
        await f.source.call('work_release', {
          ticket_id: f.ticket.id,
          claim_token: f.claimed.claim.token,
          reason: 'Released before acknowledgment.',
        });
      if (change === 'requirements')
        await planner.call('ticket_update', {
          ticket_id: f.ticket.id,
          expected_revision: offered.ticket.revision,
          criteria: ['Changed criterion.'],
        });
      if (change === 'source_revoked' || change === 'recipient_revoked')
        await f.call(f.admin.id, 'member_set', {
          actor_id: change === 'source_revoked' ? f.worker.id : f.other.id,
          role: 'reader',
        });
      if (change === 'checkpoint')
        await f.source.call('ticket_checkpoint', {
          ticket_id: f.ticket.id,
          claim_token: f.claimed.claim.token,
          progress: 'New work invalidates the old offered snapshot.',
        });
      if (change === 'expiry') f.clock.now = new Date(f.clock.now.getTime() + 600001);
      if (change === 'blocker')
        await f.source.call('ticket_note', {
          ticket_id: f.ticket.id,
          kind: 'question',
          blocking: true,
          body: 'Resolve the new blocker.',
        });
      const before = await f.storage.get('claims', f.ticket.id);
      const events = await f.storage.find('events', { where: { project_id: f.project.id } });
      await assert.rejects(
        f.acknowledge(offered.checkpoint.id),
        hasCode(change.endsWith('revoked') ? 'FORBIDDEN' : 'HANDOFF_STALE'),
      );
      assert.deepEqual(await f.storage.get('claims', f.ticket.id), before);
      assert.deepEqual(await f.storage.find('events', { where: { project_id: f.project.id } }), events);
    });

  it(`${name} handoff: keeps recipient identity, assignment and exact client/model pins authoritative`, async (t) => {
    const f = await setup(t, true);
    const offered = await f.offer();
    const before = await f.storage.get('claims', f.ticket.id);
    await assert.rejects(
      f.source.call('work_claim', { ticket_id: f.ticket.id, handoff_checkpoint_id: offered.checkpoint.id }),
      hasCode('HANDOFF_STALE'),
    );
    await assert.rejects(
      f.acknowledge(offered.checkpoint.id, { client_id: 'recipient', capabilities: ['git'] }),
      hasCode('UNSUPPORTED_EXECUTION'),
    );
    assert.deepEqual(await f.storage.get('claims', f.ticket.id), before);
    const planner = await f.connect(f.worker.id, `${f.base}?profile=planner`);
    await planner.call('ticket_update', {
      ticket_id: f.ticket.id,
      expected_revision: offered.ticket.revision,
      assignee_id: f.worker.id,
    });
    await assert.rejects(f.offer(), hasCode('ASSIGNMENT_PINNED'));
  });

  it(`${name} handoff: rechecks current blockers, capability filters and exact target ticket`, async (t) => {
    const f = await setup(t);
    const question = await f.source.call('ticket_note', {
      ticket_id: f.ticket.id,
      kind: 'question',
      blocking: true,
      body: 'Resolve this before accepting responsibility.',
    });
    const blocked = await f.offer();
    const before = await f.storage.get('claims', f.ticket.id);
    await assert.rejects(f.acknowledge(blocked.checkpoint.id), hasCode('DEPENDENCY_BLOCKED'));
    assert.deepEqual(await f.storage.get('claims', f.ticket.id), before);
    await f.recipient.call('ticket_note', {
      ticket_id: f.ticket.id,
      kind: 'answer',
      answer_to: question.note.id,
      body: 'The blocker is resolved.',
    });
    const planner = await f.connect(f.worker.id, `${f.base}?profile=planner`);
    const current = await f.source.call('ticket_get', { ticket_id: f.ticket.id });
    await planner.call('ticket_update', {
      ticket_id: f.ticket.id,
      expected_revision: current.ticket.revision,
      capabilities: ['native-check'],
    });
    const offered = await f.offer();
    await assert.rejects(f.acknowledge(offered.checkpoint.id), hasCode('NOT_CLAIMABLE'));
    assert.deepEqual(await f.storage.get('claims', f.ticket.id), before);
    const otherTicket = await f.createTicket();
    await assert.rejects(
      f.acknowledge(offered.checkpoint.id, { ticket_id: otherTicket.id, capabilities: ['native-check'] }),
      hasCode('HANDOFF_STALE'),
    );
    const accepted = await f.acknowledge(offered.checkpoint.id, { capabilities: ['native-check'] });
    assert.equal(accepted.claim.actor_id, f.other.id);
  });

  it(`${name} handoff: validates artifact identities and refuses active execution responsibility`, async (t) => {
    const f = await setup(t);
    await assert.rejects(
      f.offer({ references: [`execution:${randomUUID()}:${randomUUID()}:stdout`] }),
      hasCode('INVALID_REFERENCE'),
    );
    const executor = await f.connect(f.worker.id, `${f.base}?profile=executor`);
    const submitted = await executor.call('run_submit', {
      ticket_id: f.ticket.id,
      claim_token: f.claimed.claim.token,
      recipe_id: 'verify',
      checkpoint: { progress: 'A registered run is queued.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    });
    await assert.rejects(f.offer(), hasCode('ACTIVE_EXECUTION'));
    const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60000))!;
    await f.app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60000);
    const attempt = (await f.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
    const artifact = `execution:${run.id}:${attempt.id}:result`;
    await f.app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
      exit_code: 0,
      signal: null,
      error_code: null,
      artifacts: [artifact],
    });
    const offered = await f.offer({ references: [artifact] });
    const taken = await f.acknowledge(offered.checkpoint.id, { max_tokens: 2400 });
    const checkpoint = await f.recipient.call('checkpoint_get', {
      checkpoint_id: taken.handoff.checkpoint_id,
    });
    assert.deepEqual(checkpoint.metadata.references, [artifact]);
  });

  it(`${name} handoff: validates explicit acknowledgment and path-free offers`, () => {
    const base = {
      project_id: randomUUID(),
      ticket_id: 'TASK-1',
      idempotency_key: randomUUID(),
      handoff_checkpoint_id: randomUUID(),
    };
    assert.equal(schemas.work_claim.safeParse({ ...base, include_context: false }).success, false);
    assert.equal(schemas.work_claim.safeParse({ ...base, ticket_id: undefined }).success, false);
    assert.equal(
      schemas.work_claim.safeParse({ ...base, handoff_checkpoint_id: '../not-an-id' }).success,
      false,
    );
    for (const workspace_id of ['../outside', 'C:\\outside', '/outside'])
      assert.equal(
        schemas.ticket_checkpoint.safeParse({
          project_id: base.project_id,
          ticket_id: base.ticket_id,
          idempotency_key: base.idempotency_key,
          claim_token: randomUUID(),
          progress: 'Offer',
          remaining: ['Work'],
          handoff: { recipient_id: randomUUID(), workspace_id, commit: 'a'.repeat(40) },
        }).success,
        false,
      );
  });
}
