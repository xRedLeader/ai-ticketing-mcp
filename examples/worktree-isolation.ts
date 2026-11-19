import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface WorktreeIdentity {
  repository: string;
  workspaceRoot: string;
  runId: string;
  attemptId: string;
  baseCommit: string;
}

export interface WorktreeRecord extends WorktreeIdentity {
  version: 1;
  commonDirectory: string;
  worktreePath: string;
  artifactPath: string;
  branch: string;
}

const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const samePath = (left: string, right: string) => pathKey(left) === pathKey(right);
const inside = (parent: string, child: string) => {
  const path = relative(pathKey(parent), pathKey(child));
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function plainPath(path: string, required = true): string {
  if (!isAbsolute(path)) throw new Error(`Use an absolute path: ${path}`);
  const absolute = resolve(path);
  let current = absolute;
  let missing = false;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink/junction is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (current === absolute) missing = true;
    }
    const parent = dirname(current);
    if (current === parent) break;
    current = parent;
  }
  if (required && missing) throw new Error(`Missing owned path: ${absolute}`);
  if (!existsSync(absolute)) return absolute;
  const canonical = realpathSync.native(absolute);
  if (!samePath(canonical, absolute))
    throw new Error(`Path changed or escapes its canonical location: ${absolute}`);
  return canonical;
}

function git(repository: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Do not inherit a caller's alternate repository, index, or worktree.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
      ),
    }).trimEnd();
  } catch (error) {
    throw new Error(`Git ${args[0]} failed in ${repository}; retain the workspace and inspect it.`, {
      cause: error,
    });
  }
}

function expected(identity: WorktreeIdentity) {
  if (!identity.runId?.trim() || !identity.attemptId?.trim())
    throw new Error('An owning runId and unique attemptId are required.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity.baseCommit))
    throw new Error('baseCommit must be the full resolved commit SHA, not a moving revision.');
  const repository = plainPath(identity.repository);
  const workspaceRoot = plainPath(identity.workspaceRoot);
  if (!lstatSync(workspaceRoot).isDirectory())
    throw new Error('workspaceRoot must be an existing directory.');
  if (!samePath(plainPath(git(repository, 'rev-parse', '--show-toplevel')), repository))
    throw new Error('repository must name its Git worktree root.');
  const commonDirectory = plainPath(
    git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
  if (
    samePath(workspaceRoot, dirname(workspaceRoot)) ||
    samePath(workspaceRoot, repository) ||
    inside(workspaceRoot, repository) ||
    samePath(workspaceRoot, commonDirectory) ||
    inside(workspaceRoot, commonDirectory) ||
    inside(commonDirectory, workspaceRoot)
  )
    throw new Error('workspaceRoot must be a separate owned directory, outside Git metadata.');
  if (
    git(repository, 'rev-parse', '--verify', '--end-of-options', `${identity.baseCommit}^{commit}`) !==
    identity.baseCommit
  )
    throw new Error('The starting commit is missing from the expected repository.');
  const id = createHash('sha256')
    .update(JSON.stringify([workspaceRoot, identity.runId, identity.attemptId]))
    .digest('hex');
  const record: WorktreeRecord = {
    version: 1,
    repository,
    workspaceRoot,
    commonDirectory,
    runId: identity.runId,
    attemptId: identity.attemptId,
    baseCommit: identity.baseCommit,
    worktreePath: join(workspaceRoot, 'worktrees', id),
    artifactPath: join(workspaceRoot, 'artifacts', id),
    branch: `codex/work-${id}`,
  };
  return { record, recordPath: join(workspaceRoot, 'records', `${id}.json`) };
}

export function createWorktree(identity: WorktreeIdentity): WorktreeRecord {
  const { record, recordPath } = expected(identity);
  for (const path of [dirname(recordPath), dirname(record.worktreePath), record.artifactPath]) {
    plainPath(path, false);
    mkdirSync(path, { recursive: true });
    plainPath(path);
  }
  plainPath(recordPath, false);
  plainPath(record.worktreePath, false);
  if (existsSync(record.worktreePath))
    throw new Error(`Workspace already exists; inspect it: ${record.worktreePath}`);
  // Reserve ownership before Git runs; failures retain a recovery record and never delete an existing path.
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  git(
    record.repository,
    'worktree',
    'add',
    '-b',
    record.branch,
    '--',
    record.worktreePath,
    record.baseCommit,
  );
  return verifyWorktree(identity);
}

export function verifyWorktree(identity: WorktreeIdentity): WorktreeRecord {
  const { record, recordPath } = expected(identity);
  plainPath(recordPath);
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ownership record; retain it and recover manually: ${recordPath}`, {
      cause: error,
    });
  }
  if (
    typeof stored !== 'object' ||
    stored === null ||
    Object.keys(stored).length !== Object.keys(record).length ||
    Object.entries(record).some(([key, value]) => (stored as Record<string, unknown>)[key] !== value)
  )
    throw new Error(`Ownership record does not match repository/base/run/attempt; inspect: ${recordPath}`);
  plainPath(record.worktreePath);
  plainPath(record.artifactPath);
  plainPath(join(record.worktreePath, '.git'));
  const registrations = git(record.repository, 'worktree', 'list', '--porcelain', '-z').split('\0\0');
  if (
    !registrations.some((entry) => {
      const fields = entry.split('\0');
      return (
        fields.includes(`worktree ${record.worktreePath.replaceAll('\\', '/')}`) &&
        fields.includes(`branch refs/heads/${record.branch}`)
      );
    })
  )
    throw new Error(`Missing or mismatched Git worktree registration: ${record.worktreePath}`);
  if (
    !samePath(plainPath(git(record.worktreePath, 'rev-parse', '--show-toplevel')), record.worktreePath) ||
    !samePath(
      plainPath(git(record.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
      record.commonDirectory,
    ) ||
    git(record.worktreePath, 'symbolic-ref', '--quiet', 'HEAD') !== `refs/heads/${record.branch}`
  )
    throw new Error(`The worktree repository or branch changed; retain and inspect: ${record.worktreePath}`);
  const gitDirectory = plainPath(git(record.worktreePath, 'rev-parse', '--absolute-git-dir'));
  if (!inside(join(record.commonDirectory, 'worktrees'), gitDirectory))
    throw new Error('The workspace is not a linked worktree of the expected repository.');
  git(record.worktreePath, 'merge-base', '--is-ancestor', record.baseCommit, 'HEAD');
  return record;
}

// Call for both implementation and publication so stale records fail before either callback starts.
export function useWorktree<T>(identity: WorktreeIdentity, operation: (record: WorktreeRecord) => T): T {
  return operation(verifyWorktree(identity));
}

export function cleanupWorktree(identity: WorktreeIdentity): WorktreeRecord {
  const record = verifyWorktree(identity);
  if (
    git(record.worktreePath, 'ls-files', '-v', '-z')
      .split('\0')
      .some((entry) => /^[a-zS] /.test(entry))
  )
    throw new Error(
      `Index flags can hide changes; clear assume-unchanged/skip-worktree before cleanup: ${record.worktreePath}`,
    );
  if (
    git(
      record.worktreePath,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored',
    )
  )
    throw new Error(
      `Workspace has modified, untracked, or ignored files; retain and inspect: ${record.worktreePath}`,
    );
  const directories = [record.worktreePath];
  let entries = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100_000)
        throw new Error('Cleanup inspection exceeded 100,000 entries; retain and inspect manually.');
      if (directory === record.worktreePath && entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlink/junction inside checkout; retain and inspect: ${path}`);
      if (entry.name.toLowerCase() === '.git')
        throw new Error(`Nested repository metadata; retain and inspect: ${path}`);
      if (entry.isDirectory()) directories.push(path);
    }
  }
  git(record.repository, 'worktree', 'remove', '--', record.worktreePath);
  return record;
}
