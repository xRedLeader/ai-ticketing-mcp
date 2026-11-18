import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application } from './application.js';
import { ensure, type ExecutionJob } from './contracts.js';
import { HostCapacity, type HostCapacityLease } from './host-capacity.js';
import { ExecutionRecipeRegistry, type ExecutionRecipe } from './execution-recipes.js';

export type ExecutionApplication = Pick<
  Application,
  | 'listExecutionRuns'
  | 'reserveExecutionRun'
  | 'startExecutionRun'
  | 'heartbeatExecutionRun'
  | 'settleExecutionRun'
>;
export interface ExecutionCompanionOptions {
  application: ExecutionApplication;
  capacity: HostCapacity;
  recipes: ExecutionRecipeRegistry;
  actor_id: string;
  project_id: string;
  host_id: string;
  artifacts_directory: string;
}
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const CAPACITY_WAIT_MS = 30_000;
type Terminal = {
  exit_code: number | null;
  signal: string | null;
  error_code: string | null;
  artifacts: string[];
};

function durableFile(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Separate operator process: no MCP transport, model provider, retry or abandoned-execution takeover. */
export class ExecutionCompanion {
  private readonly owner = randomUUID();
  private readonly directory: string;
  private readonly heartbeatMs: number;

  constructor(private readonly options: ExecutionCompanionOptions) {
    ensure(
      isAbsolute(options.artifacts_directory),
      'INVALID_CONFIG',
      'Execution artifact directory must be absolute.',
    );
    mkdirSync(options.artifacts_directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(options.artifacts_directory);
    // All companions for this physical host must use the same immutable capacity configuration/file.
    this.heartbeatMs = Math.max(
      1,
      Math.min(HEARTBEAT_MS, Math.floor(options.capacity.inspect(options.host_id).config.lease_ms / 3)),
    );
  }

  /** Runs at most one queued job; reservations are never reclaimed or relaunched after a crash. */
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const { application: app, actor_id: actor, project_id: project, capacity, host_id: host } = this.options;
    signal?.throwIfAborted();
    const candidates = await app.listExecutionRuns(actor, project);
    for (const candidate of candidates) {
      const job = await app.reserveExecutionRun(actor, project, candidate.id, LEASE_MS);
      if (!job) continue;
      const token = job.reservation_token!;
      let recipe: ExecutionRecipe;
      try {
        recipe = this.options.recipes.get(job.recipe_id, job.recipe_fingerprint, project);
      } catch {
        await app.settleExecutionRun(actor, project, job.id, token, {
          exit_code: null,
          signal: null,
          artifacts: [],
          error_code: 'RECIPE_UNAVAILABLE',
        });
        return true;
      }
      try {
        capacity.enqueue(host, {
          queue_id: job.id,
          run_id: job.id,
          project_id: project,
          kind: 'script',
          resources: { ...recipe.resources },
          timeout_ms: recipe.timeout_ms,
          created_at: Date.parse(job.created_at),
        });
      } catch (error) {
        await app.settleExecutionRun(actor, project, job.id, token, {
          exit_code: null,
          signal: null,
          artifacts: [],
          error_code: 'CAPACITY_REJECTED',
        });
        throw error;
      }
      let admission: ReturnType<HostCapacity['claimNext']>;
      const capacityDeadline = Date.now() + CAPACITY_WAIT_MS;
      while (true) {
        admission = capacity.claimNext(host, this.owner, { kind: 'script', queue_ids: [job.id] });
        if (admission.admitted) break;
        if (
          signal?.aborted ||
          Date.now() >= capacityDeadline ||
          !(await app.heartbeatExecutionRun(actor, project, job.id, token, LEASE_MS))
        ) {
          capacity.cancel(host, job.id);
          await app.settleExecutionRun(actor, project, job.id, token, {
            exit_code: null,
            signal: null,
            artifacts: [],
            error_code: Date.now() >= capacityDeadline ? 'CAPACITY_TIMEOUT' : 'NOT_STARTED',
          });
          return true;
        }
        await delay(1000);
      }
      const lease = admission.lease,
        executionToken = admission.request.execution_token!;
      let spawned = false,
        settled = false;
      const observedAt = () => Date.now();
      try {
        const started = await app.startExecutionRun(actor, project, job.id, token, LEASE_MS);
        if (!started) {
          const stored = await app.settleExecutionRun(actor, project, job.id, token, {
            exit_code: null,
            signal: null,
            artifacts: [],
            error_code: 'NOT_STARTED',
          });
          if (stored)
            capacity.reconcile(lease, {
              source: 'execution-companion',
              execution_token: executionToken,
              observed_at: observedAt(),
              state: 'never_started',
              script_result: { outcome: 'cancelled', runtime_ms: 0 },
            });
          return true;
        }
        const outcome = await this.execute(started, recipe, lease, signal, () => {
          spawned = true;
        });
        // Persist authentic outcome before releasing the separately stored host slot.
        const stored = await app.settleExecutionRun(actor, project, job.id, token, outcome.result);
        settled = stored;
        ensure(stored, 'CONFLICT', 'Execution result could not be fenced; host capacity remains occupied.');
        capacity.reconcile(lease, {
          source: 'execution-companion',
          execution_token: executionToken,
          observed_at: outcome.finished_at,
          state: outcome.spawned ? 'terminated' : 'never_started',
          script_result: {
            outcome: outcome.spawned
              ? outcome.result.exit_code === 0 && !outcome.result.error_code
                ? 'succeeded'
                : 'failed'
              : 'cancelled',
            runtime_ms: outcome.spawned ? outcome.runtime_ms : 0,
          },
        });
        return true;
      } catch (error) {
        // A crash or lost fence is not evidence that an admitted process stopped.
        if (!spawned && !settled) {
          const stored = await app.settleExecutionRun(actor, project, job.id, token, {
            exit_code: null,
            signal: null,
            artifacts: [],
            error_code: 'NOT_STARTED',
          });
          if (stored)
            capacity.reconcile(lease, {
              source: 'execution-companion',
              execution_token: executionToken,
              observed_at: observedAt(),
              state: 'never_started',
              script_result: { outcome: 'cancelled', runtime_ms: 0 },
            });
        }
        throw error;
      }
    }
    return false;
  }

  async run(signal?: AbortSignal) {
    while (!signal?.aborted) {
      if (!(await this.runOnce(signal))) await delay(1000, undefined, { signal });
    }
  }

  private async execute(
    job: ExecutionJob,
    recipe: ExecutionRecipe,
    lease: HostCapacityLease,
    signal: AbortSignal | undefined,
    onSpawn: () => void,
  ) {
    const { application: app, capacity, actor_id: actor, project_id: project } = this.options;
    const directory = join(this.directory, job.id);
    mkdirSync(directory, { mode: 0o700 });
    const stdout = openSync(join(directory, 'stdout.log'), 'wx', 0o600);
    let stderr: number;
    try {
      stderr = openSync(join(directory, 'stderr.log'), 'wx', 0o600);
    } catch (error) {
      closeSync(stdout);
      throw error;
    }
    const started = Date.now(),
      bytes = { stdout: 0, stderr: 0 },
      truncated = { stdout: false, stderr: false };
    let child: ChildProcess | undefined,
      spawned = false,
      terminalObserved = false,
      errorCode: string | null = null;
    let stopping: Promise<boolean> | undefined,
      cleanupVerified = true,
      heartbeatBusy = false;
    let timeout: NodeJS.Timeout | undefined,
      heartbeat: NodeJS.Timeout | undefined,
      cleanupDeadline: NodeJS.Timeout | undefined;
    let rejectUnverified: ((reason: Error) => void) | undefined;
    const stop = (reason: string) => {
      if (terminalObserved) return;
      errorCode ??= reason;
      if (!child || stopping) return;
      stopping = terminateTree(child);
      void stopping.then(
        (verified) => {
          cleanupVerified = verified;
        },
        () => {
          cleanupVerified = false;
        },
      );
      cleanupDeadline = setTimeout(() => {
        child?.unref();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        rejectUnverified?.(
          new Error('Process termination was not observed; host capacity remains occupied.'),
        );
      }, 15_000);
    };
    const abort = () => stop('CANCELLED');
    try {
      durableFile(join(directory, 'execution.json'), {
        run_id: job.id,
        recipe_id: recipe.id,
        recipe_fingerprint: recipe.fingerprint,
        capacity_lease: lease,
        started_at: started,
      });
      ensure(
        await app.heartbeatExecutionRun(actor, project, job.id, job.reservation_token!, LEASE_MS),
        'CONFLICT',
        'Execution ownership expired before spawn.',
      );
      capacity.heartbeat(lease);
      signal?.throwIfAborted();
      child = spawn(recipe.executable, [...recipe.argv], {
        cwd: recipe.cwd,
        env: { ...recipe.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          rejectUnverified = reject;
          child!.once('spawn', () => {
            spawned = true;
            onSpawn();
          });
          child!.on('error', () => {
            errorCode ??= spawned ? 'PROCESS_ERROR' : 'SPAWN_FAILED';
          });
          child!.once('close', (code, closeSignal) => {
            terminalObserved = true;
            resolve({ code, signal: closeSignal });
          });
        },
      );
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
      timeout = setTimeout(() => stop('TIMEOUT'), recipe.timeout_ms);
      heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void (async () => {
          try {
            if (!(await app.heartbeatExecutionRun(actor, project, job.id, job.reservation_token!, LEASE_MS)))
              return stop('OWNERSHIP_LOST');
            if (terminalObserved) return;
            capacity.heartbeat(lease);
          } catch {
            stop('OWNERSHIP_LOST');
          } finally {
            heartbeatBusy = false;
          }
        })();
      }, this.heartbeatMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const observed = await terminal;
      if (observed.signal !== null) cleanupVerified = false;
      if (stopping) {
        try {
          cleanupVerified = await stopping;
        } catch {
          cleanupVerified = false;
        }
      }
      fsyncSync(stdout);
      fsyncSync(stderr);
      const finished = Date.now();
      const result: Terminal = {
        exit_code: spawned ? observed.code : null,
        signal: observed.signal,
        error_code: errorCode,
        artifacts: ['stdout', 'stderr', 'result'].map((name) => `execution:${job.id}:${name}`),
      };
      durableFile(join(directory, 'result.json'), {
        run_id: job.id,
        recipe_fingerprint: recipe.fingerprint,
        pid: child.pid ?? null,
        started_at: started,
        finished_at: finished,
        ...result,
        bytes,
        truncated,
        cleanup_verified: cleanupVerified,
      });
      ensure(
        cleanupVerified,
        'CONFLICT',
        'Process tree termination was not verified; host capacity remains occupied.',
      );
      return { result, spawned, finished_at: finished, runtime_ms: finished - started };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      if (cleanupDeadline) clearTimeout(cleanupDeadline);
      signal?.removeEventListener('abort', abort);
      closeSync(stdout);
      closeSync(stderr);
    }
  }
}

async function terminateTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return true;
  // shortcut: a direct-child handle cannot prove tree termination; SELF-9 needs OS containment before release.
  child.kill('SIGKILL');
  return false;
}
