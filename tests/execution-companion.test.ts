import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExecutionAttempt,
  ExecutionController,
  ExecutionJob,
  ExecutionObservation,
  ExecutionOutcome,
  ExecutionReconciliation,
} from '../src/contracts.js';
import {
  ExecutionRecipeRegistry,
  EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_RECIPE_BYTES,
} from '../src/execution-recipes.js';
import { ExecutionCompanion, type ExecutionApplication } from '../src/execution-companion.js';
import { HostCapacity } from '../src/host-capacity.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { ExecutionArtifacts } from '../src/execution-artifacts.js';
import { fixture as contractFixture } from '../src/testing/contracts.js';

async function fixture(script: string, extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-execution-'));
  const adapters = createSqliteAdapters(join(directory, 'launch.sqlite'));
  await adapters.storage.migrate();
  const authority = await contractFixture(adapters);
  const project = authority.project.id,
    actor = authority.admin.id;
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
  const registered = createApplication({ ...adapters, executionRecipes: recipes.metadata() });
  const ticket = await authority.ticket();
  const claim = await authority.claim(ticket.id);
  const receipt = (await registered.execute(authority.worker.id, 'run_submit', {
    project_id: project,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: metadata.id,
    checkpoint: { progress: 'Await execution.' },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  let job: ExecutionJob = (await adapters.storage.get('execution_jobs', receipt.run_id))!;
  const events: string[] = [];
  let controller: ExecutionController | null = null;
  let attempt: ExecutionAttempt;
  let observed: ExecutionObservation | null = null;
  const state = (): ExecutionReconciliation => ({
    run: { ...job },
    attempt,
    observation: observed,
    state: ['succeeded', 'failed'].includes(job.status)
      ? 'completed'
      : observed?.kind === 'running'
        ? 'running'
        : 'unresolved',
    next_step: observed?.next_step ?? (job.status === 'reserved' ? 'dispatch' : 'inspect_launch'),
  });
  const app: ExecutionApplication = {
    cancelExecutionRun: registered.cancelExecutionRun.bind(registered),
    reconcileExecutionCancellation: registered.reconcileExecutionCancellation.bind(registered),
    storage: adapters.storage,
    async acquireExecutionController(_actor, _project, owner, lease) {
      if (controller) return null;
      const acquired = await registered.acquireExecutionController(actor, project, owner, lease);
      if (acquired) controller = acquired;
      return acquired;
    },
    async heartbeatExecutionController() {
      return true;
    },
    async releaseExecutionController() {
      if (controller) await registered.releaseExecutionController(actor, project, controller);
      controller = null;
    },
    async listExecutionReconciliations(_actor, _project, ids) {
      return ids?.includes(job.id) || (!ids && ['reserved', 'running'].includes(job.status)) ? [state()] : [];
    },
    async adoptExecutionRun() {
      job.reservation_token = randomUUID();
      return state();
    },
    async observeExecutionRun(_actor, _project, _id, _token, _attempt, _process, fence, identity, kind) {
      observed = {
        id: randomUUID(),
        project_id: project,
        run_id: job.id,
        attempt_id: attempt.id,
        sequence: (observed?.sequence ?? 0) + 1,
        controller_generation: fence.generation,
        kind,
        next_step: kind === 'running' ? 'wait_for_result' : 'inspect_side_effects',
        process_identity: identity,
        outcome: null,
        created_at: new Date().toISOString(),
      };
      return true;
    },
    async recoverExecutionRun(actor, project, id, token, _attempt, _process, outcome, fence) {
      return app.settleExecutionRun(actor, project, id, token, outcome, fence);
    },
    async listExecutionRuns() {
      return job.status === 'queued' ? [{ ...job }] : [];
    },
    async reserveExecutionRun() {
      if (job.status !== 'queued') return null;
      events.push('reserved');
      job = (await registered.reserveExecutionRun(actor, project, job.id, 60000, controller!))!;
      attempt = (await registered.listExecutionReconciliations(actor, project, [job.id]))[0]!.attempt!;
      return { ...job };
    },
    async startExecutionRun() {
      assert.equal(capacity.inspect('host').occupied.script, 1);
      assert.equal(job.status, 'reserved');
      events.push('running');
      const current = createApplication({
        ...adapters,
        executionRecipes: [
          { id: job.recipe_id, fingerprint: job.recipe_fingerprint, project_ids: [project] },
        ],
      });
      job = (await current.startExecutionRun(
        actor,
        project,
        job.id,
        job.reservation_token!,
        60000,
        controller!,
      ))!;
      return { ...job };
    },
    admitExecutionRun: registered.admitExecutionRun.bind(registered),
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
    artifactDirectory: () => join(options.artifacts_directory, job.id, attempt.id),
    get attempt() {
      return attempt;
    },
    job: () => job,
    setRecipeFingerprint(fingerprint: string) {
      const db = new DatabaseSync(adapters.storage.executionLaunchStorage!.filename);
      try {
        db.prepare('UPDATE execution_jobs SET recipe_fingerprint=? WHERE id=?').run(fingerprint, job.id);
        job.recipe_fingerprint = fingerprint;
      } finally {
        db.close();
      }
    },
    async dispose() {
      capacity.close();
      await adapters.storage.close();
      await adapters.search.close();
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
      directory = f.artifactDirectory();
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
      ['stdout', 'stderr', 'result'].map((name) => `execution:${job.id}:${f.attempt.id}:${name}`),
    );
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.exit_code, 7);
    assert.equal(result.cleanup_verified, true);
    assert.deepEqual(result.truncated, { stdout: true, stderr: true });
    assert.deepEqual(result.total_bytes, { stdout: 100016, stderr: 100000 });
    const publicResult = JSON.parse(await readFile(join(directory, 'outcome.json'), 'utf8'));
    assert.equal(publicResult.exit_code, 7);
    assert.equal(publicResult.process_token, undefined);
    assert.equal(
      result.sha256.stdout,
      createHash('sha256')
        .update(await readFile(join(directory, 'stdout.log')))
        .digest('hex'),
    );
    assert.equal(
      result.sha256.result,
      createHash('sha256')
        .update(await readFile(join(directory, 'outcome.json')))
        .digest('hex'),
    );
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
  } finally {
    delete process.env[inherited];
    await f.dispose();
  }
});

it('streams large Unicode output through bounded capture without losing its exit status', async () => {
  const f = await fixture(
    `
    const { once } = require('node:events');
    (async () => {
      const chunk = '🧪漢'.repeat(8192);
      for (let i = 0; i < 512; i++) if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
      process.stderr.write('fixture.ts:7: failed\\n');
      process.exitCode = 23;
    })();`,
    { max_log_bytes: 127 },
  );
  try {
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), true);
    assert.equal(f.job().exit_code, 23);
    const directory = f.artifactDirectory(),
      result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.total_bytes.stdout, 7 * 8192 * 512);
    assert.equal(result.bytes.stdout, 127);
    assert.equal((await stat(join(directory, 'stdout.log'))).size, 127);
    assert.equal(
      result.sha256.stdout,
      createHash('sha256')
        .update(await readFile(join(directory, 'stdout.log')))
        .digest('hex'),
    );
    assert.equal(result.truncated.stdout, true);
  } finally {
    await f.dispose();
  }
});

it('preserves the authoritative exit journal when the public outcome artifact cannot be published', async () => {
  const f = await fixture(`
    const fs = require('node:fs'), path = require('node:path');
    const root = path.join(process.cwd(), 'artifacts');
    const run = path.join(root, fs.readdirSync(root)[0]);
    fs.writeFileSync(path.join(run, fs.readdirSync(run)[0], 'outcome.json'), 'untrusted collision');
    process.exitCode = 19;`);
  try {
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), true);
    assert.equal(f.job().exit_code, 19);
    const result = JSON.parse(await readFile(join(f.artifactDirectory(), 'result.json'), 'utf8'));
    assert.equal(result.exit_code, 19);
    assert.deepEqual(result.artifact_errors, ['OUTCOME_WRITE_FAILED']);
    assert.equal(result.sha256.result, null);
    const artifact = new ExecutionArtifacts(f.options.artifacts_directory).read(
      f.job().artifacts[2]!,
      {
        run_id: f.job().id,
        attempt_id: f.attempt.id,
        process_token: f.attempt.process_token,
        recipe_fingerprint: f.job().recipe_fingerprint,
      },
      0,
      1024,
      Date.now(),
    );
    assert.equal(artifact.status, 'missing');
  } finally {
    await f.dispose();
  }
});

it('releases a verified timed-out process group and retains unverified cleanup without rerun', async () => {
  const f = await fixture(`process.stdout.write('started'); setTimeout(() => {}, 10000);`, {
    timeout_ms: 200,
  });
  try {
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), true);
    const verified = process.platform === 'linux';
    assert.equal(f.job().status, verified ? 'failed' : 'running');
    assert.equal(f.capacity.inspect('host').occupied.script, verified ? 0 : 1);
    const result = JSON.parse(await readFile(join(f.artifactDirectory(), 'result.json'), 'utf8'));
    assert.equal(result.error_code, 'TIMEOUT');
    assert.equal(result.cleanup_verified, verified);
    assert.ok(result.signal !== null || result.exit_code !== null);
    assert.equal(await new ExecutionCompanion(f.options).runOnce(), false);
    assert.deepEqual(f.events, verified ? ['reserved', 'running', 'settled'] : ['reserved', 'running']);
  } finally {
    await f.dispose();
  }
});

it('transfers recipes above 256 KiB without persisting secrets and rejects the shared input bound before dispatch', async () => {
  const env = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`APPROVED_${i}`, 'x'.repeat(16_384)]));
  const f = await fixture('', { env });
  try {
    const recipe = f.recipes.get('fixture', f.metadata.fingerprint, f.options.project_id);
    assert.ok(Buffer.byteLength(JSON.stringify(recipe)) > 262_144);
    assert.ok(Buffer.byteLength(JSON.stringify(recipe)) <= MAX_EXECUTION_RECIPE_BYTES);
    await new ExecutionCompanion(f.options).runOnce();
    assert.ok(['succeeded', 'failed'].includes(f.job().status));
    assert.equal(f.capacity.inspect('host').occupied.script, 0);
    const manifest = JSON.parse(await readFile(join(f.artifactDirectory(), 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), [
      'attempt_id',
      'process_token',
      'recipe_fingerprint',
      'run_id',
    ]);
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...f.config,
          recipes: [
            {
              ...f.config.recipes[0],
              env: Object.fromEntries(
                Array.from({ length: 80 }, (_, i) => [`TOO_LARGE_${i}`, 'x'.repeat(32_768)]),
              ),
            },
          ],
        }),
      /exceeds 2 MiB/,
    );
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
    f.setRecipeFingerprint(recipes.metadata()[0]!.fingerprint);
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
    const result = JSON.parse(await readFile(join(f.artifactDirectory(), 'result.json'), 'utf8'));
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
    const result = JSON.parse(await readFile(join(f.artifactDirectory(), 'result.json'), 'utf8'));
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
