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
import { HostCapacity, type HostCapacityNeverStartedProof } from './host-capacity.js';
import { ExecutionRecipeRegistry } from './execution-recipes.js';
import { durableExecutionFile, executionProcessIdentity, readExecutionFile } from './execution-journal.js';
import type { ExecutionLaunch, ExecutionManifest } from './execution-supervisor.js';

export type ExecutionApplication = Pick<
  Application,
  | 'storage'
  | 'listExecutionRuns'
  | 'reserveExecutionRun'
  | 'admitExecutionRun'
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
type NeverStartedJournal = ResultJournal & {
  capacity: HostCapacityNeverStartedProof | null;
};

/** One renewable controller per store; recovered attempts are inspected, never relaunched. */
export class ExecutionCompanion {
  private readonly owner = randomUUID();
  private readonly directory: string;
  private readonly heartbeatMs: number;
  private recoveryCursor?: string;
  private capacityCursor?: string;
  constructor(private readonly options: ExecutionCompanionOptions) {
    ensure(
      options.application.storage.executionLaunchStorage,
      'UNSUPPORTED_EXECUTION_RUNS',
      'Storage must provide a detached launch connection to the same store.',
    );
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
      let recovery = await app.listExecutionReconciliations(actor, project, undefined, this.recoveryCursor);
      if (!recovery.length && this.recoveryCursor)
        recovery = await app.listExecutionReconciliations(actor, project);
      this.recoveryCursor = recovery.at(-1)?.run.id;
      const occupied = capacity
        .inspect(host)
        .entries.filter(
          (entry) =>
            entry.kind === 'script' &&
            entry.project_id === project &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.queue_id) &&
            ['queued', 'running', 'reconciling'].includes(entry.state),
        )
        .sort((a, b) => a.queue_id.localeCompare(b.queue_id));
      let page = occupied
        .filter((entry) => !this.capacityCursor || entry.queue_id > this.capacityCursor)
        .slice(0, 100);
      if (!page.length) page = occupied.slice(0, 100);
      this.capacityCursor = page.at(-1)?.queue_id;
      const terminal = page.length
        ? await app.listExecutionReconciliations(
            actor,
            project,
            page.map((entry) => entry.queue_id),
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
          await this.settleNeverStarted(job.id, controller, 'RECIPE_UNAVAILABLE');
          return true;
        }
        const capacityDeadline = Date.now() + 30_000;
        let admission!: ReturnType<HostCapacity['claimNext']>;
        let noStartCapacity: HostCapacityNeverStartedProof | null = null;
        while (true) {
          const current = await app.admitExecutionRun(actor, project, job.id, token, controller, () => {
            capacity.enqueue(host, {
              queue_id: job.id,
              run_id: job.id,
              project_id: project,
              kind: 'script',
              resources: { ...recipe.resources },
              timeout_ms: recipe.timeout_ms,
              created_at: Date.parse(job.created_at),
            });
            admission = capacity.claimNext(host, this.owner, { kind: 'script', queue_ids: [job.id] });
            noStartCapacity = {
              host_id: host,
              queue_id: job.id,
              run_id: job.id,
              project_id: project,
              state: admission.admitted ? 'running' : 'queued',
              execution_token: admission.admitted ? admission.request.execution_token : null,
            };
          });
          if (!current) {
            await this.settleNeverStarted(job.id, controller, 'NOT_STARTED', noStartCapacity);
            return true;
          }
          if (admission.admitted) break;
          if (
            !owned ||
            signal?.aborted ||
            Date.now() >= capacityDeadline ||
            !(await app.heartbeatExecutionRun(actor, project, job.id, token, LEASE_MS, controller))
          ) {
            await this.settleNeverStarted(job.id, controller, 'NOT_STARTED', noStartCapacity);
            return true;
          }
          await delay(1000);
        }
        const started = await app.startExecutionRun(actor, project, job.id, token, LEASE_MS, controller);
        if (!started) {
          await this.settleNeverStarted(job.id, controller, 'NOT_STARTED', noStartCapacity);
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
        const launch: ExecutionLaunch = {
          recipe,
          storage: app.storage.executionLaunchStorage!,
          actor_id: actor,
          project_id: project,
          reservation_token: token,
          controller,
          capacity: noStartCapacity!,
        };
        child.stdin!.end(JSON.stringify(launch));
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
          await this.settleNeverStarted(job.id, controller, 'SPAWN_FAILED', noStartCapacity);
          return true;
        }
        const deadline = Date.now() + recipe.timeout_ms + 20_000;
        let renewedAt = Date.now(),
          acknowledged = false;
        while (Date.now() <= deadline) {
          if (!owned) throw new Error('Execution controller ownership lost; reconciliation is required.');
          if (signal?.aborted && !existsSync(join(directory, 'cancel.json')))
            durableExecutionFile(join(directory, 'cancel.json'), { reason: 'CANCELLED' });
          const proof = this.neverStarted(state, directory);
          const result = this.result(state, directory) ?? proof;
          if (result) {
            if (!result.cleanup_verified) break;
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
            if (result === proof) {
              if (proof.capacity) capacity.reconcileNeverStarted(proof.capacity, proof.finished_at);
            } else this.releaseCapacity(job.id, result);
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
        return true;
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
  private async settleNeverStarted(
    runId: string,
    controller: ExecutionControllerFence,
    errorCode: string,
    capacity: HostCapacityNeverStartedProof | null = null,
  ) {
    const { application: app, actor_id: actor, project_id: project } = this.options;
    const state = (await app.listExecutionReconciliations(actor, project, [runId]))[0];
    if (!state?.attempt) return;
    if (
      !(state.run.status === 'reserved' && state.next_step === 'dispatch') &&
      !(errorCode === 'SPAWN_FAILED' && state.run.status === 'running')
    )
      return;
    const directory = join(this.directory, runId, state.attempt.id);
    if (existsSync(join(directory, 'dispatch.json'))) return;
    const proof = this.recordNeverStarted(state, directory, errorCode, capacity);
    if (!proof) return;
    if (
      await app.recoverExecutionRun(
        actor,
        project,
        runId,
        state.run.reservation_token!,
        state.attempt.id,
        state.attempt.process_token,
        this.outcome(proof),
        controller,
      )
    ) {
      if (proof.capacity) this.options.capacity.reconcileNeverStarted(proof.capacity, proof.finished_at);
    }
  }
  private recordNeverStarted(
    state: ExecutionReconciliation,
    directory: string,
    errorCode: string,
    expectedCapacity?: HostCapacityNeverStartedProof | null,
  ): NeverStartedJournal | null {
    const existing = this.neverStarted(state, directory);
    if (existing) return existing;
    const { capacity, host_id: host } = this.options;
    const entry = capacity.inspect(host).entries.find((entry) => entry.queue_id === state.run.id);
    if (
      entry &&
      (entry.kind !== 'script' || entry.run_id !== state.run.id || entry.project_id !== state.run.project_id)
    )
      return null;
    const active = entry && ['queued', 'running', 'reconciling'].includes(entry.state) ? entry : null;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Legacy torn journals stay untouched; only the database's undispatched fence permits repair.
    const filename = existsSync(join(directory, 'never-started.json'))
      ? 'never-started-recovered.json'
      : 'never-started.json';
    if (existsSync(join(directory, filename))) return null;
    durableExecutionFile(join(directory, filename), {
      run_id: state.run.id,
      attempt_id: state.attempt!.id,
      process_token: state.attempt!.process_token,
      recipe_fingerprint: state.run.recipe_fingerprint,
      exit_code: null,
      signal: null,
      artifacts: [],
      error_code: errorCode,
      started_at: 0,
      finished_at: Date.now(),
      cleanup_verified: true,
      spawned: false,
      capacity:
        expectedCapacity !== undefined
          ? expectedCapacity
          : active
            ? {
                host_id: host,
                queue_id: active.queue_id,
                run_id: active.run_id,
                project_id: active.project_id,
                state: active.state as HostCapacityNeverStartedProof['state'],
                execution_token: active.execution_token,
              }
            : null,
    } satisfies NeverStartedJournal);
    return this.neverStarted(state, directory);
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
  private liveIdentity(
    state: ExecutionReconciliation,
    directory: string,
    includeSupervisor = false,
  ): ExecutionProcessIdentity | null {
    for (const name of includeSupervisor ? ['process.json', 'supervisor.json'] : ['process.json']) {
      const journal = this.journal(directory, name);
      if (!this.matches(state, journal) || !journal.identity) continue;
      const current = executionProcessIdentity(journal.identity.pid);
      if (current?.start_marker === journal.identity.start_marker) return current;
    }
    return null;
  }
  private async reconcile(original: ExecutionReconciliation, controller: ExecutionControllerFence) {
    const { application: app, actor_id: actor, project_id: project, capacity } = this.options;
    if (original.state === 'completed') {
      const directory = original.attempt
        ? join(this.directory, original.run.id, original.attempt.id)
        : join(this.directory, original.run.id);
      const proof = original.attempt ? this.neverStarted(original, directory) : null;
      const result =
        (original.attempt ? (this.result(original, directory) ?? proof) : null) ??
        this.legacyResult(original);
      if (
        result?.cleanup_verified &&
        JSON.stringify(this.outcome(result)) === JSON.stringify(this.outcome(original.run))
      ) {
        if (result === proof) {
          if (proof?.capacity) capacity.reconcileNeverStarted(proof.capacity, proof.finished_at);
        } else this.releaseCapacity(original.run.id, result);
      }
      return;
    }
    const state = await app.adoptExecutionRun(actor, project, original.run.id, controller, LEASE_MS);
    if (!state?.attempt) return;
    const directory = join(this.directory, state.run.id, state.attempt.id);
    const proof = this.neverStarted(state, directory);
    const result = this.result(state, directory) ?? proof ?? this.legacyResult(state);
    if (result?.cleanup_verified && result.error_code !== 'RECOVERED_NOT_DISPATCHED') {
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
        if (result === proof) {
          if (proof.capacity) capacity.reconcileNeverStarted(proof.capacity, proof.finished_at);
        } else this.releaseCapacity(state.run.id, result);
      return;
    }
    if (state.run.status === 'reserved' && state.next_step === 'dispatch') {
      const proof = this.recordNeverStarted(state, directory, 'RECOVERED_NOT_DISPATCHED');
      if (!proof) return;
      if (
        await app.recoverExecutionRun(
          actor,
          project,
          state.run.id,
          state.run.reservation_token!,
          state.attempt.id,
          state.attempt.process_token,
          this.outcome(proof),
          controller,
        )
      ) {
        if (proof.capacity) capacity.reconcileNeverStarted(proof.capacity, proof.finished_at);
      }
      return;
    }
    const identity = result ? null : this.liveIdentity(state, directory, true);
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
  private neverStarted(state: ExecutionReconciliation, directory: string): NeverStartedJournal | null {
    if (existsSync(join(directory, 'dispatch.json'))) return null;
    for (const name of ['never-started.json', 'never-started-recovered.json', 'launch.json']) {
      const proof = this.journal(directory, name);
      if (
        !this.matches(state, proof) ||
        (name === 'launch.json' && proof.no_launch !== true) ||
        !this.validResult(proof) ||
        proof.cleanup_verified !== true ||
        proof.spawned !== false ||
        proof.started_at !== 0 ||
        !proof.error_code ||
        ![
          'RECOVERED_NOT_DISPATCHED',
          'NOT_STARTED',
          'RECIPE_UNAVAILABLE',
          'SPAWN_FAILED',
          'DISPATCH_REJECTED',
        ].includes(proof.error_code) ||
        proof.exit_code !== null ||
        proof.signal !== null ||
        proof.artifacts.length !== 0
      )
        continue;
      const { host_id: host } = this.options;
      const never = proof as NeverStartedJournal;
      if (never.capacity === null) return never;
      const capacity = never.capacity;
      if (
        capacity?.host_id !== host ||
        capacity.queue_id !== state.run.id ||
        capacity.run_id !== state.run.id ||
        capacity.project_id !== state.run.project_id ||
        !(
          capacity.execution_token === null ||
          (typeof capacity.execution_token === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              capacity.execution_token,
            ))
        )
      )
        continue;
      // Earlier immutable proofs encoded queued/occupied state in their nullable execution token.
      const expectedState = capacity.state ?? (capacity.execution_token === null ? 'queued' : 'running');
      if (!['queued', 'running', 'reconciling'].includes(expectedState)) continue;
      return { ...never, capacity: { ...capacity, state: expectedState } };
    }
    return null;
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
