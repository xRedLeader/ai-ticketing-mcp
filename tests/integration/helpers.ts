import { PostgresStorage, PostgresSearch } from '../../src/adapters/postgres.js';
import { fixture, testEmbeddings } from '../../src/testing/contracts.js';
import type { Policy } from '../../src/contracts.js';
export function adapters() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'TEST_DATABASE_URL is required. Start PostgreSQL with pgvector; integration tests are never silently skipped.',
    );
  const storage = new PostgresStorage(url);
  const search = new PostgresSearch(storage.pool);
  return {
    storage,
    search,
    initialTime: async () =>
      (await storage.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now,
    dispose: () => storage.close(),
  };
}
export async function setup(policy: Policy = 'independent') {
  const a = adapters();
  await a.storage.migrate();
  await a.search.configure(testEmbeddings.profile);
  return { ...(await fixture(a, policy)), dispose: a.dispose };
}
