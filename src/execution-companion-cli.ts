#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ensure, DomainError } from './contracts.js';
import { createRuntime } from './runtime.js';
import { HostCapacity } from './host-capacity.js';
import { loadExecutionRecipes } from './execution-recipes.js';
import { ExecutionCompanion } from './execution-companion.js';

async function main() {
  const { values } = parseArgs({
    options: {
      sqlite: { type: 'string' },
      actor: { type: 'string' },
      project: { type: 'string' },
      capacity: { type: 'string' },
      host: { type: 'string' },
      artifacts: { type: 'string' },
      once: { type: 'boolean' },
      pause: { type: 'boolean' },
      resume: { type: 'boolean' },
      drain: { type: 'boolean' },
      cancel: { type: 'string' },
      retire: { type: 'string' },
      reconcile: { type: 'string' },
      evidence: { type: 'string' },
    },
  });
  ensure(
    values.actor &&
      values.project &&
      [values.pause, values.resume, values.drain, values.cancel, values.reconcile, values.retire].filter(
        Boolean,
      ).length <= 1,
    'INVALID_CONFIG',
    'Require --actor --project and at most one of --pause --resume --drain --cancel RUN_UUID --reconcile RUN_UUID --retire ARTIFACT_ID.',
  );
  const app = createRuntime({
    ...process.env,
    EMBEDDING_PROVIDER: 'none',
    EXECUTION_ARTIFACTS_DIRECTORY: values.artifacts,
    ...(values.sqlite ? { STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: values.sqlite } : {}),
  });
  let capacity: HostCapacity | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (app.storage.executionLaunchStorage?.adapter === 'sqlite') await app.storage.migrate();
    if (values.retire) {
      ensure(
        values.artifacts && isAbsolute(values.artifacts),
        'INVALID_CONFIG',
        'Retirement requires --artifacts ABSOLUTE_OWNED_ROOT.',
      );
      process.stdout.write(
        JSON.stringify(await app.retireExecutionArtifact(values.actor, values.project, values.retire)) + '\n',
      );
      return;
    }
    if (values.pause || values.resume || values.cancel) {
      const result = values.cancel
        ? await app.cancelExecutionRun(values.actor, values.project, values.cancel)
        : await app.setExecutionAdmissions(values.actor, values.project, !!values.pause);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    ensure(
      values.capacity &&
        values.host &&
        values.artifacts &&
        isAbsolute(values.capacity) &&
        isAbsolute(values.artifacts) &&
        process.env.EXECUTION_RECIPES_FILE,
      'INVALID_CONFIG',
      'Execution, drain and external reconciliation require --capacity ABSOLUTE_PATH --host --artifacts ABSOLUTE_PATH and EXECUTION_RECIPES_FILE.',
    );
    const recipes = loadExecutionRecipes(process.env.EXECUTION_RECIPES_FILE);
    capacity = new HostCapacity(values.capacity);
    try {
      capacity.inspect(values.host);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error;
      capacity.configureHost(values.host);
    }
    const companion = new ExecutionCompanion({
      application: app,
      capacity,
      recipes,
      actor_id: values.actor,
      project_id: values.project,
      host_id: values.host,
      artifacts_directory: values.artifacts,
    });
    if (values.reconcile) {
      ensure(
        values.evidence && (await stat(values.evidence)).size <= 65_536,
        'INVALID_INPUT',
        'Provide a bounded --evidence JSON file.',
      );
      const evidence = JSON.parse(await readFile(values.evidence, 'utf8'));
      process.stdout.write(
        JSON.stringify(await companion.reconcileCancellation(values.reconcile, evidence)) + '\n',
      );
      return;
    }
    if (values.drain) {
      await app.setExecutionAdmissions(values.actor, values.project, true);
      while (!abort.signal.aborted) {
        await companion.runOnce(abort.signal);
        const active = await app.listExecutionReconciliations(values.actor, values.project);
        if (!active.length || active.some((state) => state.next_step === 'inspect_side_effects')) {
          process.stdout.write(JSON.stringify({ paused: true, drained: !active.length, active }) + '\n');
          if (active.length) process.exitCode = 2;
          return;
        }
        await delay(1000, undefined, { signal: abort.signal });
      }
      return;
    }
    process.stdout.write(
      JSON.stringify({
        event: 'execution_companion_started',
        pid: process.pid,
        project_id: values.project,
        host_id: values.host,
      }) + '\n',
    );
    if (values.once)
      process.stdout.write(
        JSON.stringify({
          event: 'execution_companion_processed',
          processed: await companion.runOnce(abort.signal),
        }) + '\n',
      );
    else await companion.run(abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    capacity?.close();
    await app.storage.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      event: 'execution_companion_error',
      code: error instanceof DomainError ? error.code : 'ERROR',
      ...(error instanceof DomainError && error.code === 'ARTIFACT_STAGING_CONFLICT'
        ? { message: error.message, details: error.details }
        : {}),
    }) + '\n',
  );
  process.exitCode = 1;
});
