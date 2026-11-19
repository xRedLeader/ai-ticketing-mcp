import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../application.js';
import { ExecutionRecipeRegistry } from '../execution-recipes.js';
import { ExecutionCompanion } from '../execution-companion.js';
import { HostCapacity } from '../host-capacity.js';
import { runVerificationPipeline } from '../verification-runner.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerExecutionCacheContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  async function setup(cacheable = true) {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters),
      foreign = await fixture(adapters);
    const directory = realpathSync(await mkdtemp(join(tmpdir(), 'ticketing-execution-cache-')));
    const repository = join(directory, 'source'),
      artifacts = join(directory, 'artifacts');
    await mkdir(repository);
    const git = realpathSync(
      execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]!,
    );
    const command = (...args: string[]) =>
      execFileSync(git, args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    command('init');
    command('config', 'core.autocrlf', 'false');
    await writeFile(join(repository, 'source.txt'), 'source-v1\n');
    command('add', 'source.txt');
    const commit = (...args: string[]) =>
      command(
        '-c',
        'user.name=Cache Fixture',
        '-c',
        'user.email=cache@example.invalid',
        'commit',
        '-m',
        'test: cache fixture',
        ...args,
      );
    commit();
    const toolchain = join(directory, 'toolchain.txt');
    await writeFile(toolchain, 'toolchain-v1');
    const projects = [f.project.id, foreign.project.id];
    const config = {
      workspace_roots: [directory],
      recipes: [
        {
          id: 'source-git',
          project_ids: projects,
          executable: git,
          argv: [] as string[],
          cwd: repository,
          env: {},
        },
        {
          id: 'check',
          project_ids: projects,
          executable: process.execPath,
          argv: ['-e', ''],
          cwd: repository,
          env: { CACHE_FIXTURE: 'original' },
          timeout_ms: 10_000,
        },
      ],
      pipelines: [
        {
          id: 'verify',
          project_ids: projects,
          ...(cacheable ? { cacheable: true as const } : {}),
          source: { recipe_id: 'source-git', commit: command('rev-parse', 'HEAD') },
          timeout_ms: 30_000,
          steps: [
            {
              id: 'check',
              recipe_id: 'check',
              needs: [] as string[],
              on_failure: 'stop',
              toolchain_files: [toolchain],
            },
          ],
        },
      ],
    };
    const registry = () => new ExecutionRecipeRegistry(config);
    const recipes = registry();
    const pipeline = (registered = recipes) => {
      const metadata = registered.metadata().find((recipe) => recipe.id === 'verify')!;
      const pinned = registered.get(metadata.id, metadata.fingerprint, f.project.id);
      assert.ok('kind' in pinned);
      return pinned;
    };
    const appFor = (registered = recipes) =>
      createApplication({
        ...adapters,
        executionRecipes: registered.metadata(),
        executionArtifacts: { directory: artifacts },
      });
    const app = appFor(),
      ticket = await f.ticket(),
      claim = await f.claim(ticket.id);
    const submit = async (
      application = app,
      target = ticket,
      token = claim.claim.token,
      project = f.project.id,
      worker = f.worker.id,
    ) =>
      application.execute(worker, 'run_submit', {
        project_id: project,
        ticket_id: target.id,
        claim_token: token,
        recipe_id: 'verify',
        checkpoint: { progress: 'Verify exact fixed operator inputs.' },
        completion_condition: { kind: 'exit_code', exit_code: 0 },
        idempotency_key: randomUUID(),
      }) as Promise<any>;
    const source = await submit();
    const seedController = (await app.acquireExecutionController(
      f.admin.id,
      f.project.id,
      randomUUID(),
      60_000,
    ))!;
    assert.ok(seedController);
    const reserved = (await app.reserveExecutionRun(
      f.admin.id,
      f.project.id,
      source.run_id,
      60_000,
      seedController,
    ))!;
    assert.ok(
      await app.startExecutionRun(
        f.admin.id,
        f.project.id,
        reserved.id,
        reserved.reservation_token!,
        60_000,
        seedController,
      ),
    );
    const attempt = (await app.listExecutionReconciliations(f.admin.id, f.project.id, [reserved.id]))[0]!
      .attempt!;
    const report = await runVerificationPipeline(pipeline());
    assert.equal(report.status, 'passed');
    const sourceDirectory = join(artifacts, reserved.id, attempt.id);
    await mkdir(sourceDirectory, { recursive: true });
    const outcome = {
      run_id: reserved.id,
      attempt_id: attempt.id,
      exit_code: 0,
      signal: null,
      error_code: null,
      verification: report,
    };
    const data = JSON.stringify(outcome) + '\n';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const references = ['stdout', 'stderr', 'result'].map(
      (name) => `execution:${reserved.id}:${attempt.id}:${name}`,
    );
    for (const name of ['stdout', 'stderr']) await writeFile(join(sourceDirectory, `${name}.log`), '');
    await writeFile(join(sourceDirectory, 'outcome.json'), data);
    await writeFile(
      join(sourceDirectory, 'result.json'),
      JSON.stringify({
        ...outcome,
        process_token: attempt.process_token,
        recipe_fingerprint: reserved.recipe_fingerprint,
        started_at: Date.parse(reserved.started_at ?? new Date().toISOString()),
        finished_at: Date.now(),
        cleanup_verified: true,
        spawned: true,
        artifacts: references,
        bytes: { stdout: 0, stderr: 0 },
        sha256: { stdout: hash(''), stderr: hash(''), result: hash(data) },
      }),
    );
    assert.ok(
      await app.settleExecutionRun(
        f.admin.id,
        f.project.id,
        reserved.id,
        reserved.reservation_token!,
        {
          exit_code: 0,
          signal: null,
          error_code: null,
          artifacts: references,
        },
        seedController,
      ),
    );
    await app.releaseExecutionController(f.admin.id, f.project.id, seedController);
    const controllers: { project: string; fence: typeof seedController }[] = [];
    const capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
    capacity.configureHost('host');
    const begin = async (application = app, receipt?: any, project = f.project.id) => {
      const current = receipt ?? (await submit(application));
      const controller = (await application.acquireExecutionController(
        f.admin.id,
        project,
        randomUUID(),
        60_000,
      ))!;
      assert.ok(controller);
      controllers.push({ project, fence: controller });
      const run = (await application.reserveExecutionRun(
        f.admin.id,
        project,
        current.run_id,
        60_000,
        controller,
      ))!;
      assert.ok(run);
      return {
        run,
        controller,
        reuse: (pin = pipeline()) =>
          application.tryReuseExecutionRun(
            f.admin.id,
            project,
            run.id,
            run.reservation_token!,
            controller,
            pin,
          ),
      };
    };
    const view = (id: string, application = app) =>
      application.execute(f.worker.id, 'run_get', {
        project_id: f.project.id,
        run_id: id,
        max_tokens: 16000,
      }) as Promise<any>;
    return {
      ...f,
      foreign,
      app,
      appFor,
      directory,
      repository,
      sourceDirectory,
      toolchain,
      command,
      commit,
      config,
      recipes,
      registry,
      pipeline,
      ticket,
      source: reserved,
      attempt,
      references,
      submit,
      begin,
      view,
      capacity,
      async dispose() {
        for (const { project, fence } of controllers)
          await app.releaseExecutionController(f.admin.id, project, fence);
        capacity.close();
        await adapters.dispose?.();
        assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('ticketing-execution-cache-'));
        await rm(directory, { recursive: true });
      },
    };
  }
  const check = (
    title: string,
    work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
    cacheable = true,
  ) =>
    it(`${name} execution cache: ${title}`, async () => {
      const f = await setup(cacheable);
      try {
        await work(f);
      } finally {
        await f.dispose();
      }
    });

  check(
    'reuses exact retained verification after restart with source attribution and no process admission',
    async (f) => {
      const target = await f.submit();
      const application = f.appFor();
      const companion = new ExecutionCompanion({
        application,
        capacity: f.capacity,
        recipes: f.recipes,
        actor_id: f.admin.id,
        project_id: f.project.id,
        host_id: 'host',
        artifacts_directory: join(f.directory, 'artifacts'),
      });
      assert.equal(await companion.runOnce(), true);
      const result = await f.view(target.run_id, application);
      assert.equal(result.run.status, 'succeeded');
      assert.equal(result.run.started_at, null);
      assert.equal(result.continuation.status, 'satisfied');
      assert.equal(result.run.cache.source_run_id, f.source.id);
      assert.equal(result.run.cache.source_attempt_id, f.attempt.id);
      assert.deepEqual(result.run.artifacts, f.references);
      assert.ok(result.output.every((artifact: any) => artifact.status === 'available'));
      assert.equal(f.capacity.inspect('host').entries.length, 0);
      assert.equal(existsSync(join(f.directory, 'artifacts', target.run_id)), false);
      const current = (
        await application.listExecutionReconciliations(f.admin.id, f.project.id, [target.run_id])
      )[0]!;
      const timeline = await f.storage.find('execution_observations', { where: { run_id: target.run_id } });
      assert.deepEqual(
        timeline.map((item) => item.kind),
        ['reserved', 'completed'],
      );
      assert.ok(current.observation?.outcome?.cache);
      const context: any = await application.execute(f.worker.id, 'ticket_context', {
        project_id: f.project.id,
        ticket_id: f.ticket.id,
        detail: 'full',
        max_tokens: 32768,
      });
      assert.ok(
        context.execution_outcomes.some(
          (item: any) =>
            item.run.id === target.run_id &&
            item.run.cache &&
            JSON.stringify(item.run.artifacts) === JSON.stringify(f.references),
        ),
      );
      assert.equal((await f.storage.get('tickets', f.ticket.id))!.status, 'in_progress');
      assert.equal((await f.storage.find('submissions', { where: { ticket_id: f.ticket.id } })).length, 0);
      const events = await f.storage.find('events', {
        where: { project_id: f.project.id, type: 'verification.cache_hit' },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.data.source_run_id, f.source.id);
      assert.equal(await companion.runOnce(), false);
    },
  );

  check(
    'never reuses default jobs or caller-added cacheability',
    async (f) => {
      const current = await f.begin();
      assert.equal(await current.reuse({ ...f.pipeline(), cacheable: true }), false);
      assert.equal((await f.storage.get('execution_jobs', current.run.id))!.status, 'reserved');
      assert.throws(
        () =>
          new ExecutionRecipeRegistry({
            ...f.config,
            recipes: [{ ...f.config.recipes[1], cacheable: true }],
          }),
      );
    },
    false,
  );

  for (const change of [
    'source_bytes',
    'revision',
    'toolchain',
    'environment',
    'artifact_bytes',
    'missing',
    'expired',
    'report',
    'cleanup',
    'missing_hash',
  ] as const)
    check(`misses conservatively for changed ${change}`, async (f) => {
      let application = f.app,
        pinned = f.pipeline();
      if (change === 'source_bytes') {
        f.command('update-index', '--skip-worktree', 'source.txt');
        await writeFile(join(f.repository, 'source.txt'), 'source-v2\n');
      }
      if (change === 'revision') {
        f.commit('--allow-empty');
        f.config.pipelines[0]!.source.commit = f.command('rev-parse', 'HEAD');
        const registry = f.registry();
        application = f.appFor(registry);
        pinned = f.pipeline(registry);
      }
      if (change === 'toolchain') await writeFile(f.toolchain, 'toolchain-v2');
      if (change === 'environment') {
        f.config.recipes[1]!.env = { CACHE_FIXTURE: 'changed' };
        const registry = f.registry();
        application = f.appFor(registry);
        pinned = f.pipeline(registry);
      }
      if (change === 'artifact_bytes') await writeFile(join(f.sourceDirectory, 'stdout.log'), 'changed');
      if (change === 'missing') await rm(join(f.sourceDirectory, 'stderr.log'));
      if (change === 'expired' || change === 'cleanup' || change === 'report' || change === 'missing_hash') {
        const path = join(f.sourceDirectory, 'result.json');
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        if (change === 'expired') metadata.finished_at = Date.now() - 8 * 24 * 60 * 60_000;
        if (change === 'cleanup') metadata.cleanup_verified = false;
        if (change === 'missing_hash') delete metadata.sha256;
        if (change === 'report') {
          const outcomePath = join(f.sourceDirectory, 'outcome.json');
          const outcome = JSON.parse(await readFile(outcomePath, 'utf8'));
          outcome.verification.steps[0].status = 'failed';
          const bytes = JSON.stringify(outcome) + '\n';
          await writeFile(outcomePath, bytes);
          metadata.sha256.result = createHash('sha256').update(bytes).digest('hex');
        }
        await writeFile(path, JSON.stringify(metadata));
      }
      const current = await f.begin(application);
      assert.equal(await current.reuse(pinned), false);
      assert.equal((await f.storage.get('execution_jobs', current.run.id))!.status, 'reserved');
      assert.equal(f.capacity.inspect('host').entries.length, 0);
      assert.equal(
        (
          await f.storage.find('events', {
            where: { project_id: f.project.id, type: 'verification.cache_hit' },
          })
        ).length,
        0,
      );
    });

  check('requires current claim and controller ownership without changing ticket acceptance', async (f) => {
    const current = await f.begin();
    assert.equal(
      await f.app.tryReuseExecutionRun(
        f.admin.id,
        f.project.id,
        current.run.id,
        current.run.reservation_token!,
        { ...current.controller, token: randomUUID() },
        f.pipeline(),
      ),
      false,
    );
    await f.storage.transaction(f.project.id, async (tx) => {
      const claim = (await tx.get('claims', f.ticket.id))!;
      await tx.put('claims', { ...claim, expires_at: new Date(Date.now() - 1).toISOString() });
    });
    assert.equal(await current.reuse(), false);
    assert.equal((await f.storage.get('continuations', current.run.continuation_id))!.status, 'pending');
  });

  check('misses after ticket requirements change even with identical source and toolchain', async (f) => {
    const ticket = (await f.storage.get('tickets', f.ticket.id))!;
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: ticket.revision,
      description: 'New current requirement; old verification cannot satisfy it.',
    });
    const currentTicket = (await f.storage.get('tickets', ticket.id))!;
    const claim = await f.claim(ticket.id);
    const receipt = await f.submit(f.app, currentTicket, claim.claim.token);
    const current = await f.begin(f.app, receipt);
    assert.equal(await current.reuse(), false);
    assert.equal((await f.storage.get('continuations', current.run.continuation_id))!.status, 'pending');
  });

  check('never crosses projects even when the operator permits the same pipeline in both', async (f) => {
    const target = await f.foreign.ticket(),
      claim = await f.foreign.claim(target.id);
    const receipt = await f.submit(
      f.app,
      target,
      claim.claim.token,
      f.foreign.project.id,
      f.foreign.worker.id,
    );
    const current = await f.begin(f.app, receipt, f.foreign.project.id);
    assert.equal(await current.reuse(), false);
    await assert.rejects(
      f.app.execute(f.foreign.worker.id, 'artifact_read', {
        project_id: f.foreign.project.id,
        artifact_id: f.references[0],
      }),
      hasCode('NOT_FOUND'),
    );
  });

  check('serializes reuse and retirement and pins original evidence after the ticket closes', async (f) => {
    const current = await f.begin();
    const result = await Promise.allSettled([
      current.reuse(),
      f.app.retireExecutionArtifact(f.admin.id, f.project.id, f.references[0]!),
    ]);
    assert.equal(result[0]!.status, 'fulfilled');
    assert.equal(result[0]!.status === 'fulfilled' && result[0]!.value, true);
    assert.equal(result[1]!.status, 'rejected');
    assert.equal(result[1]!.status === 'rejected' && (result[1]!.reason as any).code, 'ARTIFACT_PINNED');
    const ticket = (await f.storage.get('tickets', f.ticket.id))!;
    await f.call(f.worker.id, 'ticket_transition', {
      ticket_id: ticket.id,
      expected_revision: ticket.revision,
      status: 'cancelled',
      reason: 'Close cache fixture while retaining attributed evidence.',
    });
    const pinned = await f.storage.transaction(f.project.id, (tx) =>
      tx.artifactPinned!({
        run_id: f.source.id,
        attempt_id: f.attempt.id,
        ticket_id: ticket.id,
        checkpoint_id: f.source.checkpoint_id,
      }),
    );
    assert.equal(pinned, true);
    const view = await f.view(current.run.id);
    assert.ok(view.output.every((artifact: any) => artifact.status === 'available'));
  });
}
