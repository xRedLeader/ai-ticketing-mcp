import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release, version } from 'node:os';
import { z } from 'zod';
import { ensure } from './contracts.js';
import type { ExecutionCommand } from './execution-recipes.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
export const MAX_VERIFICATION_REPORT_BYTES = 1024 * 1024;
const recovery = z.strictObject({
  signature: id,
  exit_code: z.number().int().min(1).max(255),
  effects: z.literal('none'),
});
export const recoveryFailureSchema = z.strictObject({
  kind: z.literal('transient_failure'),
  signature: id,
  effects: z.enum(['none', 'unknown']),
  approval_required: z.boolean(),
});
const recoveryAttempt = z.object({
  number: z.number().int(),
  runtime_ms: z.number().nonnegative(),
  status: z.string(),
  error_code: z.string().nullable(),
  exit_code: z.number().int(),
  signal: z.null(),
  diagnostics: z.json(),
  stderr_proof: z.object({
    encoding: z.literal('base64'),
    data: z.string().max(684),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.boolean(),
  }),
});
const recoveryEvidence = z.object({
  attempts: z.array(recoveryAttempt).min(1).max(2),
  recovery: recovery.extend({
    budget_ms: z.number().positive(),
    max_attempts: z.literal(2),
    state: z.enum(['not_needed', 'recovered']),
    stop_reason: z.null(),
  }),
  diagnostics: z.json(),
});

export function verifiedRecoveryEvidence(
  step: { attempts?: unknown; recovery?: unknown; diagnostics?: unknown },
  expected?: z.output<typeof recovery> & { budget_ms: number },
) {
  if (step.attempts === undefined && step.recovery === undefined) return expected === undefined;
  const evidence = recoveryEvidence.safeParse(step);
  if (!evidence.success) return false;
  const { attempts, recovery: declaration, diagnostics } = evidence.data;
  if (
    expected &&
    Object.entries(expected).some(([key, value]) => declaration[key as keyof typeof declaration] !== value)
  )
    return false;
  if (attempts.length !== (declaration.state === 'recovered' ? 2 : 1)) return false;
  if (attempts.reduce((elapsed, attempt) => elapsed + attempt.runtime_ms, 0) > declaration.budget_ms)
    return false;
  const proof = attempts.map(({ stderr_proof }) => {
    const bytes = Buffer.from(stderr_proof.data, 'base64');
    return bytes.length <= 512 &&
      bytes.toString('base64') === stderr_proof.data &&
      createHash('sha256').update(bytes).digest('hex') === stderr_proof.sha256
      ? bytes
      : null;
  });
  if (proof.some((bytes) => bytes === null)) return false;
  const last = attempts.at(-1)!;
  if (
    last.number !== attempts.length ||
    last.status !== 'passed' ||
    last.error_code !== null ||
    last.exit_code !== 0 ||
    digest(last.diagnostics) !== digest(diagnostics)
  )
    return false;
  if (declaration.state === 'not_needed') return true;
  const first = attempts[0]!;
  if (
    first.number !== 1 ||
    first.status !== 'failed' ||
    first.error_code !== 'EXIT_FAILED' ||
    first.exit_code !== declaration.exit_code ||
    !first.stderr_proof.complete
  )
    return false;
  try {
    const failure = recoveryFailureSchema.safeParse(JSON.parse(proof[0]!.toString('utf8')));
    return (
      failure.success &&
      failure.data.signature === declaration.signature &&
      failure.data.effects === 'none' &&
      !failure.data.approval_required
    );
  } catch {
    return false;
  }
}
export const verificationPipelineSchema = z.strictObject({
  id,
  cacheable: z.literal(true).optional(),
  project_ids: z.array(z.uuid()).min(1).max(128),
  source: z.strictObject({ recipe_id: id, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }),
  steps: z
    .array(
      z.strictObject({
        id,
        recipe_id: id,
        needs: z.array(id).max(16),
        on_failure: z.enum(['stop', 'proceed']),
        toolchain_files: z.array(z.string().min(1).max(4096)).max(64),
        recovery: recovery.optional(),
      }),
    )
    .min(1)
    .max(16),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000),
  max_log_bytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
});
interface FileIdentity {
  path: string;
  sha256: string;
}
export interface SourceIdentity {
  commit: string;
  tree: string;
  tracked_sha256: string;
}
export interface VerificationPipeline {
  readonly kind: 'verification_pipeline';
  readonly cacheable?: true;
  readonly id: string;
  readonly project_ids: readonly string[];
  readonly fingerprint: string;
  readonly timeout_ms: number;
  readonly max_log_bytes: number;
  readonly resources: Readonly<{ cpu_millis: number; memory_bytes: number }>;
  readonly runtime: Readonly<{
    node_sha256: string;
    runner_sha256: string;
    identity_sha256: string;
    environment_sha256: string;
  }>;
  readonly source: Readonly<{
    command: ExecutionCommand;
    executable_sha256: string;
    identity: Readonly<SourceIdentity>;
  }>;
  readonly steps: readonly Readonly<{
    id: string;
    command: ExecutionCommand;
    needs: readonly string[];
    on_failure: 'stop' | 'proceed';
    executable_sha256: string;
    toolchain_files: readonly Readonly<FileIdentity>[];
    toolchain_sha256: string;
    recovery?: Readonly<z.output<typeof recovery>>;
  }>[];
}
export function fileSha256(path: string): string {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(65_536),
    fd = openSync(path, 'r');
  try {
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function verificationRunnerPath(): string {
  const path = fileURLToPath(new URL('./verification-runner.js', import.meta.url));
  return existsSync(path) ? path : path.replace(/\.js$/, '.ts');
}
function runtimeIdentity() {
  return {
    environment_sha256: digest([process.platform, process.arch, release(), version(), process.versions]),
    node_sha256: fileSha256(process.execPath),
    runner_sha256: fileSha256(verificationRunnerPath()),
    identity_sha256: fileSha256(fileURLToPath(import.meta.url)),
  };
}

/** Fixed Git reads only; the registered recipe supplies the trusted binary, cwd and environment. */
export function readPipelineSource(command: ExecutionCommand): SourceIdentity {
  const git = (...args: string[]) =>
    execFileSync(command.executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd: command.cwd,
      env: { ...command.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  ensure(
    realpathSync(git('rev-parse', '--show-toplevel').trim()) === command.cwd,
    'INVALID_CONFIG',
    'Pipeline source recipe cwd must be the repository root.',
  );
  const commit = git('rev-parse', 'HEAD').trim(),
    tree = git('rev-parse', 'HEAD^{tree}').trim();
  ensure(
    !git('status', '--porcelain', '--untracked-files=no').trim(),
    'SOURCE_CHANGED',
    'Pipeline source must have a clean tracked working tree.',
  );
  const hash = createHash('sha256');
  for (const path of [...new Set(git('ls-files', '-z').split('\0').filter(Boolean))].sort()) {
    const file = join(command.cwd, path),
      stat = lstatSync(file);
    ensure(
      stat.isFile() && !stat.isSymbolicLink(),
      'INVALID_CONFIG',
      'Pipeline source links and submodules are unsupported.',
    );
    hash.update(JSON.stringify([path, fileSha256(file)]));
  }
  return { commit, tree, tracked_sha256: hash.digest('hex') };
}
export function pipelineIdentityError(
  pipeline: VerificationPipeline,
  step?: VerificationPipeline['steps'][number],
): string | null {
  try {
    if (digest(runtimeIdentity()) !== digest(pipeline.runtime)) return 'TOOLCHAIN_CHANGED';
    if (
      fileSha256(pipeline.source.command.executable) !== pipeline.source.executable_sha256 ||
      digest(readPipelineSource(pipeline.source.command)) !== digest(pipeline.source.identity)
    )
      return 'SOURCE_CHANGED';
    const steps = step ? [step] : pipeline.steps;
    for (const item of steps) {
      if (
        fileSha256(item.command.executable) !== item.executable_sha256 ||
        item.toolchain_files.some(
          (file) => realpathSync(file.path) !== file.path || fileSha256(file.path) !== file.sha256,
        )
      )
        return 'TOOLCHAIN_CHANGED';
    }
    return null;
  } catch {
    return 'IDENTITY_UNAVAILABLE';
  }
}
export function pinVerificationPipeline(
  input: z.output<typeof verificationPipelineSchema>,
  commands: readonly ExecutionCommand[],
  roots: readonly string[],
): VerificationPipeline {
  const command = (id: string) => {
    const found = commands.find((item) => item.id === id);
    ensure(
      found && input.project_ids.every((project) => found.project_ids.includes(project)),
      'INVALID_CONFIG',
      'Every pipeline recipe must permit all pipeline projects.',
    );
    return found;
  };
  const git = command(input.source.recipe_id);
  ensure(git.argv.length === 0, 'INVALID_CONFIG', 'The pipeline Git recipe must have empty argv.');
  const source = readPipelineSource(git);
  ensure(
    source.commit === input.source.commit,
    'SOURCE_CHANGED',
    'Pipeline source commit does not match configured commit.',
  );
  const seen = new Set<string>();
  const steps = input.steps.map((step) => {
    ensure(
      !seen.has(step.id) &&
        new Set(step.needs).size === step.needs.length &&
        step.needs.every((need) => seen.has(need)),
      'INVALID_CONFIG',
      'Pipeline step IDs must be unique and dependencies must precede their step.',
    );
    seen.add(step.id);
    const recipe = command(step.recipe_id);
    ensure(
      recipe.cwd === git.cwd,
      'INVALID_CONFIG',
      'Pipeline step cwd must match the pinned repository root.',
    );
    const files = step.toolchain_files.map((path) => {
      ensure(isAbsolute(path), 'INVALID_CONFIG', 'Toolchain files must be absolute.');
      const resolved = realpathSync(path);
      ensure(
        resolved === path &&
          lstatSync(path).isFile() &&
          roots.some((root) => {
            const child = relative(root, path);
            return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
          }),
        'INVALID_CONFIG',
        'Toolchain files must be canonical files inside an allowed workspace.',
      );
      return Object.freeze({ path, sha256: fileSha256(path) });
    });
    const executable_sha256 = fileSha256(recipe.executable);
    return Object.freeze({
      id: step.id,
      command: recipe,
      needs: Object.freeze([...step.needs]),
      on_failure: step.on_failure,
      executable_sha256,
      toolchain_files: Object.freeze(files),
      toolchain_sha256: digest([executable_sha256, files]),
      ...(step.recovery ? { recovery: Object.freeze({ ...step.recovery }) } : {}),
    });
  });
  const normalized = {
    kind: 'verification_pipeline' as const,
    ...(input.cacheable ? { cacheable: true as const } : {}),
    id: input.id,
    project_ids: Object.freeze([...new Set(input.project_ids)].sort()),
    timeout_ms: input.timeout_ms,
    max_log_bytes: input.max_log_bytes,
    resources: Object.freeze({
      cpu_millis: Math.max(...steps.map((step) => step.command.resources.cpu_millis)),
      memory_bytes: Math.max(...steps.map((step) => step.command.resources.memory_bytes)),
    }),
    runtime: Object.freeze(runtimeIdentity()),
    source: Object.freeze({
      command: git,
      executable_sha256: fileSha256(git.executable),
      identity: Object.freeze(source),
    }),
    steps: Object.freeze(steps),
  };
  const pinned = Object.freeze({ ...normalized, fingerprint: digest(normalized) });
  ensure(
    Buffer.byteLength(JSON.stringify(pinned)) <= 2 * 1024 * 1024,
    'INVALID_CONFIG',
    'Normalized pipeline exceeds 2 MiB.',
  );
  return pinned;
}
