import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket, SchedulingPolicy } from '../src/contracts.js';
import { fixture, type ContractAdapters } from '../src/testing/contracts.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const hour = 60 * 60 * 1000;
async function ticket(f: Fixture, age: number, fields: Partial<Ticket> = {}) {
  const created = await f.ticket({ priority: fields.priority ?? 3 });
  const value = {
    ...created,
    ...fields,
    created_at: new Date(f.clock.now.getTime() - age * hour).toISOString(),
    updated_at: f.clock.now.toISOString(),
  };
  await f.storage.transaction(f.project.id, (tx) => tx.put('tickets', value));
  return value;
}
async function link(f: Fixture, source: Ticket, target: Ticket, kind: 'blocks' | 'related' = 'blocks') {
  await f.storage.transaction(f.project.id, (tx) =>
    tx.put('links', {
      id: `${source.id}:${target.id}:${kind}`,
      project_id: f.project.id,
      source_id: source.id,
      target_id: target.id,
      kind,
    }),
  );
}
async function dependents(f: Fixture, source: Ticket, count: number) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const dependent = await ticket(f, 0, { status: 'backlog' });
    await link(f, source, dependent);
    result.push(dependent);
  }
  return result;
}
const ids = (tickets: Ticket[]) => tickets.map((value) => value.id);
const candidates = (
  f: Fixture,
  policy?: SchedulingPolicy,
  now = f.clock.now.toISOString(),
  limit = 100,
  offset = 0,
) => f.storage.workCandidates(f.project.id, f.worker.id, [], [], now, limit, offset, policy);
async function enable(f: Fixture) {
  const project = (await f.storage.get('projects', f.project.id))!;
  await f.call(f.admin.id, 'project_update', {
    expected_revision: project.revision,
    scheduling_policy: 'unblocking',
  });
}

export function registerSchedulingContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  describe(`${name} scheduling contract`, () => {
    const check = (title: string, test: (f: Fixture) => Promise<void>) =>
      it(title, async () => {
        const adapters = await factory();
        try {
          await adapters.storage.migrate();
          const f = await fixture(adapters);
          f.clock.now = new Date('2030-01-02T12:00:00.000Z');
          await test(f);
        } finally {
          await adapters.dispose?.();
        }
      });
    check('keeps the default FIFO order and counts only direct unfinished blocking dependents', async (f) => {
      assert.deepEqual(f.storage.schedulingPolicies, ['priority_age', 'unblocking']);
      const project = (await f.storage.get('projects', f.project.id))!;
      assert.equal(project.scheduling_policy, undefined);
      await f.storage.transaction(f.project.id, (tx) =>
        tx.put('projects', { ...project, scheduling_policy: undefined }),
      );
      assert.equal((await f.storage.get('projects', f.project.id))?.scheduling_policy, undefined);
      const oldest = await ticket(f, 3),
        decoy = await ticket(f, 2),
        useful = await ticket(f, 1);
      await dependents(f, useful, 2);
      const [bridge] = await dependents(f, decoy, 1);
      await dependents(f, bridge!, 4);
      for (const status of ['done', 'cancelled'] as const)
        await link(f, decoy, await ticket(f, 0, { status }));
      await link(f, decoy, await ticket(f, 0, { status: 'backlog' }), 'related');
      assert.deepEqual(ids(await candidates(f)), [oldest.id, decoy.id, useful.id]);
      assert.deepEqual(ids(await candidates(f, 'priority_age')), [oldest.id, decoy.id, useful.id]);
      assert.deepEqual(ids(await candidates(f, 'unblocking')), [useful.id, decoy.id, oldest.id]);
      assert.deepEqual(
        ids(
          await f.storage.readSnapshot((reader) =>
            reader.workCandidates(
              f.project.id,
              f.worker.id,
              [],
              [],
              f.clock.now.toISOString(),
              100,
              0,
              'unblocking',
            ),
          ),
        ),
        [useful.id, decoy.id, oldest.id],
      );
      assert.deepEqual(ids(await candidates(f, 'unblocking', undefined, 1, 1)), [decoy.id]);
      for (const [limit, offset] of [
        [0, 0],
        [10002, 0],
        [1, -1],
      ])
        await assert.rejects(candidates(f, 'unblocking', undefined, limit!, offset!), {
          code: 'INVALID_QUERY',
        });
      await assert.rejects(candidates(f, 'unknown' as SchedulingPolicy), { code: 'INVALID_QUERY' });
    });
    check(
      'keeps priority first and promotes the exact 24-hour group in FIFO order with stable ties',
      async (f) => {
        const high = await ticket(f, 0, { priority: 1 }),
          low = await ticket(f, 100, { priority: 5 });
        const oldest = await ticket(f, 26),
          tieOne = await ticket(f, 25),
          tieTwo = await ticket(f, 25),
          boundary = await ticket(f, 24),
          useful = await ticket(f, 23.9);
        await dependents(f, tieOne, 3);
        await dependents(f, useful, 4);
        const ties = [tieOne.id, tieTwo.id].sort();
        const after = [high.id, oldest.id, ...ties, boundary.id, useful.id, low.id];
        assert.deepEqual(ids(await candidates(f, 'unblocking')), after);
        assert.deepEqual(
          ids(await candidates(f, 'unblocking', new Date(f.clock.now.getTime() - 1).toISOString())),
          [high.id, oldest.id, ...ties, useful.id, boundary.id, low.id],
        );
        assert.deepEqual(ids(await candidates(f, 'unblocking')), after);
      },
    );
    check(
      'never lets ranking bypass assignment, capabilities, labels, blockers, status, or active claims',
      async (f) => {
        const valid = await ticket(f, 1, { labels: ['ship'], capabilities: ['sql'] });
        const assigned = await ticket(f, 1, { priority: 1, labels: ['ship'], assignee_id: f.other.id });
        const incapable = await ticket(f, 1, { priority: 1, labels: ['ship'], capabilities: ['gpu'] });
        const unlabelled = await ticket(f, 1, { priority: 1 });
        const question = await ticket(f, 1, { priority: 1, labels: ['ship'] });
        await f.call(f.worker.id, 'ticket_note', {
          ticket_id: question.id,
          kind: 'question',
          body: 'Blocking question.',
          blocking: true,
        });
        const blocked = await ticket(f, 1, { priority: 1, labels: ['ship'] });
        const prerequisite = await ticket(f, 1, { status: 'backlog' });
        await link(f, prerequisite, blocked);
        const active = await ticket(f, 1, { priority: 1, labels: ['ship'] });
        await f.claim(active.id);
        for (const excluded of [assigned, incapable, unlabelled, question, blocked, active])
          await dependents(f, excluded, 1);
        for (const status of ['backlog', 'done', 'cancelled'] as const)
          await ticket(f, 1, { priority: 1, labels: ['ship'], status });
        const direct = await f.storage.workCandidates(
          f.project.id,
          f.worker.id,
          ['sql'],
          ['ship'],
          f.clock.now.toISOString(),
          100,
          0,
          'unblocking',
        );
        assert.deepEqual(ids(direct), [valid.id]);
        await enable(f);
        const next: any = await f.app.execute(f.worker.id, 'work_next', {
          project_id: f.project.id,
          capabilities: ['sql'],
          labels: ['ship'],
          limit: 10,
        });
        assert.deepEqual(ids(next.tickets), [valid.id]);
        const claimed: any = await f.call(f.worker.id, 'work_claim', {
          capabilities: ['sql'],
          labels: ['ship'],
        });
        assert.equal(claimed.ticket.id, valid.id);
        assert.deepEqual(
          await f.storage.workCandidates(
            f.project.id,
            f.worker.id,
            ['sql'],
            ['ship'],
            f.clock.now.toISOString(),
            100,
            0,
            'unblocking',
          ),
          [],
        );
      },
    );
    check('atomically distributes ranked candidates without duplicate concurrent claims', async (f) => {
      const ready: Ticket[] = [];
      for (let i = 0; i < 8; i++) {
        const value = await ticket(f, 1);
        await dependents(f, value, i % 3);
        ready.push(value);
      }
      const expected = [...ready].sort(
        (a, b) => (ready.indexOf(b) % 3) - (ready.indexOf(a) % 3) || a.id.localeCompare(b.id),
      );
      assert.deepEqual(ids(await candidates(f, 'unblocking')), ids(expected));
      await enable(f);
      const claims = await Promise.all(
        ready.map((_, i) => f.claim(undefined, i % 2 ? f.worker.id : f.other.id)),
      );
      assert.equal(new Set(claims.map((result) => result.ticket.id)).size, ready.length);
      assert.deepEqual(claims.map((result) => result.ticket.id).sort(), ids(ready).sort());
      assert.deepEqual(await candidates(f, 'unblocking'), []);
      for (const result of claims)
        assert.equal((await f.storage.get('claims', result.ticket.id))?.actor_id, result.claim.actor_id);
    });
  });
}
