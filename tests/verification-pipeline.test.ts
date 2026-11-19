import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';
import { runVerificationPipeline } from '../src/verification-runner.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { fixture as contractFixture } from '../src/testing/contracts.js';
import { ExecutionCompanion } from '../src/execution-companion.js';
import { ExecutionArtifacts } from '../src/execution-artifacts.js';
import { HostCapacity } from '../src/host-capacity.js';

async function fixture(scripts: string[], project = randomUUID()) {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'ticketing-pipeline-'))),
    repository = join(directory, 'source');
  await mkdir(repository);
  const git = realpathSync(
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0]!,
  );
  const command = (...args: string[]) =>
    execFileSync(git, args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  command('init');
  command('config', 'core.autocrlf', 'false');
  await writeFile(join(repository, 'source.txt'), 'original\n');
  command('add', 'source.txt');
  command(
    '-c',
    'user.name=Pipeline Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'test: pipeline source',
  );
  const toolchain = join(directory, 'toolchain.txt');
  await writeFile(toolchain, 'toolchain-v1');
  const config = {
    workspace_roots: [directory],
    recipes: [
      { id: 'git', project_ids: [project], executable: git, argv: [], cwd: repository, env: {} },
      ...scripts.map((script, index) => ({
        id: `command-${index}`,
        project_ids: [project],
        executable: process.execPath,
        argv: ['-e', script],
        cwd: repository,
        env: { SECRET_FIXTURE: 'private-environment-value' },
        timeout_ms: 10_000,
      })),
    ],
    pipelines: [
      {
        id: 'verify',
        project_ids: [project],
        source: { recipe_id: 'git', commit: command('rev-parse', 'HEAD').trim() },
        timeout_ms: 30_000,
        max_log_bytes: 32,
        steps: scripts.map((_, index) => ({
          id: `step-${index}`,
          recipe_id: `command-${index}`,
          needs: index ? [`step-${index - 1}`] : [],
          on_failure: 'stop' as 'stop' | 'proceed',
          toolchain_files: [toolchain],
        })),
      },
    ],
  };
  const registry = () => new ExecutionRecipeRegistry(config);
  const pipeline = (recipes = registry()) => {
    const metadata = recipes.metadata().find((item) => item.id === 'verify')!;
    const recipe = recipes.get(metadata.id, metadata.fingerprint, project);
    assert.ok('kind' in recipe);
    return recipe;
  };
  return {
    directory,
    repository,
    command,
    toolchain,
    config,
    project,
    registry,
    pipeline,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('runs every configured step without a model turn, pins identities and permits generated untracked output', async () => {
  const f = await fixture([
    `require('node:fs').writeFileSync('generated.txt','ready')`,
    `if(require('node:fs').readFileSync('generated.txt','utf8')!=='ready') process.exitCode=1`,
  ]);
  try {
    const pipeline = f.pipeline(),
      report = await runVerificationPipeline(pipeline);
    assert.equal(report.status, 'passed');
    assert.deepEqual(
      report.steps.map((step) => step.status),
      ['passed', 'passed'],
    );
    assert.equal(report.source.commit, f.config.pipelines[0]!.source.commit);
    assert.match(report.source.tracked_sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      report.steps.every(
        (step) =>
          /^[a-f0-9]{64}$/.test(step.recipe_fingerprint) && /^[a-f0-9]{64}$/.test(step.toolchain_sha256),
      ),
    );
    assert.ok(Object.isFrozen(pipeline) && Object.isFrozen(pipeline.steps[0]!.toolchain_files));
    const json = JSON.stringify(report);
    assert.ok(
      !json.includes('private-environment-value') && !json.includes(f.repository) && !json.includes('argv'),
    );
  } finally {
    await f.dispose();
  }
});

it('records bounded failure diagnostics, dependency skips and explicit proceed/stop decisions', async () => {
  const f = await fixture([
    `process.stderr.write('x'.repeat(100000));process.exitCode=7`,
    '',
    '',
    `process.exitCode=9`,
    '',
  ]);
  try {
    const steps = f.config.pipelines[0]!.steps;
    steps[0]!.on_failure = 'proceed';
    steps[2]!.needs = [];
    steps[3]!.needs = [];
    const report = await runVerificationPipeline(f.pipeline());
    assert.equal(report.status, 'failed');
    assert.deepEqual(
      report.steps.map((step) => step.status),
      ['failed', 'skipped', 'passed', 'failed', 'skipped'],
    );
    assert.equal(report.steps[0]!.exit_code, 7);
    assert.equal(report.steps[0]!.diagnostics.stderr.total_bytes, 100000);
    assert.equal(report.steps[0]!.diagnostics.stderr.captured_bytes, 512);
    assert.equal(report.steps[0]!.diagnostics.stderr.truncated, true);
    assert.equal(report.steps[1]!.error_code, 'DEPENDENCY_FAILED');
    assert.deepEqual(report.steps[1]!.blocked_by, ['step-0']);
    assert.equal(report.steps[4]!.error_code, 'PIPELINE_STOPPED');
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 65536);
  } finally {
    await f.dispose();
  }
});

it('records a timed-out step and never proceeds without confirmed process cleanup', async () => {
  const f = await fixture([`setTimeout(()=>{},10000)`, '']);
  try {
    f.config.recipes[1]!.timeout_ms = 25;
    const report = await runVerificationPipeline(f.pipeline());
    assert.equal(report.status, 'failed');
    assert.equal(report.steps[0]!.status, 'timed_out');
    assert.equal(report.steps[0]!.error_code, 'TIMEOUT');
    assert.equal(report.steps[1]!.status, 'skipped');
    if (process.platform === 'win32') assert.equal(report.cleanup_verified, false);
  } finally {
    await f.dispose();
  }
});

it('rejects changed source bytes even when Git status hides the tracked file', async () => {
  const f = await fixture([`require('node:fs').writeFileSync('must-not-run','x')`]);
  try {
    const pipeline = f.pipeline();
    f.command('update-index', '--skip-worktree', 'source.txt');
    await writeFile(join(f.repository, 'source.txt'), 'changed\n');
    assert.equal(f.command('status', '--porcelain', '--untracked-files=no').trim(), '');
    const report = await runVerificationPipeline(pipeline);
    assert.equal(report.status, 'failed');
    assert.equal(report.error_code, 'SOURCE_CHANGED');
    assert.equal(report.steps[0]!.status, 'skipped');
    await assert.rejects(readFile(join(f.repository, 'must-not-run')));
  } finally {
    await f.dispose();
  }
});

it('records total pipeline timeout and skips remaining work after its deadline', async () => {
  const f = await fixture(['', '']);
  try {
    const report = await runVerificationPipeline(f.pipeline(), Date.now() - 1);
    assert.equal(report.status, 'failed');
    assert.equal(report.error_code, 'TIMEOUT');
    assert.deepEqual(
      report.steps.map((step) => step.status),
      ['skipped', 'skipped'],
    );
    assert.deepEqual(
      report.steps.map((step) => step.error_code),
      ['TIMEOUT', 'PIPELINE_STOPPED'],
    );
  } finally {
    await f.dispose();
  }
});

it('refuses passing evidence when source or a declared toolchain changes during a step', async () => {
  for (const target of ['source', 'toolchain']) {
    const f = await fixture(['', '']);
    try {
      const path = target === 'source' ? join(f.repository, 'source.txt') : f.toolchain;
      f.config.recipes[1]!.argv = [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(path)},'changed')`,
      ];
      const report = await runVerificationPipeline(f.pipeline());
      assert.equal(report.status, 'failed');
      assert.equal(report.steps[0]!.status, 'failed');
      assert.equal(report.steps[1]!.status, 'skipped');
      assert.ok(['SOURCE_CHANGED', 'TOOLCHAIN_CHANGED', 'IDENTITY_UNAVAILABLE'].includes(report.error_code!));
    } finally {
      await f.dispose();
    }
  }
});

it('rejects cycles, unknown recipes, source mismatch and arbitrary pipeline commands', async () => {
  const f = await fixture(['']);
  try {
    const original = structuredClone(f.config);
    f.config.pipelines[0]!.steps[0]!.needs = ['step-0'];
    assert.throws(f.registry);
    f.config.pipelines = structuredClone(original.pipelines);
    f.config.pipelines[0]!.steps[0]!.recipe_id = 'unknown';
    assert.throws(f.registry);
    f.config.pipelines = structuredClone(original.pipelines);
    f.config.pipelines[0]!.source.commit = '0'.repeat(40);
    assert.throws(f.registry);
    assert.throws(
      () =>
        new ExecutionRecipeRegistry({
          ...original,
          pipelines: [{ ...original.pipelines[0], command: 'caller-input' }],
        }),
    );
    const first = new ExecutionRecipeRegistry(original)
      .metadata()
      .find((item) => item.id === 'verify')!.fingerprint;
    original.recipes[1]!.argv = ['-e', 'process.exitCode=1'];
    assert.notEqual(
      new ExecutionRecipeRegistry(original).metadata().find((item) => item.id === 'verify')!.fingerprint,
      first,
    );
  } finally {
    await f.dispose();
  }
});

it('settles one fenced durable run and publishes the pipeline through the existing result artifact without submitting the ticket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-pipeline-db-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  await adapters.storage.migrate();
  const authority = await contractFixture(adapters);
  const f = await fixture(['', ''], authority.project.id);
  const recipes = f.registry(),
    artifacts = join(f.directory, 'artifacts');
  const app = createApplication({
    ...adapters,
    executionRecipes: recipes.metadata(),
    executionArtifacts: new ExecutionArtifacts(artifacts),
  });
  const capacity = new HostCapacity(join(f.directory, 'capacity.sqlite'));
  capacity.configureHost('test');
  try {
    const ticket = await authority.ticket(),
      claim = await authority.claim(ticket.id);
    const receipt = (await app.execute(authority.worker.id, 'run_submit', {
      project_id: f.project,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'verify',
      checkpoint: { progress: 'Verify configured steps.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    const options = {
      application: app,
      capacity,
      recipes,
      actor_id: authority.admin.id,
      project_id: f.project,
      host_id: 'test',
      artifacts_directory: artifacts,
    };
    assert.equal(await new ExecutionCompanion(options).runOnce(), true);
    const run = (await adapters.storage.get('execution_jobs', receipt.run_id))!;
    assert.equal(run.status, 'succeeded');
    assert.equal((await adapters.storage.get('continuations', run.continuation_id))!.status, 'satisfied');
    assert.equal((await adapters.storage.get('tickets', ticket.id))!.status, 'in_progress');
    assert.equal((await adapters.storage.find('submissions', { where: { ticket_id: ticket.id } })).length, 0);
    assert.equal(capacity.inspect('test').occupied.script, 0);
    const result = (await app.execute(authority.worker.id, 'artifact_read', {
      project_id: f.project,
      artifact_id: run.artifacts.find((item) => item.endsWith(':result'))!,
      length: 65536,
      max_tokens: 16000,
    })) as any;
    const outcome = JSON.parse(Buffer.from(result.range.data, 'base64').toString('utf8'));
    assert.equal(outcome.verification.status, 'passed');
    assert.deepEqual(
      outcome.verification.steps.map((step: any) => step.status),
      ['passed', 'passed'],
    );
    assert.equal(await new ExecutionCompanion(options).runOnce(), false);
  } finally {
    capacity.close();
    await adapters.storage.close();
    await adapters.search.close();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
