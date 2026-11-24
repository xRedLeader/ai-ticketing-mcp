# Conservative local validation selection

[`examples/validation-selection.ts`](../examples/validation-selection.ts) is an opt-in local companion for an operator-registered [verification pipeline](verification.md) in an [owned worktree](worktree-isolation.md). It selects existing checks and delegates execution to the existing runner. It does not create commands, alter recipes, accept executable arguments, modify tickets, submit evidence, or change MCP catalogs, protected CI, independent review or approval requirements.

```ts
import { readRepositoryAnalysis } from './examples/repository-context.js';
import { runSelectedValidation } from './examples/validation-selection.js';

// Get pipeline through ExecutionRecipeRegistry.get for this authorized project/worktree.
// Pin it after committing the change: the existing runner requires clean tracked source.
const revision = readRepositoryAnalysis(identity).revision.fingerprint;
const result = await runSelectedValidation(identity, pipeline, {
  expected_revision: revision,
  policy: {
    standalone_tests: [{ path: 'tests/widget.test.ts', step_ids: ['widget-tests'] }],
    mandatory_step_ids: ['typecheck'],
  },
});
// Preserve both result.selection and result.report in the run's existing evidence store.
```

The policy is trusted operator configuration. A mapping asserts that the named file is a standalone test exercised exclusively by the listed checks: it is not an imported helper, shared fixture, test configuration or other checks' input. Only exact, existing `*.test.*`/`*.spec.*` JS/TS paths inside `test`, `tests` or `__tests__` directories qualify. Paths in configuration, migration, Git or dependency directories do not qualify. Use full validation when that standalone assertion cannot be established. Shared or indirectly loaded test code must not be mapped as standalone.

Narrowing requires every actual change since the owning base commit to be a modification of a mapped standalone test. The complete pre-budget repository analysis supplies exact paths and revisions. Candidate symbols/callers from [repository context](repository-context.md) do not prove impact and are not used. The selected steps include all mapped checks, all `mandatory_step_ids`, and the transitive `needs` closure of both, preserving original pipeline order and failure behavior. A closure that includes every step runs the original full pipeline.

Every other case uses the full configured suite: missing opt-in/revision/mapping, duplicate or unknown mappings/step IDs, production code, configuration, dependencies, migrations, additions/deletions/renames, shared helpers, empty changes, incomplete/unavailable enumeration, or stale analysis. Any untracked file, including ignored inputs, also forces full validation. The fixed untracked inventory is bounded to 2 MiB; failure or overflow uses full validation. Invalid ownership or a pipeline from another worktree fails closed before execution. Stale pinned source/toolchain runs through the original runner's failure checks and cannot execute narrowed checks against another revision.

`selection` records the original pipeline fingerprint, policy digest, full analysis revision, pinned source identity, untracked inventory digest/count, selected/omitted step IDs, scope, reason and selection fingerprint. `scope` is `full_local` or `narrow_local`. The wrapper recomputes native source/selection identities immediately before execution; changed selections revert to full validation. Narrow execution retains the existing runner's before/after source/toolchain checks, deadlines, recovery handling and diagnostics. A final exact repository revision check also rejects tracked-byte, index, mode or ownership changes made during a narrowed run. Generated untracked output is allowed by the existing runner, but forces full validation on the next attempt if it remains present.

Narrowed reports have a distinct recipe fingerprint derived from the original pipeline and exact selection. They cannot satisfy a full registered recipe's fingerprint, full ordered step list or execution-cache checks. Their local success does not satisfy protected CI or independent acceptance. Full fallback retains the original fingerprint and every configured step; selected, mandatory and prerequisite failures remain failed reports with their existing diagnostics.

The companion uses the existing Node 24/`tsx` setup and adds no dependencies. Local operator configuration, registered native Git binary and filesystem remain trusted, under the same concurrent-path-replacement limits as worktree isolation. It performs no model or network calls. `options.deadline_at` and `options.report_path`, if supplied, pass through to the existing verification runner; recovery-enabled pipelines still require their existing durable report/journal location. Preserve the wrapper's selection alongside that runner report.

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 tests/validation-selection.test.ts
```
