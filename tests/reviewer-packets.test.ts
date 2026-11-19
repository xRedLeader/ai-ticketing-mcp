import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerReviewerPacketContracts } from '../src/testing/reviewer-packet-contracts.js';

registerReviewerPacketContracts('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-review-packet-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-review-packet-'));
      await rm(directory, { recursive: true });
    },
  };
});
