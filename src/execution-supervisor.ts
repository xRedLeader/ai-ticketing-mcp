import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionControllerFence, StorageAdapter } from './contracts.js';
import { createRuntime } from './runtime.js';
import { MAX_EXECUTION_RECIPE_BYTES, type ExecutionRecipe } from './execution-recipes.js';
import { durableExecutionFile, executionProcessIdentity, readExecutionFile } from './execution-journal.js';
import type { HostCapacityNeverStartedProof } from './host-capacity.js';

export interface ExecutionManifest {
  run_id: string;
  attempt_id: string;
  process_token: string;
  recipe_fingerprint: string;
}
export interface ExecutionLaunch {
  recipe: ExecutionRecipe;
  storage: NonNullable<StorageAdapter['executionLaunchStorage']>;
  actor_id: string;
  project_id: string;
  reservation_token: string;
  controller: ExecutionControllerFence;
  capacity: HostCapacityNeverStartedProof;
}
/** Detached from the controller, so an observed completion can survive its restart. */
async function supervise(directory: string) {
  const manifest = readExecutionFile(join(directory, 'manifest.json')) as ExecutionManifest;
  const input: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_EXECUTION_RECIPE_BYTES + 65536) throw new Error('Launch exceeds supervisor input limit.');
    input.push(chunk);
  }
  const launch = JSON.parse(Buffer.concat(input).toString('utf8')) as ExecutionLaunch;
  const { recipe } = launch;
  if (recipe.fingerprint !== manifest.recipe_fingerprint) throw new Error('Recipe fingerprint changed.');
  const identity = {
    run_id: manifest.run_id,
    attempt_id: manifest.attempt_id,
    process_token: manifest.process_token,
    recipe_fingerprint: recipe.fingerprint,
  };
  let started = Date.now();
  durableExecutionFile(join(directory, 'supervisor.json'), {
    ...identity,
    identity: executionProcessIdentity(process.pid),
    started_at: started,
  });
  const stdout = openSync(join(directory, 'stdout.log'), 'wx', 0o600);
  const stderr = openSync(join(directory, 'stderr.log'), 'wx', 0o600);
  const bytes = { stdout: 0, stderr: 0 },
    total_bytes = { stdout: 0, stderr: 0 },
    hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') },
    truncated = { stdout: false, stderr: false };
  let child: ChildProcess | undefined,
    spawned = false,
    stopped = false,
    terminal = false,
    error: string | null = null;
  let deadline: NodeJS.Timeout | undefined;
  const stop = (reason: string) => {
    if (terminal || stopped) return;
    stopped = true;
    error ??= reason;
    child?.kill('SIGKILL');
    // shortcut: native direct-child termination cannot prove process-tree cleanup; retain capacity for inspection.
    deadline = setTimeout(() => process.exit(1), 15_000);
  };
  let timeout: NodeJS.Timeout | undefined;
  const cancellation = setInterval(() => {
    if (existsSync(join(directory, 'cancel.json'))) stop('CANCELLED');
  }, 100);
  try {
    let completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    const app = createRuntime({
      EMBEDDING_PROVIDER: 'none',
      STORAGE_ADAPTER: launch.storage.adapter,
      ...(launch.storage.adapter === 'sqlite'
        ? { SQLITE_PATH: launch.storage.filename }
        : { DATABASE_URL: launch.storage.connection_string }),
    });
    try {
      const dispatched = await app.dispatchExecutionRun(
        launch.actor_id,
        launch.project_id,
        manifest.run_id,
        launch.reservation_token,
        manifest.attempt_id,
        manifest.process_token,
        manifest.recipe_fingerprint,
        launch.controller,
        () => {
          if (stopped || existsSync(join(directory, 'cancel.json')))
            throw new Error('Execution was cancelled before its launch fence was acquired.');
          started = Date.now();
          timeout = setTimeout(() => stop('TIMEOUT'), recipe.timeout_ms);
          // Consuming this capability before spawn makes a duplicate or uncertain launch non-replayable.
          durableExecutionFile(join(directory, 'launch.json'), identity);
          durableExecutionFile(join(directory, 'dispatch.json'), { ...identity, started_at: started });
          try {
            child = spawn(recipe.executable, [...recipe.argv], {
              cwd: recipe.cwd,
              env: { ...recipe.env },
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
              child!.once('spawn', () => {
                spawned = true;
                try {
                  durableExecutionFile(join(directory, 'process.json'), {
                    ...identity,
                    identity: executionProcessIdentity(child!.pid!),
                    started_at: started,
                  });
                } catch {
                  stop('JOURNAL_WRITE_FAILED');
                }
              });
              child!.on('error', () => {
                error ??= spawned ? 'PROCESS_ERROR' : 'SPAWN_FAILED';
              });
              child!.once('close', (code, signal) => {
                terminal = true;
                resolve({ code, signal });
              });
            });
            const capture = (stream: 'stdout' | 'stderr', fd: number) => (chunk: Buffer) => {
              total_bytes[stream] = Math.min(Number.MAX_SAFE_INTEGER, total_bytes[stream] + chunk.length);
              const length = Math.min(chunk.length, Math.max(0, recipe.max_log_bytes - bytes[stream]));
              try {
                if (length) {
                  writeFileSync(fd, chunk.subarray(0, length));
                  hashes[stream].update(chunk.subarray(0, length));
                  bytes[stream] += length;
                }
              } catch {
                stop('LOG_WRITE_FAILED');
              }
              if (length < chunk.length) truncated[stream] = true;
            };
            child.stdout!.on('data', capture('stdout', stdout));
            child.stderr!.on('data', capture('stderr', stderr));
            child.stdout!.on('error', () => stop('LOG_READ_FAILED'));
            child.stderr!.on('error', () => stop('LOG_READ_FAILED'));
          } catch (cause) {
            if (child) throw cause;
            error = 'SPAWN_FAILED';
            terminal = true;
            completion = Promise.resolve({ code: null, signal: null });
          }
        },
      );
      if (!dispatched) {
        // A thrown database/native error is ambiguous; only a positive rejection proves no launch.
        if (!existsSync(join(directory, 'dispatch.json')))
          durableExecutionFile(join(directory, 'launch.json'), {
            ...identity,
            no_launch: true,
            exit_code: null,
            signal: null,
            artifacts: [],
            error_code: 'DISPATCH_REJECTED',
            started_at: 0,
            finished_at: Date.now(),
            cleanup_verified: true,
            spawned: false,
            capacity: launch.capacity,
          });
        return;
      }
    } catch (cause) {
      if (!completion) throw cause;
    } finally {
      await Promise.allSettled([app.storage.close(), app.searchAdapter.close()]);
    }
    const observed = await completion!;
    try {
      fsyncSync(stdout);
      fsyncSync(stderr);
    } catch {
      error ??= 'LOG_SYNC_FAILED';
    }
    const finished = Date.now();
    const sha256 = {
      stdout: hashes.stdout.digest('hex'),
      stderr: hashes.stderr.digest('hex'),
      result: null as string | null,
    };
    const outcome = {
      run_id: manifest.run_id,
      attempt_id: manifest.attempt_id,
      started_at: started,
      finished_at: finished,
      exit_code: spawned ? observed.code : null,
      signal: observed.signal,
      error_code: error,
      bytes,
      total_bytes,
      truncated,
      sha256: { stdout: sha256.stdout, stderr: sha256.stderr },
    };
    const artifact_errors: string[] = [];
    try {
      durableExecutionFile(join(directory, 'outcome.json'), outcome);
      sha256.result = createHash('sha256')
        .update(JSON.stringify(outcome) + '\n')
        .digest('hex');
    } catch {
      artifact_errors.push('OUTCOME_WRITE_FAILED');
    }
    // Natural foreground completion relies on the operator recipe contract, not OS tree containment.
    durableExecutionFile(join(directory, 'result.json'), {
      ...identity,
      pid: child?.pid ?? null,
      spawned,
      started_at: started,
      finished_at: finished,
      exit_code: spawned ? observed.code : null,
      signal: observed.signal,
      error_code: error,
      artifacts: ['stdout', 'stderr', 'result'].map(
        (name) => `execution:${manifest.run_id}:${manifest.attempt_id}:${name}`,
      ),
      bytes,
      total_bytes,
      sha256,
      artifact_errors,
      truncated,
      cleanup_verified: !stopped && observed.signal === null,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    clearInterval(cancellation);
    if (deadline) clearTimeout(deadline);
    closeSync(stdout);
    closeSync(stderr);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  supervise(process.argv[2]!).catch(() => {
    process.exitCode = 1;
  });
}
