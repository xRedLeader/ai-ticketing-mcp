import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { fixture, registerAdapterContractTests, testEmbeddings } from '../src/testing/contracts.js';
import type { OutboundDelivery } from '../src/contracts.js';

async function adapters() {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-sqlite-'));
  const filename = join(directory, 'tickets.sqlite');
  const a = createSqliteAdapters(filename);
  return {
    ...a,
    filename,
    async dispose() {
      await Promise.all([a.search.close(), a.storage.close()]);
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-sqlite-'));
      await rm(directory, { recursive: true });
    },
  };
}
async function setup() {
  const a = await adapters();
  await a.storage.migrate();
  await a.search.configure(testEmbeddings.profile);
  return { ...(await fixture(a)), ...a };
}
async function deliveryRecord(
  a: Awaited<ReturnType<typeof setup>>,
  target = 'a'.repeat(64),
): Promise<OutboundDelivery> {
  await a.ticket();
  const [event] = await a.storage.find('events', {
    where: { project_id: a.project.id },
    order: [{ field: 'seq', direction: 'desc' }],
    limit: 1,
  });
  return {
    id: randomUUID(),
    event_id: event!.id,
    project_id: a.project.id,
    body: '{ "id": "stable-delivery", "event": "ticket.changed" }\n',
    target_fingerprint: target,
    attempt_count: 0,
    next_attempt_at: '2000-01-01T00:00:00.000Z',
    locked_until: null,
    lock_token: null,
    sent_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
  };
}
registerAdapterContractTests('SQLite', adapters);

it('upgrades schema 001 without losing tickets and stores immutable GitHub evidence', async () => {
  const a = await adapters();
  try {
    const actorId = randomUUID(),
      projectId = randomUUID(),
      ticketId = randomUUID();
    const at = new Date().toISOString();
    const db = new DatabaseSync(a.filename);
    try {
      db.exec(await readFile(new URL('../migrations/sqlite/001_initial.sql', import.meta.url), 'utf8'));
      db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run('001_initial.sql', at);
      db.prepare('INSERT INTO actors VALUES(?,?,?,?,?,?)').run(
        actorId,
        'migration-test',
        'operator',
        'Original operator',
        'human',
        1,
      );
      db.prepare("INSERT INTO projects(id,key,name,policy,revision,created_at) VALUES(?,?,?,'self',1,?)").run(
        projectId,
        'OLD',
        'Original project',
        at,
      );
      db.prepare(
        "INSERT INTO tickets(id,project_id,key,title,description,status,priority,revision,requirements_revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'ready',3,1,1,?,?,?)",
      ).run(ticketId, projectId, 'OLD-1', 'Original ticket', 'Preserve this existing body.', actorId, at, at);
    } finally {
      db.close();
    }
    await a.storage.migrate();
    await a.storage.migrate();
    const original = (await a.storage.get('tickets', ticketId))!;
    assert.equal(original.description, 'Preserve this existing body.');
    assert.equal(original.github_pull_request, undefined);
    assert.equal((await a.storage.get('actors', actorId))?.name, 'Original operator');
    assert.equal((await a.storage.get('projects', projectId))?.scheduling_policy, undefined);
    const linked = { ...original, github_pull_request: { repository: 'owner/repository', number: 7 } };
    const evidence = {
      id: randomUUID(),
      project_id: projectId,
      ticket_id: ticketId,
      actor_id: actorId,
      repository: 'owner/repository',
      pull_request_number: 7,
      head_sha: 'a'.repeat(40),
      observed_head_sha: 'a'.repeat(40),
      status: 'passed' as const,
      requirements_revision: 1,
      ticket_revision: 1,
      checks: [
        {
          name: 'CI',
          required_app_id: 15368,
          run_id: 123,
          app_id: 15368,
          head_sha: 'a'.repeat(40),
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/owner/repository/actions/runs/123',
        },
      ],
      observed_at: at,
    };
    await a.storage.transaction(projectId, async (tx) => {
      await tx.put('tickets', linked);
      await tx.put('github_evidence', evidence);
    });
    assert.deepEqual(
      (await a.storage.get('tickets', ticketId))?.github_pull_request,
      linked.github_pull_request,
    );
    assert.deepEqual(await a.storage.get('github_evidence', evidence.id), evidence);
    await assert.rejects(
      a.storage.transaction(projectId, (tx) => tx.put('github_evidence', { ...evidence, status: 'failed' })),
      { code: 'CONFLICT' },
    );
    await assert.rejects(
      a.storage.transaction(projectId, (tx) => tx.remove('github_evidence', evidence.id)),
      { code: 'IMMUTABLE_EVIDENCE' },
    );
    assert.equal((await a.storage.get('github_evidence', evidence.id))?.status, 'passed');
  } finally {
    await a.dispose();
  }
});

it('rejects paths that cannot provide durable isolated readers', () => {
  for (const filename of ['', '   ', ':memory:'])
    assert.throws(() => createSqliteAdapters(filename), { code: 'INVALID_CONFIG' });
});

it('rejects nested standalone writes instead of deadlocking the file coordinator', async () => {
  const a = await setup();
  try {
    const ticket = await a.ticket();
    const source = (await a.app.sourceDocument(a.storage, 'ticket', ticket.id))!;
    await assert.rejects(
      a.storage.transaction(a.project.id, async () => a.search.indexText(source)),
      { code: 'NESTED_TRANSACTION' },
    );
    await a.storage.health();
    await a.search.indexText(source);
    assert.equal((await a.search.coverage(a.project.id)).documents, 1);
  } finally {
    await a.dispose();
  }
});

it('releases the nested-write guard for asynchronous descendants after commit', async () => {
  const a = await setup();
  try {
    const ticket = await a.ticket();
    const source = (await a.app.sourceDocument(a.storage, 'ticket', ticket.id))!;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let indexing!: Promise<void>;
    await a.storage.transaction(a.project.id, async () => {
      indexing = (async () => {
        await resume;
        await a.search.indexText(source);
      })();
    });
    release();
    await indexing;
    assert.equal((await a.search.coverage(a.project.id)).documents, 1);
  } finally {
    await a.dispose();
  }
});

it('pages only unanswered questions of the requested blocking kind', async () => {
  const a = await setup();
  try {
    const ticket = await a.ticket();
    const ask = async (blocking: boolean) =>
      (
        (await a.call(a.worker.id, 'ticket_note', {
          ticket_id: ticket.id,
          kind: 'question',
          body: 'Confirm this access decision.',
          blocking,
        })) as any
      ).note;
    const answered = await ask(false);
    for (let i = 0; i < 2; i++)
      await a.call(a.worker.id, 'ticket_note', {
        ticket_id: ticket.id,
        kind: 'answer',
        answer_to: answered.id,
        body: `Answer ${i}`,
      });
    const open = [await ask(false), await ask(false), await ask(false)];
    const blocking = await ask(true);
    const ids = open.map((note) => note.id).sort();
    assert.deepEqual(
      (await a.storage.unansweredQuestions(a.project.id, ticket.id, false, 1, 1)).map((note) => note.id),
      ids.slice(1, 2),
    );
    assert.deepEqual(
      (await a.storage.unansweredQuestions(a.project.id, ticket.id, true, 10, 0)).map((note) => note.id),
      [blocking.id],
    );
    const page = (await a.app.execute(a.worker.id, 'ticket_history', {
      project_id: a.project.id,
      ticket_id: ticket.id,
      nonblocking_unanswered: true,
      limit: 1,
      offset: 1,
    })) as any;
    assert.deepEqual(
      page.items.map((note: any) => note.id),
      ids.slice(1, 2),
    );
  } finally {
    await a.dispose();
  }
});

it('leases jobs once across factories and fences superseded tokens and retries', async () => {
  const a = await setup();
  const other = createSqliteAdapters(a.filename);
  try {
    const ticket = await a.ticket();
    const batches = await Promise.all([a.storage.leaseJobs(100, 60000), other.storage.leaseJobs(100, 60000)]);
    const jobs = batches.flat();
    assert.equal(new Set(jobs.map((job) => job.id)).size, jobs.length);
    const stale = jobs.find((job) => job.entity_id === ticket.id)!;
    assert.ok(stale);
    const db = new DatabaseSync(a.filename);
    try {
      db.prepare('UPDATE jobs SET locked_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', stale.id);
    } finally {
      db.close();
    }
    const current = (await other.storage.leaseJobs(100, 60000)).find((job) => job.id === stale.id)!;
    assert.notEqual(current.lock_token, stale.lock_token);
    await a.storage.finishJob(stale);
    assert.equal((await a.storage.get('jobs', stale.id))?.lock_token, current.lock_token);
    await other.storage.finishJob(current, 'retry safely '.repeat(100));
    const retry = (await a.storage.get('jobs', current.id))!;
    assert.equal(retry.attempts, 1);
    assert.equal(retry.lock_token, null);
    assert.equal(retry.locked_until, null);
    assert.equal(retry.last_error?.length, 500);
    assert.ok(Date.parse(retry.available_at) > Date.now());
  } finally {
    await other.search.close();
    await other.storage.close();
    await a.dispose();
  }
});

it('adds the outbox to schema 002 without losing tickets and preserves exact delivery bytes across restart', async () => {
  const a = await adapters();
  let reopened: ReturnType<typeof createSqliteAdapters> | undefined;
  try {
    const originalActor = randomUUID();
    const originalProject = randomUUID(),
      originalTicket = randomUUID(),
      originalEvent = randomUUID();
    const createdAt = new Date().toISOString();
    const db = new DatabaseSync(a.filename);
    try {
      db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
      for (const name of ['001_initial.sql', '002_github_evidence.sql']) {
        db.exec(await readFile(new URL(`../migrations/sqlite/${name}`, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(name, new Date().toISOString());
      }
      db.prepare('INSERT INTO actors VALUES(?,?,?,?,?,?)').run(
        originalActor,
        'upgrade002',
        'preserved',
        'Preserved actor',
        'human',
        0,
      );
      db.prepare("INSERT INTO projects(id,key,name,policy,revision,created_at) VALUES(?,?,?,'self',1,?)").run(
        originalProject,
        'PRE002',
        'Preserved project',
        createdAt,
      );
      db.prepare(
        "INSERT INTO tickets(id,project_id,key,title,description,status,priority,revision,requirements_revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'ready',3,1,1,?,?,?)",
      ).run(
        originalTicket,
        originalProject,
        'PRE002-1',
        'Preserved ticket',
        'Original schema 002 requirements.',
        originalActor,
        createdAt,
        createdAt,
      );
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(
        originalEvent,
        originalProject,
        1,
        originalActor,
        'ticket.created',
        originalTicket,
        '{}',
        createdAt,
      );
    } finally {
      db.close();
    }
    await a.storage.migrate();
    await a.storage.migrate();
    assert.equal((await a.storage.get('actors', originalActor))?.name, 'Preserved actor');
    assert.equal(
      (await a.storage.get('tickets', originalTicket))?.description,
      'Original schema 002 requirements.',
    );
    assert.equal((await a.storage.get('events', originalEvent))?.entity_id, originalTicket);
    const delivery: OutboundDelivery = {
      id: randomUUID(),
      event_id: originalEvent,
      project_id: originalProject,
      body: '{ "id": "stable-delivery", "event": "ticket.changed" }\n',
      target_fingerprint: 'a'.repeat(64),
      attempt_count: 0,
      next_attempt_at: createdAt,
      locked_until: null,
      lock_token: null,
      sent_at: null,
      last_error: null,
      created_at: createdAt,
    };
    await a.storage.transaction(originalProject, (tx) => tx.put('outbound_deliveries', delivery));
    await a.search.close();
    await a.storage.close();
    reopened = createSqliteAdapters(a.filename);
    await reopened.storage.migrate();
    assert.deepEqual(await reopened.storage.get('outbound_deliveries', delivery.id), delivery);
    assert.deepEqual(await reopened.storage.deliveryMetrics!(), {
      webhook_pending: 1,
      webhook_failed: 0,
      webhook_attempts: 0,
    });
  } finally {
    await reopened?.search.close();
    await reopened?.storage.close();
    await a.dispose();
  }
});

it('commits outbound records with their events and rejects mutation or duplicate delivery identities', async () => {
  const a = await setup();
  try {
    const delivery = await deliveryRecord(a);
    const event = (await a.storage.get('events', delivery.event_id))!;
    const rolledEvent = { ...event, id: randomUUID(), seq: event.seq + 1 };
    const rolledDelivery = { ...delivery, id: randomUUID(), event_id: rolledEvent.id };
    await assert.rejects(
      a.storage.transaction(a.project.id, async (tx) => {
        await tx.put('events', rolledEvent);
        await tx.put('outbound_deliveries', rolledDelivery);
        throw new Error('rollback both');
      }),
      /rollback both/,
    );
    assert.equal(await a.storage.get('events', rolledEvent.id), null);
    assert.equal(await a.storage.get('outbound_deliveries', rolledDelivery.id), null);
    await a.storage.transaction(a.project.id, (tx) => tx.put('outbound_deliveries', delivery));
    for (const candidate of [
      { ...delivery, body: '{}' },
      { ...delivery, id: randomUUID() },
    ])
      await assert.rejects(
        a.storage.transaction(a.project.id, (tx) => tx.put('outbound_deliveries', candidate)),
        { code: 'CONFLICT' },
      );
    await assert.rejects(
      a.storage.transaction(a.project.id, (tx) => tx.remove('outbound_deliveries', delivery.id)),
      { code: 'IMMUTABLE_DELIVERY' },
    );
    const second = (await a.app.execute(a.admin.id, 'project_create', {
      key: 'X' + randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(),
      name: 'Other project',
      idempotency_key: randomUUID(),
    })) as { id: string };
    await assert.rejects(
      a.storage.transaction(a.project.id, (tx) =>
        tx.put('outbound_deliveries', {
          ...delivery,
          id: randomUUID(),
          target_fingerprint: 'b'.repeat(64),
          project_id: second.id,
        }),
      ),
      { code: 'INVALID_REFERENCE' },
    );
    assert.deepEqual(await a.storage.get('outbound_deliveries', delivery.id), delivery);
  } finally {
    await a.dispose();
  }
});

it('leases each due delivery once, fences stale acknowledgements, and retains retry failures without content', async () => {
  const a = await setup();
  const other = createSqliteAdapters(a.filename);
  try {
    for (const [limit, leaseMs] of [
      [0, 1],
      [101, 1],
      [1, 0],
      [1, 3_600_001],
    ])
      await assert.rejects(a.storage.leaseDeliveries!('a'.repeat(64), limit!, leaseMs!), {
        code: 'INVALID_INPUT',
      });
    const due = await deliveryRecord(a),
      mismatch = await deliveryRecord(a, 'b'.repeat(64)),
      future = { ...(await deliveryRecord(a)), next_attempt_at: '2999-01-01T00:00:00.000Z' };
    await a.storage.transaction(a.project.id, async (tx) => {
      for (const delivery of [due, mismatch, future]) await tx.put('outbound_deliveries', delivery);
    });
    const batches = await Promise.all([
      a.storage.leaseDeliveries!(due.target_fingerprint, 100, 60_000),
      other.storage.leaseDeliveries!(due.target_fingerprint, 100, 60_000),
    ]);
    const [stale] = batches.flat();
    assert.equal(batches.flat().length, 1);
    assert.equal(stale!.id, due.id);
    assert.equal(stale!.attempt_count, 1);
    const db = new DatabaseSync(a.filename);
    try {
      db.prepare('UPDATE outbound_deliveries SET locked_until=? WHERE id=?').run(
        '2000-01-01T00:00:00.000Z',
        due.id,
      );
    } finally {
      db.close();
    }
    const [current] = await other.storage.leaseDeliveries!(due.target_fingerprint, 100, 60_000);
    assert.notEqual(current!.lock_token, stale!.lock_token);
    assert.equal(current!.attempt_count, 2);
    await a.storage.finishDelivery!(stale!, { sent_at: new Date().toISOString() });
    assert.equal((await a.storage.get('outbound_deliveries', due.id))?.lock_token, current!.lock_token);
    await assert.rejects(
      a.storage.finishDelivery!(current!, {
        next_attempt_at: '2000-01-01T00:00:00.000Z',
        error_code: 'Receiver said secret=do-not-store',
      }),
      { code: 'INVALID_QUERY' },
    );
    await other.storage.finishDelivery!(current!, {
      next_attempt_at: '2000-01-01T00:00:00.000Z',
      error_code: 'NETWORK_ERROR',
    });
    const failed = (await a.storage.get('outbound_deliveries', due.id))!;
    assert.equal(failed.last_error, 'NETWORK_ERROR');
    assert.equal(failed.lock_token, null);
    assert.equal(failed.body, due.body);
    assert.deepEqual(await a.storage.deliveryMetrics!(), {
      webhook_pending: 3,
      webhook_failed: 1,
      webhook_attempts: 2,
    });
    const [retry] = await a.storage.leaseDeliveries!(due.target_fingerprint, 100, 60_000);
    assert.equal(retry!.attempt_count, 3);
    const sent = new Date().toISOString();
    await a.storage.finishDelivery!(retry!, { sent_at: sent });
    await a.storage.finishDelivery!(retry!, {
      next_attempt_at: '2000-01-01T00:00:00.000Z',
      error_code: 'NETWORK_ERROR',
    });
    assert.equal((await a.storage.get('outbound_deliveries', due.id))?.sent_at, sent);
    assert.equal((await a.storage.get('outbound_deliveries', due.id))?.last_error, null);
    assert.equal((await a.storage.leaseDeliveries!(due.target_fingerprint, 100, 60_000)).length, 0);
    assert.equal(
      (await a.storage.leaseDeliveries!(mismatch.target_fingerprint, 100, 60_000))[0]?.id,
      mismatch.id,
    );
  } finally {
    await other.search.close();
    await other.storage.close();
    await a.dispose();
  }
});

it('recovers a delivery abandoned by a terminated worker and saturates attempt counters', async () => {
  const a = await setup();
  try {
    const delivery = { ...(await deliveryRecord(a)), attempt_count: 2147483646 };
    await a.storage.transaction(a.project.id, (tx) => tx.put('outbound_deliveries', delivery));
    const source = new URL('../src/adapters/sqlite.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import {createSqliteAdapters} from ${JSON.stringify(source)}; const a=createSqliteAdapters(process.argv[1]); await a.storage.leaseDeliveries(process.argv[2],1,1); process.exit(0);`,
        a.filename,
        delivery.target_fingerprint,
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const [exitCode] = await once(child, 'close');
    assert.equal(exitCode, 0, stderr);
    const abandoned = (await a.storage.get('outbound_deliveries', delivery.id))!;
    assert.equal(abandoned.attempt_count, 2147483647);
    assert.ok(abandoned.lock_token);
    const [recovered] = await a.storage.leaseDeliveries!(delivery.target_fingerprint, 1, 60_000);
    assert.ok(recovered);
    assert.equal(recovered.attempt_count, 2147483647);
    assert.notEqual(recovered.lock_token, abandoned.lock_token);
    assert.equal(recovered.body, delivery.body);
    await a.storage.finishDelivery!(abandoned, { sent_at: new Date().toISOString() });
    assert.equal((await a.storage.get('outbound_deliveries', delivery.id))?.sent_at, null);
    await a.storage.finishDelivery!(recovered, { sent_at: new Date().toISOString() });
    assert.deepEqual(await a.storage.deliveryMetrics!(), {
      webhook_pending: 0,
      webhook_failed: 0,
      webhook_attempts: 2147483647,
    });
  } finally {
    await a.dispose();
  }
});

it('isolates pending writer state from plain reads and snapshots while queuing FTS writes', async () => {
  const a = await setup();
  let release!: () => void;
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = createSqliteAdapters(a.filename);
  try {
    const ticket = await a.ticket();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = a.storage.transaction(a.project.id, async (tx) => {
      const before = (await tx.get('tickets', ticket.id))!;
      await tx.put('tickets', { ...before, priority: 1 });
      entered();
      await resume;
      throw new Error('roll back pending write');
    });
    const rejected = assert.rejects(writing, /roll back pending write/);
    await ready;
    assert.equal((await a.storage.get('tickets', ticket.id))?.priority, 3);
    assert.equal(
      (await other.storage.readSnapshot((reader) => reader.get('tickets', ticket.id)))?.priority,
      3,
    );
    const source = (await a.app.sourceDocument(a.storage, 'ticket', ticket.id))!;
    const indexing = other.search.indexText(source);
    let indexed = false;
    void indexing.then(() => {
      indexed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(indexed, false);
    release();
    await rejected;
    await indexing;
    assert.equal((await a.storage.get('tickets', ticket.id))?.priority, 3);
    assert.ok((await a.search.search(a.project.id, 'database', 10)).some((hit) => hit.id === ticket.id));
  } finally {
    release();
    await other.search.close();
    await other.storage.close();
    await a.dispose();
  }
});

it('coordinates separate factories and preserves JSON hints, receipt nulls and foreign-key errors', async () => {
  const a = await setup();
  const other = createSqliteAdapters(a.filename);
  try {
    const ticket = await a.ticket();
    const app = createApplication({
      storage: other.storage,
      search: other.search,
      embeddings: testEmbeddings,
    });
    const attempts = await Promise.allSettled([
      a.claim(ticket.id),
      app.execute(a.other.id, 'work_claim', {
        project_id: a.project.id,
        ticket_id: ticket.id,
        idempotency_key: randomUUID(),
      }),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    await a.storage.transaction(a.project.id, async (tx) => {
      const project = (await tx.get('projects', a.project.id))!;
      await tx.put('projects', { ...project, execution_hints: { model: 'local-model', effort: 'high' } });
      await tx.put('receipts', {
        id: 'null-receipt',
        project_id: a.project.id,
        actor_id: a.worker.id,
        operation: 'test',
        input_hash: 'hash',
        result: null,
        created_at: new Date().toISOString(),
      });
    });
    assert.deepEqual((await other.storage.get('projects', a.project.id))?.execution_hints, {
      model: 'local-model',
      effort: 'high',
    });
    assert.equal((await other.storage.get('receipts', 'null-receipt'))?.result, null);
    await assert.rejects(
      a.storage.transaction('catalog', (tx) => tx.put('actors', { ...a.worker, id: randomUUID() })),
      { code: 'CONFLICT' },
    );
    await assert.rejects(
      a.storage.transaction(a.project.id, (tx) =>
        tx.put('members', {
          id: 'bad-member',
          project_id: a.project.id,
          actor_id: randomUUID(),
          role: 'reader',
        }),
      ),
      { code: 'INVALID_REFERENCE' },
    );
  } finally {
    await other.search.close();
    await other.storage.close();
    await a.dispose();
  }
});

it('persists deterministic full-text search across restart and rejects stale archive writes', async () => {
  const a = await setup();
  let reopened: ReturnType<typeof createSqliteAdapters> | undefined;
  try {
    const ticket = await a.ticket();
    const source = (await a.app.sourceDocument(a.storage, 'ticket', ticket.id))!;
    await a.search.indexText(source);
    assert.equal(a.search.capabilities?.semantic, false);
    await assert.rejects(a.search.indexVector(source, testEmbeddings.profile, [1, 0, 0]), {
      code: 'UNSUPPORTED_SEARCH',
    });
    assert.ok(
      (await a.search.search(a.project.id, 'database-security', 10)).some((hit) => hit.id === ticket.id),
    );
    assert.deepEqual(await a.search.search(randomUUID(), 'database', 10), []);
    await a.search.close();
    await a.storage.close();
    reopened = createSqliteAdapters(a.filename);
    await reopened.storage.migrate();
    assert.ok(
      (await reopened.search.search(a.project.id, 'database', 10)).some((hit) => hit.id === ticket.id),
    );
    assert.deepEqual(
      (await reopened.search.search(a.project.id, 'database', 10)).map((hit) => hit.id),
      (await reopened.search.search(a.project.id, 'database', 10)).map((hit) => hit.id),
    );
    const coverage = await reopened.search.coverage(a.project.id);
    assert.equal(coverage.documents, 1);
    assert.equal(coverage.embedded, 0);
    await reopened.search.indexText({ ...source, revision: source.revision + 1, archived: true });
    await reopened.search.indexText(source);
    assert.deepEqual(await reopened.search.search(a.project.id, 'database', 10), []);
    assert.deepEqual(await reopened.search.search(a.project.id, '" - OR : ()', 10), []);
    await Promise.all([
      reopened.search.close(),
      reopened.storage.close(),
      reopened.search.close(),
      reopened.storage.close(),
    ]);
  } finally {
    await reopened?.search.close();
    await reopened?.storage.close();
    await a.dispose();
  }
});

it(
  'allows another process to open and wait asynchronously for an active writer',
  { timeout: 15000 },
  async () => {
    const a = await setup();
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const ticket = await a.ticket();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writing = a.storage.transaction(a.project.id, async (tx) => {
        const value = (await tx.get('tickets', ticket.id))!;
        await tx.put('tickets', { ...value, priority: 1 });
        entered();
        await resume;
      });
      await ready;
      const source = new URL('../src/adapters/sqlite.ts', import.meta.url).href;
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import {createSqliteAdapters} from ${JSON.stringify(source)}; const a=createSqliteAdapters(process.argv[1]); console.log('opened'); try {const jobs=await a.storage.leaseJobs(100,60000); console.log(JSON.stringify({jobs:jobs.length}));} finally {await a.search.close();await a.storage.close();}`,
          a.filename,
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      let errors = '';
      let opened!: () => void;
      const opening = new Promise<void>((resolve, reject) => {
        opened = resolve;
        child!.once('error', reject);
        child!.once('exit', (code) => {
          if (!output.includes('opened')) reject(new Error(`Child exited ${code}: ${errors}`));
        });
      });
      child.stdout!.on('data', (data) => {
        output += data.toString();
        if (output.includes('opened')) opened();
      });
      child.stderr!.on('data', (data) => {
        errors += data.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child!.once('exit', resolve);
        child!.once('error', reject);
      });
      await opening;
      assert.equal((await a.storage.get('tickets', ticket.id))?.priority, 3);
      release();
      await writing;
      assert.equal(await exited, 0, errors);
      assert.ok(JSON.parse(output.trim().split(/\r?\n/).at(-1)!).jobs >= 1);
    } finally {
      release();
      if (child && child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await a.dispose();
    }
  },
);
