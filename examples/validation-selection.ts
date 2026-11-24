import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from '../src/contracts.js';
import { pipelineIdentityError, type VerificationPipeline } from '../src/verification-pipeline.js';
import { runVerificationPipeline } from '../src/verification-runner.js';
import {
  readRepositoryAnalysis,
  type RepositoryAnalysis,
  type RepositoryRevision,
} from './repository-context.js';
import { verifyWorktree, type WorktreeIdentity } from './worktree-isolation.js';

const stepId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
export const validationSelectionPolicySchema = z.strictObject({
  standalone_tests: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        step_ids: z.array(stepId).min(1).max(16),
      }),
    )
    .min(1)
    .max(256),
  mandatory_step_ids: z.array(stepId).max(16),
});
export type ValidationSelectionPolicy = z.input<typeof validationSelectionPolicySchema>;
export interface ValidationSelectionInput {
  policy?: ValidationSelectionPolicy;
  expected_revision?: string;
}
export interface ValidationSelection {
  scope: 'full_local' | 'narrow_local';
  reason: string;
  pipeline_fingerprint: string;
  policy_sha256: string | null;
  analysis_revision: RepositoryRevision | null;
  source: VerificationPipeline['source']['identity'];
  untracked: { count: number; sha256: string } | null;
  selected_step_ids: string[];
  omitted_step_ids: string[];
  fingerprint: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const standaloneTestPath = (path: string) =>
  !/[\\:\x00-\x1f]/.test(path) &&
  path
    .split('/')
    .every(
      (part) =>
        part &&
        ![
          '.',
          '..',
          '.git',
          '.github',
          'node_modules',
          'config',
          'configs',
          'migration',
          'migrations',
        ].includes(part.toLowerCase()),
    ) &&
  /^(?:[^/]+\/)*(?:tests?|__tests__)\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Only operator-registered pipeline steps are selectable; candidate symbol/caller matches are never used. */
export function selectValidationChecks(
  identity: WorktreeIdentity,
  pipeline: VerificationPipeline,
  input: ValidationSelectionInput = {},
): ValidationSelection {
  const record = verifyWorktree(identity);
  ensure(
    pathKey(pipeline.source.command.cwd) === pathKey(record.worktreePath),
    'WORKTREE_MISMATCH',
    'Validation pipeline must belong to the verified owned worktree.',
  );
  const policy = validationSelectionPolicySchema.safeParse(input.policy);
  let analysis: RepositoryAnalysis | null = null;
  let untracked: ValidationSelection['untracked'] = null;
  const finish = (reason: string, selected = pipeline.steps.map(({ id }) => id)): ValidationSelection => {
    const omitted = pipeline.steps.map(({ id }) => id).filter((id) => !selected.includes(id));
    const result = {
      scope: omitted.length ? ('narrow_local' as const) : ('full_local' as const),
      reason,
      pipeline_fingerprint: pipeline.fingerprint,
      policy_sha256: policy.success ? hash(policy.data) : null,
      analysis_revision: analysis?.revision ?? null,
      source: pipeline.source.identity,
      untracked,
      selected_step_ids: selected,
      omitted_step_ids: omitted,
    };
    return { ...result, fingerprint: hash(result) };
  };
  try {
    analysis = readRepositoryAnalysis(identity);
    if (
      pipelineIdentityError(pipeline) ||
      analysis.revision.head_commit !== pipeline.source.identity.commit ||
      analysis.revision.tree !== pipeline.source.identity.tree
    )
      return finish('source_changed');
    const command = pipeline.source.command;
    const inventory = execFileSync(
      command.executable,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '-z'],
      {
        cwd: command.cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(command.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
          ),
          GIT_TERMINAL_PROMPT: '0',
        },
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    untracked = { count: inventory.split('\0').filter(Boolean).length, sha256: hash(inventory) };
  } catch {
    return finish('analysis_unavailable');
  }
  if (!input.policy) return finish('opt_in_missing');
  if (!policy.success) return finish('invalid_policy');
  if (!input.expected_revision) return finish('revision_missing');
  if (input.expected_revision !== analysis.revision.fingerprint) return finish('revision_changed');
  if (!analysis.changed_paths_complete || !untracked) return finish('analysis_incomplete');
  if (untracked.count) return finish('untracked_files');
  if (!analysis.changed_files.length) return finish('no_changes');
  const mappings = new Map<string, readonly string[]>();
  const known = new Map(pipeline.steps.map((step) => [step.id, step]));
  for (const mapping of policy.data.standalone_tests) {
    if (
      !standaloneTestPath(mapping.path) ||
      mappings.has(pathKey(mapping.path)) ||
      new Set(mapping.step_ids).size !== mapping.step_ids.length ||
      mapping.step_ids.some((id) => !known.has(id))
    )
      return finish('ambiguous_mapping');
    mappings.set(pathKey(mapping.path), mapping.step_ids);
  }
  if (
    new Set(policy.data.mandatory_step_ids).size !== policy.data.mandatory_step_ids.length ||
    policy.data.mandatory_step_ids.some((id) => !known.has(id))
  )
    return finish('ambiguous_mapping');
  const selected = new Set<string>();
  const include = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const prerequisite of known.get(id)!.needs) include(prerequisite);
  };
  for (const id of policy.data.mandatory_step_ids) include(id);
  for (const file of analysis.changed_files) {
    if (file.change !== 'modified' || !standaloneTestPath(file.path)) return finish('unsupported_change');
    const steps = mappings.get(pathKey(file.path));
    if (!steps) return finish('mapping_missing');
    for (const id of steps) include(id);
  }
  const ids = pipeline.steps.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  return finish(ids.length === pipeline.steps.length ? 'all_steps_required' : 'mapped_standalone_tests', ids);
}

/** Local evidence only. Narrow reports have a distinct recipe identity and cannot stand in for full CI. */
export async function runSelectedValidation(
  identity: WorktreeIdentity,
  pipeline: VerificationPipeline,
  input: ValidationSelectionInput = {},
  options: { deadline_at?: number; report_path?: string } = {},
) {
  const proposed = selectValidationChecks(identity, pipeline, input);
  let selection = selectValidationChecks(identity, pipeline, input);
  if (selection.fingerprint !== proposed.fingerprint) {
    selection = selectValidationChecks(identity, pipeline, {});
    selection = { ...selection, scope: 'full_local', reason: 'selection_changed' };
    const { fingerprint: _previous, ...body } = selection;
    selection.fingerprint = hash(body);
  }
  const selectedPipeline =
    selection.scope === 'narrow_local'
      ? Object.freeze({
          ...pipeline,
          fingerprint: hash({ pipeline: pipeline.fingerprint, selection: selection.fingerprint }),
          steps: Object.freeze(pipeline.steps.filter(({ id }) => selection.selected_step_ids.includes(id))),
        })
      : pipeline;
  const report = await runVerificationPipeline(selectedPipeline, options.deadline_at, options.report_path);
  if (selection.scope === 'narrow_local') {
    try {
      const after = readRepositoryAnalysis(identity, {
        expected_revision: selection.analysis_revision!.fingerprint,
      });
      ensure(after.changed_paths_complete, 'SOURCE_CHANGED', 'Source enumeration changed during validation.');
    } catch {
      report.status = 'failed';
      report.error_code ??= 'SELECTION_SOURCE_CHANGED';
    }
  }
  return { selection, report };
}
