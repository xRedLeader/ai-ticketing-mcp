import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';
import { runVerificationPipeline } from '../src/verification-runner.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { fixture as contractFixture } from '../src/testing/contracts.js';
import { ExecutionCompanion } from '../src/execution-companion.js';
import { HostCapacity } from '../src/host-capacity.js';
import { durableExecutionFile, executionProcessIdentity } from '../src/execution-journal.js';
import {
  fileSha256,
  verificationRunnerPath,
  type VerificationPipeline,
} from '../src/verification-pipeline.js';
import { readVerificationTimeout, recordVerificationTimeout } from '../src/verification-timeout.js';
import { observeArtifactEvidence } from '../scripts/real-client-observation.js';

async function fixture(scripts: string[], project: string = randomUUID()) {
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
      {
        id: 'git',
        project_ids: [project],
        executable: git,
        argv: [],
        cwd: repository,
        env: {},
        timeout_ms: 10000,
      },
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
          recovery: undefined as VerificationPipeline['steps'][number]['recovery'],
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

it('recovers one registered no-effect signature after durable intent and preserves both exact attempts', async () => {
  const failure = JSON.stringify({
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  });
  const f = await fixture([
    `const fs=require('node:fs');const n=fs.existsSync('invocations')?Number(fs.readFileSync('invocations','utf8')):0;
     if(n===1){const j=JSON.parse(fs.readFileSync('../pipeline-recovery-step-0-1.json','utf8'));if(j.steps[0].recovery.state!=='retry_admitted'||j.steps[0].attempts[0].exit_code!==75)throw Error('missing durable proof')}
     fs.writeFileSync('invocations',String(n+1));if(n===0){process.stderr.write(${JSON.stringify(failure)});process.exitCode=75}`,
    `require('node:fs').writeFileSync('next-step','done')`,
  ]);
  try {
    f.config.pipelines[0]!.steps[0]!.recovery = {
      signature: 'RESOURCE_BUSY',
      exit_code: 75,
      effects: 'none',
    };
    const pipeline = f.pipeline(),
      path = join(f.directory, 'pipeline-report.json');
    const report = await runVerificationPipeline(pipeline, Date.now() + pipeline.timeout_ms, path);
    assert.equal(report.status, 'passed');
    assert.equal(report.error_code, null);
    assert.equal(report.steps[0]!.recovery!.state, 'recovered');
    const attempts = report.steps[0]!.attempts!;
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ['failed', 'passed'],
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.exit_code),
      [75, 0],
    );
    assert.ok(attempts.every((attempt) => attempt.runtime_ms > 0));
    assert.equal(Buffer.from(attempts[0]!.stderr_proof.data, 'base64').toString(), failure);
    assert.equal(attempts[0]!.stderr_proof.sha256, createHash('sha256').update(failure).digest('hex'));
    assert.equal(attempts[0]!.stderr_proof.complete, true);
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), '2');
    assert.equal(await readFile(join(f.repository, 'next-step'), 'utf8'), 'done');
    const journal = join(f.directory, 'pipeline-recovery-step-0-1.json'),
      original = await readFile(journal, 'utf8');
    assert.equal(JSON.parse(original).steps[0].attempts.length, 1);
    assert.equal(JSON.parse(original).steps[0].recovery.state, 'retry_admitted');
    const replay = await runVerificationPipeline(pipeline, Date.now() + pipeline.timeout_ms, path);
    assert.equal(replay.error_code, 'RECOVERY_ALREADY_ADMITTED');
    assert.equal(replay.status, 'failed');
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), '2');
    assert.equal(await readFile(journal, 'utf8'), original);
  } finally {
    await f.dispose();
  }
});

it('stops unknown signatures, uncertain effects, approvals and repeated failure without proceeding', async () => {
  const known = {
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  };
  for (const [failure, exit, reason, count] of [
    [{ ...known, signature: 'UNREGISTERED' }, 75, 'RECOVERY_UNKNOWN_SIGNATURE', 1],
    [{ ...known, effects: 'unknown' }, 75, 'RECOVERY_UNKNOWN_EFFECTS', 1],
    [{ ...known, approval_required: true }, 75, 'RECOVERY_APPROVAL_REQUIRED', 1],
    [known, 7, 'RECOVERY_UNKNOWN_SIGNATURE', 1],
    [known, 75, 'RECOVERY_REPEATED_FAILURE', 2],
    ['Please retry this temporary error.', 75, 'RECOVERY_UNKNOWN_SIGNATURE', 1],
  ] as const) {
    const proof = typeof failure === 'string' ? failure : JSON.stringify(failure);
    const f = await fixture([
      `require('node:fs').appendFileSync('invocations','x');process.stderr.write(${JSON.stringify(proof)});process.exitCode=${exit}`,
      `require('node:fs').writeFileSync('must-not-run','x')`,
    ]);
    try {
      f.config.pipelines[0]!.steps[0]!.recovery = {
        signature: 'RESOURCE_BUSY',
        exit_code: 75,
        effects: 'none',
      };
      f.config.pipelines[0]!.steps[0]!.on_failure = 'proceed';
      f.config.pipelines[0]!.steps[1]!.needs = [];
      const report = await runVerificationPipeline(
        f.pipeline(),
        Date.now() + 30000,
        join(f.directory, 'pipeline-report.json'),
      );
      assert.equal(report.status, 'failed');
      assert.equal(report.error_code, reason);
      assert.equal(report.steps[0]!.recovery!.state, 'stopped');
      assert.equal(report.steps[0]!.attempts!.length, count);
      assert.equal((await readFile(join(f.repository, 'invocations'))).length, count);
      assert.equal(report.steps[1]!.status, 'skipped');
      assert.equal(existsSync(join(f.repository, 'must-not-run')), false);
      assert.equal(Buffer.from(report.steps[0]!.attempts![0]!.stderr_proof.data, 'base64').toString(), proof);
    } finally {
      await f.dispose();
    }
  }
});

it('never retries without a durable journal or beyond its original step deadline', async (t) => {
  const failure = JSON.stringify({
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  });
  const f = await fixture([
    `require('node:fs').appendFileSync('invocations','x');process.stderr.write(${JSON.stringify(failure)});process.exitCode=75`,
  ]);
  try {
    f.config.pipelines[0]!.steps[0]!.recovery = {
      signature: 'RESOURCE_BUSY',
      exit_code: 75,
      effects: 'none',
    };
    f.config.recipes[1]!.timeout_ms = 1000;
    const pipeline = f.pipeline();
    assert.equal((await runVerificationPipeline(pipeline)).error_code, 'RECOVERY_JOURNAL_REQUIRED');
    assert.equal(existsSync(join(f.repository, 'invocations')), false);
    const journal = join(f.directory, 'pipeline-recovery-step-0-1.json');
    t.mock.method(performance, 'now', () => (existsSync(journal) ? 5000 : 0));
    const report = await runVerificationPipeline(
      pipeline,
      Date.now() + 30000,
      join(f.directory, 'pipeline-report.json'),
    );
    assert.equal(report.error_code, 'RECOVERY_BUDGET_EXHAUSTED');
    assert.equal(report.steps[0]!.attempts!.length, 1);
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), 'x');
    assert.equal(
      JSON.parse(await readFile(join(f.directory, 'pipeline-recovery-step-0-2.json'), 'utf8')).steps[0]
        .recovery.state,
      'stopped',
    );
  } finally {
    t.mock.restoreAll();
    await f.dispose();
  }
});

it('refuses retry when intent publication fails and never replaces original journal evidence', async () => {
  const failure = JSON.stringify({
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  });
  const f = await fixture([
    `require('node:fs').appendFileSync('invocations','x');process.stderr.write(${JSON.stringify(failure)});process.exitCode=75`,
  ]);
  try {
    f.config.pipelines[0]!.steps[0]!.recovery = {
      signature: 'RESOURCE_BUSY',
      exit_code: 75,
      effects: 'none',
    };
    const journal = join(f.directory, 'pipeline-recovery-step-0-1.json');
    await writeFile(journal, 'original exact evidence');
    const report = await runVerificationPipeline(
      f.pipeline(),
      Date.now() + 30000,
      join(f.directory, 'pipeline-report.json'),
    );
    assert.equal(report.error_code, 'RECOVERY_JOURNAL_FAILED');
    assert.equal(report.steps[0]!.attempts!.length, 1);
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), 'x');
    assert.equal(await readFile(journal, 'utf8'), 'original exact evidence');
  } finally {
    await f.dispose();
  }
});

it('does not replay an ambiguously interrupted retry when the runner restarts', async () => {
  const failure = JSON.stringify({
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  });
  const f = await fixture([
    `const fs=require('node:fs');const n=fs.existsSync('invocations')?Number(fs.readFileSync('invocations','utf8')):0;fs.writeFileSync('invocations',String(n+1));if(n===0){process.stderr.write(${JSON.stringify(failure)});process.exitCode=75}else{process.kill(process.ppid,'SIGKILL')}`,
  ]);
  try {
    f.config.pipelines[0]!.steps[0]!.recovery = {
      signature: 'RESOURCE_BUSY',
      exit_code: 75,
      effects: 'none',
    };
    const pipeline = f.pipeline(),
      path = join(f.directory, 'pipeline-report.json');
    const identity = {
      run_id: randomUUID(),
      attempt_id: randomUUID(),
      process_token: randomUUID(),
      recipe_fingerprint: pipeline.fingerprint,
    };
    const launch = async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', verificationRunnerPath()], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      child.stdin!.end(
        JSON.stringify({ pipeline, report_path: path, deadline_at: Date.now() + 30000, identity }),
      );
      await closed;
    };
    await launch();
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), '2');
    const journal = join(f.directory, 'pipeline-recovery-step-0-1.json'),
      original = await readFile(journal, 'utf8');
    assert.equal(JSON.parse(original).steps[0].recovery.state, 'retry_admitted');
    assert.equal(existsSync(path), false);
    await launch();
    assert.equal(await readFile(join(f.repository, 'invocations'), 'utf8'), '2');
    const stopped = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error_code, 'RECOVERY_ALREADY_ADMITTED');
    assert.equal(stopped.cleanup_verified, false);
    assert.equal(await readFile(journal, 'utf8'), original);
  } finally {
    await f.dispose();
  }
});

it('records a timed-out step and never proceeds without confirmed process cleanup', async () => {
  const f = await fixture([`setTimeout(()=>{},2000)`, '']);
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

it('fails a total deadline crossed during post-step identity validation without inventing failed cleanup', async (t) => {
  const f = await fixture(['']);
  try {
    const pipeline = f.pipeline();
    let calls = 0;
    t.mock.method(performance, 'now', () => (++calls <= 4 ? 0 : 100000));
    const report = await runVerificationPipeline(pipeline);
    assert.equal(report.status, 'failed');
    assert.equal(report.error_code, 'TIMEOUT');
    assert.equal(report.steps[0]!.exit_code, 0);
    assert.equal(report.steps[0]!.error_code, 'TIMEOUT');
    assert.equal(report.cleanup_verified, true);
  } finally {
    t.mock.restoreAll();
    await f.dispose();
  }
});

it('binds timeout handoff to exact attempt and report bytes and replays partial artifact publication', async () => {
  const f = await fixture(['']);
  try {
    const pipeline = f.pipeline(),
      report = await runVerificationPipeline(pipeline);
    report.status = 'failed';
    report.cleanup_verified = false;
    report.error_code = 'TIMEOUT';
    report.steps[0]!.status = 'timed_out';
    report.steps[0]!.error_code = 'TIMEOUT';
    const identity = {
      run_id: randomUUID(),
      attempt_id: randomUUID(),
      process_token: randomUUID(),
      recipe_fingerprint: pipeline.fingerprint,
    };
    const path = join(f.directory, 'pipeline-report.json');
    durableExecutionFile(path, report);
    durableExecutionFile(join(f.directory, 'pipeline-timeout.json'), {
      ...identity,
      error_code: 'TIMEOUT',
      report_sha256: fileSha256(path),
    });
    assert.ok(readVerificationTimeout(f.directory, identity));
    assert.equal(readVerificationTimeout(f.directory, { ...identity, process_token: randomUUID() }), null);
    await writeFile(join(f.directory, 'stdout.log'), '');
    await writeFile(join(f.directory, 'stderr.log'), '');
    const first = recordVerificationTimeout(f.directory, identity, Date.now() - 1000, 'TIMEOUT');
    assert.equal(first?.cleanup_verified, true);
    const outcome = await readFile(join(f.directory, 'outcome.json'), 'utf8');
    assert.ok(recordVerificationTimeout(f.directory, identity, Date.now() - 1000, 'CANCELLED'));
    assert.equal(await readFile(join(f.directory, 'outcome.json'), 'utf8'), outcome);
    await writeFile(path, JSON.stringify({ ...report, status: 'passed' }));
    assert.equal(readVerificationTimeout(f.directory, identity), null);
  } finally {
    await f.dispose();
  }
});

for (const crashSupervisor of [false, true])
  it(
    `hands step timeout to its supervisor group and retains the structured result (restart=${crashSupervisor})`,
    { skip: crashSupervisor && process.platform !== 'linux' },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ticketing-pipeline-timeout-db-'));
      const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
      await adapters.storage.migrate();
      const authority = await contractFixture(adapters),
        f = await fixture(
          [
            `require('node:fs').writeFileSync('step.pid',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',"require('node:fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore',detached:false});process.stderr.write('timed step');setInterval(()=>{},1000)`,
            '',
          ],
          authority.project.id,
        );
      f.config.recipes[1]!.timeout_ms = 500;
      const recipes = f.registry(),
        artifacts = join(f.directory, 'artifacts');
      const app = createApplication({
        ...adapters,
        executionRecipes: recipes.metadata(),
        executionArtifacts: { directory: artifacts },
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
          checkpoint: { progress: 'Timeout configured step.' },
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
        const running = new ExecutionCompanion(options).runOnce();
        if (crashSupervisor) {
          const until = Date.now() + 10000;
          let attempt;
          while (Date.now() < until) {
            attempt = (
              await adapters.storage.find('execution_attempts', { where: { run_id: receipt.run_id } })
            )[0];
            if (attempt) {
              try {
                await readFile(join(f.repository, 'step.pid'));
                break;
              } catch {}
            }
            await delay(10);
          }
          assert.ok(attempt);
          const path = join(artifacts, receipt.run_id, attempt.id);
          const supervisor = JSON.parse(await readFile(join(path, 'supervisor.json'), 'utf8')).identity;
          assert.deepEqual(executionProcessIdentity(supervisor.pid), supervisor);
          process.kill(supervisor.pid, 'SIGSTOP');
          while (Date.now() < until) {
            try {
              await readFile(join(path, 'pipeline-timeout.json'));
              break;
            } catch {}
            await delay(10);
          }
          assert.ok(await readFile(join(path, 'pipeline-timeout.json')));
          process.kill(supervisor.pid, 'SIGKILL');
          await running;
          await new ExecutionCompanion(options).runOnce();
        } else await running;
        const run = (await adapters.storage.get('execution_jobs', receipt.run_id))!;
        const attempt = (
          await adapters.storage.find('execution_attempts', { where: { run_id: run.id } })
        )[0]!;
        const report = JSON.parse(
          await readFile(join(artifacts, run.id, attempt.id, 'pipeline-report.json'), 'utf8'),
        );
        assert.deepEqual(
          report.steps.map((step: any) => step.status),
          ['timed_out', 'skipped'],
        );
        if (process.platform === 'linux') {
          for (const name of ['step.pid', 'descendant.pid']) {
            const pid = Number(await readFile(join(f.repository, name), 'utf8'));
            assert.equal(
              executionProcessIdentity(pid),
              null,
              'The supervisor must stop the step and its descendants.',
            );
          }
          assert.equal(run.status, 'failed');
          assert.equal(run.error_code, 'TIMEOUT');
          assert.equal(capacity.inspect('test').occupied.script, 0);
          const result = (await app.execute(authority.worker.id, 'artifact_read', {
            project_id: f.project,
            artifact_id: run.artifacts.find((item) => item.endsWith(':result'))!,
            length: 65536,
            max_tokens: 16000,
          })) as any;
          const outcome = JSON.parse(Buffer.from(result.range.data, 'base64').toString('utf8'));
          assert.equal(outcome.verification.status, 'failed');
          assert.equal(outcome.verification.cleanup_verified, true);
          assert.equal(outcome.verification.steps[0].diagnostics.stderr.text, 'timed step');
        } else {
          assert.equal(run.status, 'running');
          assert.equal(capacity.inspect('test').occupied.script, 1);
        }
      } finally {
        capacity.close();
        await adapters.storage.close();
        await adapters.search.close();
        await f.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
    for (const recovery of [
      { signature: 'RESOURCE_BUSY', exit_code: 0, effects: 'none' },
      { signature: 'RESOURCE_BUSY', exit_code: 75, effects: 'external' },
      { signature: 'RESOURCE_BUSY', exit_code: 75, effects: 'none', command: 'caller-input' },
      { signature: 'RESOURCE_BUSY', exit_code: 75, effects: 'none', max_attempts: 3 },
    ])
      assert.throws(
        () =>
          new ExecutionRecipeRegistry({
            ...original,
            pipelines: [
              {
                ...original.pipelines[0],
                steps: original.pipelines[0]!.steps.map((step, index) =>
                  index === 0 ? { ...step, recovery } : step,
                ),
              },
            ],
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

it('settles one admitted run with a registered recovery and publishes both attempts without submitting the ticket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-pipeline-db-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  await adapters.storage.migrate();
  const authority = await contractFixture(adapters);
  const failure = JSON.stringify({
    kind: 'transient_failure',
    signature: 'RESOURCE_BUSY',
    effects: 'none',
    approval_required: false,
  });
  const f = await fixture(
    [
      `const fs=require('node:fs');if(!fs.existsSync('once')){fs.writeFileSync('once','ready');process.stderr.write(${JSON.stringify(failure)});process.exitCode=75}`,
      '',
    ],
    authority.project.id,
  );
  f.config.pipelines[0]!.steps[0]!.recovery = { signature: 'RESOURCE_BUSY', exit_code: 75, effects: 'none' };
  const recipes = f.registry(),
    artifacts = join(f.directory, 'artifacts');
  const app = createApplication({
    ...adapters,
    executionRecipes: recipes.metadata(),
    executionArtifacts: { directory: artifacts },
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
    assert.equal(capacity.inspect('test').entries.length, 1);
    assert.equal(
      (await adapters.storage.find('execution_attempts', { where: { run_id: run.id } })).length,
      1,
    );
    const result = (await app.execute(authority.worker.id, 'artifact_read', {
      project_id: f.project,
      artifact_id: run.artifacts.find((item) => item.endsWith(':result'))!,
      length: 65536,
      max_tokens: 16000,
    })) as any;
    const outcome = JSON.parse(Buffer.from(result.range.data, 'base64').toString('utf8'));
    assert.equal(outcome.verification.status, 'passed');
    assert.equal(outcome.verification.steps[0].recovery.state, 'recovered');
    assert.deepEqual(
      outcome.verification.steps[0].attempts.map((attempt: any) => attempt.exit_code),
      [75, 0],
    );
    assert.equal(outcome.total_bytes.stderr, Buffer.byteLength(failure));
    assert.equal(outcome.verification.steps[0].diagnostics.stderr.total_bytes, 0);
    const runtime = capacity.inspect('test').entries[0]!.observation!.script_result!.runtime_ms!;
    assert.ok(
      runtime >=
        Math.floor(
          outcome.verification.steps[0].attempts.reduce(
            (sum: number, attempt: any) => sum + attempt.runtime_ms,
            0,
          ),
        ),
    );
    assert.deepEqual(
      outcome.verification.steps.map((step: any) => step.status),
      ['passed', 'passed'],
    );
    assert.equal(await new ExecutionCompanion(options).runOnce(), false);
    const current = await authority.read(ticket.id);
    await app.execute(authority.worker.id, 'ticket_submit', {
      project_id: f.project,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      expected_revision: current.ticket.revision,
      idempotency_key: randomUUID(),
      summary: 'Inspect the native pipeline result independently.',
      evidence: current.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Both configured steps completed.',
        references: [result.artifact_id],
      })),
    });
    const review = (await app.execute(
      authority.reviewer.id,
      'ticket_context',
      { project_id: f.project, ticket_id: ticket.id },
      'reviewer',
    )) as any;
    const reference = review.omitted.find((item: any) => item.section === 'submission_artifact');
    assert.equal(reference.arguments.artifact_id, result.artifact_id);
    const independent = (await app.execute(
      authority.reviewer.id,
      reference.retrieve_with,
      reference.arguments,
      'reviewer',
    )) as any;
    assert.equal(independent.sha256, result.sha256);
    assert.deepEqual(observeArtifactEvidence(reference, reference.arguments, independent), {
      pending: null,
      unverified: false,
    });
    assert.deepEqual(
      JSON.parse(Buffer.from(independent.range.data, 'base64').toString()).verification,
      outcome.verification,
    );
  } finally {
    capacity.close();
    await adapters.storage.close();
    await adapters.search.close();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
