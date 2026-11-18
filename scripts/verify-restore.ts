import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
const source = new pg.Client({ connectionString: process.env.SOURCE_DATABASE_URL });
const restored = new pg.Client({ connectionString: process.env.RESTORE_DATABASE_URL });
if (!process.env.SOURCE_DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are required.');
const tables = [
  'actors',
  'projects',
  'members',
  'tickets',
  'criteria',
  'links',
  'notes',
  'claims',
  'submissions',
  'reviews',
  'knowledge',
  'knowledge_revisions',
  'events',
  'receipts',
  'jobs',
  'schema_migrations',
];
try {
  await source.connect();
  await restored.connect();
  await source.query('BEGIN READ ONLY');
  await restored.query('BEGIN READ ONLY');
  const results = [];
  for (const table of tables) {
    const order = table === 'schema_migrations' ? 'name' : 'id';
    const hashes = [];
    let count = 0;
    for (const client of [source, restored]) {
      const hash = createHash('sha256');
      let offset = 0;
      while (true) {
        const result = await client.query(
          `SELECT row_to_json(t)::text AS row FROM (SELECT * FROM ${table} ORDER BY ${order} LIMIT 1000 OFFSET $1) t`,
          [offset],
        );
        for (const row of result.rows) hash.update(row.row + '\n');
        offset += result.rows.length;
        if (result.rows.length < 1000) break;
      }
      hashes.push(hash.digest('hex'));
      count = offset;
    }
    assert.equal(hashes[0], hashes[1], `${table} differs after restore`);
    results.push({ table, rows: count, match: true });
  }
  await source.query('COMMIT');
  await restored.query('COMMIT');
  console.log(JSON.stringify({ verified: true, tables: results }, null, 2));
} finally {
  await source.end();
  await restored.end();
}
