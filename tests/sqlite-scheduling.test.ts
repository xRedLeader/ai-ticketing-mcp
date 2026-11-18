import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerSchedulingContractTests } from './scheduling-contract.js';

registerSchedulingContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-scheduling-'));
  const a = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...a,
    async dispose() {
      await a.search.close();
      await a.storage.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-scheduling-'));
      await rm(directory, { recursive: true });
    },
  };
});
