import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/application.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture, hasCode } from '../src/testing/contracts.js';
import type { OutboundDelivery, StorageAdapter, Ticket, WebhookTarget } from '../src/contracts.js';

async function withFixture(
  work: (
    f: Awaited<ReturnType<typeof fixture>>,
    target: WebhookTarget & { sent: OutboundDelivery[] },
    create: () => Promise<Ticket>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-webhook-test-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const target = {
      fingerprint: 'a'.repeat(64),
      sent: [] as OutboundDelivery[],
      async send(delivery: OutboundDelivery) {
        target.sent.push(delivery);
        return undefined;
      },
    };
    const app = createApplication({ ...adapters, now: () => f.clock.now, webhook: target });
    const create = async () =>
      (
        (await app.execute(f.worker.id, 'tickets_create', {
          project_id: f.project.id,
          idempotency_key: randomUUID(),
          tickets: [
            {
              title: 'private title',
              description: 'private description',
              criteria: ['private criterion'],
              status: 'ready',
            },
          ],
        })) as { tickets: Ticket[] }
      ).tickets[0]!;
    await work({ ...f, app }, target, create);
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
    const path = resolve(directory);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('ticketing-webhook-test-'));
    await rm(path, { recursive: true, force: true });
  }
}

it('enqueues compact committed event hints atomically and skips heartbeats and knowledge', async () => {
  await withFixture(async (f, target, create) => {
    const ticket = await create();
    assert.equal(target.sent.length, 0, 'Mutations must not contact receivers.');
    const rows = await f.storage.find('outbound_deliveries');
    assert.equal(rows.length, 1);
    const delivery = rows[0]!,
      payload = JSON.parse(delivery.body);
    assert.deepEqual(Object.keys(payload), [
      'schema_version',
      'delivery_id',
      'event_id',
      'project_id',
      'entity_id',
      'event_type',
      'seq',
      'ticket_revision',
      'requirements_revision',
      'occurred_at',
    ]);
    const event = (await f.storage.get('events', delivery.event_id))!;
    assert.deepEqual(payload, {
      schema_version: 1,
      delivery_id: delivery.id,
      event_id: event.id,
      project_id: f.project.id,
      entity_id: ticket.id,
      event_type: 'ticket.created',
      seq: event.seq,
      ticket_revision: ticket.revision,
      requirements_revision: ticket.requirements_revision,
      occurred_at: event.created_at,
    });
    assert.equal(delivery.body.includes('private'), false);
    const call = (operation: any, input: Record<string, unknown>) =>
      f.app.execute(f.worker.id, operation, {
        project_id: f.project.id,
        idempotency_key: randomUUID(),
        ...input,
      }) as Promise<any>;
    const claim = await call('work_claim', { ticket_id: ticket.id });
    await call('work_heartbeat', { ticket_id: ticket.id, claim_token: claim.claim.token });
    await call('knowledge_write', { title: 'private knowledge', body: 'private content' });
    await call('ticket_note', { ticket_id: ticket.id, body: 'private note' });
    await call('ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      progress: 'private progress',
    });
    await call('work_release', {
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      reason: 'private release',
    });
    const bodies = (await f.storage.find('outbound_deliveries')).map((row) => JSON.parse(row.body));
    assert.deepEqual(
      bodies.map((body) => body.event_type).sort(),
      ['ticket.created', 'work.claimed', 'ticket.note_added', 'ticket.checkpointed', 'work.released'].sort(),
    );
    assert.equal(JSON.stringify(bodies).includes('private'), false);
    assert.equal(JSON.stringify(bodies).includes(claim.claim.token), false);
    await f.app.deliverOnce();
    assert.equal(target.sent.length, 1);
    assert.equal(
      (await f.storage.get('outbound_deliveries', target.sent[0]!.id))!.sent_at,
      f.clock.now.toISOString(),
    );
  });
});

it('fails configured unsupported adapters early and rolls back event and mutation when enqueue fails', async () => {
  await withFixture(async (f, target) => {
    const unsupported = new Proxy(f.storage, {
      get(storage, property) {
        if (property === 'leaseDeliveries') return undefined;
        const value = Reflect.get(storage, property);
        return typeof value === 'function' ? value.bind(storage) : value;
      },
    });
    assert.throws(
      () => createApplication({ storage: unsupported, search: f.search, webhook: target }),
      hasCode('INVALID_CONFIG'),
    );
    const broken = new Proxy(f.storage, {
      get(storage, property) {
        if (property === 'transaction')
          return (scope: string, work: Parameters<StorageAdapter['transaction']>[1]) =>
            storage.transaction(scope, (tx) =>
              work({
                ...tx,
                async put(table, value) {
                  if (table === 'outbound_deliveries') throw new Error('outbox unavailable');
                  await tx.put(table, value);
                },
              }),
            );
        const value = Reflect.get(storage, property);
        return typeof value === 'function' ? value.bind(storage) : value;
      },
    });
    const app = createApplication({ storage: broken, search: f.search, webhook: target });
    const before = await f.storage.get('projects', f.project.id);
    await assert.rejects(
      app.execute(f.worker.id, 'tickets_create', {
        project_id: f.project.id,
        idempotency_key: randomUUID(),
        tickets: [{ title: 'test', description: 'test', criteria: ['test'] }],
      }),
      /outbox unavailable/,
    );
    assert.deepEqual(await f.storage.get('projects', f.project.id), before);
    assert.equal((await f.storage.find('tickets')).length, 0);
    assert.equal((await f.storage.find('outbound_deliveries')).length, 0);
  });
});

it('isolates receiver failures from successful mutations and indexing and retries with bounded backoff', async () => {
  await withFixture(async (f, target, create) => {
    const ticket = await create();
    target.send = async () => {
      throw new Error('private receiver secret');
    };
    assert.equal(await f.app.deliverOnce(), 1);
    let delivery = (await f.storage.find('outbound_deliveries'))[0]!;
    assert.equal(delivery.last_error, 'NETWORK_ERROR');
    assert.equal(delivery.attempt_count, 1);
    assert.equal(Date.parse(delivery.next_attempt_at) - f.clock.now.getTime(), 2000);
    assert.equal(await f.app.deliverOnce(), 0);
    await f.app.indexOnce(100);
    assert.equal((await f.storage.get('tickets', ticket.id))!.title, 'private title');
    assert.equal((await f.search.search(f.project.id, 'private', 10)).length, 1);
    assert.equal((await f.storage.deliveryMetrics!()).webhook_failed, 1);
    const originalLease = f.storage.leaseDeliveries!.bind(f.storage);
    f.storage.leaseDeliveries = async () => [
      { ...delivery, attempt_count: 2147483647, lock_token: randomUUID() },
    ];
    let outcome: unknown;
    const originalFinish = f.storage.finishDelivery!.bind(f.storage);
    f.storage.finishDelivery = async (_delivery, result) => {
      outcome = result;
    };
    try {
      await f.app.deliverOnce();
      assert.deepEqual(outcome, {
        next_attempt_at: new Date(f.clock.now.getTime() + 3600000).toISOString(),
        error_code: 'NETWORK_ERROR',
      });
    } finally {
      f.storage.leaseDeliveries = originalLease;
      f.storage.finishDelivery = originalFinish;
    }
    delivery = (await f.storage.get('outbound_deliveries', delivery.id))!;
    assert.equal(delivery.body.includes('private'), false);
  });
});

it('leaves old-target rows pending and fences accepted-before-crash retries by stable ID', async () => {
  await withFixture(async (f, target, create) => {
    await create();
    const other = createApplication({
      storage: f.storage,
      search: f.search,
      webhook: {
        fingerprint: 'b'.repeat(64),
        async send() {
          assert.fail('Old destination was rerouted.');
        },
      },
    });
    assert.equal(await other.deliverOnce(), 0);
    assert.equal((await f.storage.deliveryMetrics!()).webhook_pending, 1);
    const originalLease = f.storage.leaseDeliveries!.bind(f.storage);
    f.storage.leaseDeliveries = (fingerprint, limit) => originalLease(fingerprint, limit, 1);
    const originalFinish = f.storage.finishDelivery!.bind(f.storage);
    f.storage.finishDelivery = async () => {
      throw new Error('process ended before acknowledgement');
    };
    try {
      await assert.rejects(f.app.deliverOnce(), /before acknowledgement/);
    } finally {
      f.storage.finishDelivery = originalFinish;
      f.storage.leaseDeliveries = originalLease;
    }
    const accepted = target.sent[0]!;
    await delay(10);
    const restarted = createApplication({ storage: f.storage, search: f.search, webhook: target });
    await restarted.deliverOnce();
    assert.equal(target.sent.length, 2);
    assert.equal(target.sent[1]!.id, accepted.id);
    assert.equal(target.sent[1]!.body, accepted.body);
    assert.notEqual(target.sent[1]!.lock_token, accepted.lock_token);
    assert.equal((await f.storage.deliveryMetrics!()).webhook_pending, 0);
  });
});
