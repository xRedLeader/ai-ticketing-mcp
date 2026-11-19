import { createHash } from 'node:crypto';
import { ensure, type ExecutionAttempt, type ExecutionCacheHit, type ExecutionJob } from './contracts.js';
import { ExecutionArtifacts } from './execution-artifacts.js';
import type { VerificationPipeline } from './verification-pipeline.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Safe retained-artifact reads, bounded chunks, and no trust in a declared hash alone. */
export function inspectVerificationCache(
  artifacts: ExecutionArtifacts,
  run: ExecutionJob,
  attempt: ExecutionAttempt,
  pipeline: VerificationPipeline,
  now: number,
): ExecutionCacheHit['artifacts'] | null {
  try {
    const authority = {
      run_id: run.id,
      attempt_id: attempt.id,
      process_token: attempt.process_token,
      recipe_fingerprint: run.recipe_fingerprint,
      cleanup_verified: true,
      spawned: true,
      exit_code: 0,
      signal: null,
      error_code: null,
    };
    const verified: ExecutionCacheHit['artifacts'] = [];
    for (const name of ['stdout', 'stderr', 'result']) {
      const artifact_id = `execution:${run.id}:${attempt.id}:${name}`;
      ensure(
        run.artifacts.length === 3 && run.artifacts.includes(artifact_id),
        'INVALID_ARTIFACT',
        'Cache requires all original execution artifacts.',
      );
      const first = artifacts.read(artifact_id, authority, 0, 65_536, now, false, true);
      ensure(
        first.status === 'available' && first.sha256 && first.size_bytes !== null,
        'INVALID_ARTIFACT',
        'Cache artifact is unavailable.',
      );
      const hash = createHash('sha256');
      let range = first,
        offset = 0;
      do {
        const bytes = Buffer.from(range.range.data, 'base64');
        hash.update(bytes);
        offset += bytes.length;
        ensure(
          range.status === 'available' &&
            range.sha256 === first.sha256 &&
            range.size_bytes === first.size_bytes &&
            (offset === first.size_bytes || bytes.length > 0),
          'INVALID_ARTIFACT',
          'Cache artifact changed during verification.',
        );
        if (offset < first.size_bytes)
          range = artifacts.read(artifact_id, authority, offset, 65_536, now, false, true);
      } while (offset < first.size_bytes);
      ensure(hash.digest('hex') === first.sha256, 'INVALID_ARTIFACT', 'Cache artifact bytes changed.');
      if (name === 'result') {
        ensure(first.size_bytes <= 65_536, 'INVALID_ARTIFACT', 'Cache result exceeds limit.');
        const outcome = JSON.parse(Buffer.from(first.range.data, 'base64').toString('utf8'));
        const report = outcome?.verification;
        ensure(
          outcome.run_id === run.id &&
            outcome.attempt_id === attempt.id &&
            outcome.exit_code === 0 &&
            outcome.signal === null &&
            outcome.error_code === null &&
            report?.pipeline_id === pipeline.id &&
            report.recipe_fingerprint === pipeline.fingerprint &&
            same(report.source, pipeline.source.identity) &&
            same(report.runtime, pipeline.runtime) &&
            report.source_toolchain_sha256 === pipeline.source.executable_sha256 &&
            report.status === 'passed' &&
            report.error_code === null &&
            report.cleanup_verified === true &&
            Array.isArray(report.steps) &&
            report.steps.length === pipeline.steps.length &&
            pipeline.steps.every((step, index) => {
              const result = report.steps[index];
              return (
                result?.id === step.id &&
                result.recipe_fingerprint === step.command.fingerprint &&
                result.executable_sha256 === step.executable_sha256 &&
                result.toolchain_sha256 === step.toolchain_sha256 &&
                result.status === 'passed' &&
                result.exit_code === 0 &&
                result.signal === null &&
                result.error_code === null &&
                Array.isArray(result.blocked_by) &&
                result.blocked_by.length === 0
              );
            }),
          'INVALID_ARTIFACT',
          'Cache report does not match the exact successful verification.',
        );
      }
      verified.push({ artifact_id, sha256: first.sha256, size_bytes: first.size_bytes });
    }
    return verified;
  } catch {
    return null;
  }
}
