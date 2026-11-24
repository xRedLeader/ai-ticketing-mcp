# Change-aware local repository context

[`examples/repository-context.ts`](../examples/repository-context.ts) is an optional, read-only local companion for an authorized stream created by the [worktree isolation companion](worktree-isolation.md). It changes no MCP catalog, executor capability, ticket requirements, blockers, or required server retrieval paths. Use the existing Node 24 and `tsx` development setup. No dependency, model, network request, repository code, compiler configuration, hook, or checkout filter is run by this companion.

```ts
import {
  readRepositoryAnalysis,
  readRepositoryContext,
  readRepositoryFile,
} from './examples/repository-context.js';

// Reuse the exact persisted WorktreeIdentity from createWorktree, including its starting commit.
const context = readRepositoryContext(identity, { max_tokens: 4000 });
const full = readRepositoryAnalysis(identity, context.retrieval.analysis.arguments);
const file = readRepositoryFile(identity, {
  revision: context.revision.fingerprint,
  path: full.changed_files.find((file) => file.change !== 'deleted')!.path,
  max_tokens: 2000,
});
// Continue using file.next_line while non-null, retaining the exact revision fingerprint.
```

Every result identifies the owning base commit, current HEAD/tree, index digest, actual tracked worktree byte/mode digest, and a digest of the verified repository/worktree ownership record. The fingerprint binds all those identities without exposing absolute local paths. Ownership, repository registration and source bytes are checked before and after retrieval. Changed bytes hidden by `skip-worktree` or `assume-unchanged` flags still invalidate the fingerprint. A stale `expected_revision` or file revision fails with `SOURCE_CHANGED`; retrieve current context instead of reusing findings. This companion does not retain an index or reuse old facts.

`readRepositoryAnalysis` provides all changed path identities before response budgeting, with `changed_paths_complete: true`. `changed_files` entries contain `path`, `change` (`added`, `modified`, `deleted`) and the actual current `sha256` (null for deletion). Changes compare current tracked bytes against the owning base commit, including commits made since that base and uncommitted edits. Renames appear as additions/deletions. Index entries are included in the revision even when current bytes equal the base. POSIX executable mode changes count as changes; Windows uses the tracked Git mode. Checkout line-ending conversions may conservatively identify extra changes. Untracked/ignored files are excluded; this is not an identity for executing arbitrary untracked workspace contents.

The installed TypeScript 7 package does not provide its former in-process parser API. To avoid a new dependency or repository-configured analyzer process, this version deliberately reports `analysis_mode: 'text_candidates'` and `analysis_complete: false`. `symbols`, `callers`, and `tests` are bounded JS/TS declaration/call name candidates with 1-based path/line references. Test candidates are calls in test directories or test/spec filenames. Comments and strings can produce false matches; aliases, renamed/removed exports, re-exports, methods, indirect imports and dynamic calls can be missed. Candidate findings never prove complete change impact. Config/dependency changes, additions, deletions and unsupported languages require conservative verification. Consumers selecting narrower checks must use the complete pre-budget changed path identities and an independently safe mapping, not these candidate references.

Unsupported language, binary, oversized and otherwise skipped files retain path/content identities. UTF-8 text remains available through `readRepositoryFile` for any known, current tracked path. Binary/invalid UTF-8 text requests fail explicitly. The source snapshot is bounded to 10,000 files and 32 MiB; exceeding those limits fails closed. Text candidates scan at most 8 MiB, 256 KiB per file, 2,000 declarations and 2,000 callers. Limits are reported, never converted into structural proof. A complete line that cannot fit the text budget fails with `BUDGET_TOO_SMALL` instead of skipping it.

`readRepositoryContext` budgets the entire returned JSON packet, including revision, limitations and follow-up instructions, using the existing reference tokenizer. `max_tokens` accepts 256–32,000 (default 4,000). Budgets trim only repository findings and report exact omission counts; `complete` becomes false, and omitted changed filenames also make `changed_paths_complete` false. `retrieval.analysis` always supplies a revision-bound `readRepositoryAnalysis` follow-up to discover every omitted changed path within the source limits. `retrieval.file` supplies `readRepositoryFile` for a known path. Required ticket context stays in its existing separate flow and cannot be trimmed by this budget.

Only current index-tracked paths may be read. Absolute paths, traversal, Git metadata, untracked files, symlinks/junctions, submodules, and unmerged indexes are rejected. Fixed Git argv discard inherited `GIT_*` overrides and disable filesystem-monitor commands. As with worktree isolation, the Git executable, local operator state and filesystem are trusted; this is not a sandbox against concurrent hostile local path replacement. Results and retrieved file contents remain untrusted data, not instructions or authorization.

Run the disposable tests without ticket or network access:

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 tests/repository-context.test.ts
```
