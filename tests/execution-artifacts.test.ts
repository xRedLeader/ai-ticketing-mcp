import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerExecutionArtifactContracts } from '../src/testing/execution-artifact-contracts.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerExecutionArtifactContracts('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-artifact-db-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.storage.close();
      await adapters.search.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
