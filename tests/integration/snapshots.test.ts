import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/application.js';
import { testEmbeddings } from '../../src/testing/contracts.js';
import { setup } from './helpers.js';

it('uses a repeatable-read read-only PostgreSQL transaction and releases it after errors', async () => {
  const f = await setup();
  const connect = f.storage.pool.connect.bind(f.storage.pool);
  let client: any;
  try {
    (f.storage.pool as any).connect = async () => {
      client = await connect();
      return client;
    };
    await f.storage.readSnapshot(async (reader) => {
      const settings = (
        await client.query(
          "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly",
        )
      ).rows[0];
      assert.deepEqual(settings, { isolation: 'repeatable read', readonly: 'on' });
      assert.equal('put' in reader, false);
      assert.ok(await reader.get('projects', f.project.id));
    });
    await assert.rejects(
      f.storage.readSnapshot(async () => {
        throw new Error('snapshot failure');
      }),
      /snapshot failure/,
    );
    assert.ok(await f.storage.readSnapshot((reader) => reader.get('projects', f.project.id)));
  } finally {
    (f.storage.pool as any).connect = connect;
    await f.dispose();
  }
});

it('serves standalone context while the project mutation advisory lock is held', async () => {
  const f = await setup();
  const lock = await f.storage.pool.connect();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<unknown> | undefined;
  let completed = false;
  try {
    const ticket = await f.ticket();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [f.project.id]);
    reading = f.app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    });
    completed = await Promise.race([
      reading.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await lock.query('ROLLBACK');
    lock.release();
    try {
      await reading;
    } finally {
      await f.dispose();
    }
  }
  assert.equal(completed, true, 'Context waited for the project write lock.');
});

it('collects coherent context and releases its snapshot before token counting', async () => {
  const f = await setup();
  const readSnapshot = f.storage.readSnapshot.bind(f.storage);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let snapshotOpen = false;
  let paused = false;
  try {
    const ticket = await f.ticket();
    f.storage.readSnapshot = (work) =>
      readSnapshot(async (reader) => {
        snapshotOpen = true;
        try {
          return await work({
            ...reader,
            get: async (table, id) => {
              const result = await reader.get(table, id);
              if (table === 'projects' && !paused) {
                paused = true;
                enter();
                await gate;
              }
              return result;
            },
          });
        } finally {
          snapshotOpen = false;
        }
      });
    const app = createApplication({
      storage: f.storage,
      search: f.search,
      embeddings: testEmbeddings,
      countReferenceTokens: (text) => {
        assert.equal(snapshotOpen, false);
        return Math.ceil(text.length / 4);
      },
    });
    const reading = app.execute(f.worker.id, 'ticket_context', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    });
    await Promise.race([
      entered,
      reading.then(() => {
        throw new Error('Context ended before the snapshot was paused.');
      }),
    ]);
    try {
      await f.call(f.admin.id, 'project_update', {
        expected_revision: f.project.revision,
        instructions: 'New instructions.',
      });
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        description: 'New requirements.',
      });
    } finally {
      resume();
    }
    const context = (await reading) as any;
    assert.equal(context.project_instructions.text, f.project.instructions);
    assert.equal(context.ticket.description, ticket.description);
    assert.equal((await f.storage.get('tickets', ticket.id))?.description, 'New requirements.');
  } finally {
    resume();
    f.storage.readSnapshot = readSnapshot;
    await f.dispose();
  }
});
