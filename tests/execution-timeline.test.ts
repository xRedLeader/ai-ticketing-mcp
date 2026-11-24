import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerExecutionTimelineContractTests } from '../src/testing/execution-timeline-contracts.js';
registerExecutionTimelineContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-timeline-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.storage.close();
      await adapters.search.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
