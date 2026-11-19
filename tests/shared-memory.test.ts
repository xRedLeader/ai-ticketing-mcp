import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerSharedMemoryContractTests } from '../src/testing/shared-memory-contracts.js';

registerSharedMemoryContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-shared-memory-'));
  const adapters = createSqliteAdapters(join(directory, 'memory.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-shared-memory-'));
      await rm(directory, { recursive: true });
    },
  };
});
