import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerClientCapabilityContracts } from '../src/testing/client-capability-contracts.js';

registerClientCapabilityContracts('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-client-db-')),
    adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.storage.close();
      await adapters.search.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
