import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from '../src/application.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { schemas } from '../src/schemas.js';
import { fixture, hasCode } from '../src/testing/contracts.js';
import { contextFixture } from './context-fixture.js';
import type { SchedulingPolicy, SearchAdapter, StorageAdapter, Ticket } from '../src/contracts.js';

function capabilities(storage: StorageAdapter, policies?: readonly SchedulingPolicy[]) {
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'schedulingPolicies') return policies;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function withFixture(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-scheduling-test-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  try {
    await adapters.storage.migrate();
    await work(await fixture(adapters));
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
    const path = resolve(directory);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('ticketing-scheduling-test-'));
    await rm(path, { recursive: true, force: true });
  }
}

it('keeps scheduling opt-in and accepts a nullable update only to clear the override', () => {
  const create = { key: 'SCHED', name: 'Scheduling', idempotency_key: 'scheduling-key' };
  const update = { project_id: randomUUID(), expected_revision: 1, idempotency_key: 'scheduling-key' };
  assert.equal(Object.hasOwn(schemas.project_create.parse(create), 'scheduling_policy'), false);
  assert.equal(Object.hasOwn(schemas.project_update.parse(update), 'scheduling_policy'), false);
  for (const scheduling_policy of ['priority_age', 'unblocking']) {
    assert.equal(
      schemas.project_create.parse({ ...create, scheduling_policy }).scheduling_policy,
      scheduling_policy,
    );
    assert.equal(
      schemas.project_update.parse({ ...update, scheduling_policy }).scheduling_policy,
      scheduling_policy,
    );
  }
  assert.equal(schemas.project_update.parse({ ...update, scheduling_policy: null }).scheduling_policy, null);
  assert.equal(schemas.project_create.safeParse({ ...create, scheduling_policy: null }).success, false);
  for (const scheduling_policy of ['', 'model_ranked', {}, 1]) {
    assert.equal(schemas.project_create.safeParse({ ...create, scheduling_policy }).success, false);
    assert.equal(schemas.project_update.safeParse({ ...update, scheduling_policy }).success, false);
  }
});

it('rejects unsupported policy mutations atomically and preserves legacy defaults and receipts', async () => {
  await withFixture(async (f) => {
    const legacy = createApplication({ storage: capabilities(f.storage), search: f.search });
    const input = {
      key: 'SCHED',
      name: 'Scheduling',
      scheduling_policy: 'unblocking',
      idempotency_key: randomUUID(),
    };
    const beforeProject = await f.storage.get('projects', f.project.id);
    const beforeReceipts = await f.storage.find('receipts');
    await assert.rejects(
      legacy.execute(f.admin.id, 'project_create', input),
      hasCode('UNSUPPORTED_SCHEDULING_POLICY'),
    );
    await assert.rejects(
      legacy.execute(f.admin.id, 'project_update', {
        project_id: f.project.id,
        expected_revision: beforeProject!.revision,
        scheduling_policy: 'unblocking',
        name: 'must not commit',
        idempotency_key: randomUUID(),
      }),
      hasCode('UNSUPPORTED_SCHEDULING_POLICY'),
    );
    assert.deepEqual(await f.storage.get('projects', f.project.id), beforeProject);
    assert.equal((await f.storage.find('projects')).length, 1);
    assert.deepEqual(await f.storage.find('receipts'), beforeReceipts);
    const base = { key: 'LEGACY', name: 'Legacy', idempotency_key: randomUUID() };
    const created = (await legacy.execute(f.admin.id, 'project_create', base)) as any;
    assert.equal(Object.hasOwn(created, 'scheduling_policy'), false);
    assert.deepEqual(await legacy.execute(f.admin.id, 'project_create', base), created);
    const explicit = (await legacy.execute(f.admin.id, 'project_update', {
      project_id: created.id,
      expected_revision: created.revision,
      scheduling_policy: 'priority_age',
      idempotency_key: randomUUID(),
    })) as any;
    assert.equal(explicit.scheduling_policy, 'priority_age');
    const supported = createApplication({
      storage: capabilities(f.storage, ['priority_age', 'unblocking']),
      search: f.search,
    });
    const configured = (await supported.execute(f.admin.id, 'project_create', input)) as any;
    assert.equal(configured.scheduling_policy, 'unblocking');
    const listed = (await supported.execute(f.admin.id, 'project_list', {})) as any;
    assert.equal(
      listed.projects.find((project: any) => project.id === configured.id).scheduling_policy,
      'unblocking',
    );
    const cleared = (await legacy.execute(f.admin.id, 'project_update', {
      project_id: configured.id,
      expected_revision: configured.revision,
      scheduling_policy: null,
      idempotency_key: randomUUID(),
    })) as any;
    assert.equal(Object.hasOwn(cleared, 'scheduling_policy'), false);
    assert.equal(
      Object.hasOwn((await f.storage.get('projects', configured.id))!, 'scheduling_policy'),
      false,
    );
    assert.deepEqual(await supported.execute(f.admin.id, 'project_create', input), configured);
  });
});

it('guards automatic selection for restored unsupported policies and lets administrators clear them', async () => {
  await withFixture(async (f) => {
    const ticket = await f.ticket();
    await f.storage.transaction(f.project.id, async (tx) => {
      const project = (await tx.get('projects', f.project.id))!;
      project.scheduling_policy = 'unblocking';
      await tx.put('projects', project);
    });
    let queries = 0;
    const storage = capabilities(f.storage);
    const original = f.storage.workCandidates.bind(f.storage);
    f.storage.workCandidates = async (...args) => {
      queries++;
      return original(...args);
    };
    const app = createApplication({ storage, search: f.search });
    await assert.rejects(
      app.execute(f.worker.id, 'work_next', { project_id: f.project.id }),
      hasCode('UNSUPPORTED_SCHEDULING_POLICY'),
    );
    await assert.rejects(
      app.execute(f.worker.id, 'work_claim', {
        project_id: f.project.id,
        include_context: false,
        idempotency_key: randomUUID(),
      }),
      hasCode('UNSUPPORTED_SCHEDULING_POLICY'),
    );
    assert.equal(queries, 0);
    assert.equal(await f.storage.get('claims', ticket.id), null);
    await assert.rejects(
      app.execute(f.worker.id, 'project_update', {
        project_id: f.project.id,
        expected_revision: f.project.revision,
        scheduling_policy: null,
        idempotency_key: randomUUID(),
      }),
      hasCode('FORBIDDEN'),
    );
    await app.execute(f.admin.id, 'project_update', {
      project_id: f.project.id,
      expected_revision: f.project.revision,
      scheduling_policy: null,
      idempotency_key: randomUUID(),
    });
    const next = (await app.execute(f.worker.id, 'work_next', { project_id: f.project.id })) as any;
    assert.equal(next.tickets[0].id, ticket.id);
  });
});

it('passes one policy and fixed instant through all candidate pages and active-claim checks', async () => {
  for (const policy of ['priority_age', 'unblocking'] as const) {
    const f = contextFixture();
    if (policy === 'unblocking') f.tables.projects![0].scheduling_policy = policy;
    const next = { ...f.ticket, id: randomUUID(), key: 'PACK-2' } as Ticket;
    f.tables.tickets!.push(next);
    f.tables.claims!.push({
      id: f.ticket.id,
      actor_id: f.actor.id,
      token: randomUUID(),
      expires_at: new Date(f.now.getTime() + 1).toISOString(),
    });
    const calls: Parameters<StorageAdapter['workCandidates']>[] = [];
    f.storage.workCandidates = async (...args) => {
      calls.push(args);
      return [calls.length === 1 ? (f.ticket as Ticket) : next];
    };
    let ticks = 0;
    const app = createApplication({
      storage: capabilities(f.storage, policy === 'unblocking' ? ['priority_age', 'unblocking'] : undefined),
      search: {} as SearchAdapter,
      now: () => new Date(f.now.getTime() + ticks++ * 3600000),
    });
    const result = (await app.execute(f.actor.id, 'work_next', { project_id: f.project.id })) as any;
    assert.equal(
      result.tickets[0].id,
      next.id,
      'The first candidate is still claimed at the selection instant.',
    );
    assert.equal(calls.length, 2);
    assert.equal(ticks, 1);
    assert.deepEqual(
      calls.map((args) => [args[4], args[6], args[7]]),
      [
        [f.now.toISOString(), 0, policy],
        [f.now.toISOString(), 1, policy],
      ],
    );
  }
});
