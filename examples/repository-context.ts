import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ensure } from '../src/contracts.js';
import { countReferenceTokens } from '../src/tokens.js';
import { verifyWorktree, type WorktreeIdentity } from './worktree-isolation.js';

export interface RepositoryRevision {
  base_commit: string;
  head_commit: string;
  tree: string;
  worktree_identity_sha256: string;
  index_sha256: string;
  worktree_sha256: string;
  fingerprint: string;
}
export interface ChangedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  sha256: string | null;
}
export interface RepositoryReference {
  path: string;
  line: number;
  name: string;
}
export interface RepositoryAnalysis {
  revision: RepositoryRevision;
  changed_files: ChangedFile[];
  symbols: RepositoryReference[];
  callers: RepositoryReference[];
  tests: RepositoryReference[];
  changed_paths_complete: boolean;
  analysis_mode: 'text_candidates';
  analysis_complete: boolean;
  limitations: string[];
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const supported = /\.(?:[cm]?[jt]sx?)$/i;
const testFile = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

function git(repository: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repository, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
      ),
    },
  );
}
function relativePath(path: string) {
  ensure(
    path.length > 0 &&
      !isAbsolute(path) &&
      !/[\\:\x00-\x1f]/.test(path) &&
      path.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase())),
    'UNSAFE_PATH',
    'Repository retrieval requires a plain tracked relative path.',
  );
  return path;
}
function source(identity: WorktreeIdentity) {
  const record = verifyWorktree(identity);
  const head = git(record.worktreePath, 'rev-parse', 'HEAD').trim();
  const tree = git(record.worktreePath, 'rev-parse', 'HEAD^{tree}').trim();
  const index = git(record.worktreePath, 'ls-files', '--stage', '-z');
  const baseline = new Map<string, { mode: string; object: string }>();
  for (const row of git(record.worktreePath, 'ls-tree', '-r', '-z', record.baseCommit).split('\0')) {
    if (!row) continue;
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    ensure(match, 'INVALID_SOURCE', 'Cannot identify baseline tree entries.');
    baseline.set(relativePath(match[3]!), { mode: match[1]!, object: match[2]! });
  }
  const files = new Map<string, Buffer | null>();
  const modes = new Map<string, string>();
  const hashes = new Map<string, string | null>();
  const changed = new Map<string, ChangedFile>();
  let bytesRead = 0;
  const rows = index.split('\0').filter(Boolean);
  ensure(
    rows.length <= 10000 && baseline.size <= 10000,
    'SOURCE_LIMIT',
    'Source exceeds 10,000 tracked files.',
  );
  for (const row of rows.sort()) {
    const match = /^(100644|100755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row);
    ensure(match, 'UNSAFE_SOURCE', 'Unmerged entries, symlinks and submodules are unsupported.');
    const path = relativePath(match[2]!);
    let mode = match[1]!;
    let bytes: Buffer | null = null;
    try {
      let current = record.worktreePath;
      for (const part of path.split('/')) {
        current = join(current, part);
        ensure(
          !lstatSync(current).isSymbolicLink(),
          'UNSAFE_SOURCE',
          'Source symlinks/junctions are unsupported.',
        );
      }
      const absolute = join(record.worktreePath, path);
      const stat = lstatSync(absolute);
      if (process.platform !== 'win32') mode = stat.mode & 0o111 ? '100755' : '100644';
      ensure(
        stat.isFile() &&
          key(realpathSync.native(absolute)) === key(absolute) &&
          !relative(record.worktreePath, absolute).startsWith(`..${sep}`),
        'UNSAFE_SOURCE',
        'Tracked source must remain a plain file in the registered worktree.',
      );
      bytesRead += stat.size;
      ensure(bytesRead <= MAX_SOURCE_BYTES, 'SOURCE_LIMIT', 'Source exceeds the 32 MiB read limit.');
      bytes = readFileSync(absolute);
      ensure(bytes.length === stat.size, 'SOURCE_CHANGED', 'Source changed during retrieval.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    files.set(path, bytes);
    modes.set(path, mode);
    const sha256 = bytes === null ? null : digest(bytes);
    hashes.set(path, sha256);
    const before = baseline.get(path);
    const object =
      bytes === null
        ? null
        : createHash(before?.object.length === 64 ? 'sha256' : 'sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex');
    if (before ? before.object !== object || before.mode !== mode : bytes !== null)
      changed.set(path, { path, change: bytes === null ? 'deleted' : before ? 'modified' : 'added', sha256 });
  }
  for (const path of baseline.keys())
    if (!files.has(path)) changed.set(path, { path, change: 'deleted', sha256: null });
  const version = {
    base_commit: record.baseCommit,
    head_commit: head,
    tree,
    worktree_identity_sha256: digest(JSON.stringify(record)),
    index_sha256: digest(index),
    worktree_sha256: digest(JSON.stringify([...hashes].map(([path, hash]) => [path, modes.get(path), hash]))),
  };
  return {
    revision: { ...version, fingerprint: digest(JSON.stringify(version)) },
    files,
    changed_files: [...changed.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
function current(identity: WorktreeIdentity, fingerprint: string) {
  ensure(
    source(identity).revision.fingerprint === fingerprint,
    'SOURCE_CHANGED',
    'Repository context is stale; retrieve the current revision.',
  );
}

/** Full, pre-response-budget facts for trusted local consumers such as conservative impact selection. */
export function readRepositoryAnalysis(
  identity: WorktreeIdentity,
  input: { expected_revision?: string } = {},
): RepositoryAnalysis {
  const snapshot = source(identity);
  if (input.expected_revision !== undefined)
    ensure(
      input.expected_revision === snapshot.revision.fingerprint,
      'SOURCE_CHANGED',
      'Repository context is stale; retrieve the current revision.',
    );
  const result: RepositoryAnalysis = {
    revision: snapshot.revision,
    changed_files: snapshot.changed_files,
    symbols: [],
    callers: [],
    tests: [],
    changed_paths_complete: true,
    analysis_mode: 'text_candidates',
    analysis_complete: false,
    limitations: [
      'Tracked files only; untracked and ignored files are excluded.',
      'Structural analysis is unavailable. Symbols, callers and tests are text candidates, not complete impact proof; comments, strings, aliases, removed exports and dynamic dispatch can mislead or be missed.',
      'Changes compare actual worktree bytes to the owning base commit; checkout conversions can conservatively report extra changes.',
    ],
  };
  const changed = new Set(result.changed_files.map(({ path }) => path));
  const texts = new Map<string, string>();
  let analyzedBytes = 0;
  for (const [path, bytes] of snapshot.files) {
    if (bytes === null) continue;
    if (
      !supported.test(path) ||
      bytes.length > 256 * 1024 ||
      bytes.includes(0) ||
      analyzedBytes + bytes.length > 8 * 1024 * 1024
    ) {
      if (changed.has(path) || supported.test(path)) {
        result.analysis_complete = false;
        result.limitations.push(`Text fallback required: ${path}.`);
      }
      continue;
    }
    analyzedBytes += bytes.length;
    const text = bytes.toString('utf8');
    texts.set(path, text);
    if (!changed.has(path)) continue;
    let line = 1,
      previous = 0;
    for (const match of text.matchAll(
      /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      if (result.symbols.length === 2000) break;
      line += text.slice(previous, match.index).split('\n').length - 1;
      previous = match.index;
      result.symbols.push({ path, line, name: match[1]! });
    }
  }
  for (const { path, change } of result.changed_files)
    if (change === 'deleted') {
      result.analysis_complete = false;
      result.limitations.push(`Deleted source has no current symbols: ${path}.`);
    }
  const names = new Set(result.symbols.map(({ name }) => name));
  for (const [path, text] of texts) {
    let line = 1,
      previous = 0;
    for (const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (result.callers.length === 2000) break;
      line += text.slice(previous, match.index).split('\n').length - 1;
      previous = match.index;
      const name = match[1]!;
      if (!names.has(name) || /\bfunction\s*$/.test(text.slice(Math.max(0, match.index - 100), match.index)))
        continue;
      const reference = { path, line, name };
      result.callers.push(reference);
      if (testFile.test(path)) result.tests.push(reference);
    }
  }
  if (result.symbols.length === 2000 || result.callers.length === 2000)
    result.limitations.push(
      'Text candidates are capped at 2,000 declarations and 2,000 callers; retrieve tracked text for further inspection.',
    );
  current(identity, result.revision.fingerprint);
  return result;
}

function budget(value: number | undefined) {
  const tokens = value ?? 4000;
  ensure(
    Number.isInteger(tokens) && tokens >= 256 && tokens <= 32000,
    'INVALID_ARGUMENT',
    'max_tokens must be an integer from 256 to 32000.',
  );
  return tokens;
}
export function readRepositoryContext(
  identity: WorktreeIdentity,
  input: { max_tokens?: number; expected_revision?: string } = {},
) {
  const max = budget(input.max_tokens);
  const analysis = readRepositoryAnalysis(identity, input);
  const packet = {
    ...analysis,
    complete: true,
    omitted: { changed_files: 0, symbols: 0, callers: 0, tests: 0, limitations: 0 },
    retrieval: {
      analysis: {
        operation: 'readRepositoryAnalysis',
        arguments: { expected_revision: analysis.revision.fingerprint },
      },
      file: {
        operation: 'readRepositoryFile',
        revision: analysis.revision.fingerprint,
        scope: 'tracked_files_only',
      },
    },
  };
  const sections = ['callers', 'tests', 'symbols', 'changed_files', 'limitations'] as const;
  while (countReferenceTokens(JSON.stringify(packet)) > max) {
    const section = sections.find((name) => packet[name].length > (name === 'limitations' ? 3 : 0));
    ensure(
      section,
      'BUDGET_TOO_SMALL',
      'Increase max_tokens to retain revision, limits and retrieval instructions.',
    );
    packet[section].pop();
    packet.omitted[section]++;
    if (section === 'changed_files') packet.changed_paths_complete = false;
    packet.complete = false;
  }
  return packet;
}

/** Revision-bound text fallback. Caller paths must already be tracked in this exact worktree. */
export function readRepositoryFile(
  identity: WorktreeIdentity,
  input: { revision: string; path: string; start_line?: number; max_tokens?: number },
) {
  const max = budget(input.max_tokens);
  const path = relativePath(input.path);
  const start = input.start_line ?? 1;
  ensure(
    Number.isSafeInteger(start) && start >= 1,
    'INVALID_ARGUMENT',
    'start_line must be a positive integer.',
  );
  const snapshot = source(identity);
  ensure(
    snapshot.revision.fingerprint === input.revision,
    'SOURCE_CHANGED',
    'Repository context is stale; retrieve the current revision.',
  );
  ensure(snapshot.files.has(path), 'UNAUTHORIZED_PATH', 'Only current tracked files may be retrieved.');
  const bytes = snapshot.files.get(path);
  ensure(bytes, 'FILE_UNAVAILABLE', 'Tracked file is deleted from the worktree.');
  ensure(!bytes.includes(0), 'BINARY_FILE', 'Binary files have identities but no text fallback.');
  const text = bytes.toString('utf8');
  ensure(Buffer.from(text).equals(bytes), 'UNSUPPORTED_ENCODING', 'Text fallback requires valid UTF-8.');
  const lines = text.split('\n');
  const page = {
    revision: snapshot.revision,
    path,
    sha256: digest(bytes),
    start_line: start,
    text: '',
    complete: start > lines.length,
    next_line: start > lines.length ? (null as number | null) : start,
  };
  for (let index = start - 1; index < lines.length; index++) {
    const candidate = {
      ...page,
      text: page.text + (index > start - 1 ? '\n' : '') + lines[index],
      complete: index === lines.length - 1,
      next_line: index === lines.length - 1 ? null : index + 2,
    };
    if (countReferenceTokens(JSON.stringify(candidate)) > max) break;
    Object.assign(page, candidate);
  }
  ensure(
    page.complete || page.next_line !== start,
    'BUDGET_TOO_SMALL',
    'Increase max_tokens to fit the next complete line.',
  );
  ensure(
    countReferenceTokens(JSON.stringify(page)) <= max,
    'BUDGET_TOO_SMALL',
    'Increase max_tokens to retain file revision metadata.',
  );
  current(identity, snapshot.revision.fingerprint);
  return page;
}
