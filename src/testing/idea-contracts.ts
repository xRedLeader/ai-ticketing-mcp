import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DomainError, type Idea, type IdeaTicket } from '../contracts.js';
import { createHttpServer } from '../http.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

const proposal = {
  title: 'Avoid duplicate indexing',
  problem: 'Repeated indexing wastes time.',
  proposal: 'Reuse unchanged index documents.',
  why: 'Reduce processing and response delays.',
};
const delivery = (title: string, status: 'backlog' | 'ready' = 'backlog') => ({
  title,
  description: 'Implement the proposed improvement.',
  criteria: ['Unchanged input reuses its document.'],
  status,
});

export function registerIdeaContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  async function setup(t: import('node:test').TestContext) {
    const adapters = await factory();
    t.after(async () => {
      await adapters.dispose?.();
    });
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const create = async () => {
      const receipt = (await f.call(f.worker.id, 'idea_create', proposal)) as { id: string };
      return (await f.storage.get('ideas', receipt.id))!;
    };
    const get = (id: string) =>
      f.app.execute(f.worker.id, 'idea_get', {
        project_id: f.project.id,
        idea_id: id,
      }) as Promise<{ idea: Idea; tickets: IdeaTicket[] }>;
    return { ...f, create, get };
  }

  it(`${name} ideas: MCP intake, durable triage, role and scope authorization`, async (t) => {
    const f = await setup(t);
    await f.call(f.admin.id, 'member_set', { actor_id: f.outsider.id, role: 'reader' });
    const server = createHttpServer(f.app, {
      publicUrl: 'http://127.0.0.1',
      issuer: 'https://ideas.invalid',
      authenticate: async (authorization) => ({
        actorId: authorization!.slice('Bearer '.length).split(':')[0]!,
        scopes: new Set(
          authorization!.endsWith(':read') ? ['ticketing:read'] : ['ticketing:read', 'ticketing:write'],
        ),
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const clients: Client[] = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const connect = async (identity: string) => {
      const client = new Client({ name: 'ideas-contract', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp?profile=planner`),
          { requestInit: { headers: { Authorization: `Bearer ${identity}` } } },
        ),
      );
      return async (operation: string, args: Record<string, unknown>) => {
        const result = await client.callTool({
          name: operation,
          arguments: { project_id: f.project.id, ...args },
        });
        const envelope = result.structuredContent as any;
        if (!envelope.ok) throw new DomainError(envelope.error.code, envelope.error.message);
        return envelope.data;
      };
    };
    const call = await connect(f.worker.id);
    const reader = await connect(f.outsider.id);
    const readonly = await connect(`${f.worker.id}:read`);
    const idea = await call('idea_create', { ...proposal, idempotency_key: randomUUID() });
    assert.equal(idea.status, 'submitted');
    const parked = await call('idea_triage', {
      idea_id: idea.id,
      expected_revision: 1,
      action: 'park',
      rationale: 'Wait for profiling.',
      idempotency_key: randomUUID(),
    });
    assert.equal(parked.idea.revision, 2);
    await call('idea_triage', {
      idea_id: idea.id,
      expected_revision: 2,
      action: 'decline',
      rationale: 'Profiling shows no benefit.',
      idempotency_key: randomUUID(),
    });
    assert.equal((await f.get(idea.id)).idea.decided_by, f.worker.id);
    assert.equal(
      (await reader('idea_get', { idea_id: idea.id })).idea.rationale,
      'Profiling shows no benefit.',
    );
    assert.deepEqual(
      (await reader('idea_list', { status: 'declined' })).ideas.map((item: Idea) => item.id),
      [idea.id],
    );
    await assert.rejects(
      reader('idea_create', { ...proposal, idempotency_key: randomUUID() }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      reader('idea_triage', {
        idea_id: idea.id,
        expected_revision: 3,
        action: 'park',
        rationale: 'No authority.',
        idempotency_key: randomUUID(),
      }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      readonly('idea_create', { ...proposal, idempotency_key: randomUUID() }),
      hasCode('INSUFFICIENT_SCOPE'),
    );
    assert.equal((await f.storage.find('tickets', { where: { project_id: f.project.id } })).length, 0);
    assert.deepEqual(await f.app.execute(f.worker.id, 'work_next', { project_id: f.project.id }), {
      tickets: [],
    });
    const decisions = await f.storage.find('events', {
      where: { project_id: f.project.id, entity_id: idea.id, type: 'idea.triaged' },
    });
    assert.equal(decisions.length, 2);
    assert.ok(decisions.some((event) => event.data.rationale === 'Wait for profiling.'));
  });

  it(`${name} ideas: atomic multi-ticket promotion, provenance, idempotent retries and stale fencing`, async (t) => {
    const f = await setup(t);
    const idea = await f.create();
    const input = {
      idea_id: idea.id,
      expected_revision: 1,
      action: 'promote',
      rationale: 'Measured improvement.',
      tickets: [delivery('Reuse documents', 'ready'), delivery('Document behavior')],
      idempotency_key: randomUUID(),
    };
    const promote = () =>
      f.call(f.worker.id, 'idea_triage', input) as Promise<{ idea: Idea; tickets: IdeaTicket[] }>;
    const [first, retry] = await Promise.all([promote(), promote()]);
    assert.deepEqual(first, retry);
    assert.equal(first.idea.status, 'promoted');
    assert.equal(first.tickets.length, 2);
    for (const link of first.tickets) {
      const ticket = await f.read(link.ticket_id);
      assert.deepEqual(ticket.source_idea, link);
      assert.equal(link.idea_id, idea.id);
      assert.equal(link.idea_revision, 2);
      assert.equal(ticket.criteria.length, 1);
      await assert.rejects(f.storage.transaction(f.project.id, (tx) => tx.put('idea_tickets', link)));
      await assert.rejects(f.storage.transaction(f.project.id, (tx) => tx.remove('idea_tickets', link.id)));
    }
    assert.equal((await f.get(idea.id)).tickets.length, 2);
    const candidates = (await f.app.execute(f.worker.id, 'work_next', { project_id: f.project.id })) as any;
    assert.equal(candidates.tickets.length, 1);
    await assert.rejects(
      f.call(f.worker.id, 'idea_triage', {
        idea_id: idea.id,
        expected_revision: 1,
        rationale: 'A stale decision.',
        idempotency_key: randomUUID(),
        action: 'park',
      }),
      hasCode('VERSION_CONFLICT'),
    );
    await assert.rejects(
      f.call(f.worker.id, 'idea_triage', { ...input, expected_revision: 2, idempotency_key: randomUUID() }),
      hasCode('INVALID_STATE'),
    );
    await assert.rejects(
      f.call(f.worker.id, 'idea_triage', { ...input, rationale: 'Changed retry.' }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'reader' });
    await assert.rejects(promote(), hasCode('FORBIDDEN'));
    assert.equal((await f.storage.find('tickets', { where: { project_id: f.project.id } })).length, 2);
  });

  it(`${name} ideas: failed promotion rolls back decision, tickets, criteria, provenance, events and receipt`, async (t) => {
    const f = await setup(t);
    const idea = await f.create();
    const before = await f.storage.get('projects', f.project.id);
    const input = {
      idea_id: idea.id,
      expected_revision: 1,
      action: 'promote',
      rationale: 'Split implementation.',
      tickets: [delivery('First'), { ...delivery('Invalid second'), parent_id: randomUUID() }],
      idempotency_key: randomUUID(),
    };
    await assert.rejects(f.call(f.worker.id, 'idea_triage', input), hasCode('NOT_FOUND'));
    assert.deepEqual(await f.get(idea.id), { idea, tickets: [] });
    for (const table of ['tickets', 'criteria', 'idea_tickets', 'jobs'] as const)
      assert.equal((await f.storage.find(table, { where: { project_id: f.project.id } })).length, 0);
    assert.deepEqual(await f.storage.get('projects', f.project.id), before);
    assert.equal(
      (await f.storage.find('receipts', { where: { project_id: f.project.id, operation: 'idea_triage' } }))
        .length,
      0,
    );
    assert.equal(
      (await f.storage.find('events', { where: { project_id: f.project.id, type: 'idea.triaged' } })).length,
      0,
    );
    const corrected = (await f.call(f.worker.id, 'idea_triage', {
      ...input,
      tickets: [delivery('Corrected')],
    })) as any;
    assert.equal(corrected.tickets.length, 1);
  });

  it(`${name} ideas: concurrent decisions and cross-project references are fenced`, async (t) => {
    const f = await setup(t);
    const idea = await f.create();
    const outcomes = await Promise.allSettled([
      f.call(f.worker.id, 'idea_triage', {
        idea_id: idea.id,
        expected_revision: 1,
        action: 'park',
        rationale: 'Later.',
      }),
      f.call(f.other.id, 'idea_triage', {
        idea_id: idea.id,
        expected_revision: 1,
        action: 'promote',
        rationale: 'Now.',
        tickets: [delivery('Implement')],
      }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const failed = outcomes.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    assert.ok(hasCode('VERSION_CONFLICT')(failed.reason));
    const foreign = (await f.app.execute(f.admin.id, 'project_create', {
      key: `I${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      name: 'Other project',
      idempotency_key: randomUUID(),
    })) as any;
    await assert.rejects(
      f.app.execute(f.worker.id, 'idea_get', { project_id: foreign.id, idea_id: idea.id }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.app.execute(f.admin.id, 'idea_get', { project_id: foreign.id, idea_id: idea.id }),
      hasCode('NOT_FOUND'),
    );
    await assert.rejects(
      f.app.execute(f.admin.id, 'idea_triage', {
        project_id: foreign.id,
        idea_id: idea.id,
        expected_revision: 2,
        action: 'decline',
        rationale: 'Wrong project.',
        idempotency_key: randomUUID(),
      }),
      hasCode('NOT_FOUND'),
    );
    const ticket = await f.ticket();
    await assert.rejects(
      f.storage.transaction(foreign.id, (tx) =>
        tx.put('idea_tickets', {
          id: randomUUID(),
          project_id: foreign.id,
          idea_id: idea.id,
          idea_revision: 2,
          ticket_id: ticket.id,
        }),
      ),
    );
    assert.equal((await f.get(idea.id)).idea.revision, 2);
  });

  it(`${name} ideas: adapters without intake retain ticket reads`, async (t) => {
    const f = await setup(t);
    const ticket = await f.ticket();
    Object.defineProperty(f.storage, 'ideaIntake', { value: undefined });
    assert.equal((await f.read(ticket.id)).ticket.id, ticket.id);
    await assert.rejects(f.create(), hasCode('UNSUPPORTED_IDEAS'));
  });

  it(`${name} ideas: every stored proposal field pins native artifact references`, async (t) => {
    const f = await setup(t);
    for (const field of ['title', 'problem', 'proposal', 'why', 'rationale']) {
      const run = randomUUID(),
        attempt = randomUUID();
      const reference = `execution:${run}:${attempt}:stdout`;
      const input = { ...proposal, ...(field !== 'rationale' ? { [field]: reference } : {}) };
      const created = (await f.call(f.worker.id, 'idea_create', input)) as { id: string };
      assert.equal('problem' in created, false);
      if (field === 'rationale')
        await f.call(f.worker.id, 'idea_triage', {
          idea_id: created.id,
          expected_revision: 1,
          action: 'park',
          rationale: reference,
        });
      assert.equal(
        await f.storage.transaction(f.project.id, (tx) =>
          tx.artifactPinned!({
            run_id: run,
            attempt_id: attempt,
            ticket_id: randomUUID(),
            checkpoint_id: randomUUID(),
          }),
        ),
        true,
        `${field} must pin its citation independently of compact receipts`,
      );
    }
  });
}
