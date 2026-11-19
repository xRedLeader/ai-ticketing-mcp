import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerWakeContractTests } from '../src/testing/wake-contracts.js';
registerWakeContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-wakes-'));
  const filename = join(directory, 'wakes.sqlite');
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
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-wakes-'));
      await rm(directory, { recursive: true });
    },
  };
});
