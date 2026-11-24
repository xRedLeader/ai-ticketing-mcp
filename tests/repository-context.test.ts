import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import {
  readRepositoryAnalysis,
  readRepositoryContext,
  readRepositoryFile,
} from '../examples/repository-context.js';
import { createWorktree } from '../examples/worktree-isolation.js';
import { countReferenceTokens } from '../src/tokens.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-repository-context-'));
  const repository = join(directory, 'repository');
  const workspaceRoot = join(directory, 'owned');
  mkdirSync(repository);
  mkdirSync(workspaceRoot);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
      ),
    }).trim();
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Context Test');
  git(repository, 'config', 'user.email', 'context@example.test');
  git(repository, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(repository, 'src'));
  mkdirSync(join(repository, 'tests'));
  writeFileSync(
    join(repository, 'src/math.ts'),
    'export function twice(value: number) { return value * 2; }\n',
  );
  writeFileSync(
    join(repository, 'src/use.ts'),
    "import { twice } from './math.js';\nexport const result = twice(3);\n",
  );
  writeFileSync(
    join(repository, 'tests/math.test.ts'),
    "import { twice } from '../src/math.js';\ntwice(2);\n",
  );
  writeFileSync(join(repository, 'notes.txt'), 'plain text\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'test: context fixture');
  const identity = {
    repository,
    workspaceRoot,
    runId: 'run',
    attemptId: 'attempt',
    baseCommit: git(repository, 'rev-parse', 'HEAD'),
  };
  const record = createWorktree(identity);
  return {
    identity,
    record,
    git: (...args: string[]) => git(record.worktreePath, ...args),
    write: (path: string, text: string) => writeFileSync(join(record.worktreePath, path), text),
    dispose() {
      // Only the exact temporary fixture root may be recursively removed.
      assert.equal(resolve(directory, '..'), resolve(tmpdir()));
      assert.match(directory, /[\\/]ticketing-repository-context-[^\\/]+$/);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('binds changed files, declarations, direct callers and tests to actual registered worktree bytes', () => {
  const f = fixture();
  try {
    const clean = readRepositoryAnalysis(f.identity);
    assert.deepEqual(clean.changed_files, []);
    f.write('src/math.ts', 'export function twice(value: number) { return value + value; }\n');
    const analysis = readRepositoryAnalysis(f.identity);
    assert.equal(analysis.revision.base_commit, f.identity.baseCommit);
    assert.equal(analysis.revision.head_commit, f.git('rev-parse', 'HEAD'));
    assert.notEqual(analysis.revision.fingerprint, clean.revision.fingerprint);
    assert.equal(analysis.analysis_complete, false);
    assert.equal(analysis.changed_paths_complete, true);
    assert.equal(analysis.analysis_mode, 'text_candidates');
    assert.deepEqual(analysis.changed_files, [
      {
        path: 'src/math.ts',
        change: 'modified',
        sha256: createHash('sha256')
          .update(readFileSync(join(f.record.worktreePath, 'src/math.ts')))
          .digest('hex'),
      },
    ]);
    assert.deepEqual(analysis.symbols, [{ path: 'src/math.ts', line: 1, name: 'twice' }]);
    assert.ok(
      analysis.callers.some(
        ({ path, line, name }) => path === 'src/use.ts' && line === 2 && name === 'twice',
      ),
    );
    assert.deepEqual(analysis.tests, [{ path: 'tests/math.test.ts', line: 2, name: 'twice' }]);
    assert.equal(
      readFileSync(join(f.identity.repository, 'src/math.ts'), 'utf8'),
      'export function twice(value: number) { return value * 2; }\n',
    );
    f.git('add', 'src/math.ts');
    f.git('commit', '-m', 'test: advance worktree');
    const committed = readRepositoryAnalysis(f.identity);
    assert.notEqual(committed.revision.head_commit, clean.revision.head_commit);
    assert.equal(committed.changed_files.length, 1);
  } finally {
    f.dispose();
  }
});

it('detects hidden worktree edits and rejects stale analysis and file retrieval revisions', () => {
  const f = fixture();
  try {
    const before = readRepositoryAnalysis(f.identity);
    f.git('update-index', '--skip-worktree', 'src/math.ts');
    f.write('src/math.ts', 'export function twice(value: number) { return value * 3; }\n');
    assert.equal(f.git('diff', '--name-only'), '');
    const after = readRepositoryAnalysis(f.identity);
    assert.equal(after.changed_files[0]?.path, 'src/math.ts');
    assert.notEqual(after.revision.worktree_sha256, before.revision.worktree_sha256);
    assert.throws(
      () => readRepositoryContext(f.identity, { expected_revision: before.revision.fingerprint }),
      /stale/,
    );
    assert.throws(
      () => readRepositoryFile(f.identity, { revision: before.revision.fingerprint, path: 'src/math.ts' }),
      /stale/,
    );
    assert.equal(
      readRepositoryFile(f.identity, { revision: after.revision.fingerprint, path: 'src/math.ts' }).sha256,
      after.changed_files[0]?.sha256,
    );
  } finally {
    f.dispose();
  }
});

it('uses explicit text fallback for unsupported languages, invalid syntax and deleted source', () => {
  const f = fixture();
  try {
    f.write('other.py', 'def twice(value):\n    return value * 2\n');
    f.git('add', 'other.py');
    f.write('src/math.ts', 'export function twice( {');
    f.git('rm', 'notes.txt');
    const analysis = readRepositoryAnalysis(f.identity);
    assert.equal(analysis.analysis_complete, false);
    assert.ok(analysis.limitations.some((text) => text.includes('other.py')));
    assert.ok(analysis.limitations.some((text) => text.includes('Structural analysis is unavailable')));
    assert.ok(
      analysis.changed_files.some(({ path, change }) => path === 'notes.txt' && change === 'deleted'),
    );
    const page = readRepositoryFile(f.identity, {
      revision: analysis.revision.fingerprint,
      path: 'other.py',
    });
    assert.equal(page.text, 'def twice(value):\n    return value * 2\n');
    assert.equal(page.complete, true);
  } finally {
    f.dispose();
  }
});

it('budgets complete packets and paginated text while retaining revision and retrieval instructions', () => {
  const f = fixture();
  try {
    f.write(
      'src/math.ts',
      Array.from(
        { length: 100 },
        (_, index) => `export function changed${index}(value: number) { return value + ${index}; }`,
      ).join('\n'),
    );
    const full = readRepositoryAnalysis(f.identity);
    const packet = readRepositoryContext(f.identity, { max_tokens: 750 });
    assert.ok(countReferenceTokens(JSON.stringify(packet)) <= 750);
    assert.equal(packet.complete, false);
    assert.ok(packet.omitted.symbols > 0);
    assert.equal(packet.revision.fingerprint, full.revision.fingerprint);
    assert.equal(packet.retrieval.file.operation, 'readRepositoryFile');
    assert.equal(packet.retrieval.analysis.operation, 'readRepositoryAnalysis');
    assert.deepEqual(
      readRepositoryAnalysis(f.identity, packet.retrieval.analysis.arguments).changed_files,
      full.changed_files,
    );
    assert.equal(full.symbols.length, 100);
    let next: number | null = 1;
    let total = 0;
    while (next !== null) {
      const page = readRepositoryFile(f.identity, {
        revision: full.revision.fingerprint,
        path: 'src/math.ts',
        start_line: next,
        max_tokens: 650,
      });
      assert.ok(countReferenceTokens(JSON.stringify(page)) <= 650);
      assert.ok(page.next_line === null || page.next_line > next);
      total += page.text.split('\n').length;
      next = page.next_line;
    }
    assert.equal(total, 100);
    assert.throws(() => readRepositoryContext(f.identity, { max_tokens: 1 }), /max_tokens/);
  } finally {
    f.dispose();
  }
});

it('refuses arbitrary, untracked, metadata and binary file text paths', () => {
  const f = fixture();
  try {
    f.write('untracked.txt', 'must not be returned');
    f.write('binary.bin', 'a\0b');
    f.git('add', 'binary.bin');
    const { revision } = readRepositoryAnalysis(f.identity);
    for (const path of [
      '../notes.txt',
      '.git/config',
      'src/../../notes.txt',
      'src\\math.ts',
      f.identity.repository,
      'untracked.txt',
    ])
      assert.throws(
        () => readRepositoryFile(f.identity, { revision: revision.fingerprint, path }),
        /tracked|relative/,
      );
    assert.throws(
      () => readRepositoryFile(f.identity, { revision: revision.fingerprint, path: 'binary.bin' }),
      /Binary/,
    );
    f.git('branch', '-m', 'swapped-branch');
    assert.throws(() => readRepositoryAnalysis(f.identity), /registration|branch changed/);
  } finally {
    f.dispose();
  }
});

it('rejects parent junctions and tracked link modes without following them', () => {
  const f = fixture();
  try {
    const oldSource = join(f.record.worktreePath, 'old-source');
    renameSync(join(f.record.worktreePath, 'src'), oldSource);
    symlinkSync(
      oldSource,
      join(f.record.worktreePath, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(() => readRepositoryAnalysis(f.identity), /symlinks\/junctions/);
    unlinkSync(join(f.record.worktreePath, 'src'));
    renameSync(oldSource, join(f.record.worktreePath, 'src'));
    const object = f.git('rev-parse', 'HEAD:src/math.ts');
    f.git('update-index', '--cacheinfo', `120000,${object},src/math.ts`);
    assert.throws(() => readRepositoryAnalysis(f.identity), /symlinks and submodules/);
  } finally {
    f.dispose();
  }
});

it('retains a concrete revision-bound follow-up when changed filenames exceed the response budget', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 25; index++) f.write(`long-tracked-change-${index}.txt`, `change ${index}`);
    f.git('add', '.');
    const packet = readRepositoryContext(f.identity, { max_tokens: 750 });
    assert.ok(packet.omitted.changed_files > 0);
    assert.equal(packet.changed_paths_complete, false);
    assert.ok(countReferenceTokens(JSON.stringify(packet)) <= 750);
    const full = readRepositoryAnalysis(f.identity, packet.retrieval.analysis.arguments);
    assert.equal(full.changed_files.length, 25);
    assert.equal(full.changed_paths_complete, true);
    const path = full.changed_files.at(-1)!.path;
    assert.ok(readRepositoryFile(f.identity, { revision: packet.revision.fingerprint, path }).complete);
    f.write(path, 'changed after retrieval');
    assert.throws(() => readRepositoryAnalysis(f.identity, packet.retrieval.analysis.arguments), /stale/);
  } finally {
    f.dispose();
  }
});

it('binds identical source revisions to their owning worktree identity', () => {
  const f = fixture();
  try {
    const other = { ...f.identity, attemptId: 'another-attempt' };
    createWorktree(other);
    const left = readRepositoryAnalysis(f.identity).revision;
    const right = readRepositoryAnalysis(other).revision;
    assert.equal(left.worktree_sha256, right.worktree_sha256);
    assert.notEqual(left.worktree_identity_sha256, right.worktree_identity_sha256);
    assert.notEqual(left.fingerprint, right.fingerprint);
    assert.throws(
      () => readRepositoryFile(other, { revision: left.fingerprint, path: 'notes.txt' }),
      /stale/,
    );
  } finally {
    f.dispose();
  }
});

it(
  'includes actual POSIX executable-mode changes in source identity',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const before = readRepositoryAnalysis(f.identity);
      chmodSync(join(f.record.worktreePath, 'src/math.ts'), 0o755);
      const after = readRepositoryAnalysis(f.identity);
      assert.notEqual(before.revision.worktree_sha256, after.revision.worktree_sha256);
      assert.equal(after.changed_files[0]?.path, 'src/math.ts');
    } finally {
      f.dispose();
    }
  },
);
