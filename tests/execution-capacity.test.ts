import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

it('never-started proof cannot release a queued entry claimed in the same millisecond', () => {
  const f = fixture(),
    capacity = f.capacity;
  const originalNow = Date.now;
  try {
    const now = Date.now();
    Date.now = () => now;
    capacity.configureHost('host');
    capacity.enqueue('host', {
      queue_id: 'queue',
      run_id: 'run',
      project_id: 'project',
      kind: 'script',
      created_at: now,
    });
    const entry = capacity.inspect('host').entries[0]!;
    const proof = {
      host_id: 'host',
      queue_id: entry.queue_id,
      run_id: entry.run_id,
      project_id: entry.project_id,
      state: 'queued' as const,
      execution_token: entry.execution_token,
    };
    const claim = capacity.claimNext('host', 'dispatcher');
    assert.equal(claim.admitted, true);
    assert.deepEqual(capacity.reconcileNeverStarted(proof, now), { released: false });
    assert.equal(capacity.inspect('host').occupied.script, 1);
    if (claim.admitted) assert.deepEqual(capacity.inspect('host').entries[0]!.lease, claim.lease);
  } finally {
    Date.now = originalNow;
    f.dispose();
  }
});

it('never-started cleanup matches host/run/project/token and allows running to reconciling once', () => {
  const f = fixture(),
    capacity = f.capacity;
  try {
    for (const host of ['host', 'other']) {
      capacity.configureHost(host);
      capacity.enqueue(host, {
        queue_id: 'queue',
        run_id: 'run',
        project_id: 'project',
        kind: 'script',
        created_at: Date.now(),
      });
      assert.equal(capacity.claimNext(host, 'dispatcher').admitted, true);
    }
    const entry = capacity.inspect('host').entries[0]!;
    const proof = {
      host_id: 'host',
      queue_id: entry.queue_id,
      run_id: entry.run_id,
      project_id: entry.project_id,
      state: 'running' as const,
      execution_token: entry.execution_token,
    };
    for (const mismatch of [
      { host_id: 'other' },
      { queue_id: 'other' },
      { run_id: 'other' },
      { project_id: 'other' },
      { execution_token: randomUUID() },
      { state: 'queued' as const },
    ])
      assert.deepEqual(capacity.reconcileNeverStarted({ ...proof, ...mismatch }, Date.now()), {
        released: false,
      });
    assert.equal(capacity.inspect('host').occupied.script, 1);
    capacity.cancel('host', 'queue');
    assert.equal(capacity.inspect('host').entries[0]!.state, 'reconciling');
    assert.deepEqual(capacity.reconcileNeverStarted(proof, Date.now()), { released: true });
    assert.deepEqual(capacity.reconcileNeverStarted(proof, Date.now()), { released: false });
    assert.equal(capacity.inspect('host').occupied.script, 0);
    assert.equal(capacity.inspect('other').occupied.script, 1);
  } finally {
    f.dispose();
  }
});
