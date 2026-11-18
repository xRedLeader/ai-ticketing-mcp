import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application } from './application.js';
import {
  ensure,
  type ExecutionControllerFence,
  type ExecutionOutcome,
  type ExecutionProcessIdentity,
  type ExecutionReconciliation,
} from './contracts.js';
import { HostCapacity } from './host-capacity.js';
import { ExecutionRecipeRegistry } from './execution-recipes.js';
import { durableExecutionFile, executionProcessIdentity, readExecutionFile } from './execution-journal.js';
import type { ExecutionManifest } from './execution-supervisor.js';

export type ExecutionApplication = Pick<
  Application,
  | 'listExecutionRuns'
  | 'reserveExecutionRun'
  | 'startExecutionRun'
  | 'heartbeatExecutionRun'
  | 'settleExecutionRun'
  | 'acquireExecutionController'
  | 'heartbeatExecutionController'
  | 'releaseExecutionController'
  | 'listExecutionReconciliations'
  | 'adoptExecutionRun'
  | 'observeExecutionRun'
  | 'recoverExecutionRun'
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
type ResultJournal = ExecutionOutcome & {
  run_id: string;
  attempt_id?: string;
  process_token?: string;
  recipe_fingerprint: string;
  started_at: number;
  finished_at: number;
  cleanup_verified: boolean;
  spawned?: boolean;
};

/** One renewable controller per store; recovered attempts are inspected, never relaunched. */
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
    this.heartbeatMs = Math.max(
      1,
      Math.min(10_000, Math.floor(options.capacity.inspect(options.host_id).config.lease_ms / 3)),
    );
  }
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const { application: app, actor_id: actor, project_id: project, capacity, host_id: host } = this.options;
    signal?.throwIfAborted();
    const controller = await app.acquireExecutionController(actor, project, this.owner, LEASE_MS);
    if (!controller) return false;
    let owned = true,
      busy = false;
    const heartbeat = setInterval(() => {
      if (busy) return;
      busy = true;
      void app
        .heartbeatExecutionController(actor, project, controller, LEASE_MS)
        .then(
          (ok) => {
            owned &&= ok;
          },
          () => {
            owned = false;
          },
        )
        .finally(() => {
          busy = false;
        });
    }, this.heartbeatMs);
    try {
      const recovery = await app.listExecutionReconciliations(actor, project);
      const occupied = capacity
        .inspect(host)
        .entries.filter((entry) => ['running', 'reconciling'].includes(entry.state));
      const terminal = occupied.length
        ? await app.listExecutionReconciliations(
            actor,
            project,
            occupied.slice(0, 100).map((entry) => entry.queue_id),
          )
        : [];
      for (const original of [
        ...new Map([...recovery, ...terminal].map((value) => [value.run.id, value])).values(),
      ]) {
        if (!owned) return false;
        await this.reconcile(original, controller);
      }
      for (const candidate of await app.listExecutionRuns(actor, project)) {
        if (!owned) return false;
        const job = await app.reserveExecutionRun(actor, project, candidate.id, LEASE_MS, controller);
        if (!job) continue;
        const token = job.reservation_token!;
        let recipe;
        try {
          recipe = this.options.recipes.get(job.recipe_id, job.recipe_fingerprint, project);
        } catch {
          await app.settleExecutionRun(
            actor,
            project,
            job.id,
            token,
            { exit_code: null, signal: null, artifacts: [], error_code: 'RECIPE_UNAVAILABLE' },
            controller,
          );
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
          await app.settleExecutionRun(
            actor,
            project,
            job.id,
            token,
            { exit_code: null, signal: null, artifacts: [], error_code: 'CAPACITY_REJECTED' },
            controller,
          );
          throw error;
        }
        const capacityDeadline = Date.now() + 30_000;
        let admission: ReturnType<HostCapacity['claimNext']>;
        while (true) {
          admission = capacity.claimNext(host, this.owner, { kind: 'script', queue_ids: [job.id] });
          if (admission.admitted) break;
          if (
            !owned ||
            signal?.aborted ||
            Date.now() >= capacityDeadline ||
            !(await app.heartbeatExecutionRun(actor, project, job.id, token, LEASE_MS, controller))
          ) {
            capacity.cancel(host, job.id);
            await app.settleExecutionRun(
              actor,
              project,
              job.id,
              token,
              { exit_code: null, signal: null, artifacts: [], error_code: 'NOT_STARTED' },
              controller,
            );
            return true;
          }
          await delay(1000);
        }
        const started = await app.startExecutionRun(actor, project, job.id, token, LEASE_MS, controller);
        if (!started) {
          const stored = await app.settleExecutionRun(
            actor,
            project,
            job.id,
            token,
            { exit_code: null, signal: null, artifacts: [], error_code: 'NOT_STARTED' },
            controller,
          );
          if (stored)
            this.releaseCapacity(job.id, {
              started_at: 0,
              finished_at: Date.now(),
              spawned: false,
              exit_code: null,
              error_code: 'NOT_STARTED',
            });
          return true;
        }
        const state = (await app.listExecutionReconciliations(actor, project, [job.id]))[0]!;
        ensure(state.attempt, 'INVALID_REFERENCE', 'Execution attempt is missing.');
        const directory = join(this.directory, job.id, state.attempt.id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const manifest: ExecutionManifest = {
          run_id: job.id,
          attempt_id: state.attempt.id,
          process_token: state.attempt.process_token,
          recipe_fingerprint: recipe.fingerprint,
        };
        durableExecutionFile(join(directory, 'manifest.json'), manifest);
        let supervisor = fileURLToPath(new URL('./execution-supervisor.js', import.meta.url));
        if (!existsSync(supervisor)) supervisor = supervisor.replace(/\.js$/, '.ts');
        const args = supervisor.endsWith('.ts')
          ? [
              '--import',
              pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
              supervisor,
              directory,
            ]
          : [supervisor, directory];
        const child = spawn(process.execPath, args, {
          detached: true,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.stdin!.on('error', () => {
          /* Broken launch input is ambiguous; reconciliation retains the attempt. */
        });
        child.stdin!.end(JSON.stringify(recipe));
        let supervisorExited = false;
        child.once('exit', () => {
          supervisorExited = true;
        });
        const spawned = await new Promise<boolean>((resolve) => {
          child.once('spawn', () => resolve(true));
          child.once('error', () => resolve(false));
        });
        child.unref();
        if (!spawned) {
          const stored = await app.settleExecutionRun(
            actor,
            project,
            job.id,
            token,
            { exit_code: null, signal: null, artifacts: [], error_code: 'SPAWN_FAILED' },
            controller,
          );
          if (stored)
            this.releaseCapacity(job.id, {
              started_at: 0,
              finished_at: Date.now(),
              spawned: false,
              exit_code: null,
              error_code: 'SPAWN_FAILED',
            });
          return true;
        }
        const deadline = Date.now() + recipe.timeout_ms + 20_000;
        let renewedAt = Date.now(),
          acknowledged = false;
        while (Date.now() <= deadline) {
          if (!owned) throw new Error('Execution controller ownership lost; reconciliation is required.');
          if (signal?.aborted && !existsSync(join(directory, 'cancel.json')))
            durableExecutionFile(join(directory, 'cancel.json'), { reason: 'CANCELLED' });
          const result = this.result(state, directory);
          if (result) {
            ensure(
              result.cleanup_verified,
              'CONFLICT',
              'Process tree termination was not verified; host capacity remains occupied.',
            );
            const stored = await app.recoverExecutionRun(
              actor,
              project,
              job.id,
              token,
              state.attempt.id,
              state.attempt.process_token,
              this.outcome(result),
              controller,
            );
            ensure(
              stored,
              'CONFLICT',
              'Execution result could not be fenced; host capacity remains occupied.',
            );
            this.releaseCapacity(job.id, result);
            return true;
          }
          if (supervisorExited) break;
          if (!acknowledged) {
            const identity = this.liveIdentity(state, directory);
            if (identity)
              acknowledged = await app.observeExecutionRun(
                actor,
                project,
                job.id,
                token,
                state.attempt.id,
                state.attempt.process_token,
                controller,
                identity,
                'running',
              );
          }
          if (Date.now() - renewedAt >= this.heartbeatMs) {
            const ok = await app.heartbeatExecutionRun(actor, project, job.id, token, LEASE_MS, controller);
            if (!ok && !existsSync(join(directory, 'cancel.json')))
              durableExecutionFile(join(directory, 'cancel.json'), { reason: 'OWNERSHIP_LOST' });
            capacity.heartbeat(admission.lease);
            renewedAt = Date.now();
          }
          await delay(100);
        }
        await app.observeExecutionRun(
          actor,
          project,
          job.id,
          token,
          state.attempt.id,
          state.attempt.process_token,
          controller,
          null,
          'unresolved',
        );
        throw new Error('Execution result is unresolved; inspect launch and side effects before retry.');
      }
      return false;
    } finally {
      clearInterval(heartbeat);
      await app.releaseExecutionController(actor, project, controller);
    }
  }
  private outcome(result: ExecutionOutcome): ExecutionOutcome {
    return {
      exit_code: result.exit_code,
      signal: result.signal,
      artifacts: result.artifacts,
      error_code: result.error_code,
    };
  }
  private journal(directory: string, name: string): any {
    try {
      return readExecutionFile(join(directory, name));
    } catch {
      return null;
    }
  }
  private matches(state: ExecutionReconciliation, journal: any) {
    return (
      journal?.run_id === state.run.id &&
      journal.recipe_fingerprint === state.run.recipe_fingerprint &&
      journal.attempt_id === state.attempt?.id &&
      journal.process_token === state.attempt?.process_token
    );
  }
  private result(state: ExecutionReconciliation, directory: string): ResultJournal | null {
    const result = this.journal(directory, 'result.json');
    if (!this.matches(state, result) || !this.validResult(result)) return null;
    return result;
  }
  private validResult(result: any): result is ResultJournal {
    return (
      !!result &&
      typeof result.cleanup_verified === 'boolean' &&
      Number.isSafeInteger(result.started_at) &&
      Number.isSafeInteger(result.finished_at) &&
      result.started_at <= result.finished_at &&
      result.finished_at <= Date.now() &&
      (result.exit_code === null ||
        (Number.isSafeInteger(result.exit_code) &&
          result.exit_code >= -2147483648 &&
          result.exit_code <= 4294967295)) &&
      (result.signal === null ||
        (typeof result.signal === 'string' && result.signal.length > 0 && result.signal.length <= 80)) &&
      (result.error_code === null ||
        (typeof result.error_code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.error_code))) &&
      Array.isArray(result.artifacts) &&
      result.artifacts.length <= 50 &&
      result.artifacts.every(
        (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2000,
      ) &&
      (result.exit_code !== null || result.signal !== null || result.error_code !== null)
    );
  }
  private liveIdentity(state: ExecutionReconciliation, directory: string): ExecutionProcessIdentity | null {
    for (const name of ['process.json', 'supervisor.json']) {
      const journal = this.journal(directory, name);
      if (!this.matches(state, journal) || !journal.identity) continue;
      const current = executionProcessIdentity(journal.identity.pid);
      if (current?.start_marker === journal.identity.start_marker) return current;
    }
    return null;
  }
  private async reconcile(original: ExecutionReconciliation, controller: ExecutionControllerFence) {
    const { application: app, actor_id: actor, project_id: project, capacity, host_id: host } = this.options;
    if (original.state === 'completed') {
      const directory = original.attempt
        ? join(this.directory, original.run.id, original.attempt.id)
        : join(this.directory, original.run.id);
      const result =
        (original.attempt ? this.result(original, directory) : null) ?? this.legacyResult(original);
      if (
        result?.cleanup_verified &&
        JSON.stringify(this.outcome(result)) === JSON.stringify(this.outcome(original.run))
      )
        this.releaseCapacity(original.run.id, result);
      return;
    }
    const state = await app.adoptExecutionRun(actor, project, original.run.id, controller, LEASE_MS);
    if (!state?.attempt) return;
    const directory = join(this.directory, state.run.id, state.attempt.id);
    const result = this.result(state, directory) ?? this.legacyResult(state);
    if (result?.cleanup_verified) {
      if (
        await app.recoverExecutionRun(
          actor,
          project,
          state.run.id,
          state.run.reservation_token!,
          state.attempt.id,
          state.attempt.process_token,
          this.outcome(result),
          controller,
        )
      )
        this.releaseCapacity(state.run.id, result);
      return;
    }
    if (state.next_step === 'dispatch') {
      const outcome = {
        exit_code: null,
        signal: null,
        artifacts: [],
        error_code: 'RECOVERED_NOT_DISPATCHED',
      };
      if (
        await app.recoverExecutionRun(
          actor,
          project,
          state.run.id,
          state.run.reservation_token!,
          state.attempt.id,
          state.attempt.process_token,
          outcome,
          controller,
        )
      ) {
        const entry = capacity.inspect(host).entries.find((entry) => entry.queue_id === state.run.id);
        if (entry?.state === 'queued') capacity.cancel(host, state.run.id);
        else
          this.releaseCapacity(state.run.id, {
            ...outcome,
            started_at: 0,
            finished_at: Date.now(),
            spawned: false,
          });
      }
      return;
    }
    const identity = result ? null : this.liveIdentity(state, directory);
    await app.observeExecutionRun(
      actor,
      project,
      state.run.id,
      state.run.reservation_token!,
      state.attempt.id,
      state.attempt.process_token,
      controller,
      identity,
      identity ? 'running' : 'unresolved',
    );
  }
  private legacyResult(state: ExecutionReconciliation): ResultJournal | null {
    const directory = join(this.directory, state.run.id);
    const execution = this.journal(directory, 'execution.json'),
      result = this.journal(directory, 'result.json');
    if (
      execution?.run_id !== state.run.id ||
      execution.recipe_fingerprint !== state.run.recipe_fingerprint ||
      result?.run_id !== state.run.id ||
      result.recipe_fingerprint !== state.run.recipe_fingerprint ||
      !this.validResult(result) ||
      result.cleanup_verified !== true ||
      (state.attempt && existsSync(join(directory, state.attempt.id, 'manifest.json')))
    )
      return null;
    return { ...result, spawned: result.error_code !== 'SPAWN_FAILED' };
  }
  private releaseCapacity(
    runId: string,
    result: Pick<ResultJournal, 'started_at' | 'finished_at' | 'exit_code' | 'error_code' | 'spawned'>,
  ) {
    const { capacity, host_id: host } = this.options;
    const entry = capacity.inspect(host).entries.find((entry) => entry.queue_id === runId);
    if (!entry?.lease || !['running', 'reconciling'].includes(entry.state)) return;
    const takeover = capacity.takeOver(host, runId, entry.lease.generation, this.owner);
    capacity.reconcile(takeover.lease, {
      source: 'execution-companion-recovery',
      execution_token: takeover.execution_token!,
      observed_at: result.finished_at,
      state: result.spawned === false ? 'never_started' : 'terminated',
      script_result: {
        outcome:
          result.spawned === false
            ? 'cancelled'
            : result.exit_code === 0 && !result.error_code
              ? 'succeeded'
              : 'failed',
        runtime_ms: result.spawned === false ? 0 : result.finished_at - result.started_at,
      },
    });
  }
  async run(signal?: AbortSignal) {
    while (!signal?.aborted) {
      if (!(await this.runOnce(signal))) await delay(1000, undefined, { signal });
    }
  }
}
