import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Application } from '../src/application.js';
import { DomainError, ensure } from '../src/contracts.js';
import { durableExecutionFile, readExecutionFile } from '../src/execution-journal.js';
import {
  fileSha256,
  pipelineIdentityError,
  type VerificationPipeline,
} from '../src/verification-pipeline.js';
import { runLocalVerificationPipeline, type VerificationReport } from '../src/verification-runner.js';
import {
  createWorktree,
  verifyWorktree,
  type WorktreeIdentity,
  type WorktreeRecord,
} from './worktree-isolation.js';

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z.strictObject({
  repository: z.string().max(4096),
  workspaceRoot: z.string().max(4096),
  runId: z.string().min(1).max(256),
  attemptId: z.string().min(1).max(256),
  baseCommit: sha,
});
const requestSchema = z.strictObject({
  operation_id: z.uuid(),
  ticket_id: z.uuid(),
  sources: z
    .array(
      z.strictObject({
        ticket_id: z.uuid(),
        requirements_revision: z.int().positive(),
        submission_id: z.uuid(),
        commit: sha,
        worktree: identity,
      }),
    )
    .min(1)
    .max(128),
});
export type IntegrationRequest = z.input<typeof requestSchema>;
export interface IntegrationReceipt {
  state:
    | 'ready_for_review'
    | 'conflict'
    | 'failed'
    | 'revalidation_required'
    | 'needs_attention'
    | 'abandoned'
    | 'busy';
  code: string | null;
  operation_id: string;
  ticket_id: string;
  actor_id: string;
  project_id: string;
  target_ref: string;
  target_commit: string;
  join_identity: string;
  sources: IntegrationRequest['sources'];
  journal_path: string;
  cleanup_verified: boolean;
  candidate_commit?: string;
  worktree?: WorktreeRecord;
  verification_sha256?: string;
  reconciliation_source?: string;
  conflict?: {
    ticket_id: string;
    submission_id: string;
    commit: string;
    paths: string[];
    artifact_path: string;
  };
}
export interface IntegrationCompanionOptions {
  application: Pick<Application, 'getDependencyJoin'>;
  actor_id: string;
  project_id: string;
  repository: string;
  workspace_root: string;
  /** A configured full local ref, read only; no fetch or publication occurs. */
  target_ref: string;
  git_executable: string;
  /** Operator configuration must pin actual recipes to this owned candidate worktree. */
  pipeline: (worktree: WorktreeRecord, commit: string) => VerificationPipeline;
}
interface Intent {
  version: 2;
  input_hash: string;
  request: IntegrationRequest;
  target_commit: string;
  join_identity: string;
  git_sha256: string;
}
interface TargetOwner {
  operation: string;
  acquisition?: string;
}
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failureCode = (error: unknown) =>
  error instanceof DomainError ? error.code : 'INTEGRATION_UNRESOLVED';

/** Local preparation only. Immutable journals and a common-Git-directory interlock fence native work. */
export class IntegrationCompanion {
  constructor(private readonly options: IntegrationCompanionOptions) {
    this.options = Object.freeze({ ...options });
    ensure(
      realpathSync(options.repository) === options.repository &&
        realpathSync(options.workspace_root) === options.workspace_root,
      'INVALID_CONFIG',
      'Use canonical repository and workspace roots.',
    );
    ensure(
      isAbsolute(options.git_executable) &&
        realpathSync(options.git_executable) === options.git_executable &&
        lstatSync(options.git_executable).isFile(),
      'INVALID_CONFIG',
      'Use a canonical native Git executable.',
    );
    ensure(
      /^refs\/(?:heads|remotes)\//.test(options.target_ref),
      'INVALID_CONFIG',
      'Configure a full local target ref.',
    );
    this.git(options.repository, ['check-ref-format', options.target_ref]);
  }

  private git(cwd: string, argv: string[], allowed = [0], input?: string) {
    const result = spawnSync(
      this.options.git_executable,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...argv],
      {
        cwd,
        encoding: 'utf8',
        input,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
          ),
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    ensure(
      !result.error && result.status !== null && allowed.includes(result.status),
      'GIT_FAILED',
      `Git ${argv[0]} failed; retain the integration journal.`,
      { status: result.status },
    );
    return { status: result.status!, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  private read<T>(path: string): T {
    ensure(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      'JOURNAL_CHANGED',
      'Journal is not an owned plain file.',
    );
    return readExecutionFile(path, MAX_JOURNAL_BYTES) as T;
  }
  private readIntent(path: string): Intent {
    const intent = this.read<
      | Intent
      | (Omit<Intent, 'version' | 'join_identity'> & {
          version: 1;
          join: { identity: string };
        })
    >(path);
    return intent.version === 1 ? { ...intent, version: 2, join_identity: intent.join.identity } : intent;
  }
  private directory(path: string) {
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    ensure(
      lstatSync(path).isDirectory() &&
        !lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === resolve(path),
      'JOURNAL_CHANGED',
      'Journal directory changed.',
    );
    return path;
  }
  private sourceRecords(request: IntegrationRequest) {
    const records = request.sources.map((source) => {
      const record = verifyWorktree(source.worktree);
      ensure(
        record.repository === this.options.repository,
        'SOURCE_CHANGED',
        'All source worktrees must belong to the configured repository.',
      );
      ensure(
        this.git(record.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim() ===
          source.commit,
        'SOURCE_CHANGED',
        'Accepted source branch moved.',
      );
      return record;
    });
    ensure(
      new Set(records.map((record) => record.commonDirectory)).size === 1,
      'SOURCE_CHANGED',
      'Sources must share one Git common directory.',
    );
    return records;
  }
  private paths(request: IntegrationRequest) {
    ensure(
      this.git(this.options.repository, ['rev-parse', '--show-toplevel'])
        .stdout.trim()
        .replaceAll('\\', '/') === this.options.repository.replaceAll('\\', '/'),
      'INVALID_CONFIG',
      'Integration repository must be its worktree root.',
    );
    const common = realpathSync(
      this.git(this.options.repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).stdout.trim(),
    );
    const root = this.directory(join(common, 'ai-ticketing-integrations'));
    const operations = this.directory(join(root, 'operations'));
    const locks = this.directory(join(root, 'targets'));
    const key = digest([this.options.project_id, request.ticket_id, request.operation_id]);
    const journal = this.directory(join(operations, key));
    const targetKey = digest(this.options.target_ref);
    return { journal, lock: join(locks, `${targetKey}.json`), key, targetKey };
  }
  private target() {
    return this.git(this.options.repository, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${this.options.target_ref}^{commit}`,
    ]).stdout.trim();
  }
  private async join(request: IntegrationRequest) {
    const snapshot = await this.options.application.getDependencyJoin(
      this.options.actor_id,
      this.options.project_id,
      request.ticket_id,
    );
    ensure(snapshot.ready, 'DEPENDENCY_BLOCKED', 'Every integration source needs accepted current evidence.');
    const required = new Map(snapshot.branches.map((branch) => [branch.ticket_id, branch]));
    ensure(
      new Set(request.sources.map((source) => source.ticket_id)).size === request.sources.length &&
        required.size === request.sources.length &&
        request.sources.every((source) => {
          const branch = required.get(source.ticket_id);
          return (
            branch?.state === 'accepted' &&
            branch.submission_id === source.submission_id &&
            branch.requirements_revision === source.requirements_revision
          );
        }),
      'SOURCE_ACCEPTANCE_CHANGED',
      'Supply one exact accepted submission-to-commit mapping for every required branch.',
    );
    return snapshot;
  }
  private async validate(intent: Intent, worktree?: WorktreeRecord, pipeline?: VerificationPipeline) {
    ensure(
      fileSha256(this.options.git_executable) === intent.git_sha256,
      'TOOLCHAIN_CHANGED',
      'Integration Git executable changed.',
    );
    ensure(
      (await this.join(intent.request)).identity === intent.join_identity,
      'JOIN_CHANGED',
      'Accepted join changed; revalidation is required.',
    );
    this.sourceRecords(intent.request);
    ensure(
      this.target() === intent.target_commit,
      'TARGET_CHANGED',
      'Target advanced; rebuild and revalidate against its current commit.',
    );
    if (worktree) {
      const record = verifyWorktree(worktree);
      ensure(
        this.git(record.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() === record.baseCommit,
        'SOURCE_CHANGED',
        'Integration candidate moved.',
      );
      if (pipeline)
        ensure(
          !pipelineIdentityError(pipeline),
          'VERIFICATION_CHANGED',
          'Pinned verification/source identity changed.',
        );
    }
  }
  private base(intent: Intent, journal: string): IntegrationReceipt {
    return {
      state: 'needs_attention',
      code: 'INTEGRATION_UNRESOLVED',
      operation_id: intent.request.operation_id,
      ticket_id: intent.request.ticket_id,
      actor_id: this.options.actor_id,
      project_id: this.options.project_id,
      target_ref: this.options.target_ref,
      target_commit: intent.target_commit,
      join_identity: intent.join_identity,
      sources: intent.request.sources,
      journal_path: journal,
      cleanup_verified: false,
    };
  }
  private release(path: string, owner: TargetOwner, journal: string, recovery = false) {
    const grant = recovery ? 'reconciliation-release' : 'release';
    ensure(
      owner.acquisition === undefined || z.uuid().safeParse(owner.acquisition).success,
      'INTERLOCK_CHANGED',
      'Invalid target acquisition identity.',
    );
    try {
      durableExecutionFile(
        join(journal, owner.acquisition ? `${grant}-${owner.acquisition}.json` : `${grant}.json`),
        owner,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    if (!existsSync(path)) return;
    const current = this.read<TargetOwner>(path);
    ensure(
      current.operation === owner.operation && current.acquisition === owner.acquisition,
      'INTERLOCK_CHANGED',
      'Target interlock ownership changed.',
    );
    unlinkSync(path);
  }

  private previousReceipt(journal: string) {
    for (const name of ['reconciliation.json', 'result.json']) {
      const path = join(journal, name);
      if (existsSync(path)) return this.read<IntegrationReceipt>(path);
    }
  }

  private async replay(intent: Intent, receipt: IntegrationReceipt): Promise<IntegrationReceipt> {
    if (receipt.state === 'ready_for_review') {
      try {
        const reportPath = join(receipt.journal_path, 'verification.json');
        ensure(
          fileSha256(reportPath) === receipt.verification_sha256 &&
            receipt.worktree &&
            receipt.candidate_commit,
          'VERIFICATION_CHANGED',
          'Verification evidence changed.',
        );
        const pipeline = this.options.pipeline(receipt.worktree, receipt.candidate_commit);
        const report = this.read<VerificationReport>(reportPath);
        ensure(
          report.recipe_fingerprint === pipeline.fingerprint &&
            report.status === 'passed' &&
            report.cleanup_verified,
          'VERIFICATION_CHANGED',
          'Verification recipe/evidence changed.',
        );
        await this.validate(intent, receipt.worktree, pipeline);
      } catch (error) {
        return { ...receipt, state: 'revalidation_required', code: failureCode(error) };
      }
    }
    return receipt;
  }

  async prepare(raw: IntegrationRequest): Promise<IntegrationReceipt> {
    const request = requestSchema.parse(raw);
    await this.options.application.getDependencyJoin(
      this.options.actor_id,
      this.options.project_id,
      request.ticket_id,
    );
    request.sources.sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
    const paths = this.paths(request);
    const intentPath = join(paths.journal, 'intent.json'),
      resultPath = join(paths.journal, 'result.json');
    const inputHash = digest([
      this.options.actor_id,
      this.options.project_id,
      this.options.repository,
      this.options.workspace_root,
      this.options.target_ref,
      request,
    ]);
    let intent: Intent;
    if (existsSync(intentPath)) {
      intent = this.readIntent(intentPath);
      ensure(
        intent.input_hash === inputHash,
        'IDEMPOTENCY_CONFLICT',
        'Integration operation was already bound to different inputs.',
      );
    } else {
      intent = {
        version: 2,
        input_hash: inputHash,
        request,
        target_commit: this.target(),
        join_identity: (await this.join(request)).identity,
        git_sha256: fileSha256(this.options.git_executable),
      };
      ensure(
        Buffer.byteLength(JSON.stringify(intent) + '\n') <= MAX_JOURNAL_BYTES,
        'JOURNAL_LIMIT',
        'Integration intent exceeds the journal size limit.',
      );
      try {
        durableExecutionFile(intentPath, intent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        intent = this.readIntent(intentPath);
        ensure(
          intent.input_hash === inputHash,
          'IDEMPOTENCY_CONFLICT',
          'Integration operation inputs changed.',
        );
      }
    }
    const base = this.base(intent, paths.journal);
    const owner = { operation: paths.key, acquisition: randomUUID() };
    for (;;) {
      const previous = this.previousReceipt(paths.journal);
      if (previous) return this.replay(intent, previous);
      try {
        durableExecutionFile(paths.lock, { ...owner, input_hash: inputHash, journal_path: paths.journal });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let current: TargetOwner;
        try {
          current = this.read<TargetOwner>(paths.lock);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        return {
          ...base,
          state: current.operation === paths.key ? 'needs_attention' : 'busy',
          code: current.operation === paths.key ? 'NATIVE_UNRESOLVED' : 'TARGET_INTERLOCKED',
        };
      }
    }
    let previous: IntegrationReceipt | undefined;
    try {
      previous = this.previousReceipt(paths.journal);
    } catch (error) {
      this.release(paths.lock, owner, paths.journal);
      throw error;
    }
    // A replay can acquire the lock just after the original owner publishes and releases it.
    if (previous) {
      this.release(paths.lock, owner, paths.journal);
      return this.replay(intent, previous);
    }
    let nativeStarted = false,
      cleanupVerified = true,
      finalized = false;
    try {
      await this.validate(intent);
      if (existsSync(join(paths.journal, 'native-start.json'))) {
        nativeStarted = true;
        cleanupVerified = false;
      }
      ensure(
        !nativeStarted,
        'NATIVE_UNRESOLVED',
        'An earlier native attempt requires explicit reconciliation.',
      );
      durableExecutionFile(join(paths.journal, 'native-start.json'), {
        target: intent.target_commit,
        sources: request.sources,
        git_sha256: intent.git_sha256,
      });
      nativeStarted = true;
      let candidate = intent.target_commit;
      for (const [index, source] of request.sources.entries()) {
        cleanupVerified = false;
        const ancestor = this.git(
          this.options.repository,
          ['merge-base', '--is-ancestor', source.commit, candidate],
          [0, 1],
        );
        cleanupVerified = true;
        if (ancestor.status === 0) continue;
        cleanupVerified = false;
        const merged = this.git(
          this.options.repository,
          ['merge-tree', '--write-tree', '--messages', '--name-only', '-z', candidate, source.commit],
          [0, 1],
        );
        cleanupVerified = true;
        const artifact = join(paths.journal, `merge-${index}.json`);
        durableExecutionFile(artifact, { previous_commit: candidate, source, ...merged });
        if (merged.status === 1) {
          const fields = merged.stdout.split('\0');
          const end = fields.indexOf('', 1);
          const receipt: IntegrationReceipt = {
            ...base,
            state: 'conflict',
            code: 'MERGE_CONFLICT',
            cleanup_verified: true,
            candidate_commit: candidate,
            conflict: {
              ticket_id: source.ticket_id,
              submission_id: source.submission_id,
              commit: source.commit,
              paths: fields.slice(1, end < 0 ? 1 : end),
              artifact_path: artifact,
            },
          };
          durableExecutionFile(resultPath, receipt);
          finalized = true;
          return receipt;
        }
        const tree = merged.stdout.split('\0')[0]!;
        ensure(sha.safeParse(tree).success, 'GIT_FAILED', 'Merge did not produce an exact tree identity.');
        cleanupVerified = false;
        candidate = this.git(
          this.options.repository,
          ['commit-tree', tree, '-p', candidate, '-p', source.commit],
          [0],
          `Integrate accepted submission ${source.submission_id}\n`,
        ).stdout.trim();
        cleanupVerified = true;
      }
      const owner: WorktreeIdentity = {
        repository: this.options.repository,
        workspaceRoot: this.options.workspace_root,
        runId: `integration:${this.options.project_id}:${request.ticket_id}:${paths.targetKey}`,
        attemptId: request.operation_id,
        baseCommit: candidate,
      };
      durableExecutionFile(join(paths.journal, 'candidate.json'), { commit: candidate, owner });
      cleanupVerified = false;
      const worktree = createWorktree(owner);
      cleanupVerified = true;
      const pipeline = this.options.pipeline(worktree, candidate);
      ensure(
        pipeline.project_ids.includes(this.options.project_id) &&
          pipeline.source.command.cwd === worktree.worktreePath &&
          pipeline.source.identity.commit === candidate &&
          pipeline.source.command.executable === this.options.git_executable,
        'INVALID_CONFIG',
        'Verification must pin the current owned candidate and configured native Git.',
      );
      await this.validate(intent, worktree, pipeline);
      durableExecutionFile(join(paths.journal, 'verification-start.json'), {
        commit: candidate,
        recipe_fingerprint: pipeline.fingerprint,
      });
      cleanupVerified = false;
      const report = await runLocalVerificationPipeline(
        pipeline,
        Date.now() + pipeline.timeout_ms,
        join(paths.journal, 'verification.json'),
      );
      cleanupVerified = report.cleanup_verified;
      durableExecutionFile(join(paths.journal, 'verification.json'), report);
      await this.validate(intent, worktree, pipeline);
      const receipt: IntegrationReceipt = {
        ...base,
        candidate_commit: candidate,
        worktree,
        verification_sha256: fileSha256(join(paths.journal, 'verification.json')),
        cleanup_verified: cleanupVerified,
        state:
          report.status === 'passed' && cleanupVerified
            ? 'ready_for_review'
            : cleanupVerified
              ? 'failed'
              : 'needs_attention',
        code: report.error_code,
      };
      durableExecutionFile(resultPath, receipt);
      finalized = true;
      return receipt;
    } catch (error) {
      const receipt: IntegrationReceipt = {
        ...base,
        state: cleanupVerified
          ? [
              'TARGET_CHANGED',
              'JOIN_CHANGED',
              'SOURCE_CHANGED',
              'SOURCE_ACCEPTANCE_CHANGED',
              'DEPENDENCY_BLOCKED',
              'VERIFICATION_CHANGED',
              'TOOLCHAIN_CHANGED',
            ].includes(failureCode(error))
            ? 'revalidation_required'
            : 'failed'
          : 'needs_attention',
        code: failureCode(error),
        cleanup_verified: cleanupVerified,
      };
      durableExecutionFile(resultPath, receipt);
      finalized = true;
      return receipt;
    } finally {
      if (finalized && (!nativeStarted || cleanupVerified)) this.release(paths.lock, owner, paths.journal);
    }
  }

  /** Explicit operator proof of native/process termination; missing acknowledgment or PID disappearance is insufficient. */
  async reconcile(
    raw: IntegrationRequest,
    proof: { source: string; stopped: (journalPath: string) => boolean },
  ): Promise<IntegrationReceipt> {
    ensure(
      typeof proof.source === 'string' && proof.source.trim().length > 0 && proof.source.length <= 256,
      'INVALID_INPUT',
      'Name the independent termination proof source.',
    );
    const request = requestSchema.parse(raw),
      paths = this.paths(request);
    await this.options.application.getDependencyJoin(
      this.options.actor_id,
      this.options.project_id,
      request.ticket_id,
    );
    const intent = this.readIntent(join(paths.journal, 'intent.json'));
    ensure(
      intent.input_hash ===
        digest([
          this.options.actor_id,
          this.options.project_id,
          this.options.repository,
          this.options.workspace_root,
          this.options.target_ref,
          {
            ...request,
            sources: [...request.sources].sort((a, b) => a.ticket_id.localeCompare(b.ticket_id)),
          },
        ]),
      'IDEMPOTENCY_CONFLICT',
      'Reconciliation inputs changed.',
    );
    if (existsSync(join(paths.journal, 'reconciliation.json')))
      return this.read<IntegrationReceipt>(join(paths.journal, 'reconciliation.json'));
    const owner = this.read<TargetOwner>(paths.lock);
    ensure(
      owner.operation === paths.key && proof.stopped(paths.journal) === true,
      'NATIVE_UNRESOLVED',
      'Exact native termination/cleanup proof is required.',
    );
    const receipt: IntegrationReceipt = {
      ...this.base(intent, paths.journal),
      state: 'abandoned',
      code: 'EXPLICIT_REVALIDATION_REQUIRED',
      reconciliation_source: proof.source,
      cleanup_verified: true,
    };
    const resultPath = join(paths.journal, 'result.json');
    if (!existsSync(resultPath)) durableExecutionFile(resultPath, receipt);
    try {
      durableExecutionFile(join(paths.journal, 'reconciliation.json'), receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return this.read<IntegrationReceipt>(join(paths.journal, 'reconciliation.json'));
      throw error;
    }
    this.release(paths.lock, owner, paths.journal, true);
    return receipt;
  }
}
