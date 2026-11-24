import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  HostCapacity,
  type HostCapacityLimits,
  type HostCapacityLease,
  type HostCapacityRequest,
} from '../src/host-capacity.js';

const execute = promisify(execFile);
async function fixture(limits: HostCapacityLimits = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-host-capacity-'));
  const filename = join(directory, 'ledger.sqlite'),
    capacity = new HostCapacity(filename);
  capacity.configureHost('host', limits);
  return {
    filename,
    capacity,
    async dispose() {
      capacity.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-host-capacity-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function queue(
  capacity: HostCapacity,
  queueId: string,
  project = 'project',
  extra: Partial<HostCapacityRequest> = {},
  budget = 100_000,
) {
  if (extra.kind === 'script')
    return capacity.enqueue('host', {
      queue_id: queueId,
      run_id: project,
      project_id: project,
      kind: 'script',
      created_at: Date.now() - 1000,
      ...extra,
    } as HostCapacityRequest);
  capacity.createRun({
    run_id: project,
    project_id: project,
    work: [{ ticket_id: 'ticket', requirements_revision: 1 }],
    limits: { max_attempts: 100, max_provider_tokens: budget, max_runtime_ms: 1_000_000 },
  });
  return capacity.enqueue('host', {
    queue_id: queueId,
    run_id: project,
    kind: 'agent',
    created_at: Date.now() - 1000,
    admission: {
      attempt_id: queueId,
      ticket_id: 'ticket',
      requirements_revision: 1,
      actor_id: 'worker',
      role: 'worker',
      provider: 'fixture',
      model: 'fixture',
      allowance: { provider_tokens: 100, runtime_ms: 1000, cost_usd_micros: null },
    },
    ...extra,
  });
}
function claim(capacity: HostCapacity) {
  const result = capacity.claimNext('host', 'owner');
  assert.equal(result.admitted, true);
  if (!result.admitted) throw new Error('Expected admission');
  return result;
}
function settle(
  capacity: HostCapacity,
  lease: HostCapacityLease,
  outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
) {
  const entry = capacity.inspect('host').entries.find((item) => item.queue_id === lease.queue_id)!;
  return capacity.reconcile(lease, {
    source: 'trusted-supervisor',
    execution_token: entry.execution_token!,
    observed_at: Date.now(),
    state: 'terminated',
    ...(entry.kind === 'script'
      ? { script_result: { outcome, runtime_ms: 10 } }
      : {
          settlement: {
            outcome,
            usage: { input_tokens: 10, output_tokens: 10 },
            usage_source: 'provider-terminal-event',
            runtime_ms: 10,
          },
        }),
  });
}

it('defaults scripts to 30 minutes, keeps the 15-minute agent timeout and rejects excessive script timeouts', async () => {
  const f = await fixture();
  try {
    assert.equal(f.capacity.inspect('host').config.script_timeout_ms, 30 * 60_000);
    queue(f.capacity, 'agent');
    assert.equal(f.capacity.report('project').config.limits.invocation_timeout_ms, 15 * 60_000);
    queue(f.capacity, 'script-default', 'script-project', { kind: 'script' });
    queue(f.capacity, 'script-boundary', 'script-project', {
      kind: 'script',
      timeout_ms: 30 * 60_000,
    });
    assert.equal(
      f.capacity.inspect('host').entries.find((entry) => entry.queue_id === 'script-default')!.timeout_ms,
      30 * 60_000,
    );
    assert.throws(() =>
      queue(f.capacity, 'script-excess', 'script-project', {
        kind: 'script',
        timeout_ms: 30 * 60_000 + 1,
      }),
    );
    assert.equal(f.capacity.inspect('host').entries.length, 3);
  } finally {
    await f.dispose();
  }
});

it('keeps agent and script slots separate and commits actual SELF-10 reservations', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 3; n++) {
      queue(f.capacity, `agent-${n}`);
      queue(f.capacity, `script-${n}`, 'project', { kind: 'script' });
    }
    for (let n = 0; n < 4; n++) claim(f.capacity);
    assert.equal(f.capacity.claimNext('host', 'owner').admitted, false);
    assert.deepEqual(f.capacity.inspect('host').occupied, {
      agent: 2,
      script: 2,
      cpu_millis: 0,
      memory_bytes: 0,
    });
    assert.equal(f.capacity.report('project').totals.in_flight, 2);
    assert.equal(f.capacity.report('project').budget_charged_or_reserved.provider_tokens, 200);
    assert.equal('admit' in f.capacity, false);
    assert.equal('settle' in f.capacity, false);
    assert.equal('runInvocation' in f.capacity, false);
  } finally {
    await f.dispose();
  }
});

it('has one cross-process admission transaction for host slots and usage reservations', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 8; n++) queue(f.capacity, `agent-${n}`);
    const script = `import {HostCapacity} from './src/host-capacity.ts'; const c=new HostCapacity(process.argv[1]); console.log(JSON.stringify(c.claimNext('host',process.argv[2]))); c.close();`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        execute(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, f.filename, `process-${n}`],
          { cwd: process.cwd() },
        ),
      ),
    );
    assert.equal(
      results.map((result) => JSON.parse(result.stdout)).filter((result) => result.admitted).length,
      2,
    );
    assert.equal(f.capacity.inspect('host').occupied.agent, 2);
    assert.equal(f.capacity.report('project').totals.in_flight, 2);
    assert.equal(f.capacity.report('project').budget_charged_or_reserved.provider_tokens, 200);
  } finally {
    await f.dispose();
  }
});

it('concurrent host admissions cannot overbook the actual provider-token budget', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 4; n++) queue(f.capacity, `agent-${n}`, 'project', {}, 150);
    const script = `import {HostCapacity} from './src/host-capacity.ts'; const c=new HostCapacity(process.argv[1]); console.log(JSON.stringify(c.claimNext('host','process'))); c.close();`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.filename], {
          cwd: process.cwd(),
        }),
      ),
    );
    assert.equal(
      results.map((result) => JSON.parse(result.stdout)).filter((result) => result.admitted).length,
      1,
    );
    assert.equal(f.capacity.inspect('host').occupied.agent, 1);
    assert.equal(f.capacity.report('project').budget_charged_or_reserved.provider_tokens, 100);
  } finally {
    await f.dispose();
  }
});

it('scripts run without an agent budget, survive restart and never consume agent attempts or tokens', async () => {
  const f = await fixture({ script_slots: 1, lease_ms: 1 });
  try {
    queue(f.capacity, 'denied-agent', 'a', {}, 50);
    queue(f.capacity, 'script-no-budget', 'b', { kind: 'script', timeout_ms: 10 });
    const first = claim(f.capacity);
    assert.equal(first.lease.queue_id, 'script-no-budget');
    assert.equal(first.request.admission, null);
    assert.equal(f.capacity.report('a').totals.invocations, 0);
    assert.throws(() => f.capacity.report('b'), /Usage run not found/);
    await delay(5);
    const reopened = new HostCapacity(f.filename);
    try {
      assert.equal(reopened.inspect('host').occupied.script, 1);
      queue(reopened, 'script-waits', 'a', { kind: 'script' });
      reopened.cancel('host', first.lease.queue_id);
      assert.equal(reopened.claimNext('host', 'owner').admitted, false);
      const recovery = reopened.takeOver('host', first.lease.queue_id, 1, 'restarted');
      assert.throws(() => settle(reopened, first.lease), /Stale execution ownership/);
      settle(reopened, recovery.lease, 'failed');
      assert.equal(claim(reopened).lease.queue_id, 'script-waits');
      assert.equal(reopened.report('a').totals.invocations, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

it('normalizes host identifiers consistently and enforces one policy for queued project work', async () => {
  const f = await fixture();
  try {
    f.capacity.configureHost(' host ');
    f.capacity.enqueue(' host ', {
      queue_id: 'script',
      run_id: 'run',
      project_id: 'project',
      kind: 'script',
      created_at: Date.now(),
    });
    assert.equal(f.capacity.inspect('host').entries.length, 1);
    const first = f.capacity.claimNext(' host ', 'owner');
    assert.equal(first.admitted, true);
    if (first.admitted) {
      assert.equal(first.lease.host_id, 'host');
      settle(f.capacity, first.lease);
    }
    queue(f.capacity, 'one');
    assert.throws(
      () => queue(f.capacity, 'two', 'project', { policy: 'unblocking' }),
      /one scheduling policy/,
    );
  } finally {
    await f.dispose();
  }
});

it('requires independently observed no-start evidence and makes reconciliation idempotent', async () => {
  const f = await fixture();
  try {
    queue(f.capacity, 'one');
    const first = claim(f.capacity);
    const evidence = {
      source: 'native-supervisor-spawn-log',
      execution_token: first.request.execution_token!,
      observed_at: Date.now(),
      state: 'never_started' as const,
      settlement: {
        outcome: 'cancelled' as const,
        usage: { input_tokens: 0, output_tokens: 0 },
        usage_source: 'supervisor-confirmed-no-provider-call',
        runtime_ms: 0,
      },
    };
    assert.throws(
      () =>
        f.capacity.reconcile(first.lease, {
          ...evidence,
          settlement: { ...evidence.settlement, runtime_ms: 1 },
        }),
      /zero usage/,
    );
    assert.equal(f.capacity.inspect('host').occupied.agent, 1);
    assert.deepEqual(f.capacity.reconcile(first.lease, evidence), { released: true });
    assert.deepEqual(f.capacity.reconcile(first.lease, evidence), { released: false });
    assert.equal(f.capacity.report('project').budget_charged_or_reserved.provider_tokens, 0);
    assert.equal(f.capacity.report('project').totals.invocations, 1);
  } finally {
    await f.dispose();
  }
});

it('rolls back budget admission when saving the capacity slot fails', async () => {
  const f = await fixture();
  try {
    queue(f.capacity, 'one');
    const db = new DatabaseSync(f.filename);
    db.exec(
      "CREATE TRIGGER fail_host BEFORE UPDATE ON host_capacity BEGIN SELECT RAISE(ABORT,'injected slot persistence failure'); END",
    );
    assert.throws(() => claim(f.capacity), /injected slot persistence failure/);
    assert.equal(f.capacity.report('project').totals.in_flight, 0);
    assert.equal(f.capacity.inspect('host').occupied.agent, 0);
    db.exec('DROP TRIGGER fail_host');
    db.close();
    claim(f.capacity);
  } finally {
    await f.dispose();
  }
});

it('retains cancelled, expired and restarted slots until fenced terminal reconciliation', async () => {
  const f = await fixture({ agent_slots: 1, lease_ms: 1 });
  try {
    queue(f.capacity, 'one');
    queue(f.capacity, 'two');
    const first = claim(f.capacity);
    await delay(5);
    assert.equal(f.capacity.inspect('host').entries[0]!.state, 'reconciling');
    f.capacity.cancel('host', 'one');
    assert.equal(f.capacity.claimNext('host', 'other').admitted, false);
    const reopened = new HostCapacity(f.filename);
    try {
      assert.equal(reopened.inspect('host').occupied.agent, 1);
      const recovered = reopened.takeOver('host', 'one', first.lease.generation, 'restarted');
      assert.equal(recovered.start_allowed, false);
      assert.equal(recovered.lease.generation, 2);
      assert.notEqual(recovered.lease.token, first.lease.token);
      assert.equal(recovered.execution_token, first.request.execution_token);
      assert.throws(() => f.capacity.heartbeat(first.lease), /Stale execution ownership/);
      assert.throws(() => settle(f.capacity, first.lease), /Stale execution ownership/);
      assert.throws(() => reopened.takeOver('host', 'one', 1, 'other'), /Stale recovery generation/);
      settle(reopened, recovered.lease, 'cancelled');
      assert.equal(reopened.inspect('host').occupied.agent, 0);
      assert.equal(reopened.report('project').totals.in_flight, 0);
      claim(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

it('settles and releases atomically and rejects evidence for a different execution', async () => {
  const f = await fixture();
  try {
    queue(f.capacity, 'one');
    const first = claim(f.capacity);
    const db = new DatabaseSync(f.filename);
    db.exec(
      "CREATE TRIGGER fail_host BEFORE UPDATE ON host_capacity BEGIN SELECT RAISE(ABORT,'injected release failure'); END",
    );
    assert.throws(() => settle(f.capacity, first.lease), /injected release failure/);
    assert.equal(f.capacity.report('project').totals.in_flight, 1);
    assert.equal(f.capacity.inspect('host').occupied.agent, 1);
    db.exec('DROP TRIGGER fail_host');
    db.close();
    assert.throws(
      () =>
        f.capacity.reconcile(first.lease, {
          source: 'supervisor',
          execution_token: first.lease.token,
          observed_at: Date.now(),
          state: 'terminated',
          settlement: { outcome: 'failed', runtime_ms: 1 },
        }),
      /another execution/,
    );
    settle(f.capacity, first.lease, 'failed');
    assert.equal(f.capacity.report('project').totals.failed, 1);
  } finally {
    await f.dispose();
  }
});

it('round-robins projects deterministically while preserving project priority and age', async () => {
  const f = await fixture({ agent_slots: 1 });
  try {
    const created = Date.now() - 1000;
    queue(f.capacity, 'a-low', 'a', { priority: 5, created_at: created - 100 });
    queue(f.capacity, 'a-high', 'a', { priority: 1, created_at: created });
    queue(f.capacity, 'b-one', 'b', { priority: 5, created_at: created });
    const first = claim(f.capacity);
    assert.equal(first.lease.queue_id, 'a-high');
    settle(f.capacity, first.lease);
    const second = claim(f.capacity);
    assert.equal(second.lease.queue_id, 'b-one');
    settle(f.capacity, second.lease);
    assert.equal(claim(f.capacity).lease.queue_id, 'a-low');
  } finally {
    await f.dispose();
  }
});

it('keeps strict priority then 24-hour aged FIFO before younger unblocking benefit', async () => {
  const f = await fixture({ agent_slots: 1 });
  try {
    const now = Date.now();
    queue(f.capacity, 'young', 'project', {
      policy: 'unblocking',
      created_at: now - 100,
      unfinished_dependents: 100,
    });
    queue(f.capacity, 'boundary', 'project', { policy: 'unblocking', created_at: now - 86_400_000 });
    queue(f.capacity, 'older', 'project', { policy: 'unblocking', created_at: now - 86_400_001 });
    queue(f.capacity, 'priority', 'project', { policy: 'unblocking', priority: 1, created_at: now });
    for (const queueId of ['priority', 'older', 'boundary', 'young']) {
      const result = claim(f.capacity);
      assert.equal(result.lease.queue_id, queueId);
      settle(f.capacity, result.lease);
    }
  } finally {
    await f.dispose();
  }
});

it('does not let blocked budgets or ineligible projects block eligible projects', async () => {
  const f = await fixture();
  try {
    queue(f.capacity, 'denied', 'a', {}, 50);
    queue(f.capacity, 'ineligible', 'b', { eligible: false });
    queue(f.capacity, 'allowed', 'c');
    assert.equal(claim(f.capacity).lease.queue_id, 'allowed');
    assert.match(f.capacity.inspect('host').entries[0]!.reason!, /^needs_attention:provider_token_limit/);
    assert.equal(f.capacity.report('a').totals.invocations, 0);
    assert.equal(f.capacity.report('a').status, 'needs_attention');
    f.capacity.setEligible('host', 'ineligible', true);
    assert.equal(claim(f.capacity).lease.queue_id, 'ineligible');
  } finally {
    await f.dispose();
  }
});

it('rejects permanently oversized work and reserves a scarce resource opening for fair large work', async () => {
  const f = await fixture({ cpu_millis: 1000, memory_bytes: 1000 });
  try {
    assert.throws(
      () => queue(f.capacity, 'oversized', 'oversized', { resources: { cpu_millis: 1001 } }),
      /never fit/,
    );
    queue(f.capacity, 'active', 'a', { resources: { cpu_millis: 600, memory_bytes: 500 } });
    const first = claim(f.capacity);
    queue(f.capacity, 'large', 'b', { resources: { cpu_millis: 1000, memory_bytes: 1000 } });
    queue(f.capacity, 'small', 'c', { resources: { cpu_millis: 100, memory_bytes: 100 } });
    queue(f.capacity, 'script', 'd', { kind: 'script' });
    assert.equal(claim(f.capacity).lease.queue_id, 'script');
    assert.equal(f.capacity.claimNext('host', 'owner').admitted, false);
    settle(f.capacity, first.lease);
    assert.equal(claim(f.capacity).lease.queue_id, 'large');
    assert.equal(f.capacity.inspect('host').occupied.cpu_millis, 1000);
  } finally {
    await f.dispose();
  }
});

it('prevents duplicate queued attempts and replay never starts an invocation', async () => {
  const f = await fixture();
  try {
    const at = Date.now();
    queue(f.capacity, 'one', 'project', { created_at: at });
    assert.deepEqual(queue(f.capacity, 'one', 'project', { created_at: at }), {
      enqueued: false,
      start_allowed: false,
    });
    f.capacity.configureHost('other');
    const duplicate = f.capacity.inspect('host').entries[0]!;
    assert.throws(
      () =>
        f.capacity.enqueue('other', {
          queue_id: 'other',
          run_id: 'project',
          kind: 'agent',
          created_at: at,
          admission: duplicate.admission,
        }),
      /already queued/,
    );
    const admitted = claim(f.capacity);
    assert.deepEqual(queue(f.capacity, 'one', 'project', { created_at: at }), {
      enqueued: false,
      start_allowed: false,
    });
    assert.equal(f.capacity.claimNext('host', 'owner').admitted, false);
    assert.equal(admitted.start_allowed, true);
    assert.equal(f.capacity.report('project').totals.invocations, 1);
  } finally {
    await f.dispose();
  }
});

it('waits asynchronously with stable revisions, observes other connections and supports cancellation', async () => {
  const f = await fixture({ agent_slots: 1 });
  try {
    queue(f.capacity, 'one');
    queue(f.capacity, 'two');
    claim(f.capacity);
    const blocked = f.capacity.claimNext('host', 'owner');
    assert.equal(blocked.admitted, false);
    assert.equal(f.capacity.claimNext('host', 'owner').revision, blocked.revision);
    let timerRan = false;
    const observer = new HostCapacity(f.filename);
    try {
      const pending = f.capacity.waitForChange('host', blocked.revision, { timeout_ms: 1000 });
      await delay(10);
      timerRan = true;
      observer.cancel('host', 'two');
      assert.equal((await pending).changed, true);
      assert.equal(timerRan, true);
      const revision = f.capacity.inspect('host').revision;
      assert.equal((await f.capacity.waitForChange('host', revision, { timeout_ms: 5 })).changed, false);
      await assert.rejects(
        f.capacity.waitForChange('host', revision, { signal: AbortSignal.abort(), timeout_ms: 10 }),
      );
    } finally {
      observer.close();
    }
  } finally {
    await f.dispose();
  }
});
