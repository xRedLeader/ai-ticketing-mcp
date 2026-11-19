import { registerKnowledgeContractTests } from '../../src/testing/knowledge-contracts.js';
import { adapters } from './helpers.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { createApplication } from '../../src/application.js';

registerKnowledgeContractTests('PostgreSQL', async () => adapters());

it('upgrades legacy PostgreSQL knowledge without inventing provenance or historical revisions', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required.');
  const bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `memory_upgrade_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const storage = new PostgresStorage(url.href);
  try {
    await storage.pool.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql') && name < '013_project_memory.sql')
      .sort()) {
      await storage.pool.query(await readFile(new URL(name, directory), 'utf8'));
      await storage.pool.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    const actorId = randomUUID(),
      projectId = randomUUID(),
      activeId = randomUUID(),
      archivedId = randomUUID();
    const at = new Date().toISOString();
    await storage.pool.query('INSERT INTO actors VALUES($1,$2,$3,$4,$5,$6)', [
      actorId,
      'legacy-memory',
      'operator',
      'Original author',
      'human',
      true,
    ]);
    await storage.pool.query(
      "INSERT INTO projects(id,key,name,policy,revision,created_at) VALUES($1,'OLD','Original project','self',1,$2)",
      [projectId, at],
    );
    for (const [id, kind, revision, archived] of [
      [activeId, 'decision', 3, false],
      [archivedId, 'policy', 7, true],
    ] as const)
      await storage.pool.query('INSERT INTO knowledge VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        id,
        projectId,
        'Original knowledge',
        'Preserve existing evidence.',
        kind,
        revision,
        archived,
        actorId,
        at,
      ]);
    await storage.migrate();
    await storage.migrate();
    const app = createApplication({ storage, search: new PostgresSearch(storage.pool) });
    for (const [id, revision, archived] of [
      [activeId, 3, false],
      [archivedId, 7, true],
    ] as const) {
      const current = await storage.get('knowledge', id);
      assert.equal(current?.revision, revision);
      assert.equal(current?.archived, archived);
      assert.equal(current?.actor_id, actorId);
      assert.equal(current?.updated_at, at);
      assert.deepEqual(current?.sources, []);
      assert.equal(current?.status, 'proposed');
      assert.deepEqual(current?.verification, { state: 'unverified' });
      const historical = (await app.execute(actorId, 'knowledge_get', {
        project_id: projectId,
        knowledge_id: id,
        revision,
      })) as any;
      assert.equal(historical.id, id);
      assert.equal(historical.body, 'Preserve existing evidence.');
      assert.equal(historical.trusted_reuse, false);
      assert.equal((await storage.find('knowledge_revisions', { where: { knowledge_id: id } })).length, 1);
      await assert.rejects(
        app.execute(actorId, 'knowledge_get', { project_id: projectId, knowledge_id: id, revision: 1 }),
        { code: 'NOT_FOUND' },
      );
    }
    await assert.rejects(
      storage.pool.query('UPDATE knowledge_revisions SET body=$1 WHERE knowledge_id=$2', [
        'tampered',
        activeId,
      ]),
      /immutable/,
    );
    await assert.rejects(
      storage.pool.query('DELETE FROM knowledge_revisions WHERE knowledge_id=$1', [activeId]),
      /immutable/,
    );
    const updated = (await app.execute(actorId, 'knowledge_write', {
      project_id: projectId,
      knowledge_id: activeId,
      expected_revision: 3,
      title: 'Current decision',
      body: 'Current evidence.',
      kind: 'decision',
      idempotency_key: randomUUID(),
    })) as any;
    assert.equal(updated.revision, 4);
    assert.equal(
      (await storage.find('knowledge_revisions', { where: { knowledge_id: activeId } })).length,
      2,
    );
  } finally {
    await storage.close();
    try {
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await bootstrap.end();
    }
  }
});
