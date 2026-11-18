import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionJob, ExecutionOutcome } from '../src/contracts.js';
import { ExecutionRecipeRegistry, EXECUTION_TIMEOUT_MS } from '../src/execution-recipes.js';
import { ExecutionCompanion, type ExecutionApplication } from '../src/execution-companion.js';
import { HostCapacity } from '../src/host-capacity.js';

async function fixture(script: string, extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-execution-'));
  const project = randomUUID(),
    actor = randomUUID();
  const config = {
    workspace_roots: [directory],
    recipes: [
      {
        id: 'fixture',
        project_ids: [project],
        executable: process.execPath,
        argv: ['-e', script],
        cwd: directory,
        env: { RECIPE_VALUE: 'approved' },
        ...extra,
      },
    ],
  };
  const recipes = new ExecutionRecipeRegistry(config),
    metadata = recipes.metadata()[0]!;
  let job: ExecutionJob = {
    id: randomUUID(),
    project_id: project,
    actor_id: actor,
    ticket_id: randomUUID(),
    checkpoint_id: randomUUID(),
    continuation_id: randomUUID(),
    claim_token: randomUUID(),
    requirements_revision: 1,
    recipe_id: metadata.id,
    recipe_fingerprint: metadata.fingerprint,
    status: 'queued',
    reservation_token: null,
    locked_until: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    exit_code: null,
    signal: null,
    artifacts: [],
    error_code: null,
  };
  const events: string[] = [];
  const app: ExecutionApplication = {
    async listExecutionRuns() {
      return job.status === 'queued' ? [{ ...job }] : [];
    },
    async reserveExecutionRun() {
      if (job.status !== 'queued') return null;
      events.push('reserved');
      job = { ...job, status: 'reserved', reservation_token: randomUUID() };
      return { ...job };
    },
    async startExecutionRun() {
      assert.equal(capacity.inspect('host').occupied.script, 1);
      assert.equal(job.status, 'reserved');
      events.push('running');
      job = { ...job, status: 'running', started_at: new Date().toISOString() };
      return { ...job };
    },
    async heartbeatExecutionRun() {
      return true;
    },
    async settleExecutionRun(_actor, _project, _id, token, outcome: ExecutionOutcome) {
      assert.equal(token, job.reservation_token);
      events.push('settled');
      if (job.status === 'running') assert.equal(capacity.inspect('host').occupied.script, 1);
      job = {
        ...job,
        ...outcome,
        status: outcome.exit_code === 0 && !outcome.error_code ? 'succeeded' : 'failed',
        finished_at: new Date().toISOString(),
      };
      return true;
    },
  };
  const capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
  capacity.configureHost('host');
  const options = {
    application: app,
    capacity,
    recipes,
    actor_id: actor,
    project_id: project,
    host_id: 'host',
    artifacts_directory: join(directory, 'artifacts'),
  };
  return {
    directory,
    config,
    recipes,
    metadata,
    app,
    capacity,
    options,
    events,
    job: () => job,
    async dispose() {
      capacity.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-execution-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('pins immutable recipes and rejects workspace escapes, scripts and unregistered input', async () => {
  const f = await fixture('');
  try {
    const recipe = f.recipes.get('fixture', f.metadata.fingerprint, f.options.project_id);
    assert.equal(recipe.timeout_ms, EXECUTION_TIMEOUT_MS);
    assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.argv) && Object.isFrozen(recipe.env));
    assert.throws(() => f.recipes.get('fixture', 'changed', f.options.project_id));
    assert.throws(() => f.recipes.get('fixture', f.metadata.fingerprint, randomUUID()));
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...f.config,
          recipes: [{ ...f.config.recipes[0], cwd: dirname(f.directory) }],
        }),
    );
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...f.config,
          recipes: [{ ...f.config.recipes[0], timeout_ms: EXECUTION_TIMEOUT_MS + 1 }],
        }),
    );
    const script = join(f.directory, 'command.cmd');
    await writeFile(script, 'echo unsafe');
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...f.config,
          recipes: [{ ...f.config.recipes[0], executable: script }],
        }),
    );
    const disguised = join(f.directory, 'disguised.exe');
    await writeFile(disguised, 'echo unsafe');
    await chmod(disguised, 0o755);
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...f.config,
          recipes: [{ ...f.config.recipes[0], executable: disguised }],
        }),
    );
    const changed = new ExecutionRecipeRegistry({
      ...f.config,
      recipes: [{ ...f.config.recipes[0], argv: ['-e', 'process.exit(1)'] }],
    });
    assert.notEqual(changed.metadata()[0]!.fingerprint, f.metadata.fingerprint);
  } finally {
    await f.dispose();
  }
});

it('executes once with exact environment, bounded separate logs and authentic exit after durable reservation', async () => {
  const inherited = 'SELF7_UNTRUSTED_ENV';
  process.env[inherited] = 'must-not-leak';
  const f = await fixture(
    `process.stdout.write(process.env.RECIPE_VALUE + ':' + (process.env.${inherited} ?? 'absent') + '\\n');
    process.stdout.write('x'.repeat(100000)); process.stderr.write('e'.repeat(100000)); process.exitCode = 7;`,
    { max_log_bytes: 128 },
  );
  try {
    const results = await Promise.all([
      new ExecutionCompanion(f.options).runOnce(),
      new ExecutionCompanion(f.options).runOnce(),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const job = f.job(),
      directory = join(f.options.artifacts_directory, job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.exit_code, 7);
    assert.equal(job.error_code, null);
    assert.deepEqual(f.events, ['reserved', 'running', 'settled']);
    assert.equal(f.capacity.inspect('host').occupied.script, 0);
    assert.equal((await stat(join(directory, 'stdout.log'))).size, 128);
    assert.equal((await stat(join(directory, 'stderr.log'))).size, 128);
    assert.ok((await readFile(join(directory, 'stdout.log'), 'utf8')).startsWith('approved:absent\n'));
    assert.deepEqual(
      job.artifacts,
      ['stdout', 'stderr', 'result'].map((name) => `execution:${job.id}:${name}`),
    );
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.exit_code, 7);
    assert.equal(result.cleanup_verified, true);
    assert.deepEqual(result.truncated, { stdout: true, stderr: true });
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
  } finally {
    delete process.env[inherited];
    await f.dispose();
  }
});

it('fails closed on unverified timeout, retaining the direct-child observation and occupied slot without rerun', async () => {
  const f = await fixture(`process.stdout.write('started'); setTimeout(() => {}, 10000);`, {
    timeout_ms: 200,
  });
  try {
    await assert.rejects(new ExecutionCompanion(f.options).runOnce(), /termination was not verified/);
    assert.equal(f.job().status, 'running');
    assert.equal(f.capacity.inspect('host').occupied.script, 1);
    const result = JSON.parse(
      await readFile(join(f.options.artifacts_directory, f.job().id, 'result.json'), 'utf8'),
    );
    assert.equal(result.error_code, 'TIMEOUT');
    assert.equal(result.cleanup_verified, false);
    assert.ok(result.signal !== null || result.exit_code !== null);
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
    assert.deepEqual(f.events, ['reserved', 'running']);
  } finally {
    await f.dispose();
  }
});

it('a changed registry fails before host admission or native spawn', async () => {
  const f = await fixture('process.exitCode = 0');
  try {
    const recipes = new ExecutionRecipeRegistry({
      ...f.config,
      recipes: [{ ...f.config.recipes[0], argv: ['-e', 'process.exitCode = 1'] }],
    });
    await new ExecutionCompanion({ ...f.options, recipes }).runOnce();
    assert.equal(f.job().status, 'failed');
    assert.equal(f.job().error_code, 'RECIPE_UNAVAILABLE');
    assert.equal(f.capacity.inspect('host').entries.length, 0);
    assert.deepEqual(f.events, ['reserved', 'settled']);
  } finally {
    await f.dispose();
  }
});

it('records an authentic native spawn failure and releases verified never-started capacity', async () => {
  const f = await fixture('');
  try {
    const cwd = join(f.directory, 'removed-cwd');
    await mkdir(cwd);
    const recipes = new ExecutionRecipeRegistry({ ...f.config, recipes: [{ ...f.config.recipes[0], cwd }] });
    f.job().recipe_fingerprint = recipes.metadata()[0]!.fingerprint;
    await rmdir(cwd);
    await new ExecutionCompanion({ ...f.options, recipes }).runOnce();
    assert.equal(f.job().status, 'failed');
    assert.equal(f.job().exit_code, null);
    assert.equal(f.job().error_code, 'SPAWN_FAILED');
    assert.equal(f.capacity.inspect('host').occupied.script, 0);
    const entry = f.capacity.inspect('host').entries[0]!;
    assert.equal(entry.observation?.state, 'never_started');
    assert.equal(entry.observation?.script_result?.runtime_ms, 0);
  } finally {
    await f.dispose();
  }
});

it('retains local exact results and occupied capacity if the durable terminal fence fails', async () => {
  const f = await fixture('process.stdout.write("complete");');
  try {
    f.app.settleExecutionRun = async () => false;
    await assert.rejects(new ExecutionCompanion(f.options).runOnce(), /result could not be fenced/);
    assert.equal(f.job().status, 'running');
    assert.equal(f.capacity.inspect('host').occupied.script, 1);
    const result = JSON.parse(
      await readFile(join(f.options.artifacts_directory, f.job().id, 'result.json'), 'utf8'),
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.cleanup_verified, true);
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
  } finally {
    await f.dispose();
  }
});

it('retains durable terminal result across the capacity release gap and permits fenced trusted reconciliation', async () => {
  const f = await fixture('process.exitCode = 0;');
  const reconcile = f.capacity.reconcile.bind(f.capacity);
  try {
    f.capacity.reconcile = () => {
      throw new Error('fixture release interruption');
    };
    await assert.rejects(new ExecutionCompanion(f.options).runOnce(), /release interruption/);
    assert.equal(f.job().status, 'succeeded');
    assert.equal(f.capacity.inspect('host').occupied.script, 1);
    assert.equal(f.job().artifacts.length, 3);
    const entry = f.capacity.inspect('host').entries[0]!;
    const originalToken = entry.execution_token;
    const takeover = f.capacity.takeOver('host', f.job().id, entry.lease!.generation, 'trusted-operator');
    assert.equal(takeover.start_allowed, false);
    assert.equal(takeover.execution_token, originalToken);
    const result = JSON.parse(
      await readFile(join(f.options.artifacts_directory, f.job().id, 'result.json'), 'utf8'),
    );
    reconcile(takeover.lease, {
      source: 'trusted-operator-terminal-verification',
      execution_token: takeover.execution_token!,
      observed_at: result.finished_at,
      state: 'terminated',
      script_result: { outcome: 'succeeded', runtime_ms: result.finished_at - result.started_at },
    });
    assert.equal(f.capacity.inspect('host').occupied.script, 0);
  } finally {
    f.capacity.reconcile = reconcile;
    await f.dispose();
  }
});
