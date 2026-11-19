import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { registerArtifactRetentionContracts } from '../../src/testing/artifact-retention-contracts.js';
registerArtifactRetentionContracts('PostgreSQL', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required.');
  const bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `retention_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const adapters = () => {
    const storage = new PostgresStorage(url.href);
    return { storage, search: new PostgresSearch(storage.pool) };
  };
  let current = adapters();
  return {
    ...current,
    runtimeEnv: { STORAGE_ADAPTER: 'postgres', DATABASE_URL: url.href },
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
