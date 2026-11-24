import { mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerIdeaContractTests } from '../src/testing/idea-contracts.js';

registerIdeaContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-ideas-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...adapters,
    dispose: async () => {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-ideas-'));
      await rm(directory, { recursive: true });
    },
  };
});
