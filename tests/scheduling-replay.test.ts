import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture } from '../src/testing/contracts.js';
import { replayScheduling } from '../scripts/scheduling-replay.js';

it('replays both production orders on a frozen queue without claiming work or inventing outcomes', async () => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'ticketing-scheduling-replay-test-'));
  assert.equal(dirname(resolve(directory)), root);
  assert.ok(basename(directory).startsWith('ticketing-scheduling-replay-test-'));
  const snapshot = join(directory, 'retained.sqlite');
  try {
    const adapters = createSqliteAdapters(snapshot);
    const inputs = await (async () => {
      try {
        await adapters.storage.migrate();
        const f = await fixture(adapters);
        const oldest = await f.ticket({ priority: 4 });
        f.clock.now = new Date(f.clock.now.getTime() + 1_000);
        const unblocks = await f.ticket({ priority: 4 });
        const follower = await f.ticket({ priority: 4 });
        await f.call(f.worker.id, 'ticket_link', {
          source_id: unblocks.id,
          target_id: follower.id,
          kind: 'blocks',
          action: 'add',
        });
        return {
          oldest,
          unblocks,
          observed_at: f.clock.now.toISOString(),
          project_id: f.project.id,
          actor_id: f.worker.id,
        };
      } finally {
        await Promise.all([adapters.storage.close(), adapters.search.close()]);
      }
    })();
    const original = await readFile(snapshot);
    const { oldest, unblocks, ...observation } = inputs;
    const request = { ...observation, snapshot_sha256: createHash('sha256').update(original).digest('hex') };
    const result = await replayScheduling(snapshot, { ...request, limit: 2 });
    assert.deepEqual(
      result.baseline.candidates.map((t) => t.id),
      [oldest.id, unblocks.id],
    );
    assert.deepEqual(
      result.candidate.candidates.map((t) => t.id),
      [unblocks.id, oldest.id],
    );
    assert.equal(result.first_candidate_changed, true);
    assert.equal(result.provider_invocations_added, 0);
    assert.equal(result.counterfactual_completion, null);
    assert.deepEqual(await replayScheduling(snapshot, { ...request, limit: 2 }), result);
    const defaultPage = await replayScheduling(snapshot, request);
    assert.deepEqual(defaultPage.baseline.candidates, result.baseline.candidates.slice(0, 1));
    assert.deepEqual(defaultPage.candidate.candidates, result.candidate.candidates.slice(0, 1));
    assert.deepEqual(await readFile(snapshot), original);
    await assert.rejects(replayScheduling(snapshot, { ...request, snapshot_sha256: 'f'.repeat(64) }));
    await writeFile(snapshot + '-wal', 'pending observations');
    await assert.rejects(replayScheduling(snapshot, request), /standalone SQLite backup/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
