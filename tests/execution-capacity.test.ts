import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostCapacity } from '../src/host-capacity.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-execution-capacity-'));
  const capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
  return {
    capacity,
    dispose() {
      capacity.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-execution-capacity-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('scopes companion admission to its exact script IDs without claiming other queued work', () => {
  const f = fixture(),
    capacity = f.capacity;
  try {
    capacity.configureHost('host');
    for (const queue_id of ['companion-script', 'other-script'])
      capacity.enqueue('host', {
        queue_id,
        run_id: queue_id,
        project_id: 'project',
        kind: 'script',
        created_at: queue_id === 'companion-script' ? 0 : 1,
      });
    assert.equal(capacity.claimNext('host', 'companion', { kind: 'script', queue_ids: [] }).admitted, false);
    const admitted = capacity.claimNext('host', 'companion', {
      kind: 'script',
      queue_ids: ['companion-script'],
    });
    assert.equal(admitted.admitted, true);
    if (admitted.admitted) assert.equal(admitted.request.queue_id, 'companion-script');
    assert.equal(
      capacity.inspect('host').entries.find((entry) => entry.queue_id === 'other-script')?.state,
      'queued',
    );
    const other = capacity.claimNext('host', 'normal');
    assert.equal(other.admitted, true);
    if (other.admitted) assert.equal(other.request.queue_id, 'other-script');
  } finally {
    f.dispose();
  }
});

it('scoped admission waits for an earlier eligible script outside its IDs rather than bypassing fairness', () => {
  const f = fixture(),
    capacity = f.capacity;
  try {
    capacity.configureHost('host');
    for (const [queue_id, created_at] of [
      ['earlier', 0],
      ['mine', 1],
    ] as const)
      capacity.enqueue('host', {
        queue_id,
        run_id: queue_id,
        project_id: 'project',
        kind: 'script',
        created_at,
      });
    assert.equal(
      capacity.claimNext('host', 'companion', { kind: 'script', queue_ids: ['mine'] }).admitted,
      false,
    );
    assert.equal(capacity.inspect('host').occupied.script, 0);
    assert.ok(capacity.inspect('host').entries.every((entry) => entry.state === 'queued'));
  } finally {
    f.dispose();
  }
});
