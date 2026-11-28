import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { verifyRestore } from '../../scripts/verify-restore.js';
import { PostgresStorage } from '../../src/adapters/postgres.js';

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
        options: `-c search_path=${schema},public`,
      }),
  );
  await writer.connect();
  try {
    await writer.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    for (const schema of schemas) {
      await writer.query(`CREATE SCHEMA ${schema}`);
      await writer.query(
        `CREATE TABLE ${schema}.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`,
      );
    }
    for (const schema of schemas) {
      const url = new URL(process.env.TEST_DATABASE_URL);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      const storage = new PostgresStorage(url.href);
      try {
        await storage.migrate();
        await storage.pool.query("UPDATE schema_migrations SET applied_at='2000-01-01T00:00:00Z'");
      } finally {
        await storage.close();
      }
    }
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
    const actor = randomUUID(),
      project = randomUUID();
    for (const client of [source, restored]) {
      await client.query("INSERT INTO actors VALUES($1,'restore','worker','Worker','agent',false)", [actor]);
      await client.query(
        "INSERT INTO projects(id,key,name,policy,revision,created_at) VALUES($1,'RST','Restore','self',1,'2000-01-01T00:00:00Z')",
        [project],
      );
      await client.query("INSERT INTO execution_admissions VALUES($1,false,$2,'2000-01-01T00:00:00Z')", [
        project,
        actor,
      ]);
      await client.query(
        'CREATE TABLE future_durable (owner text, generation integer, data jsonb, PRIMARY KEY(owner,generation))',
      );
      await client.query(`INSERT INTO future_durable VALUES ('worker',1,'{"retained":true}')`);
    }
    const tables = (await verifyRestore(source, restored)).tables.map((table) => table.table);
    for (const name of [...names, 'schema_migrations', 'actors', 'tickets', 'future_durable'])
      assert.ok(tables.includes(name), `${name} was not inventoried`);
    await restored.query('DELETE FROM execution_admissions');
    await assert.rejects(verifyRestore(source, restored), /execution_admissions differs after restore/);
    await restored.query("INSERT INTO execution_admissions VALUES($1,false,$2,'2000-01-01T00:00:00Z')", [
      project,
      actor,
    ]);
    await restored.query('ALTER TABLE artifact_retirements RENAME TO hidden_artifact_retirements');
    await assert.rejects(verifyRestore(source, restored), /artifact_retirements is missing/);
    await restored.query('ALTER TABLE hidden_artifact_retirements RENAME TO artifact_retirements');
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
    let pages = 0,
      durableCursor = false;
    const intercepted = mock.method(source, 'query', async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.startsWith('DECLARE restore_rows')) durableCursor = sql.includes('"durable""rows"');
      if (durableCursor && sql === 'FETCH FORWARD 1000 FROM restore_rows' && ++pages === 1)
        await writer.query(
          `UPDATE ${schemas[0]}."durable""rows" SET data='{"changed":true}' WHERE generation=2105`,
        );
      return result;
    });
    try {
      const result = await verifyRestore(source, restored);
      assert.equal(pages, 3);
      assert.deepEqual(
        result.tables.filter((table) => ['durable"rows', 'empty_columns'].includes(table.table)),
        [
          { table: 'durable"rows', rows: 2105, match: true },
          { table: 'empty_columns', rows: 1, match: true },
        ],
      );
    } finally {
      intercepted.mock.restore();
    }
    await assert.rejects(verifyRestore(source, restored), /differs after restore/);
  });
});

it('resolves the application schema through visible migration history instead of the first search_path schema', async () => {
  await databases(async (source, restored, writer, schemas) => {
    const unrelated = `${schemas[0]}_unrelated`;
    schemas.push(unrelated);
    await writer.query(`CREATE SCHEMA ${unrelated}`);
    await writer.query(`CREATE TABLE ${unrelated}.unrelated_data (id integer)`);
    for (const [index, client] of [source, restored].entries())
      await client.query(`SET search_path TO ${unrelated},${schemas[index]}`);
    assert.equal((await source.query('SELECT current_schema() AS schema')).rows[0].schema, unrelated);
    assert.ok((await verifyRestore(source, restored)).tables.some((table) => table.table === 'tickets'));
    await restored.query("UPDATE execution_controllers SET owner_id='changed'");
    await assert.rejects(verifyRestore(source, restored), /execution_controllers differs after restore/);
    await restored.query("UPDATE execution_controllers SET owner_id='unclaimed'");
    for (const [index, client] of [source, restored].entries()) {
      await client.query(`SET search_path TO ${unrelated}`);
      await assert.rejects(
        verifyRestore(source, restored),
        new RegExp(`${index === 0 ? 'source' : 'restored'} database has no visible schema_migrations table`),
      );
      await client.query(`SET search_path TO ${unrelated},${schemas[index]}`);
    }
    await writer.query(`CREATE TABLE ${unrelated}.tickets (id integer)`);
    await assert.rejects(verifyRestore(source, restored), /source database search_path shadows .*"tickets"/);
    await writer.query(`DROP TABLE ${unrelated}.tickets`);
    await writer.query(`CREATE TABLE ${unrelated}.schema_migrations (name text PRIMARY KEY)`);
    await assert.rejects(
      verifyRestore(source, restored),
      /source database application schema .* is missing required table actors/,
    );
  });
});

it('rejects absent migration history and incomplete core schemas on either database, even when both match', async () => {
  await databases(async (source, restored, _writer, schemas) => {
    const clients = [source, restored];
    for (const [index, client] of clients.entries())
      await client.query(`SET search_path TO ${schemas[index]}`);
    for (const name of ['schema_migrations', 'tickets']) {
      for (const [index, client] of clients.entries()) {
        await client.query(`ALTER TABLE ${name} RENAME TO hidden_${name}`);
        await assert.rejects(
          verifyRestore(source, restored),
          new RegExp(
            `${index === 0 ? 'source' : 'restored'} database ${name === 'schema_migrations' ? 'has no visible schema_migrations table' : 'application schema .* is missing required table tickets'}`,
          ),
        );
        await client.query(`ALTER TABLE hidden_${name} RENAME TO ${name}`);
      }
      for (const client of clients) await client.query(`ALTER TABLE ${name} RENAME TO hidden_${name}`);
      await assert.rejects(
        verifyRestore(source, restored),
        name === 'schema_migrations'
          ? /no visible schema_migrations table/
          : /missing required table tickets/,
      );
      for (const client of clients) await client.query(`ALTER TABLE hidden_${name} RENAME TO ${name}`);
    }
    assert.equal((await verifyRestore(source, restored)).verified, true);
  });
});
