import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
    const before =
      pipelineIdentityError(pipeline, step) ?? (performance.now() >= deadline ? 'TIMEOUT' : null);
    if (before) {
      result.error_code = before;
      stopped = before;
      report.error_code = before;
      continue;
    }
    let timedOut = false,
      processError: string | null = null;
    let termination: Promise<boolean> | undefined;
    const captures = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const observed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
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
        Math.max(1, Math.min(step.command.timeout_ms, deadline - performance.now())),
      );
      child.on('error', () => {
        processError = 'SPAWN_FAILED';
      });
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]!.on('data', (chunk: Buffer) => {
          const diagnostic = result.diagnostics[stream];
          diagnostic.total_bytes = Math.min(Number.MAX_SAFE_INTEGER, diagnostic.total_bytes + chunk.length);
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
    });
    if (termination) report.cleanup_verified &&= await termination;
    for (const stream of ['stdout', 'stderr'] as const) {
      result.diagnostics[stream].text = captures[stream].toString('utf8');
      result.diagnostics[stream].captured_bytes = captures[stream].length;
      result.diagnostics[stream].truncated = result.diagnostics[stream].total_bytes > captures[stream].length;
    }
    result.exit_code = observed.code;
    result.signal = observed.signal;
    const after = timedOut
      ? null
      : (pipelineIdentityError(pipeline, step) ?? (performance.now() >= deadline ? 'TIMEOUT' : null));
    result.error_code =
      after ??
      (timedOut
        ? 'TIMEOUT'
        : (processError ?? (observed.code === 0 && !observed.signal ? null : 'EXIT_FAILED')));
    result.status = timedOut ? 'timed_out' : result.error_code ? 'failed' : 'passed';
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
  const report = await runVerificationPipeline(input.pipeline, input.deadline_at);
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
