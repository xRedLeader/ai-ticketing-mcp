import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { registerExecutionRecoveryContractTests } from '../../src/testing/execution-recovery-contracts.js';
registerExecutionRecoveryContractTests('PostgreSQL', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required.');
  const bootstrap = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const storage = new PostgresStorage(url.href),
    search = new PostgresSearch(storage.pool);
  return {
    storage,
    search,
    runtimeEnv: { STORAGE_ADAPTER: 'postgres', DATABASE_URL: url.href },
    async sql(text: string) {
      await storage.pool.query(text);
    },
    async dispose() {
      await storage.close();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    },
  };
});
