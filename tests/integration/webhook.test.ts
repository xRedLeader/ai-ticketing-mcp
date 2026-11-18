import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from '../../src/application.js';
import { PostgresStorage } from '../../src/adapters/postgres.js';
import { hasCode } from '../../src/testing/contracts.js';
import type { OutboundDelivery } from '../../src/contracts.js';
import { setup } from './helpers.js';

it('persists exact PostgreSQL outbox bodies and protects immutable event/destination identity', async () => {
  const f = await setup();
  try {
    let sends = 0;
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      webhook: {
        fingerprint,
        async send() {
          sends++;
          return undefined;
        },
      },
    });
    await app.execute(f.worker.id, 'tickets_create', {
      project_id: f.project.id,
      idempotency_key: randomUUID(),
      tickets: [{ title: 'private ticket', description: 'private body', criteria: ['private acceptance'] }],
    });
    const rows = await f.storage.find('outbound_deliveries', { where: { project_id: f.project.id } });
    assert.equal(rows.length, 1);
    assert.equal(sends, 0);
    const row = rows[0]!;
    const payload = JSON.parse(row.body);
    assert.equal(payload.event_id, row.event_id);
    assert.equal(row.body.includes('private'), false);
    assert.equal((await f.storage.get('events', row.event_id))!.type, 'ticket.created');
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) => tx.put('outbound_deliveries', { ...row, body: '{}' })),
      hasCode('CONFLICT'),
    );
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) => tx.remove('outbound_deliveries', row.id)),
      hasCode('IMMUTABLE_DELIVERY'),
    );
    const otherProject = await setup();
    try {
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) =>
          tx.put('outbound_deliveries', {
            ...row,
            id: randomUUID(),
            project_id: otherProject.project.id,
            target_fingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
          }),
        ),
        hasCode('INVALID_REFERENCE'),
      );
    } finally {
      await otherProject.dispose();
    }
    const exact = {
      ...row,
      id: randomUUID(),
      target_fingerprint: 'c'.repeat(64),
      body: '{ "escaped": "\\u0061" }',
    };
    await f.storage.transaction(f.project.id, (tx) => tx.put('outbound_deliveries', exact));
    const reopened = new PostgresStorage(process.env.TEST_DATABASE_URL!);
    try {
      assert.deepEqual(await reopened.get('outbound_deliveries', exact.id), exact);
    } finally {
      await reopened.close();
    }
    const abortedId = randomUUID(),
      eventId = `${f.project.id}:rollback`;
    await assert.rejects(
      f.storage.transaction(f.project.id, async (tx) => {
        await tx.put('events', {
          id: eventId,
          project_id: f.project.id,
          seq: 999999,
          actor_id: f.worker.id,
          type: 'ticket.created',
          entity_id: randomUUID(),
          data: {},
          created_at: new Date().toISOString(),
        });
        await tx.put('outbound_deliveries', { ...row, id: abortedId, event_id: eventId });
        throw new Error('rollback both records');
      }),
      /rollback both/,
    );
    assert.equal(await f.storage.get('events', eventId), null);
    assert.equal(await f.storage.get('outbound_deliveries', abortedId), null);
  } finally {
    await f.dispose();
  }
});

it('atomically leases PostgreSQL deliveries, recovers expired locks and fences stale acknowledgements', async () => {
  const f = await setup();
  try {
    assert.ok(f.storage instanceof PostgresStorage);
    const ticket = await f.ticket();
    const event = (
      await f.storage.find('events', { where: { project_id: f.project.id, entity_id: ticket.id } })
    )[0]!;
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const row: OutboundDelivery = {
      id: randomUUID(),
      event_id: event.id,
      project_id: f.project.id,
      body: '{}',
      target_fingerprint: fingerprint,
      attempt_count: 0,
      next_attempt_at: '2000-01-01T00:00:00.000Z',
      locked_until: null,
      lock_token: null,
      sent_at: null,
      last_error: null,
      created_at: event.created_at,
    };
    await f.storage.transaction(f.project.id, (tx) => tx.put('outbound_deliveries', row));
    assert.equal((await f.storage.leaseDeliveries('0'.repeat(64), 1, 1000)).length, 0);
    const leased = (
      await Promise.all([
        f.storage.leaseDeliveries(fingerprint, 1, 1000),
        f.storage.leaseDeliveries(fingerprint, 1, 1000),
      ])
    ).flat();
    assert.equal(leased.length, 1);
    assert.equal(leased[0]!.attempt_count, 1);
    await assert.rejects(
      f.storage.finishDelivery(leased[0]!, {
        next_attempt_at: row.next_attempt_at,
        error_code: 'private response content',
      }),
      hasCode('INVALID_INPUT'),
    );
    await f.storage.finishDelivery(leased[0]!, {
      next_attempt_at: '2999-01-01T00:00:00.000Z',
      error_code: 'HTTP_503',
    });
    assert.equal((await f.storage.leaseDeliveries(fingerprint, 1, 1000)).length, 0);
    await f.storage.pool.query(
      'UPDATE outbound_deliveries SET next_attempt_at=$2,attempt_count=2147483647 WHERE id=$1',
      [row.id, row.next_attempt_at],
    );
    const abandoned = (await f.storage.leaseDeliveries(fingerprint, 1, 1000))[0]!;
    assert.equal(abandoned.attempt_count, 2147483647);
    await f.storage.pool.query("UPDATE outbound_deliveries SET locked_until='2000-01-01' WHERE id=$1", [
      row.id,
    ]);
    const recovered = (await f.storage.leaseDeliveries(fingerprint, 1, 1000))[0]!;
    assert.notEqual(recovered.lock_token, abandoned.lock_token);
    assert.equal(recovered.attempt_count, 2147483647);
    await f.storage.finishDelivery(abandoned, { sent_at: new Date().toISOString() });
    await f.storage.finishDelivery({ ...recovered, lock_token: null }, { sent_at: new Date().toISOString() });
    assert.equal((await f.storage.get('outbound_deliveries', row.id))!.sent_at, null);
    const metrics = await f.storage.deliveryMetrics();
    assert.ok(metrics.webhook_pending >= 1);
    assert.ok(metrics.webhook_failed >= 1);
    assert.ok(metrics.webhook_attempts >= 2147483647);
    await f.storage.finishDelivery(recovered, { sent_at: new Date().toISOString() });
    assert.equal((await f.storage.get('outbound_deliveries', row.id))!.last_error, null);
    assert.equal((await f.storage.leaseDeliveries(fingerprint, 1, 1000)).length, 0);
    await f.storage.finishDelivery(abandoned, {
      next_attempt_at: row.next_attempt_at,
      error_code: 'HTTP_500',
    });
    assert.equal((await f.storage.get('outbound_deliveries', row.id))!.last_error, null);
  } finally {
    await f.dispose();
  }
});
