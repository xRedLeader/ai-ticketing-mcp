import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { artifactPinSql } from '../src/adapters/artifact-pins.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { registerMilestoneContractTests } from '../src/testing/milestone-contracts.js';

it('keeps artifact pin SQL compatible with absent optional milestone tables', () => {
  const query = { run_id: 'run', attempt_id: 'attempt', ticket_id: 'ticket', checkpoint_id: 'checkpoint' };
  assert.ok(!artifactPinSql(query, () => '?').includes('milestones'));
  assert.ok(artifactPinSql(query, () => '?', ['milestones']).includes('FROM milestones'));
  assert.ok(!artifactPinSql(query, () => '?', ['injected_table']).includes('injected_table'));
});

registerMilestoneContractTests('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-milestones-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  return {
    ...adapters,
    async dispose() {
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-milestones-'));
      await rm(directory, { recursive: true });
    },
  };
});
