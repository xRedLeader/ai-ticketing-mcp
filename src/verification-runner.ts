import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  durableExecutionFile,
  executionProcessIdentity,
  terminateExecutionProcessTree,
} from './execution-journal.js';
import {
  fileSha256,
  pipelineIdentityError,
  recoveryFailureSchema,
  type SourceIdentity,
  type VerificationPipeline,
} from './verification-pipeline.js';
import type { ExecutionManifest } from './execution-supervisor.js';

const DIAGNOSTIC_BYTES = 512;
interface Diagnostic {
  text: string;
  total_bytes: number;
  captured_bytes: number;
  truncated: boolean;
}
export interface VerificationStepResult {
  id: string;
  recipe_fingerprint: string;
  executable_sha256: string;
  toolchain_sha256: string;
  status: 'passed' | 'failed' | 'timed_out' | 'skipped';
  error_code: string | null;
  blocked_by: string[];
  exit_code: number | null;
  signal: string | null;
  diagnostics: { stdout: Diagnostic; stderr: Diagnostic };
  attempts?: (Pick<
    VerificationStepResult,
    'status' | 'error_code' | 'exit_code' | 'signal' | 'diagnostics'
  > & {
    number: number;
    runtime_ms: number;
    stderr_proof: { encoding: 'base64'; data: string; sha256: string; complete: boolean };
  })[];
  recovery?: {
    signature: string;
    exit_code: number;
    effects: 'none';
    budget_ms: number;
    max_attempts: 2;
    state: 'not_needed' | 'retry_admitted' | 'recovered' | 'stopped';
    stop_reason: string | null;
  };
}
export interface VerificationReport {
  pipeline_id: string;
  recipe_fingerprint: string;
  source: SourceIdentity;
  source_toolchain_sha256: string;
  runtime: VerificationPipeline['runtime'];
  status: 'passed' | 'failed';
  error_code: string | null;
  cleanup_verified: boolean;
  steps: VerificationStepResult[];
}
/** One deterministic pass. Only immutable operator configuration reaches this runner. */
export async function runVerificationPipeline(
  pipeline: VerificationPipeline,
  deadlineAt = Date.now() + pipeline.timeout_ms,
  reportPath?: string,
): Promise<VerificationReport> {
  const deadline = performance.now() + Math.max(0, deadlineAt - Date.now());
  const report: VerificationReport = {
    pipeline_id: pipeline.id,
    recipe_fingerprint: pipeline.fingerprint,
    source: pipeline.source.identity,
    source_toolchain_sha256: pipeline.source.executable_sha256,
    runtime: pipeline.runtime,
    status: 'failed',
    error_code: null,
    cleanup_verified: true,
    steps: [],
  };
  if (pipeline.steps.some((step) => step.recovery)) {
    if (!reportPath) {
      report.error_code = 'RECOVERY_JOURNAL_REQUIRED';
      return report;
    }
    try {
      durableExecutionFile(join(dirname(reportPath), 'pipeline-recovery-start.json'), {
        pipeline_id: pipeline.id,
        recipe_fingerprint: pipeline.fingerprint,
        deadline_at: deadlineAt,
        max_attempts_per_step: 2,
        admission: 'existing_run',
      });
    } catch (error) {
      report.error_code =
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'RECOVERY_ALREADY_ADMITTED'
          : 'RECOVERY_JOURNAL_FAILED';
      if (report.error_code === 'RECOVERY_ALREADY_ADMITTED') report.cleanup_verified = false;
      return report;
    }
  }
  let stopped: string | null = null;
  const forwarded = { stdout: 0, stderr: 0 };
  for (const step of pipeline.steps) {
    const result: VerificationStepResult = {
      id: step.id,
      recipe_fingerprint: step.command.fingerprint,
      executable_sha256: step.executable_sha256,
      toolchain_sha256: step.toolchain_sha256,
      status: 'skipped',
      error_code: null,
      blocked_by: [],
      exit_code: null,
      signal: null,
      diagnostics: {
        stdout: { text: '', total_bytes: 0, captured_bytes: 0, truncated: false },
        stderr: { text: '', total_bytes: 0, captured_bytes: 0, truncated: false },
      },
    };
    result.blocked_by = step.needs.filter(
      (need) => report.steps.find((item) => item.id === need)?.status !== 'passed',
    );
    report.steps.push(result);
    if (stopped || result.blocked_by.length) {
      result.error_code = stopped ?? 'DEPENDENCY_FAILED';
      continue;
    }
    if (performance.now() >= deadline) {
      result.error_code = 'TIMEOUT';
      report.error_code = 'TIMEOUT';
      stopped = 'PIPELINE_STOPPED';
      continue;
    }
    const stepDeadline = step.recovery
      ? Math.min(deadline, performance.now() + step.command.timeout_ms)
      : deadline;
    const before =
      pipelineIdentityError(pipeline, step) ?? (performance.now() >= stepDeadline ? 'TIMEOUT' : null);
    if (before) {
      result.error_code = before;
      stopped = before;
      report.error_code = before;
      continue;
    }
    let after: string | null = null,
      timedOut = false;
    const recordRecovery = (number: number) => {
      const path = join(dirname(reportPath!), `pipeline-recovery-${step.id}-${number}.json`);
      const expired = new Error('Recovery publication deadline exceeded.');
      try {
        durableExecutionFile(path, report, () => {
          if (result.recovery!.state !== 'stopped' && performance.now() >= stepDeadline) throw expired;
        });
      } catch (cause) {
        result.status = 'failed';
        result.error_code = cause === expired ? 'RECOVERY_BUDGET_EXHAUSTED' : 'RECOVERY_JOURNAL_FAILED';
        result.recovery!.state = 'stopped';
        result.recovery!.stop_reason = result.error_code;
        stopped = result.error_code;
        report.error_code = result.error_code;
        if (cause === expired) durableExecutionFile(path, report);
      }
    };
    for (let number = 1; number <= (step.recovery ? 2 : 1); number++) {
      if (number > 1) {
        const blocked = existsSync(join(dirname(reportPath!), 'cancel.json'))
          ? 'CANCELLED'
          : (pipelineIdentityError(pipeline, step) ??
            (performance.now() >= stepDeadline ? 'RECOVERY_BUDGET_EXHAUSTED' : null));
        if (blocked) {
          result.recovery!.state = 'stopped';
          result.recovery!.stop_reason = blocked;
          result.error_code = blocked;
          report.error_code = blocked;
          stopped = blocked;
          recordRecovery(number);
          break;
        }
      }
      timedOut = false;
      let processError: string | null = null;
      let termination: Promise<boolean> | undefined;
      const captures = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const attemptStarted = step.recovery ? performance.now() : 0;
      if (step.recovery && attemptStarted >= stepDeadline) {
        const blocked = number === 1 ? 'TIMEOUT' : 'RECOVERY_BUDGET_EXHAUSTED';
        result.error_code = blocked;
        report.error_code = blocked;
        stopped = blocked;
        if (number > 1) {
          result.recovery!.state = 'stopped';
          result.recovery!.stop_reason = blocked;
          recordRecovery(number);
        }
        break;
      }
      if (number > 1)
        for (const stream of ['stdout', 'stderr'] as const)
          result.diagnostics[stream] = { text: '', total_bytes: 0, captured_bytes: 0, truncated: false };
      const observed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          const child = spawn(step.command.executable, [...step.command.argv], {
            cwd: step.command.cwd,
            env: { ...step.command.env },
            shell: false,
            detached: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const timeout = setTimeout(
            () => {
              timedOut = true;
              const identity = child.pid ? executionProcessIdentity(child.pid) : null;
              termination =
                process.platform === 'linux'
                  ? Promise.resolve(false)
                  : identity
                    ? terminateExecutionProcessTree(identity)
                    : Promise.resolve(false);
              void termination.then((verified) => {
                if (!verified) {
                  report.cleanup_verified = false;
                  // No further work may start while a timed-out process could still be alive.
                  resolve({ code: null, signal: null });
                }
              });
            },
            Math.max(1, Math.min(step.command.timeout_ms, stepDeadline - performance.now())),
          );
          child.on('error', () => {
            processError = 'SPAWN_FAILED';
          });
          for (const stream of ['stdout', 'stderr'] as const) {
            child[stream]!.on('data', (chunk: Buffer) => {
              const diagnostic = result.diagnostics[stream];
              diagnostic.total_bytes = Math.min(
                Number.MAX_SAFE_INTEGER,
                diagnostic.total_bytes + chunk.length,
              );
              const length = Math.min(chunk.length, DIAGNOSTIC_BYTES - captures[stream].length);
              if (length > 0) captures[stream] = Buffer.concat([captures[stream], chunk.subarray(0, length)]);
              const outputLength = Math.min(chunk.length, pipeline.max_log_bytes - forwarded[stream]);
              if (outputLength > 0) {
                process[stream].write(chunk.subarray(0, outputLength));
                forwarded[stream] += outputLength;
              }
            });
            child[stream]!.on('error', () => {
              processError = 'LOG_READ_FAILED';
            });
          }
          child.once('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
        },
      );
      if (termination) report.cleanup_verified &&= await termination;
      for (const stream of ['stdout', 'stderr'] as const) {
        result.diagnostics[stream].text = captures[stream].toString('utf8');
        result.diagnostics[stream].captured_bytes = captures[stream].length;
        result.diagnostics[stream].truncated =
          result.diagnostics[stream].total_bytes > captures[stream].length;
      }
      result.exit_code = observed.code;
      result.signal = observed.signal;
      after = timedOut
        ? null
        : (pipelineIdentityError(pipeline, step) ?? (performance.now() >= stepDeadline ? 'TIMEOUT' : null));
      result.error_code =
        after ??
        (timedOut
          ? 'TIMEOUT'
          : (processError ?? (observed.code === 0 && !observed.signal ? null : 'EXIT_FAILED')));
      result.status = timedOut ? 'timed_out' : result.error_code ? 'failed' : 'passed';
      if (step.recovery) {
        const proof = captures.stderr;
        const complete =
          !timedOut && observed.code !== null && !observed.signal && !result.diagnostics.stderr.truncated;
        result.attempts ??= [];
        result.attempts.push({
          number,
          runtime_ms: Math.max(0, performance.now() - attemptStarted),
          status: result.status,
          error_code: result.error_code,
          exit_code: result.exit_code,
          signal: result.signal,
          diagnostics: { stdout: { ...result.diagnostics.stdout }, stderr: { ...result.diagnostics.stderr } },
          stderr_proof: {
            encoding: 'base64',
            data: proof.toString('base64'),
            sha256: createHash('sha256').update(proof).digest('hex'),
            complete,
          },
        });
        let reason: string | null = null;
        if (result.status !== 'passed') {
          let failure: ReturnType<typeof recoveryFailureSchema.safeParse> | undefined;
          try {
            if (complete) failure = recoveryFailureSchema.safeParse(JSON.parse(proof.toString('utf8')));
          } catch {}
          reason =
            result.error_code !== 'EXIT_FAILED' || !report.cleanup_verified
              ? 'RECOVERY_UNSAFE_FAILURE'
              : !failure?.success
                ? 'RECOVERY_UNKNOWN_SIGNATURE'
                : failure.data.approval_required
                  ? 'RECOVERY_APPROVAL_REQUIRED'
                  : failure.data.effects !== 'none'
                    ? 'RECOVERY_UNKNOWN_EFFECTS'
                    : failure.data.signature !== step.recovery.signature ||
                        observed.code !== step.recovery.exit_code
                      ? 'RECOVERY_UNKNOWN_SIGNATURE'
                      : number === 2
                        ? 'RECOVERY_REPEATED_FAILURE'
                        : null;
        }
        result.recovery = {
          signature: step.recovery.signature,
          exit_code: step.recovery.exit_code,
          effects: 'none',
          budget_ms: step.command.timeout_ms,
          max_attempts: 2,
          state:
            result.status === 'passed'
              ? number === 1
                ? 'not_needed'
                : 'recovered'
              : reason
                ? 'stopped'
                : 'retry_admitted',
          stop_reason: reason,
        };
        if (reason) {
          stopped = reason;
          report.error_code = reason;
        }
        recordRecovery(number);
        if (result.recovery.state === 'retry_admitted') continue;
      }
      break;
    }
    if (after || !report.cleanup_verified) {
      stopped = after ?? 'TERMINATION_UNCONFIRMED';
      report.error_code = timedOut ? 'TIMEOUT' : stopped;
    } else if (result.status !== 'passed' && step.on_failure === 'stop') stopped = 'PIPELINE_STOPPED';
  }
  report.error_code ??=
    pipelineIdentityError(pipeline) ??
    (report.steps.every((step) => step.status === 'passed') ? null : 'STEP_FAILED');
  report.status = !report.error_code && report.cleanup_verified ? 'passed' : 'failed';
  if (performance.now() >= deadline) {
    report.error_code = 'TIMEOUT';
    report.status = 'failed';
  }
  return report;
}

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024 + 65_536) throw new Error('Pipeline input exceeds limit.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    pipeline: VerificationPipeline;
    report_path: string;
    deadline_at: number;
    identity: ExecutionManifest;
  };
  const deadline = performance.now() + Math.max(0, input.deadline_at - Date.now());
  const report = await runVerificationPipeline(input.pipeline, input.deadline_at, input.report_path);
  const expired = new Error('Pipeline publication deadline exceeded.');
  try {
    durableExecutionFile(input.report_path, report, () => {
      if (report.status === 'passed' && performance.now() >= deadline) throw expired;
    });
  } catch (cause) {
    if (cause !== expired) throw cause;
    report.status = 'failed';
    report.error_code = 'TIMEOUT';
    durableExecutionFile(input.report_path, report);
  }
  if (!report.cleanup_verified && report.steps.some((step) => step.status === 'timed_out')) {
    durableExecutionFile(join(dirname(input.report_path), 'pipeline-timeout.json'), {
      ...input.identity,
      error_code: 'TIMEOUT',
      report_sha256: fileSha256(input.report_path),
    });
    // Keep the group leader alive until its supervisor or a replacement verifies group termination.
    setInterval(() => {}, 1000);
  }
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // The supervisor can disappear during recovery; losing its log pipe must not orphan a step.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  main().catch(() => {
    process.exitCode = 1;
  });
}
