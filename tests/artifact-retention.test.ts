import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerArtifactRetentionContracts } from '../src/testing/artifact-retention-contracts.js';
registerArtifactRetentionContracts('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-retention-db-'));
  const filename = join(directory, 'tickets.sqlite');
  let current = createSqliteAdapters(filename);
  return {
    ...current,
    runtimeEnv: { STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: filename },
    async reopen() {
      await current.storage.close();
      await current.search.close();
      current = createSqliteAdapters(filename);
      return current;
    },
    async dispose() {
      await current.storage.close();
      await current.search.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
