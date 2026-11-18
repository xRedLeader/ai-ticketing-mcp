import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import {
  cleanupWorktree,
  createWorktree,
  useWorktree,
  verifyWorktree,
  type WorktreeIdentity,
} from '../examples/worktree-isolation.js';

const git = (repository: string, ...args: string[]) =>
  execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
    ),
  }).trim();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-worktree-'));
  const repository = join(directory, 'repository');
  const workspaceRoot = join(directory, 'owned');
  mkdirSync(repository);
  mkdirSync(workspaceRoot);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Workspace Test');
  git(repository, 'config', 'user.email', 'workspace@example.test');
  writeFileSync(join(repository, 'same.txt'), 'starting file\n');
  writeFileSync(join(repository, '.gitignore'), 'ignored.txt\n');
  mkdirSync(join(repository, 'tracked'));
  writeFileSync(join(repository, 'tracked', 'same.txt'), 'tracked directory file\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'test: fixture');
  const identity: WorktreeIdentity = {
    repository,
    workspaceRoot,
    runId: 'run-1',
    attemptId: 'attempt-1',
    baseCommit: git(repository, 'rev-parse', 'HEAD'),
  };
  return {
    directory,
    identity,
    dispose() {
      // Only the exact directory allocated above may be recursively removed by this test fixture.
      assert.equal(resolve(directory), directory);
      assert.equal(resolve(directory, '..'), resolve(tmpdir()));
      assert.match(directory, /[\\/]ticketing-worktree-[^\\/]+$/);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('isolates concurrent same-file edits and preserves the user worktree', async () => {
  const { identity, dispose } = fixture();
  try {
    writeFileSync(join(identity.repository, 'same.txt'), 'uncommitted user work\n');
    writeFileSync(join(identity.repository, 'user-only.txt'), 'user artifact\n');
    const other = { ...identity, attemptId: 'attempt-2' };
    const first = createWorktree(identity);
    const second = createWorktree(other);
    await Promise.all(
      [identity, other].map(async (owner, index) =>
        useWorktree(owner, async ({ worktreePath }) => {
          await new Promise((done) => setImmediate(done));
          writeFileSync(join(worktreePath, 'same.txt'), `worker ${index}\n`);
        }),
      ),
    );
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branch, second.branch);
    assert.equal(readFileSync(join(first.worktreePath, 'same.txt'), 'utf8'), 'worker 0\n');
    assert.equal(readFileSync(join(second.worktreePath, 'same.txt'), 'utf8'), 'worker 1\n');
    assert.equal(readFileSync(join(identity.repository, 'same.txt'), 'utf8'), 'uncommitted user work\n');
    assert.equal(readFileSync(join(identity.repository, 'user-only.txt'), 'utf8'), 'user artifact\n');
    assert.throws(() => cleanupWorktree(identity), /modified, untracked, or ignored/);
  } finally {
    dispose();
  }
});

it('recovers a committed attempt and retains records, branches, and evidence after cleanup', () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    writeFileSync(join(record.worktreePath, 'same.txt'), 'committed implementation\n');
    git(record.worktreePath, 'commit', '-am', 'test: implementation');
    writeFileSync(join(record.artifactPath, 'evidence.txt'), 'passing local checks\n');
    assert.deepEqual(
      useWorktree(identity, (recovered) => recovered),
      record,
    );
    const implementation = git(record.worktreePath, 'rev-parse', 'HEAD');
    assert.notEqual(implementation, identity.baseCommit);
    cleanupWorktree(identity);
    assert.equal(existsSync(record.worktreePath), false);
    assert.equal(readFileSync(join(record.artifactPath, 'evidence.txt'), 'utf8'), 'passing local checks\n');
    assert.equal(readdirSync(join(identity.workspaceRoot, 'records')).length, 1);
    assert.equal(git(identity.repository, 'rev-parse', record.branch), implementation);
    assert.throws(
      () => useWorktree(identity, () => assert.fail('must fail before execution')),
      /Missing owned path/,
    );
  } finally {
    dispose();
  }
});

it('fails before execution/publication for corrupt or mismatched ownership records', () => {
  const { identity, dispose } = fixture();
  try {
    createWorktree(identity);
    const path = join(
      identity.workspaceRoot,
      'records',
      readdirSync(join(identity.workspaceRoot, 'records'))[0]!,
    );
    const original = readFileSync(path, 'utf8');
    for (const key of [
      'repository',
      'workspaceRoot',
      'runId',
      'attemptId',
      'baseCommit',
      'branch',
      'worktreePath',
    ]) {
      const changed = JSON.parse(original);
      changed[key] = 'mismatched';
      writeFileSync(path, JSON.stringify(changed));
      assert.throws(
        () => useWorktree(identity, () => assert.fail('publication must not start')),
        /does not match/,
      );
      assert.throws(() => cleanupWorktree(identity), /does not match/);
    }
    writeFileSync(path, '{broken');
    assert.throws(() => verifyWorktree(identity), /Cannot read ownership record/);
    writeFileSync(path, original);
    assert.throws(() => verifyWorktree({ ...identity, runId: 'another-run' }), /Missing owned path/);
    assert.throws(() => verifyWorktree({ ...identity, attemptId: 'another-attempt' }), /Missing owned path/);
    assert.throws(() => createWorktree(identity), /already exists/);
  } finally {
    dispose();
  }
});

it('rejects missing registrations, switched branches, and histories without the starting commit', () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    git(record.worktreePath, 'switch', '-c', 'unexpected');
    assert.throws(() => verifyWorktree(identity), /registration/);
    git(record.worktreePath, 'switch', record.branch);
    git(record.worktreePath, 'checkout', '--orphan', 'unrelated');
    git(record.worktreePath, 'commit', '-m', 'test: unrelated history');
    const unrelated = git(record.worktreePath, 'rev-parse', 'HEAD');
    git(record.worktreePath, 'switch', record.branch);
    git(record.worktreePath, 'reset', '--hard', unrelated);
    assert.throws(
      () => useWorktree(identity, () => assert.fail('execution must not start')),
      /Git merge-base failed/,
    );
    git(record.worktreePath, 'reset', '--hard', identity.baseCommit);
    git(identity.repository, 'worktree', 'remove', record.worktreePath);
    mkdirSync(record.worktreePath);
    assert.throws(() => verifyWorktree(identity), /Missing owned path|registration/);
  } finally {
    dispose();
  }
});

it('refuses cleanup of untracked, ignored, staged, and nested repository files', () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    for (const name of ['untracked.txt', 'ignored.txt']) {
      writeFileSync(join(record.worktreePath, name), 'retain\n');
      assert.throws(() => cleanupWorktree(identity), /modified, untracked, or ignored/);
      assert.equal(readFileSync(join(record.worktreePath, name), 'utf8'), 'retain\n');
      rmSync(join(record.worktreePath, name));
    }
    writeFileSync(join(record.worktreePath, 'same.txt'), 'staged\n');
    git(record.worktreePath, 'add', '.');
    assert.throws(() => cleanupWorktree(identity), /modified, untracked, or ignored/);
    git(record.worktreePath, 'reset', '--hard', identity.baseCommit);
    const nested = join(record.worktreePath, 'nested');
    mkdirSync(nested);
    git(nested, 'init');
    writeFileSync(join(nested, 'keep.txt'), 'nested repository work\n');
    assert.throws(() => cleanupWorktree(identity), /modified, untracked, or ignored/);
    assert.equal(existsSync(join(nested, 'keep.txt')), true);
  } finally {
    dispose();
  }
});

it('rejects junction/path swaps and leaves paths outside the workspace untouched', () => {
  const { directory, identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    const moved = `${record.worktreePath}-retained`;
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside work\n');
    renameSync(record.worktreePath, moved);
    symlinkSync(outside, record.worktreePath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => useWorktree(identity, () => assert.fail('must reject escape')), /Symlink\/junction/);
    assert.throws(() => cleanupWorktree(identity), /Symlink\/junction/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside work\n');
    rmSync(record.worktreePath);
    renameSync(moved, record.worktreePath);
    const alias = join(directory, 'alias');
    symlinkSync(identity.workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createWorktree({ ...identity, workspaceRoot: alias }), /Symlink\/junction/);
    rmSync(alias);
    const records = join(identity.workspaceRoot, 'records');
    renameSync(records, `${records}-retained`);
    symlinkSync(outside, records, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupWorktree(identity), /Symlink\/junction/);
    rmSync(records);
  } finally {
    dispose();
  }
});

it('retains files hidden by assume-unchanged and skip-worktree flags', () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git(record.worktreePath, 'update-index', `--${flag}`, 'same.txt');
      writeFileSync(join(record.worktreePath, 'same.txt'), 'hidden useful work\n');
      assert.equal(git(record.worktreePath, 'status', '--porcelain'), '');
      assert.throws(() => cleanupWorktree(identity), /Index flags can hide changes/);
      assert.equal(readFileSync(join(record.worktreePath, 'same.txt'), 'utf8'), 'hidden useful work\n');
      git(record.worktreePath, 'update-index', `--no-${flag}`, 'same.txt');
      git(record.worktreePath, 'reset', '--hard', identity.baseCommit);
    }
  } finally {
    dispose();
  }
});

it('retains nested Git history inside an otherwise clean tracked directory', () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    const nested = join(record.worktreePath, 'tracked');
    git(nested, 'init');
    git(nested, 'config', 'user.name', 'Nested Test');
    git(nested, 'config', 'user.email', 'nested@example.test');
    git(nested, 'add', 'same.txt');
    git(nested, 'commit', '-m', 'test: retained nested history');
    const nestedCommit = git(nested, 'rev-parse', 'HEAD');
    assert.equal(git(record.worktreePath, 'status', '--porcelain', '--untracked-files=all', '--ignored'), '');
    assert.throws(() => cleanupWorktree(identity), /Nested repository metadata/);
    assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedCommit);
  } finally {
    dispose();
  }
});

it('never follows a junction replacing a tracked directory during cleanup', () => {
  const { directory, identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    const tracked = join(record.worktreePath, 'tracked');
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'same.txt'), 'tracked directory file\n');
    renameSync(tracked, `${tracked}-retained`);
    symlinkSync(outside, tracked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupWorktree(identity), /Symlink\/junction|modified, untracked, or ignored/);
    assert.equal(readFileSync(join(outside, 'same.txt'), 'utf8'), 'tracked directory file\n');
    rmSync(tracked);
  } finally {
    dispose();
  }
});

it('retains ownership and user data if native Git cannot create the branch', () => {
  const { identity, dispose } = fixture();
  try {
    const id = createHash('sha256')
      .update(JSON.stringify([resolve(identity.workspaceRoot), identity.runId, identity.attemptId]))
      .digest('hex');
    git(identity.repository, 'branch', `codex/work-${id}`);
    writeFileSync(join(identity.repository, 'same.txt'), 'user work survives setup failure\n');
    assert.throws(() => createWorktree(identity), /Git worktree failed/);
    assert.equal(existsSync(join(identity.workspaceRoot, 'records', `${id}.json`)), true);
    assert.equal(
      readFileSync(join(identity.repository, 'same.txt'), 'utf8'),
      'user work survives setup failure\n',
    );
    assert.equal(git(identity.repository, 'rev-parse', `codex/work-${id}`), identity.baseCommit);
    assert.throws(
      () => useWorktree(identity, () => assert.fail('partial setup must not execute')),
      /Missing owned path/,
    );
  } finally {
    dispose();
  }
});

it('refuses a substituted repository and rejects unsafe creation inputs', () => {
  const { identity, dispose } = fixture();
  const other = fixture();
  try {
    createWorktree(identity);
    assert.throws(
      () => verifyWorktree({ ...identity, repository: other.identity.repository }),
      /Git rev-parse failed|does not match/,
    );
    assert.throws(() => createWorktree({ ...identity, baseCommit: '--help' }), /full resolved commit SHA/);
    assert.throws(
      () => createWorktree({ ...identity, workspaceRoot: identity.repository }),
      /separate owned directory/,
    );
    assert.throws(
      () => createWorktree({ ...identity, workspaceRoot: join(identity.repository, '.git') }),
      /outside Git metadata/,
    );
    assert.throws(() => createWorktree({ ...identity, repository: '.' }), /absolute path/);
    assert.throws(() => createWorktree({ ...identity, attemptId: '' }), /unique attemptId/);
  } finally {
    dispose();
    other.dispose();
  }
});

it('binds Windows path casing variants to the same attempt', { skip: process.platform !== 'win32' }, () => {
  const { identity, dispose } = fixture();
  try {
    const record = createWorktree(identity);
    const alternateCase = {
      ...identity,
      repository: identity.repository.toUpperCase(),
      workspaceRoot: identity.workspaceRoot.toUpperCase(),
    };
    assert.deepEqual(verifyWorktree(alternateCase), record);
    assert.throws(() => createWorktree(alternateCase), /already exists/);
    assert.equal(readdirSync(join(identity.workspaceRoot, 'records')).length, 1);
    cleanupWorktree(alternateCase);
  } finally {
    dispose();
  }
});
