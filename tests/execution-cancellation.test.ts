import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { executionProcessIdentity, terminateExecutionProcessTree } from '../src/execution-journal.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture } from '../src/testing/contracts.js';
import { createApplication } from '../src/application.js';
import { ExecutionCompanion } from '../src/execution-companion.js';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';
import { HostCapacity } from '../src/host-capacity.js';

async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await test()) return;
    await delay(100);
  }
  assert.fail('Timed out waiting for subprocess evidence.');
}

it('rejects reused root identity and terminates only the owned subprocess lineage', async () => {
  const root = spawn(
    process.execPath,
    [
      '-e',
      `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`,
    ],
    {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(root, 'exit');
  let descendant: ReturnType<typeof executionProcessIdentity> = null;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    const [chunk] = await once(root.stdout!, 'data');
    descendant = executionProcessIdentity(Number(String(chunk).trim()));
    const identity = executionProcessIdentity(root.pid!)!;
    assert.ok(identity && descendant);
    assert.equal(
      await terminateExecutionProcessTree({ ...identity, start_marker: identity.start_marker + '0' }),
      false,
    );
    assert.deepEqual(executionProcessIdentity(root.pid!), identity);
    assert.deepEqual(executionProcessIdentity(descendant.pid), descendant);
    assert.equal(await terminateExecutionProcessTree(identity), process.platform === 'linux');
    await exited;
    await until(() => executionProcessIdentity(descendant!.pid)?.start_marker !== descendant!.start_marker);
    assert.ok(executionProcessIdentity(unrelated.pid!));
    assert.equal(await terminateExecutionProcessTree(identity), false);
  } finally {
    root.kill();
    unrelated.kill();
    if (descendant && executionProcessIdentity(descendant.pid)?.start_marker === descendant.start_marker)
      process.kill(descendant.pid, 'SIGKILL');
  }
});

it('persists cancellation through controller restart, retains partial effects and requires external evidence for uncertain cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-cancel-'));
  const adapters = createSqliteAdapters(join(directory, 'store.sqlite'));
  await adapters.storage.migrate();
  const f = await fixture(adapters);
  const marker = join(directory, 'effects.txt'),
    ready = join(directory, 'ready.json');
  const config = {
    workspace_roots: [directory],
    recipes: [
      {
        id: 'test',
        project_ids: [f.project.id],
        executable: process.execPath,
        cwd: directory,
        env: {},
        timeout_ms: 20_000,
        argv: [
          '-e',
          `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.appendFileSync(${JSON.stringify(marker)},'effect'); console.log('partial effect'); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000);`,
        ],
      },
    ],
  };
  const recipes = new ExecutionRecipeRegistry(config);
  const recipesFile = join(directory, 'recipes.json');
  await writeFile(recipesFile, JSON.stringify(config));
  const app = createApplication({ ...adapters, executionRecipes: recipes.metadata() });
  const ticket = await f.ticket(),
    claim = await f.claim(ticket.id);
  const submitted = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'test',
    checkpoint: { progress: 'Retain effects.' },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  const runId = submitted.run_id as string,
    capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
  capacity.configureHost('test');
  const options = {
    application: app,
    recipes,
    capacity,
    actor_id: f.admin.id,
    project_id: f.project.id,
    host_id: 'test',
    artifacts_directory: join(directory, 'artifacts'),
  };
  const control = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../src/execution-companion-cli.ts', import.meta.url)),
        '--sqlite',
        join(directory, 'store.sqlite'),
        '--actor',
        f.admin.id,
        '--project',
        f.project.id,
        '--capacity',
        join(directory, 'capacity.sqlite'),
        '--host',
        'test',
        '--artifacts',
        options.artifacts_directory,
        ...args,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, EXECUTION_RECIPES_FILE: recipesFile },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  let running: Promise<boolean> | undefined;
  let owned: NonNullable<ReturnType<typeof executionProcessIdentity>>[] = [];
  try {
    running = new ExecutionCompanion(options).runOnce();
    await until(() => existsSync(ready));
    const ids = JSON.parse(await readFile(ready, 'utf8'));
    owned = [executionProcessIdentity(ids.pid), executionProcessIdentity(ids.child)].filter(
      (value) => value !== null,
    );
    assert.equal(owned.length, 2);
    assert.equal(control('--pause').paused, true);
    assert.equal((await adapters.storage.get('execution_admissions', f.project.id))!.paused, true);
    const requested = control('--cancel', runId);
    assert.equal(requested.process_state, 'requested');
    assert.deepEqual(await app.cancelExecutionRun(f.admin.id, f.project.id, runId), requested);
    assert.equal(await running, true);
    const state = (await app.listExecutionReconciliations(f.admin.id, f.project.id, [runId]))[0]!;
    const attemptDirectory = join(options.artifacts_directory, runId, state.attempt!.id);
    const result = JSON.parse(await readFile(join(attemptDirectory, 'result.json'), 'utf8'));
    assert.equal(result.error_code, 'CANCELLED');
    assert.equal(result.cleanup_verified, process.platform === 'linux');
    await until(() =>
      owned.every(
        (identity) => executionProcessIdentity(identity.pid)?.start_marker !== identity.start_marker,
      ),
    );
    assert.match(await readFile(join(attemptDirectory, 'stdout.log'), 'utf8'), /partial effect/);
    assert.equal(await readFile(marker, 'utf8'), 'effect');
    await new ExecutionCompanion(options).runOnce();
    const recovered = (await app.listExecutionReconciliations(f.admin.id, f.project.id, [runId]))[0]!;
    assert.equal(recovered.cancellation!.effects_state, 'unresolved');
    assert.equal(recovered.next_step, 'inspect_side_effects');
    assert.equal(capacity.inspect('test').occupied.script, process.platform === 'linux' ? 0 : 1);
    const outcome = {
      exit_code: result.exit_code,
      signal: result.signal,
      artifacts: result.artifacts,
      error_code: result.error_code,
    };
    const evidence = {
      process_exit_confirmed: true,
      effects_reconciled: true,
      outcome,
      note: 'Operator checked native root/descendant exit and the retained partial effect in effects.txt. No rollback.',
    };
    const evidenceFile = join(directory, 'evidence.json');
    await writeFile(evidenceFile, JSON.stringify(evidence));
    assert.equal(control('--reconcile', runId, '--evidence', evidenceFile).effects_state, 'reconciled');
    assert.equal(capacity.inspect('test').occupied.script, 0);
    const completed = (await app.listExecutionReconciliations(f.admin.id, f.project.id, [runId]))[0]!;
    assert.equal(completed.state, 'completed');
    assert.deepEqual(completed.attempt, state.attempt);
    assert.deepEqual(completed.run.artifacts, result.artifacts);
    assert.equal(await new ExecutionCompanion(options).runOnce(), false);
    assert.equal(control('--drain').drained, true);
    assert.equal(control('--resume').paused, false);
    assert.equal(await readFile(marker, 'utf8'), 'effect');
  } finally {
    for (const identity of owned) await terminateExecutionProcessTree(identity);
    await running?.catch(() => {});
    capacity.close();
    await adapters.storage.close();
    await adapters.search.close();
    await rm(directory, { recursive: true, force: true });
  }
});
