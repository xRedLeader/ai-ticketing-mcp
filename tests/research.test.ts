import { mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerResearchContractTests } from '../src/testing/research-contracts.js';
registerResearchContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-store-')),
    filename = join(directory, 'store.sqlite');
  let current = createSqliteAdapters(filename);
  return {
    ...current,
    async reopen() {
      await current.storage.close();
      await current.search.close();
      current = createSqliteAdapters(filename);
      return current;
    },
    async dispose() {
      await current.storage.close();
      await current.search.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('research-store-'));
      await rm(directory, { recursive: true });
    },
  };
});
