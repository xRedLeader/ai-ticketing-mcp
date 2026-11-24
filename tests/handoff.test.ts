import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerHandoffContractTests } from '../src/testing/handoff-contracts.js';
import assert from 'node:assert/strict';

registerHandoffContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-handoff-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...adapters,
    dispose: async () => {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-handoff-'));
      await rm(directory, { recursive: true });
    },
  };
});
