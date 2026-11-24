import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../application.js';
import { fixture, hasCode, testEmbeddings, type ContractAdapters } from './contracts.js';

export function registerSharedMemoryContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  describe(`${name} shared memory`, () => {
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
      await f.storage.transaction(f.project.id, (tx) =>
        tx.remove('members', `${f.project.id}:${f.other.id}`),
      );
      const destination = (await f.app.execute(f.admin.id, 'project_create', {
        key: `S${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
        name: 'Explicit shared scope',
        idempotency_key: randomUUID(),
      })) as any;
      for (const project of [f.project.id, destination.id])
        await f.app.execute(f.admin.id, 'member_set', {
          project_id: project,
          actor_id: f.worker.id,
          role: 'admin',
          idempotency_key: randomUUID(),
        });
      await f.app.execute(f.admin.id, 'member_set', {
        project_id: destination.id,
        actor_id: f.other.id,
        role: 'reader',
        idempotency_key: randomUUID(),
      });
      const ticket = await f.ticket({ description: 'PRIVATE_SOURCE_REQUIREMENTS' });
      const fact = { key: 'database.mode', value: 'transactions required' };
      const content = { title: 'PRIVATE_SOURCE_TITLE', body: 'PRIVATE_SOURCE_BODY', kind: 'convention' };
      const proposed = (await f.call(f.worker.id, 'knowledge_write', {
        ...content,
        fact,
        sources: [{ kind: 'ticket', id: ticket.id, revision: ticket.requirements_revision }],
      })) as any;
      const source = (await f.call(f.reviewer.id, 'knowledge_write', {
        ...content,
        knowledge_id: proposed.id,
        expected_revision: proposed.revision,
        status: 'accepted',
        verification: { state: 'verified', evidence: 'PRIVATE_SOURCE_REVIEW' },
      })) as any;
      const input = {
        project_id: destination.id,
        source_project_id: f.project.id,
        source_knowledge_id: source.id,
        source_revision: source.revision,
        fact,
        idempotency_key: randomUUID(),
      };
      const embedded: string[] = [];
      const app = createApplication({
        ...adapters,
        now: () => f.clock.now,
        embeddings: {
          ...testEmbeddings,
          async embed(text, options) {
            embedded.push(text);
            return testEmbeddings.embed(text, options);
          },
        },
      });
      const promote = (actor = f.worker.id, overrides = {}) =>
        app.execute(actor, 'knowledge_promote', { ...input, ...overrides }) as Promise<any>;
      const list = (actor = f.other.id, project = destination.id) =>
        app.execute(actor, 'knowledge_shared_list', { project_id: project }) as Promise<any>;
      return { ...f, app, embedded, destination, ticket, source, content, fact, input, promote, list };
    }
    check(
      'shares only the selected fact, keeps private provenance scoped, and never indexes it',
      async (f) => {
        const jobs = await f.storage.find('jobs', { where: { project_id: f.destination.id } });
        const shared = await f.promote();
        assert.deepEqual(await f.promote(), shared);
        const visible = await f.list();
        assert.deepEqual(visible.items[0].fact, f.fact);
        assert.equal(visible.items[0].trusted_reuse, true);
        assert.equal(visible.items[0].source, undefined);
        const wire = JSON.stringify(visible);
        for (const hidden of ['PRIVATE_SOURCE', f.project.id, f.source.id, f.ticket.id])
          assert.equal(wire.includes(hidden), false);
        const audited = await f.list(f.worker.id);
        assert.deepEqual(audited.items[0].source, {
          project_id: f.project.id,
          knowledge_id: f.source.id,
          revision: f.source.revision,
        });
        await assert.rejects(f.list(f.outsider.id), hasCode('FORBIDDEN'));
        await assert.rejects(
          f.app.execute(f.other.id, 'knowledge_get', {
            project_id: f.project.id,
            knowledge_id: f.source.id,
          }),
          hasCode('FORBIDDEN'),
        );
        await assert.rejects(f.promote(f.other.id), hasCode('FORBIDDEN'));
        await f.app.execute(f.admin.id, 'member_set', {
          project_id: f.destination.id,
          actor_id: f.other.id,
          role: 'admin',
          idempotency_key: randomUUID(),
        });
        await assert.rejects(f.promote(f.other.id), hasCode('FORBIDDEN'));
        await f.app.execute(f.admin.id, 'member_set', {
          project_id: f.destination.id,
          actor_id: f.other.id,
          role: 'reader',
          idempotency_key: randomUUID(),
        });
        await assert.rejects(
          f.promote(f.worker.id, { source_knowledge_id: shared.promotion_id, idempotency_key: randomUUID() }),
          hasCode('NOT_FOUND'),
        );
        await assert.rejects(
          f.promote(f.worker.id, {
            fact: { ...f.fact, value: 'unsupported' },
            idempotency_key: randomUUID(),
          }),
          hasCode('INVALID_INPUT'),
        );
        await assert.rejects(
          f.promote(f.worker.id, { source_revision: 1, idempotency_key: randomUUID() }),
          hasCode('VERSION_CONFLICT'),
        );
        assert.deepEqual(await f.storage.find('jobs', { where: { project_id: f.destination.id } }), jobs);
        assert.deepEqual(f.embedded, []);
        assert.equal((await f.search.coverage(f.destination.id, testEmbeddings.profile)).documents, 0);
        const results = (await f.app.execute(f.other.id, 'search', {
          project_id: f.destination.id,
          query: 'PRIVATE_SOURCE',
        })) as any;
        assert.deepEqual(results.results, []);
        assert.ok(f.embedded.every((text) => text === 'PRIVATE_SOURCE'));
        const events = (await f.app.execute(f.other.id, 'changes_since', {
          project_id: f.destination.id,
        })) as any;
        assert.ok(
          events.events.some(
            (event: any) => event.type === 'knowledge.promoted' && event.entity_id === shared.promotion_id,
          ),
        );
        assert.equal(JSON.stringify(events).includes(f.source.id), false);
      },
    );
    check(
      'deactivates stale sources and revoked promoters on fresh reads without losing audit',
      async (f) => {
        const receipt = await f.promote();
        await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'reader' });
        const revoked = (await f.list()).items[0];
        assert.equal(revoked.status, 'access_revoked');
        assert.equal(revoked.fact, null);
        await assert.rejects(f.promote(), hasCode('FORBIDDEN'));
        assert.equal(JSON.stringify(receipt).includes(f.source.id), false);
        await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
        await f.call(f.worker.id, 'ticket_update', {
          ticket_id: f.ticket.id,
          expected_revision: f.ticket.revision,
          description: 'Changed private requirements.',
        });
        const stale = (await f.list()).items[0];
        assert.equal(stale.status, 'source_stale');
        assert.equal(stale.fact, null);
        assert.equal(stale.trusted_reuse, false);
        assert.ok(await f.storage.get('knowledge_promotions', receipt.promotion_id));
        await assert.rejects(
          f.promote(f.worker.id, { idempotency_key: randomUUID() }),
          hasCode('INVALID_REFERENCE'),
        );
        await f.storage.transaction(f.destination.id, (tx) =>
          tx.remove('members', `${f.destination.id}:${f.other.id}`),
        );
        await assert.rejects(f.list(), hasCode('FORBIDDEN'));
      },
    );
    check(
      'authorizes destination and source-owner withdrawal separately and preserves immutable audit',
      async (f) => {
        const destinationReceipt = await f.promote(f.worker.id, { idempotency_key: randomUUID() });
        await f.app.execute(f.worker.id, 'knowledge_withdraw', {
          project_id: f.destination.id,
          promotion_id: destinationReceipt.promotion_id,
          idempotency_key: randomUUID(),
        });
        const receipt = await f.promote();
        const withdraw = {
          project_id: f.destination.id,
          promotion_id: receipt.promotion_id,
          idempotency_key: randomUUID(),
        };
        const first = (await f.app.execute(f.other.id, 'knowledge_shared_list', {
          project_id: f.destination.id,
          limit: 1,
        })) as any;
        const second = (await f.app.execute(f.other.id, 'knowledge_shared_list', {
          project_id: f.destination.id,
          limit: 1,
          offset: first.next_offset,
        })) as any;
        assert.equal(first.has_more, true);
        assert.equal(second.has_more, false);
        assert.equal(
          new Set([...first.items, ...second.items].map((item: any) => item.promotion_id)).size,
          2,
        );
        await assert.rejects(f.app.execute(f.other.id, 'knowledge_withdraw', withdraw), hasCode('FORBIDDEN'));
        await f.storage.transaction(f.destination.id, (tx) =>
          tx.remove('members', `${f.destination.id}:${f.worker.id}`),
        );
        await assert.rejects(f.promote(), hasCode('FORBIDDEN'));
        await assert.rejects(
          f.app.execute(f.worker.id, 'knowledge_withdraw', withdraw),
          hasCode('FORBIDDEN'),
        );
        const ownerInput = { ...withdraw, source_project_id: f.project.id };
        const withdrawn = await f.app.execute(f.worker.id, 'knowledge_withdraw', ownerInput);
        assert.deepEqual(await f.app.execute(f.worker.id, 'knowledge_withdraw', ownerInput), withdrawn);
        await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'reader' });
        await assert.rejects(
          f.app.execute(f.worker.id, 'knowledge_withdraw', ownerInput),
          hasCode('FORBIDDEN'),
        );
        const visible = (await f.list()).items.find(
          (item: any) => item.promotion_id === receipt.promotion_id,
        );
        assert.equal(visible.status, 'withdrawn');
        assert.equal(visible.fact, null);
        assert.equal(visible.source, undefined);
        assert.equal(visible.withdrawn_by, f.worker.id);
        const stored = (await f.storage.get('knowledge_promotions', receipt.promotion_id))!;
        assert.deepEqual(stored.fact, f.fact);
        await assert.rejects(
          f.storage.transaction(f.destination.id, (tx) =>
            tx.put('knowledge_promotions', { ...stored, fact: { ...f.fact, value: 'changed' } }),
          ),
        );
        await assert.rejects(
          f.storage.transaction(f.destination.id, (tx) => tx.remove('knowledge_promotions', stored.id)),
        );
        const events = (await f.app.execute(f.other.id, 'changes_since', {
          project_id: f.destination.id,
        })) as any;
        assert.equal(events.events.filter((event: any) => event.type === 'knowledge.withdrawn').length, 2);
        assert.equal(JSON.stringify(events).includes(f.project.id), false);
      },
    );
  });
}
