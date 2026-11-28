import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export async function verifyRestore(source: pg.Client, restored: pg.Client) {
  const clients = [source, restored];
  try {
    for (const client of clients) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
    }
    const inventories = [];
    for (const client of clients)
      inventories.push(
        (
          await client.query<{ schema: string; name: string; columns: unknown }>(
            `SELECT n.nspname AS schema,c.relname AS name,coalesce(jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FILTER (WHERE a.attnum IS NOT NULL),'[]'::jsonb) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY n.nspname,c.relname ORDER BY c.relname`,
          )
        ).rows,
      );
    const [original, copy] = inventories;
    const names = [...new Set([...original!, ...copy!].map((table) => table.name))].sort();
    assert.ok(names.length, 'No application tables found in the current schema');
    const results = [];
    for (const name of names) {
      const tables = inventories.map((inventory) => inventory.find((table) => table.name === name));
      assert.ok(tables[0], `${name} exists only in the restored database`);
      assert.ok(tables[1], `${name} is missing from the restored database`);
      assert.deepEqual(tables[0].columns, tables[1].columns, `${name} columns differ after restore`);
      const fingerprints = [];
      for (const [index, client] of clients.entries()) {
        const table = tables[index]!;
        const hash = createHash('sha256');
        let count = 0;
        // Canonical row ordering also covers composite keys and tables without an id column.
        await client.query(
          `DECLARE restore_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${quote(table.schema)}.${quote(name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        );
        while (true) {
          const page = await client.query<{ row: string }>('FETCH FORWARD 1000 FROM restore_rows');
          for (const row of page.rows) hash.update(row.row + '\n');
          count += page.rows.length;
          if (page.rows.length < 1000) break;
        }
        await client.query('CLOSE restore_rows');
        fingerprints.push({ hash: hash.digest('hex'), count });
      }
      assert.deepEqual(fingerprints[0], fingerprints[1], `${name} differs after restore`);
      results.push({ table: name, rows: fingerprints[0]!.count, match: true });
    }
    for (const client of clients) await client.query('COMMIT');
    return { verified: true, tables: results };
  } catch (error) {
    for (const client of clients) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SOURCE_DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
    throw new Error('SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are required.');
  const source = new pg.Client({ connectionString: process.env.SOURCE_DATABASE_URL });
  const restored = new pg.Client({ connectionString: process.env.RESTORE_DATABASE_URL });
  try {
    await source.connect();
    await restored.connect();
    console.log(JSON.stringify(await verifyRestore(source, restored), null, 2));
  } finally {
    await source.end();
    await restored.end();
  }
}
