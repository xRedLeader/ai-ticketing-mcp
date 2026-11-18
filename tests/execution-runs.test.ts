import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerExecutionContractTests } from '../src/testing/execution-contracts.js';
registerExecutionContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-execution-'));
  const filename = join(directory, 'execution.sqlite');
  let adapters = createSqliteAdapters(filename);
  return {
    ...adapters,
    async reopen() {
      await adapters.storage.close();
      await adapters.search.close();
      adapters = createSqliteAdapters(filename);
      return adapters;
    },
    async dispose() {
      await adapters.storage.close();
      await adapters.search.close();
      await rm(directory, { recursive: true });
    },
  };
});
