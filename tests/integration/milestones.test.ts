import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { registerMilestoneContractTests } from '../../src/testing/milestone-contracts.js';

registerMilestoneContractTests('PostgreSQL', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database.');
  const schema = `milestones_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new URL(url);
  isolated.searchParams.set('options', `-c search_path=${schema},public`);
  const storage = new PostgresStorage(isolated.href);
  const search = new PostgresSearch(storage.pool);
  return {
    storage,
    search,
    async dispose() {
      await storage.close();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    },
  };
});
