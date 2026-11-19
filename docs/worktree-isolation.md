# Local worktree isolation companion

[`examples/worktree-isolation.ts`](../examples/worktree-isolation.ts) is an optional callable companion for an authorized implementation stream. It uses local native Git and Node filesystem calls, with no direct model/network calls, ticket mutation, or dependency installation. Native Git can invoke repository-configured hooks and checkout filters; use trusted local Git configuration and repositories. It does not change MCP server behavior. Use Node 24 or newer, Git, and the existing `tsx` development dependency.

Each stream needs its own run/attempt identity. Resolve the exact authorized starting commit once, retain that identity with the run's state, and use a different attempt ID for concurrent workers or retries. The workspace root must already exist, be an absolute canonical directory without symlinks/junctions, and be dedicated to companion workspaces. It may be an ignored directory inside the user's checkout, or a separate directory outside it; it cannot be the checkout itself, an ancestor of it, or Git metadata.

```ts
import { execFileSync } from 'node:child_process';
import { createWorktree, useWorktree, cleanupWorktree } from './examples/worktree-isolation.js';

const identity = {
  repository: 'G:/Git2/project',
  workspaceRoot: 'G:/Git2/project-workspaces', // create this dedicated directory first
  runId: 'SELF-12-run-1',
  attemptId: 'worker-1',
  baseCommit: execFileSync(
    'git',
    ['-C', 'G:/Git2/project', 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    { encoding: 'utf8' },
  ).trim(),
};

const record = createWorktree(identity);
// Persist `identity` alongside the authorized run; keep logs/evidence in record.artifactPath.

await useWorktree(identity, async ({ worktreePath, artifactPath }) => {
  // Verification happens immediately before this implementation callback.
  // Run the authorized worker with cwd=worktreePath and save evidence in artifactPath.
});

await useWorktree(identity, async ({ worktreePath }) => {
  // Verification happens again immediately before this publication callback.
  // Apply the run's existing review/publication approval policy here.
});

// Only after callbacks/workers have stopped and all useful work is committed:
cleanupWorktree(identity);
```

`createWorktree` records the canonical repository and Git common directory, full starting commit, owner run/attempt, unique branch, checkout path, and artifact path before running `git worktree add -b`. It never resets, stashes, switches, or cleans the user's checkout. Different attempts can edit the same relative filename independently, including when the user's original file has uncommitted changes. Git subprocesses receive argv directly and discard inherited `GIT_*` overrides.

`verifyWorktree` and `useWorktree` reread the record and fail closed on missing or corrupt records, an identity mismatch, missing registration/path, a swapped repository or branch, symlinks/junctions in ownership paths, or a HEAD that no longer descends from the starting commit. New commits on the recorded branch are allowed. Verification is a local workspace check, not a claim lease or authorization check: the caller must retain its existing ticket ownership and approval checks. Call `useWorktree` separately for each execution/publication operation; a callback must not cache its path for later unverified operations.

## Recovery and cleanup

After interruption, reuse the persisted identity with `verifyWorktree` or `useWorktree`; do not recalculate the base from a moving `HEAD`. A failed creation retains its ownership record and any partial checkout for inspection. Duplicate creation refuses to overwrite existing paths or records. If verification fails, stop execution/publication, retain the record, branch, artifacts, and checkout, and inspect `git worktree list --porcelain`, the record, and the reported path. Do not repair a mismatch by rewriting the record or automatically pruning/removing an unknown checkout. Start a new attempt when ownership cannot be established; an operator can reconcile the retained failed attempt separately.

`cleanupWorktree` repeats verification and rejects modified/staged/untracked/ignored files and index flags that can hide tracked changes. A bounded tree inspection also rejects nested `.git` metadata inside tracked directories and any symlinks/junctions, without following them; checkouts above 100,000 entries require manual inspection. It invokes only native `git worktree remove` without `--force`. It never uses recursive deletion, moves paths, prunes worktree records, deletes branches, or removes the ownership record/artifact directory. Retained branches preserve committed implementation work; the separate artifact directory preserves evidence. Store needed logs and generated files there rather than leaving them ignored inside the checkout. A removed worktree intentionally fails subsequent verification; cleanup is not silently idempotent.

The root/records are trusted local operator state and require appropriate filesystem permissions. The caller must wait for active callbacks and workers to stop before cleanup. As with Git itself, checks assume another local process cannot maliciously replace paths between validation and a filesystem operation; this is not a sandbox for hostile code. No background cleanup or operating-system lock is installed.

## Disposable local verification

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 tests/worktree-isolation.test.ts
```

The tests allocate disposable repositories under the system temporary directory, exercise two concurrent workers editing one filename, preserve a dirty original checkout, verify recovery and publication failure boundaries, and reject unsafe ownership/path/cleanup cases. They do not edit the real project checkout, publish anything, call a model, or use the network.
