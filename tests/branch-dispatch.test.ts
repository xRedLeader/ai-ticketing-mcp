import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerBranchDispatchContractTests } from '../src/testing/branch-dispatch-contracts.js';

registerBranchDispatchContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-branch-store-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-branch-store-'));
      await rm(directory, { recursive: true });
    },
  };
});
