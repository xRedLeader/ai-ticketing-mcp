import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { verifyRestore } from '../../scripts/verify-restore.js';

async function databases(
  work: (source: pg.Client, restored: pg.Client, writer: pg.Client, schemas: string[]) => Promise<void>,
) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schemas = ['source', 'restored'].map((name) => `restore_${name}_${randomUUID().replaceAll('-', '')}`);
  const writer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const [source, restored] = schemas.map(
    (schema) =>
      new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      }),
  );
  await writer.connect();
  try {
    for (const schema of schemas) await writer.query(`CREATE SCHEMA ${schema}`);
    await source!.connect();
    await restored!.connect();
    await work(source!, restored!, writer, schemas);
  } finally {
    await source!.end();
    await restored!.end();
    for (const schema of schemas) await writer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await writer.end();
  }
}

it('discovers every durable table and rejects lost, missing, extra, or changed restored data', async () => {
  await databases(async (source, restored) => {
    const names = [
      'execution_admissions',
      'execution_cancellations',
      'wake_conditions',
      'knowledge_promotions',
      'artifact_retirements',
      'github_evidence',
      'outbound_deliveries',
      'ideas',
      'idea_tickets',
      'milestones',
      'milestone_memberships',
      'research_spikes',
      'branch_dispatches',
    ];
    for (const client of [source, restored]) {
      for (const name of names) {
        await client.query(
          `CREATE TABLE ${name} (owner text, generation integer, data jsonb, PRIMARY KEY(owner,generation))`,
        );
        await client.query(`INSERT INTO ${name} VALUES ('worker',1,'{"retained":true}')`);
      }
    }
    assert.deepEqual(
      (await verifyRestore(source, restored)).tables.map((table) => table.table),
      [...names].sort(),
    );
    await restored.query('DELETE FROM execution_admissions');
    await assert.rejects(verifyRestore(source, restored), /execution_admissions differs after restore/);
    await restored.query(`INSERT INTO execution_admissions VALUES ('worker',1,'{"retained":true}')`);
    await restored.query('DROP TABLE artifact_retirements');
    await assert.rejects(verifyRestore(source, restored), /artifact_retirements is missing/);
    await restored.query(
      'CREATE TABLE artifact_retirements (owner text, generation integer, data jsonb, PRIMARY KEY(owner,generation))',
    );
    await restored.query(`INSERT INTO artifact_retirements VALUES ('worker',1,'{"retained":true}')`);
    await restored.query('CREATE TABLE unexpected_durable (id integer)');
    await assert.rejects(verifyRestore(source, restored), /unexpected_durable exists only/);
    await restored.query('DROP TABLE unexpected_durable');
    await restored.query('ALTER TABLE execution_admissions ADD COLUMN lost_column text');
    await assert.rejects(verifyRestore(source, restored), /execution_admissions columns differ/);
  });
});

it('keeps a repeatable snapshot across cursor pages and canonicalizes quoted tables and JSON', async () => {
  await databases(async (source, restored, writer, schemas) => {
    for (const client of [source, restored]) {
      await client.query('CREATE TABLE empty_columns ()');
      await client.query('INSERT INTO empty_columns DEFAULT VALUES');
      await client.query(
        'CREATE TABLE "durable""rows" (owner text, generation integer, data jsonb, PRIMARY KEY(owner,generation))',
      );
      await client.query(
        `INSERT INTO "durable""rows" SELECT 'worker',n,jsonb_build_object('z',n,'a',true) FROM generate_series(1,2105) n`,
      );
    }
    const query = source.query.bind(source);
    let pages = 0;
    const intercepted = mock.method(source, 'query', async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql === 'FETCH FORWARD 1000 FROM restore_rows' && ++pages === 1)
        await writer.query(
          `UPDATE ${schemas[0]}."durable""rows" SET data='{"changed":true}' WHERE generation=2105`,
        );
      return result;
    });
    try {
      const result = await verifyRestore(source, restored);
      assert.equal(pages, 4);
      assert.deepEqual(result.tables, [
        { table: 'durable"rows', rows: 2105, match: true },
        { table: 'empty_columns', rows: 1, match: true },
      ]);
    } finally {
      intercepted.mock.restore();
    }
    await assert.rejects(verifyRestore(source, restored), /differs after restore/);
  });
});
