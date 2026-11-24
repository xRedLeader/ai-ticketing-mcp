import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerExecutionUpgradeContractTests } from '../src/testing/execution-upgrade-contracts.js';
registerExecutionUpgradeContractTests('SQLite', 'sqlite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-upgrade-')),
    filename = join(directory, 'store.sqlite');
  const adapters = createSqliteAdapters(filename);
  return {
    ...adapters,
    async sql(text: string) {
      const db = new DatabaseSync(filename);
      try {
        db.exec('PRAGMA foreign_keys=ON');
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
