import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { durableExecutionFile, readExecutionFile } from './execution-journal.js';
import { fileSha256, MAX_VERIFICATION_REPORT_BYTES } from './verification-pipeline.js';
import type { ExecutionManifest } from './execution-supervisor.js';
import type { VerificationReport } from './verification-runner.js';

export function readVerificationTimeout(
  directory: string,
  identity: ExecutionManifest,
): VerificationReport | null {
  try {
    const marker = readExecutionFile(join(directory, 'pipeline-timeout.json')) as Record<string, unknown>;
    if (
      !Object.entries(identity).every(([key, value]) => marker[key] === value) ||
      marker.error_code !== 'TIMEOUT'
    )
      return null;
    const path = join(directory, 'pipeline-report.json');
    if (marker.report_sha256 !== fileSha256(path)) return null;
    const report = readExecutionFile(path, MAX_VERIFICATION_REPORT_BYTES) as VerificationReport;
    return report.recipe_fingerprint === identity.recipe_fingerprint &&
      report.status === 'failed' &&
      report.cleanup_verified === false &&
      report.steps.length <= 16 &&
      report.steps.some((step) => step.status === 'timed_out')
      ? report
      : null;
  } catch {
    return null;
  }
}

/** Called only after the original runner group has been proved terminated. */
export function recordVerificationTimeout(
  directory: string,
  identity: ExecutionManifest,
  startedAt: number,
  errorCode: 'TIMEOUT' | 'CANCELLED',
) {
  const report = readVerificationTimeout(directory, identity);
  if (!report) return null;
  const bytes = { stdout: 0, stderr: 0 },
    total_bytes = { stdout: 0, stderr: 0 },
    truncated = { stdout: false, stderr: false },
    sha256 = { stdout: '', stderr: '', result: '' };
  for (const stream of ['stdout', 'stderr'] as const) {
    const path = join(directory, `${stream}.log`),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      return null;
    bytes[stream] = stat.size;
    total_bytes[stream] = Math.max(
      stat.size,
      report.steps.reduce(
        (total, step) =>
          Math.min(
            Number.MAX_SAFE_INTEGER,
            total +
              (step.attempts ?? [step]).reduce(
                (sum, attempt) => sum + attempt.diagnostics[stream].total_bytes,
                0,
              ),
          ),
        0,
      ),
    );
    truncated[stream] = total_bytes[stream] > bytes[stream];
    sha256[stream] = fileSha256(path);
  }
  const finishedAt = Date.now(),
    outcomePath = join(directory, 'outcome.json');
  if (!existsSync(outcomePath))
    durableExecutionFile(outcomePath, {
      run_id: identity.run_id,
      attempt_id: identity.attempt_id,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: null,
      signal: 'SIGKILL',
      error_code: errorCode,
      bytes,
      total_bytes,
      truncated,
      sha256: { stdout: sha256.stdout, stderr: sha256.stderr },
      verification: { ...report, status: 'failed', cleanup_verified: true },
    });
  const outcome = readExecutionFile(outcomePath, MAX_VERIFICATION_REPORT_BYTES) as Record<string, any>;
  if (
    outcome.run_id !== identity.run_id ||
    outcome.attempt_id !== identity.attempt_id ||
    outcome.verification?.recipe_fingerprint !== identity.recipe_fingerprint ||
    outcome.verification?.status !== 'failed'
  )
    return null;
  sha256.result = fileSha256(outcomePath);
  const result = {
    ...identity,
    exit_code: null,
    signal: 'SIGKILL',
    error_code: errorCode,
    artifacts: ['stdout', 'stderr', 'result'].map(
      (name) => `execution:${identity.run_id}:${identity.attempt_id}:${name}`,
    ),
    started_at: startedAt,
    finished_at: finishedAt,
    spawned: true,
    cleanup_verified: true,
    bytes,
    total_bytes,
    truncated,
    sha256,
  };
  const resultPath = join(directory, 'result.json');
  if (!existsSync(resultPath)) durableExecutionFile(resultPath, result);
  else {
    const previous = readExecutionFile(resultPath) as Record<string, unknown>;
    if (!Object.entries(identity).every(([key, value]) => previous[key] === value)) return null;
  }
  return result;
}
