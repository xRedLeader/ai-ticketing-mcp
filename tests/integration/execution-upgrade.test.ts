import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { createApplication } from '../../src/application.js';
import { fixture, testEmbeddings } from '../../src/testing/contracts.js';

it('adds PostgreSQL execution storage without changing existing checkpoints, claims or retry receipts', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required.');
  const bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `execution_upgrade_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const storage = new PostgresStorage(url.href);
  const search = new PostgresSearch(storage.pool);
  try {
    await storage.pool.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql') && name < '014_execution_runs.sql')
      .sort()) {
      await storage.pool.query(await readFile(new URL(name, directory), 'utf8'));
      await storage.pool.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    await search.configure(testEmbeddings.profile);
    const f = await fixture({ storage, search });
    const ticket = await f.ticket();
    const claimed = await f.claim(ticket.id);
    await f.call(f.worker.id, 'ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claimed.claim.token,
      progress: 'Existing progress.',
    });
    const original = {
      notes: await storage.find('notes'),
      receipts: await storage.find('receipts'),
      claims: await storage.find('claims'),
      tickets: await storage.find('tickets'),
    };
    await storage.migrate();
    await storage.migrate();
    assert.deepEqual(
      {
        notes: await storage.find('notes'),
        receipts: await storage.find('receipts'),
        claims: await storage.find('claims'),
        tickets: await storage.find('tickets'),
      },
      original,
    );
    assert.deepEqual(await storage.find('execution_jobs'), []);
    assert.deepEqual(await storage.find('continuations'), []);
    const app = createApplication({
      storage,
      search,
      executionRecipes: [{ id: 'upgrade', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
    });
    const receipt = await app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claimed.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'upgrade',
      checkpoint: { progress: 'Persisted after additive upgrade.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    });
    assert.ok((receipt as any).run_id);
  } finally {
    await storage.close();
    await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrap.end();
  }
});
