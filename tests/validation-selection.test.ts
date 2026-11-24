import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { createWorktree } from '../examples/worktree-isolation.js';
import { readRepositoryAnalysis } from '../examples/repository-context.js';
import {
  runSelectedValidation,
  selectValidationChecks,
  type ValidationSelectionPolicy,
  type ValidationSelectionInput,
} from '../examples/validation-selection.js';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';

function fixture(options: { failure?: string; mutate?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ticketing-validation-selection-')));
  const repository = join(directory, 'source');
  const workspaceRoot = join(directory, 'owned');
  mkdirSync(repository);
  mkdirSync(workspaceRoot);
  const gitExecutable = realpathSync(
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0]!,
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(gitExecutable, ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
      ),
    }).trim();
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Selection Fixture');
  git(repository, 'config', 'user.email', 'selection@example.invalid');
  git(repository, 'config', 'core.autocrlf', 'false');
  const files = {
    'tests/a.test.cjs': "require('node:assert/strict').equal(2, 2);\n",
    'tests/b.test.cjs': "require('node:assert/strict').equal(3, 3);\n",
    'tests/shared.cjs': 'module.exports = 2;\n',
    'source.cjs': 'module.exports = 2;\n',
    'package.json': '{"private":true}\n',
    'config.json': '{}\n',
    'migrations/001.sql': 'select 1;\n',
    '.gitignore': 'ignored.txt\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'test: validation fixture');
  const identity = {
    repository,
    workspaceRoot,
    runId: 'run',
    attemptId: 'attempt',
    baseCommit: git(repository, 'rev-parse', 'HEAD'),
  };
  const record = createWorktree(identity);
  const calls = join(record.artifactPath, 'calls.txt');
  const project = randomUUID();
  const command = (...args: string[]) => git(record.worktreePath, ...args);
  const write = (path: string, text: string) => writeFileSync(join(record.worktreePath, path), text);
  const commit = () => {
    command('add', '-A');
    command('commit', '-m', 'test: change');
  };
  const ids = ['prepare', 'test-a', 'test-b', 'mandatory'];
  const registry = () =>
    new ExecutionRecipeRegistry({
      workspace_roots: [directory],
      recipes: [
        {
          id: 'git',
          project_ids: [project],
          executable: gitExecutable,
          argv: [],
          cwd: record.worktreePath,
          env: {},
        },
        ...ids.map((id) => ({
          id,
          project_ids: [project],
          executable: process.execPath,
          argv: [
            '-e',
            `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},${JSON.stringify(id + '\n')});${id === 'test-a' ? "require('./tests/a.test.cjs');" : ''}${id === 'test-b' ? "require('./tests/b.test.cjs');" : ''}${options.failure === id ? 'process.exitCode=1;' : ''}${options.mutate && id === 'test-a' ? "fs.appendFileSync('tests/a.test.cjs','// changed during check');" : ''}`,
          ],
          cwd: record.worktreePath,
          env: {},
          timeout_ms: 5000,
        })),
      ],
      pipelines: [
        {
          id: 'verify',
          project_ids: [project],
          source: { recipe_id: 'git', commit: command('rev-parse', 'HEAD') },
          timeout_ms: 30000,
          max_log_bytes: 256,
          steps: ids.map((id) => ({
            id,
            recipe_id: id,
            needs: id.startsWith('test-') ? ['prepare'] : [],
            on_failure: 'stop',
            toolchain_files: [],
          })),
        },
      ],
    });
  const pipeline = () => {
    const recipes = registry();
    const metadata = recipes.metadata().find(({ id }) => id === 'verify')!;
    const pinned = recipes.get('verify', metadata.fingerprint, project);
    assert.ok('kind' in pinned);
    return pinned;
  };
  const policy: ValidationSelectionPolicy = {
    standalone_tests: [
      { path: 'tests/a.test.cjs', step_ids: ['test-a'] },
      { path: 'tests/b.test.cjs', step_ids: ['test-b'] },
    ],
    mandatory_step_ids: ['mandatory'],
  };
  return {
    identity,
    record,
    command,
    write,
    commit,
    policy,
    pipeline,
    files,
    revision: () => readRepositoryAnalysis(identity).revision.fingerprint,
    executed: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
    changeTest() {
      write('tests/a.test.cjs', files['tests/a.test.cjs'] + '// test-only change\n');
      commit();
    },
    dispose() {
      assert.equal(resolve(directory, '..'), resolve(tmpdir()));
      assert.match(directory, /[\\/]ticketing-validation-selection-[^\\/]+$/);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('runs only mapped standalone tests, mandatory checks and prerequisite closure with exact identities', async () => {
  const f = fixture();
  try {
    f.changeTest();
    const pipeline = f.pipeline();
    const revision = f.revision();
    const { selection, report } = await runSelectedValidation(f.identity, pipeline, {
      policy: f.policy,
      expected_revision: revision,
    });
    assert.equal(selection.scope, 'narrow_local');
    assert.equal(selection.reason, 'mapped_standalone_tests');
    assert.deepEqual(selection.selected_step_ids, ['prepare', 'test-a', 'mandatory']);
    assert.deepEqual(selection.omitted_step_ids, ['test-b']);
    assert.equal(selection.analysis_revision?.fingerprint, revision);
    assert.equal(selection.pipeline_fingerprint, pipeline.fingerprint);
    assert.equal(selection.source.commit, f.command('rev-parse', 'HEAD'));
    assert.match(selection.policy_sha256!, /^[a-f0-9]{64}$/);
    assert.match(selection.fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(report.recipe_fingerprint, pipeline.fingerprint);
    assert.equal(report.status, 'passed');
    assert.deepEqual(f.executed(), ['prepare', 'test-a', 'mandatory']);
    assert.deepEqual(
      report.steps.map(({ id }) => id),
      selection.selected_step_ids,
    );
    assert.equal(pipeline.steps.length, 4);
    assert.equal(readRepositoryAnalysis(f.identity).analysis_complete, false);
  } finally {
    f.dispose();
  }
});

it('falls back to every configured step and preserves failures when mapping is missing', async () => {
  const f = fixture({ failure: 'test-b' });
  try {
    f.changeTest();
    const policy = {
      ...f.policy,
      standalone_tests: f.policy.standalone_tests.filter(({ path }) => path !== 'tests/a.test.cjs'),
    };
    const pipeline = f.pipeline();
    const { selection, report } = await runSelectedValidation(f.identity, pipeline, {
      policy,
      expected_revision: f.revision(),
    });
    assert.equal(selection.scope, 'full_local');
    assert.equal(selection.reason, 'mapping_missing');
    assert.equal(report.recipe_fingerprint, pipeline.fingerprint);
    assert.equal(report.status, 'failed');
    assert.equal(report.steps.find(({ id }) => id === 'test-b')?.status, 'failed');
    assert.equal(report.steps.length, 4);
    assert.ok(f.executed().includes('test-b'));
  } finally {
    f.dispose();
  }
});

it('keeps opt-in, exact revision and unambiguous registered mappings mandatory', () => {
  const f = fixture();
  try {
    f.changeTest();
    const pipeline = f.pipeline();
    const revision = f.revision();
    for (const [input, reason] of [
      [{}, 'opt_in_missing'],
      [{ policy: f.policy }, 'revision_missing'],
      [{ policy: f.policy, expected_revision: '0'.repeat(64) }, 'revision_changed'],
      [
        {
          policy: {
            ...f.policy,
            standalone_tests: [f.policy.standalone_tests[0]!, f.policy.standalone_tests[0]!],
          },
          expected_revision: revision,
        },
        'ambiguous_mapping',
      ],
      [
        { policy: { ...f.policy, mandatory_step_ids: ['not-registered'] }, expected_revision: revision },
        'ambiguous_mapping',
      ],
      [
        {
          policy: { ...f.policy, standalone_tests: [{ path: '../tests/a.test.cjs', step_ids: ['test-a'] }] },
          expected_revision: revision,
        },
        'ambiguous_mapping',
      ],
      [
        {
          policy: { ...f.policy, standalone_tests: [{ path: 'tests/a.test.cjs', step_ids: [] }] },
          expected_revision: revision,
        },
        'invalid_policy',
      ],
    ] satisfies [ValidationSelectionInput, string][]) {
      const selection = selectValidationChecks(f.identity, pipeline, input);
      assert.equal(selection.scope, 'full_local');
      assert.equal(selection.reason, reason);
      assert.equal(selection.selected_step_ids.length, 4);
    }
  } finally {
    f.dispose();
  }
});

it('runs full validation for production, configuration, dependencies, migrations, additions, deletions and shared helpers', () => {
  const f = fixture();
  try {
    const paths = ['source.cjs', 'config.json', 'package.json', 'migrations/001.sql', 'tests/shared.cjs'];
    for (const path of paths) {
      f.write(path, f.files[path as keyof typeof f.files] + '\n');
      f.commit();
      const selection = selectValidationChecks(f.identity, f.pipeline(), {
        policy: f.policy,
        expected_revision: f.revision(),
      });
      assert.equal(selection.scope, 'full_local', path);
      assert.equal(selection.reason, 'unsupported_change', path);
      f.write(path, f.files[path as keyof typeof f.files]);
      f.commit();
    }
    f.write('tests/new.test.cjs', 'throw Error("new test");\n');
    f.commit();
    const addedPolicy = {
      ...f.policy,
      standalone_tests: [...f.policy.standalone_tests, { path: 'tests/new.test.cjs', step_ids: ['test-a'] }],
    };
    assert.equal(
      selectValidationChecks(f.identity, f.pipeline(), {
        policy: addedPolicy,
        expected_revision: f.revision(),
      }).reason,
      'unsupported_change',
    );
    f.command('rm', 'tests/new.test.cjs');
    f.commit();
    f.command('rm', 'tests/a.test.cjs');
    f.commit();
    assert.equal(
      selectValidationChecks(f.identity, f.pipeline(), { policy: f.policy, expected_revision: f.revision() })
        .reason,
      'unsupported_change',
    );
  } finally {
    f.dispose();
  }
});

it('falls back for untracked or ignored inputs and refuses stale pinned source before executing', async () => {
  const f = fixture();
  try {
    f.changeTest();
    const pipeline = f.pipeline();
    const input = { policy: f.policy, expected_revision: f.revision() };
    f.write('ignored.txt', 'unknown input');
    assert.equal(selectValidationChecks(f.identity, pipeline, input).reason, 'untracked_files');
    f.write('untracked.cjs', 'unknown input');
    const selection = selectValidationChecks(f.identity, pipeline, input);
    assert.equal(selection.scope, 'full_local');
    assert.equal(selection.untracked?.count, 2);
    f.write('tests/a.test.cjs', 'throw Error("changed after pinning");\n');
    const result = await runSelectedValidation(f.identity, pipeline, input);
    assert.equal(result.selection.scope, 'full_local');
    assert.equal(result.selection.reason, 'source_changed');
    assert.equal(result.report.status, 'failed');
    assert.deepEqual(f.executed(), []);
  } finally {
    f.dispose();
  }
});

it('never conceals selected test, mandatory check or prerequisite failures', async () => {
  for (const failure of ['prepare', 'test-a', 'mandatory']) {
    const f = fixture({ failure });
    try {
      f.changeTest();
      const { selection, report } = await runSelectedValidation(f.identity, f.pipeline(), {
        policy: f.policy,
        expected_revision: f.revision(),
      });
      assert.equal(selection.scope, 'narrow_local');
      assert.equal(report.status, 'failed');
      assert.equal(report.steps.find(({ id }) => id === failure)?.status, 'failed');
      if (failure === 'prepare')
        assert.equal(report.steps.find(({ id }) => id === 'test-a')?.status, 'skipped');
    } finally {
      f.dispose();
    }
  }
});

it('fails narrowed evidence when checks mutate tracked source and refuses another worktree identity', async () => {
  const f = fixture({ mutate: true });
  try {
    f.changeTest();
    const pipeline = f.pipeline();
    const { report } = await runSelectedValidation(f.identity, pipeline, {
      policy: f.policy,
      expected_revision: f.revision(),
    });
    assert.equal(report.status, 'failed');
    const other = { ...f.identity, attemptId: 'different-worktree' };
    createWorktree(other);
    assert.throws(
      () => selectValidationChecks(other, pipeline, { policy: f.policy }),
      /verified owned worktree/,
    );
  } finally {
    f.dispose();
  }
});
