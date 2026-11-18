import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_EXECUTION_RECIPE_BYTES, type ExecutionRecipe } from './execution-recipes.js';
import { durableExecutionFile, executionProcessIdentity, readExecutionFile } from './execution-journal.js';

export interface ExecutionManifest {
  run_id: string;
  attempt_id: string;
  process_token: string;
  recipe_fingerprint: string;
}
/** Detached from the controller, so an observed completion can survive its restart. */
async function supervise(directory: string) {
  const manifest = readExecutionFile(join(directory, 'manifest.json')) as ExecutionManifest;
  const input: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_EXECUTION_RECIPE_BYTES) throw new Error('Recipe exceeds supervisor input limit.');
    input.push(chunk);
  }
  const recipe = JSON.parse(Buffer.concat(input).toString('utf8')) as ExecutionRecipe;
  if (recipe.fingerprint !== manifest.recipe_fingerprint) throw new Error('Recipe fingerprint changed.');
  const identity = {
    run_id: manifest.run_id,
    attempt_id: manifest.attempt_id,
    process_token: manifest.process_token,
    recipe_fingerprint: recipe.fingerprint,
  };
  const started = Date.now();
  durableExecutionFile(join(directory, 'supervisor.json'), {
    ...identity,
    identity: executionProcessIdentity(process.pid),
    started_at: started,
  });
  const stdout = openSync(join(directory, 'stdout.log'), 'wx', 0o600);
  const stderr = openSync(join(directory, 'stderr.log'), 'wx', 0o600);
  const bytes = { stdout: 0, stderr: 0 },
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
  const timeout = setTimeout(() => stop('TIMEOUT'), recipe.timeout_ms);
  const cancellation = setInterval(() => {
    if (existsSync(join(directory, 'cancel.json'))) stop('CANCELLED');
  }, 100);
  try {
    durableExecutionFile(join(directory, 'dispatch.json'), { ...identity, started_at: started });
    let completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
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
        const length = Math.min(chunk.length, Math.max(0, recipe.max_log_bytes - bytes[stream]));
        try {
          if (length) writeFileSync(fd, chunk.subarray(0, length));
        } catch {
          stop('LOG_WRITE_FAILED');
        }
        bytes[stream] += length;
        if (length < chunk.length) truncated[stream] = true;
      };
      child.stdout!.on('data', capture('stdout', stdout));
      child.stderr!.on('data', capture('stderr', stderr));
      child.stdout!.on('error', () => stop('LOG_READ_FAILED'));
      child.stderr!.on('error', () => stop('LOG_READ_FAILED'));
    } catch {
      error = 'SPAWN_FAILED';
      terminal = true;
      completion = Promise.resolve({ code: null, signal: null });
    }
    const observed = await completion;
    fsyncSync(stdout);
    fsyncSync(stderr);
    const finished = Date.now();
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
      truncated,
      cleanup_verified: !stopped && observed.signal === null,
    });
  } finally {
    clearTimeout(timeout);
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
