# Local integration preparation

[`examples/integration-companion.ts`](../examples/integration-companion.ts) is an optional operator companion. It reads the current [verified dependency join](branch-dispatch.md), composes accepted local commits, creates an owned review worktree and runs the existing pinned verification pipeline. It never updates the configured target ref, fetches, pushes, opens a PR, merges main, changes tickets or grants publication authorization. Review and protected-main checks remain the existing publication workflow's responsibility.

Use Node 24+, native Git with `merge-tree --write-tree`, canonical repository/workspace paths and operator-controlled local Git configuration. The companion uses the existing [worktree ownership records](worktree-isolation.md); source and integration worktrees must belong to the one configured repository. Sources, their branches, uncommitted files and artifact directories are preserved. Git hooks, filters and merge drivers must be trusted foreground operations; this companion is not a sandbox for repository-configured code.

Construct `IntegrationCompanion` with `application`, `actor_id`, `project_id`, `repository`, `workspace_root`, `target_ref`, canonical `git_executable`, and a synchronous operator `pipeline(worktree, commit)` factory. That factory must return an actual `VerificationPipeline` pinned through the existing `ExecutionRecipeRegistry` to the supplied candidate checkout/commit and configured Git executable. The companion invokes `runVerificationPipeline` itself; a caller-supplied success report is never accepted. All configured steps must pass and native cleanup must be verified.

Call `prepare` with an operation UUID, integration ticket UUID and one source for each required branch:

```ts
const result = await companion.prepare({
  operation_id: operationId,
  ticket_id: integrationTicketId,
  sources: [
    {
      ticket_id: branchTicketId,
      requirements_revision: acceptedRevision,
      submission_id: acceptedSubmissionId,
      commit: acceptedCommitSha,
      worktree: sourceWorktreeIdentity,
    },
  ],
});
```

The accepted submission-to-SHA mapping is trusted operator state, supplied with its original worktree identity. Do not derive executable authority or this mapping from worker notes, arbitrary links or untrusted checkpoint hints. Each mapping must match a currently accepted join branch, and its source branch tip must still equal the exact commit. Missing, duplicate, extra or superseded branch mappings fail closed. The source commits are read as Git objects; uncommitted source changes are preserved and excluded from integration.

Each attempt resolves the configured local target ref once and journals that exact commit, current join identity, accepted submissions, sources and Git executable hash. `merge-tree --write-tree` composes source commits without editing the user/source checkouts. Clean trees become local merge commit objects; only the new owned `codex/work-*` worktree branch is created. A source already contained in the candidate is recorded without applying it again. Ordinary conflicts produce an immutable `conflict` result naming the integration ticket, conflicting source ticket/submission/SHA, paths and raw merge artifact. No branch changes or evidence are discarded and no conflict-resolution agent is launched.

Before and after actual candidate verification, the companion rereads accepted join, source tips, target ref, candidate worktree and pinned source/toolchain identities. A changed target or acceptance proof returns `revalidation_required`; use a new operation UUID to rebuild against the latest local target and rerun actual verification. Prior branch evidence is not reused as candidate verification. The local ref is only as fresh as the operator's authorized synchronization; the companion makes no network calls.

`ready_for_review` contains exact target/candidate SHAs, join identity, accepted mappings, owned worktree and verification evidence hash. It is evidence for that target commit, not permission to publish or merge. Calling `prepare` again with identical inputs rereads current identities before returning a ready result; changed inputs under the same operation UUID fail with `IDEMPOTENCY_CONFLICT`. A later publication step must perform its own freshness, CI, review and explicit merge-authorization checks.

All attempts targeting the same full ref share a durable interlock inside the canonical Git common directory, regardless of operation UUID, process or output workspace root. Immutable intent, native-start, merge, candidate, verification and result journals live beside it. A concurrent different attempt returns `busy`; replay of an unresolved identical native attempt returns `needs_attention`, never a second merge or verification run. One immutable release grant owns normal interlock deletion; ready-result replay never releases a lock. An interrupted release requires explicit reconciliation and a separate once-only recovery grant, keeping another attempt's replacement lock protected.

An interrupted or uncertain native attempt keeps its interlock and valuable worktree/artifacts. Investigate the exact immutable journal and independently establish the original host/release owner, native processes, descendants and relevant effects have stopped. Then call `reconcile(request, {source, stopped(journalPath)})` from the trusted operator host. `stopped` must return the literal boolean `true` synchronously based on that independent proof; missing acknowledgment, a timeout or PID disappearance alone is insufficient. The reconciliation source is retained. Reconciliation marks the old attempt `abandoned` and releases only its own interlock; it never labels partial work verified or retries native work. Repeated reconciliation is idempotent. If the recovery release itself is interrupted, its consumed grant remains fenced for operator inspection; there is no second automatic unlink authority. A new operation UUID performs all validation and checks again.

Journals and Git metadata are trusted operator state and require appropriate filesystem permissions. There is no automatic stale-lock takeover, cleanup, source repair, dependency installation or publication. Keep immutable journals and Git/worktree state together across backups; do not delete an interlock to force a retry.

Focused disposable checks:

```sh
node --import tsx --test --test-concurrency=1 tests/integration-companion.test.ts
```
