import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerExecutionRecoveryContractTests } from '../src/testing/execution-recovery-contracts.js';
registerExecutionRecoveryContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-recovery-db-'));
  const filename = join(directory, 'store.sqlite');
  const adapters = createSqliteAdapters(filename);
  return {
    ...adapters,
    runtimeEnv: { STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: filename },
    async sql(text: string) {
      const db = new DatabaseSync(filename);
      try {
        db.exec(text);
      } finally {
        db.close();
      }
    },
    async dispose() {
      await adapters.storage.close();
      await adapters.search.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
