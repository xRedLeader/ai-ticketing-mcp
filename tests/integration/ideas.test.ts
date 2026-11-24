import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { registerIdeaContractTests } from '../../src/testing/idea-contracts.js';

registerIdeaContractTests('PostgreSQL', async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL must point to disposable PostgreSQL with pgvector.');
  const schema = `ideas_${randomUUID().replaceAll('-', '')}`;
  const control = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await control.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  const storage = new PostgresStorage(url.toString());
  const search = new PostgresSearch(storage.pool);
  return {
    storage,
    search,
    dispose: async () => {
      await storage.close();
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.end();
    },
  };
});
