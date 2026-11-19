#!/usr/bin/env node
import { isAbsolute } from 'node:path';
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
    },
  });
  ensure(
    values.actor &&
      values.project &&
      values.capacity &&
      values.host &&
      values.artifacts &&
      isAbsolute(values.capacity) &&
      isAbsolute(values.artifacts) &&
      process.env.EXECUTION_RECIPES_FILE,
    'INVALID_CONFIG',
    'Require --actor --project --capacity ABSOLUTE_PATH --host --artifacts ABSOLUTE_PATH and EXECUTION_RECIPES_FILE.',
  );
  const recipes = loadExecutionRecipes(process.env.EXECUTION_RECIPES_FILE);
  const app = createRuntime({
    ...process.env,
    EMBEDDING_PROVIDER: 'none',
    ...(values.sqlite ? { STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: values.sqlite } : {}),
  });
  const capacity = new HostCapacity(values.capacity);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (app.storage.executionLaunchStorage?.adapter === 'sqlite') await app.storage.migrate();
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
    capacity.close();
    await app.storage.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      event: 'execution_companion_error',
      code: error instanceof DomainError ? error.code : 'ERROR',
    }) + '\n',
  );
  process.exitCode = 1;
});
