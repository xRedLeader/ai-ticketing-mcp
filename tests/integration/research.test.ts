import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { registerResearchContractTests } from '../../src/testing/research-contracts.js';
registerResearchContractTests('PostgreSQL', async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL must point to disposable PostgreSQL.');
  const schema = `research_${randomUUID().replaceAll('-', '')}`,
    bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  const adapters = () => {
    const storage = new PostgresStorage(url.href);
    return { storage, search: new PostgresSearch(storage.pool) };
  };
  let current = adapters();
  return {
    ...current,
    async reopen() {
      await current.storage.close();
      current = adapters();
      return current;
    },
    async dispose() {
      await current.storage.close();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    },
  };
});
