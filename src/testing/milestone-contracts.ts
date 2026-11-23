import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../http.js';
import { createApplication } from '../application.js';
import type { Reader, StorageAdapter, Transaction } from '../contracts.js';
import { countReferenceTokens } from '../tokens.js';
import { fixture, hasCode, testEmbeddings, type ContractAdapters } from './contracts.js';

export function registerMilestoneContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  describe(`${name} milestones`, () => {
    const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
      it(title, async () => {
        const adapters = await factory();
        try {
          await adapters.storage.migrate();
          await adapters.search.configure(testEmbeddings.profile);
          await work(await setup(adapters));
        } finally {
          await adapters.dispose?.();
        }
      });

    async function setup(adapters: ContractAdapters) {
      const f = await fixture(adapters);
      const create = (overrides = {}) =>
        f.call(f.worker.id, 'milestone_create', {
          name: 'Secure delivery',
          outcome: 'Users can safely store their data.',
          exit_criteria: ['Current member requirements are accepted.', 'The rollout is verified.'],
          ...overrides,
        }) as Promise<any>;
      const get = (id: string, overrides = {}) =>
        f.app.execute(f.worker.id, 'milestone_get', {
          project_id: f.project.id,
          milestone_id: id,
          ...overrides,
        }) as Promise<any>;
      const set = (
        ticket: string,
        milestone: string | null,
        expected: string | null = null,
        overrides = {},
      ) =>
        f.call(f.worker.id, 'ticket_milestone_set', {
          ticket_id: ticket,
          milestone_id: milestone,
          expected_milestone_id: expected,
          ...overrides,
        }) as Promise<any>;
      const complete = async (id: string, overrides = {}) =>
        f.call(f.worker.id, 'milestone_complete', {
          milestone_id: id,
          expected_revision: (await get(id)).milestone.revision,
          confirm_exit_criteria: true,
          ...overrides,
        }) as Promise<any>;
      const accept = async (id: string) => {
        const claimed = await f.claim(id);
        const submitted = await f.submit(id, claimed.claim.token);
        await f.call(f.reviewer.id, 'ticket_review', {
          ticket_id: id,
          expected_revision: submitted.ticket.revision,
          submission_id: submitted.submission.id,
          decision: 'approve',
          feedback: 'Verified independently.',
        });
      };
      return { ...f, create, get, set, complete, accept };
    }

    check(
      'protects creation, updates and retries without requiring membership on existing tickets',
      async (f) => {
        const ticket = await f.ticket();
        assert.equal((await f.read(ticket.id)).milestone_id, null);
        const input = { idempotency_key: randomUUID() };
        const milestone = await f.create(input);
        assert.deepEqual(await f.create(input), milestone);
        await assert.rejects(f.create({ ...input, name: 'Changed retry' }), hasCode('IDEMPOTENCY_CONFLICT'));
        await assert.rejects(f.complete(milestone.id), hasCode('MILESTONE_INCOMPLETE'));
        const update = {
          milestone_id: milestone.id,
          expected_revision: 1,
          name: 'Verified delivery',
          idempotency_key: randomUUID(),
        };
        const updated = (await f.call(f.worker.id, 'milestone_update', update)) as any;
        assert.deepEqual(await f.call(f.worker.id, 'milestone_update', update), updated);
        assert.equal((await f.get(milestone.id)).milestone.name, 'Verified delivery');
        await assert.rejects(
          f.call(f.worker.id, 'milestone_update', { ...update, idempotency_key: randomUUID() }),
          hasCode('VERSION_CONFLICT'),
        );
        await assert.rejects(
          f.call(f.reviewer.id, 'milestone_update', { ...update, expected_revision: 2 }),
          hasCode('FORBIDDEN'),
        );
        await assert.rejects(
          f.app.execute(f.outsider.id, 'milestone_list', { project_id: f.project.id }),
          hasCode('FORBIDDEN'),
        );
        await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'reader' });
        const visible = (await f.app.execute(f.other.id, 'milestone_list', {
          project_id: f.project.id,
        })) as any;
        assert.equal(visible.items[0].id, milestone.id);
        await assert.rejects(
          f.call(f.other.id, 'milestone_create', {
            name: 'Forbidden',
            outcome: 'Forbidden',
            exit_criteria: ['Forbidden'],
          }),
          hasCode('FORBIDDEN'),
        );
        await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'reader' });
        await assert.rejects(f.create(input), hasCode('FORBIDDEN'));
      },
    );

    check(
      'moves a single membership without changing claims, acceptance, queues or dependencies',
      async (f) => {
        const ticket = await f.ticket();
        await f.claim(ticket.id);
        const before = await f.storage.get('tickets', ticket.id);
        const claim = await f.storage.get('claims', ticket.id);
        const jobs = await f.storage.find('jobs', { where: { project_id: f.project.id } });
        const first = await f.create();
        const second = await f.create({ name: 'Next delivery' });
        const input = { idempotency_key: randomUUID() };
        const assigned = await f.set(ticket.id, first.id, null, input);
        assert.deepEqual(await f.set(ticket.id, first.id, null, input), assigned);
        assert.equal((await f.read(ticket.id)).milestone_id, first.id);
        await assert.rejects(f.set(ticket.id, second.id), hasCode('VERSION_CONFLICT'));
        await f.set(ticket.key, second.id, first.id);
        assert.equal((await f.get(first.id)).milestone.progress.total, 0);
        assert.equal((await f.get(second.id)).milestone.progress.total, 1);
        assert.equal(
          (await f.storage.find('milestone_memberships', { where: { project_id: f.project.id } })).length,
          1,
        );
        await f.set(ticket.id, null, second.id);
        assert.equal((await f.read(ticket.id)).milestone_id, null);
        assert.deepEqual(await f.storage.get('tickets', ticket.id), before);
        assert.deepEqual(await f.storage.get('claims', ticket.id), claim);
        assert.deepEqual(await f.storage.find('jobs', { where: { project_id: f.project.id } }), jobs);
        assert.deepEqual(await f.storage.find('links', { where: { project_id: f.project.id } }), []);
      },
    );

    check('rejects foreign-project tickets and milestones at the API and storage boundary', async (f) => {
      const foreign = await fixture({ storage: f.storage, search: f.search });
      const foreignTicket = await foreign.ticket();
      const foreignMilestone = (await foreign.call(foreign.worker.id, 'milestone_create', {
        name: 'Private milestone',
        outcome: 'Private outcome',
        exit_criteria: ['Private criterion'],
      })) as any;
      const ticket = await f.ticket();
      const milestone = await f.create();
      await assert.rejects(f.set(ticket.id, foreignMilestone.id), hasCode('NOT_FOUND'));
      await assert.rejects(f.set(foreignTicket.id, milestone.id), hasCode('NOT_FOUND'));
      await assert.rejects(f.get(foreignMilestone.id), hasCode('NOT_FOUND'));
      await assert.rejects(
        f.call(f.worker.id, 'milestone_update', {
          milestone_id: foreignMilestone.id,
          expected_revision: 1,
          name: 'Overwrite',
        }),
        hasCode('NOT_FOUND'),
      );
      await assert.rejects(f.complete(foreignMilestone.id), hasCode('NOT_FOUND'));
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) =>
          tx.put('milestone_memberships', {
            id: ticket.id,
            project_id: f.project.id,
            milestone_id: foreignMilestone.id,
          }),
        ),
      );
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) =>
          tx.put('milestone_memberships', {
            id: foreignTicket.id,
            project_id: f.project.id,
            milestone_id: milestone.id,
          }),
        ),
      );
      assert.equal((await f.get(milestone.id)).milestone.progress.total, 0);
    });

    check('requires current acceptance and explicit confirmation, then reopens after changes', async (f) => {
      const ticket = await f.ticket();
      const milestone = await f.create();
      await f.set(ticket.id, milestone.id);
      await assert.rejects(f.complete(milestone.id), hasCode('MILESTONE_INCOMPLETE'));
      await f.accept(ticket.id);
      const accepted = await f.get(milestone.id);
      assert.equal(accepted.milestone.progress.accepted, 1);
      assert.equal(accepted.members[0].accepted, true);
      assert.equal(accepted.milestone.status, 'open');
      await assert.rejects(
        f.complete(milestone.id, { confirm_exit_criteria: false }),
        hasCode('INVALID_INPUT'),
      );
      const input = { expected_revision: accepted.milestone.revision, idempotency_key: randomUUID() };
      const completed = await f.complete(milestone.id, input);
      assert.deepEqual(await f.complete(milestone.id, input), completed);
      assert.equal((await f.get(milestone.id)).milestone.status, 'completed');
      const current = await f.storage.get('tickets', ticket.id);
      await f.call(f.worker.id, 'ticket_transition', {
        ticket_id: ticket.id,
        expected_revision: current!.revision,
        status: 'ready',
        reason: 'Recheck delivery.',
      });
      const reopened = await f.get(milestone.id);
      assert.equal(reopened.milestone.progress.accepted, 0);
      assert.equal(reopened.milestone.status, 'open');
      assert.equal(reopened.milestone.completed_at, null);
      await f.accept(ticket.id);
      assert.equal((await f.get(milestone.id)).milestone.status, 'open');
      await f.complete(milestone.id);
      const second = await f.ticket();
      await f.set(second.id, milestone.id);
      assert.equal((await f.get(milestone.id)).milestone.status, 'open');
      await f.set(second.id, null, milestone.id);
      assert.equal((await f.get(milestone.id)).milestone.status, 'open');
      await f.complete(milestone.id);
      await f.call(f.worker.id, 'milestone_update', {
        milestone_id: milestone.id,
        expected_revision: (await f.get(milestone.id)).milestone.revision,
        outcome: 'An updated intended outcome.',
      });
      assert.equal((await f.get(milestone.id)).milestone.status, 'open');
      const done = (await f.storage.get('tickets', ticket.id))!;
      await f.accept(second.id);
      const unrelated = (await f.storage.get('tickets', second.id))!;
      await f.storage.transaction(f.project.id, (tx) =>
        tx.put('tickets', { ...done, approved_submission_id: unrelated.approved_submission_id }),
      );
      assert.equal((await f.get(milestone.id)).milestone.progress.accepted, 0);
      await f.storage.transaction(f.project.id, (tx) =>
        tx.put('tickets', { ...done, requirements_revision: done.requirements_revision + 1 }),
      );
      assert.equal((await f.get(milestone.id)).milestone.progress.accepted, 0);
      assert.equal((await f.get(milestone.id)).members[0].accepted, false);
      await assert.rejects(f.complete(milestone.id), hasCode('MILESTONE_INCOMPLETE'));
      const history = await f.storage.find('events', {
        where: { project_id: f.project.id, type: 'milestone.completed' },
      });
      assert.equal(history.length, 3);
    });

    check('keeps core ticket operations available without optional milestone support', async (f) => {
      const guard = <T extends Reader>(reader: T): T =>
        new Proxy(reader, {
          get(target, property) {
            if (property === 'milestoneProgress') return undefined;
            const value = Reflect.get(target, property);
            if ((property === 'get' || property === 'find') && typeof value === 'function')
              return (table: string, ...args: any[]) => {
                assert.ok(
                  !table.startsWith('milestone'),
                  'Core ticket operations must not query milestone tables.',
                );
                return value.call(target, table, ...args);
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const storage = new Proxy(f.storage, {
        get(target, property) {
          if (property === 'milestones' || property === 'milestoneProgress') return undefined;
          if (property === 'transaction')
            return (scope: string, work: (tx: Transaction) => Promise<unknown>) =>
              target.transaction(scope, (tx) => work(guard(tx)));
          if (property === 'readSnapshot')
            return (work: (reader: Reader) => Promise<unknown>) =>
              target.readSnapshot((reader) => work(guard(reader)));
          return Reflect.get(guard(target), property);
        },
      }) as StorageAdapter;
      const app = createApplication({ storage, search: f.search });
      const ticket = await f.ticket();
      const read = (await app.execute(f.worker.id, 'ticket_get', {
        project_id: f.project.id,
        ticket_id: ticket.id,
      })) as any;
      assert.equal(read.milestone_id, undefined);
      await app.execute(f.worker.id, 'ticket_update', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        idempotency_key: randomUUID(),
        description: 'New current requirements',
      });
      await assert.rejects(
        app.execute(f.worker.id, 'milestone_list', { project_id: f.project.id }),
        hasCode('UNSUPPORTED_MILESTONES'),
      );
    });

    check('pins artifact citations held in milestone outcome and criteria', async (f) => {
      const created = await f.create();
      const milestone = (await f.storage.get('milestones', created.id))!;
      const query = {
        run_id: randomUUID(),
        attempt_id: randomUUID(),
        ticket_id: randomUUID(),
        checkpoint_id: randomUUID(),
      };
      await f.storage.transaction(f.project.id, async (tx) => {
        assert.equal(await tx.artifactPinned!(query), false);
        await tx.put('milestones', { ...milestone, outcome: `Inspect run ${query.run_id}` });
        assert.equal(await tx.artifactPinned!(query), true);
        await tx.put('milestones', { ...milestone, exit_criteria: [`Inspect attempt ${query.attempt_id}`] });
        assert.equal(await tx.artifactPinned!(query), true);
      });
    });

    check('aggregates beyond default storage pages and pages compact milestone members', async (f) => {
      const template = await f.ticket({ description: 'PRIVATE_LONG_REQUIREMENTS' });
      const milestone = await f.create({
        outcome: 'PRIVATE_OUTCOME',
        exit_criteria: ['PRIVATE_EXIT_CRITERIA'],
      });
      await f.storage.transaction(f.project.id, async (tx) => {
        for (let index = 0; index < 1005; index++) {
          const id = randomUUID();
          await tx.put('tickets', {
            ...template,
            id,
            key: `${template.key}-M${index}`,
            status: index < 1001 ? 'ready' : 'cancelled',
          });
          await tx.put('milestone_memberships', { id, project_id: f.project.id, milestone_id: milestone.id });
        }
      });
      const first = await f.get(milestone.id, { limit: 3 });
      assert.equal(first.members.length, 3);
      assert.equal(first.has_more, true);
      assert.equal(first.next_offset, 3);
      assert.equal(first.milestone.progress.total, 1005);
      assert.equal(first.milestone.progress.status_counts.ready, 1001);
      assert.equal(first.milestone.progress.status_counts.cancelled, 4);
      const last = await f.get(milestone.id, { limit: 10, offset: 1000 });
      assert.equal(last.members.length, 5);
      assert.equal(last.has_more, false);
      assert.equal(last.next_offset, 1005);
      assert.equal(JSON.stringify(first.members).includes('PRIVATE_LONG_REQUIREMENTS'), false);
      const other = await f.create({ name: 'Second milestone' });
      const list = (await f.app.execute(f.worker.id, 'milestone_list', {
        project_id: f.project.id,
        limit: 1,
      })) as any;
      assert.equal(list.items.length, 1);
      assert.equal(list.has_more, true);
      const next = (await f.app.execute(f.worker.id, 'milestone_list', {
        project_id: f.project.id,
        limit: 1,
        offset: list.next_offset,
      })) as any;
      assert.equal(next.has_more, false);
      assert.deepEqual(new Set([list.items[0].id, next.items[0].id]), new Set([milestone.id, other.id]));
      assert.equal(JSON.stringify(list).includes('PRIVATE_OUTCOME'), false);
      assert.equal(JSON.stringify(list).includes('PRIVATE_EXIT_CRITERIA'), false);
      assert.ok(countReferenceTokens(JSON.stringify(first)) < 1500);
    });

    check('serves actual planner MCP tools, compact pages and read/write scope boundaries', async (f) => {
      const server = createHttpServer(f.app, {
        publicUrl: 'http://127.0.0.1',
        issuer: 'http://127.0.0.1/test',
        authenticate: async (authorization) => ({
          actorId: f.worker.id,
          scopes: new Set(
            authorization === 'Bearer read-only' ? ['ticketing:read'] : ['ticketing:read', 'ticketing:write'],
          ),
        }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp?profile=planner`;
      const client = new Client({ name: 'milestone-contract', version: '1.0.0' });
      const reader = new Client({ name: 'milestone-reader', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(base)));
        await reader.connect(
          new StreamableHTTPClientTransport(new URL(base), {
            requestInit: { headers: { Authorization: 'Bearer read-only' } },
          }),
        );
        const tools = (await client.listTools()).tools;
        for (const name of [
          'milestone_create',
          'milestone_update',
          'milestone_complete',
          'ticket_milestone_set',
          'milestone_list',
          'milestone_get',
        ])
          assert.ok(tools.find((tool) => tool.name === name)?.outputSchema);
        const input = {
          project_id: f.project.id,
          idempotency_key: randomUUID(),
          name: 'MCP delivery',
          outcome: 'A usable result',
          exit_criteria: ['Verified result'],
        };
        const result = await client.callTool({ name: 'milestone_create', arguments: input });
        const milestone = (result.structuredContent as any).data;
        assert.ok(milestone.id);
        assert.deepEqual(
          (await client.callTool({ name: 'milestone_create', arguments: input })).structuredContent,
          result.structuredContent,
        );
        const ticket = await f.ticket();
        await client.callTool({
          name: 'ticket_milestone_set',
          arguments: {
            project_id: f.project.id,
            idempotency_key: randomUUID(),
            ticket_id: ticket.id,
            milestone_id: milestone.id,
            expected_milestone_id: null,
          },
        });
        const second = await f.ticket();
        await client.callTool({
          name: 'ticket_milestone_set',
          arguments: {
            project_id: f.project.id,
            idempotency_key: randomUUID(),
            ticket_id: second.id,
            milestone_id: milestone.id,
            expected_milestone_id: null,
          },
        });
        const view = await reader.callTool({
          name: 'milestone_get',
          arguments: { project_id: f.project.id, milestone_id: milestone.id, limit: 1 },
        });
        const page = (view.structuredContent as any).data;
        assert.equal(page.members.length, 1);
        assert.equal(page.has_more, true);
        assert.equal(page.milestone.progress.total, 2);
        const next = await reader.callTool({
          name: 'milestone_get',
          arguments: {
            project_id: f.project.id,
            milestone_id: milestone.id,
            limit: 1,
            offset: page.next_offset,
          },
        });
        assert.equal((next.structuredContent as any).data.has_more, false);
        assert.notEqual((next.structuredContent as any).data.members[0].id, page.members[0].id);
        assert.ok(countReferenceTokens(JSON.stringify(view)) < 2000);
        const updated = await client.callTool({
          name: 'milestone_update',
          arguments: {
            project_id: f.project.id,
            milestone_id: milestone.id,
            expected_revision: page.milestone.revision,
            idempotency_key: randomUUID(),
            name: 'Verified MCP delivery',
          },
        });
        await f.accept(ticket.id);
        await f.accept(second.id);
        const completed = await client.callTool({
          name: 'milestone_complete',
          arguments: {
            project_id: f.project.id,
            milestone_id: milestone.id,
            expected_revision: (updated.structuredContent as any).data.revision,
            idempotency_key: randomUUID(),
            confirm_exit_criteria: true,
          },
        });
        assert.equal((completed.structuredContent as any).ok, true);
        const destination = await client.callTool({
          name: 'milestone_create',
          arguments: { ...input, idempotency_key: randomUUID(), name: 'Followup delivery' },
        });
        const destinationId = (destination.structuredContent as any).data.id;
        const moved = await client.callTool({
          name: 'ticket_milestone_set',
          arguments: {
            project_id: f.project.id,
            idempotency_key: randomUUID(),
            ticket_id: ticket.id,
            milestone_id: destinationId,
            expected_milestone_id: milestone.id,
          },
        });
        assert.equal((moved.structuredContent as any).data.milestone_id, destinationId);
        const detached = await client.callTool({
          name: 'ticket_milestone_set',
          arguments: {
            project_id: f.project.id,
            idempotency_key: randomUUID(),
            ticket_id: ticket.id,
            milestone_id: null,
            expected_milestone_id: destinationId,
          },
        });
        assert.equal((detached.structuredContent as any).data.milestone_id, null);
        const listed = await reader.callTool({
          name: 'milestone_list',
          arguments: { project_id: f.project.id, limit: 1 },
        });
        assert.equal((listed.structuredContent as any).data.has_more, true);
        const denied = await reader.callTool({
          name: 'milestone_create',
          arguments: { ...input, idempotency_key: randomUUID() },
        });
        assert.equal((denied.structuredContent as any).error.code, 'INSUFFICIENT_SCOPE');
      } finally {
        await client.close();
        await reader.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });
}
