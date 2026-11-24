import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresSearch, PostgresStorage } from '../../src/adapters/postgres.js';
import { registerExecutionCacheContractTests } from '../../src/testing/execution-cache-contracts.js';

registerExecutionCacheContractTests('PostgreSQL', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required.');
  const bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `execution_cache_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const storage = new PostgresStorage(url.href);
  return {
    storage,
    search: new PostgresSearch(storage.pool),
    async dispose() {
      await storage.close();
      try {
        await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await bootstrap.end();
      }
    },
  };
});
