# Durable local script companion

The optional companion runs operator-registered finite foreground scripts in a separate Node 24+ process. Start it independently of the MCP server/client: closing the submitting chat or MCP connection does not terminate that process. It makes no model calls, uses no agent token budget, and never retries an execution. MCP `run_submit` selects only a registered recipe ID and atomically stores its checkpoint, immutable recipe fingerprint and exit-code continuation; `run_get` reads that exact authorized project run later. These tools use the `executor` or `full` MCP profile. Use bounded `run_wait` for status and `artifact_read` for exact evidence; see [capability profiles](mcp.md#capability-profiles).

When storage supports [durable wakes](durable-wakes.md), each companion pass also evaluates a bounded page of explicitly registered wake conditions. It stores coalesced reasons and cursors, without consuming decisions or starting models. Terminal execution settlement emits one durable `run.settled` event with run/continuation IDs and result code; repeated identical settlement does not emit duplicates. Restart resumes each registration's durable cursor and retains active consumption fences.

## Trusted host contract

Recipes, executables, script files, workspaces, environment and artifact directory are operator-owned. Register only finite foreground work that waits for its children, never detaches/backgrounds work, and never escapes the supervisor. This is a trusted local execution boundary, not an OS sandbox for untrusted scripts. A normal exit, including a nonzero exit, is authoritative under this contract. CPU/memory declarations are HostCapacity admission estimates, not OS resource enforcement.

Timeout, cancellation and lost ownership terminate only an owned process lineage after checking its PID and OS start marker. Linux recipes run in an isolated process group; successful termination and an empty non-zombie group permit physical capacity release under the foreground recipe contract. On Windows, the supervisor acquires native process handles, validates the root start time, and terminates captured descendants through those handles. A Windows process snapshot cannot prove containment or exclude escaped descendants, so cleanup stays unresolved even after those handles exit. Inspection errors, missing/reused root identity and external/native signals also retain unresolved cleanup. There is no bare-PID `taskkill`, automatic rerun or lease-based capacity release. These controls are not an OS sandbox; recipes must never detach or escape.

Set `EXECUTION_RECIPES_FILE` to an **absolute** operator-owned JSON file for both the MCP service and companion. Restart both when changing registration. Example:

```json
{
  "workspace_roots": ["G:\\Work\\repo"],
  "recipes": [
    {
      "id": "verify",
      "project_ids": ["00000000-0000-4000-8000-000000000001"],
      "executable": "C:\\Program Files\\nodejs\\node.exe",
      "argv": ["G:\\Work\\repo\\scripts\\verify.mjs"],
      "cwd": "G:\\Work\\repo",
      "env": { "SystemRoot": "C:\\Windows" },
      "timeout_ms": 1800000,
      "max_log_bytes": 1048576,
      "resources": { "cpu_millis": 1000, "memory_bytes": 268435456 }
    }
  ]
}
```

The registry resolves real paths, requires an absolute native executable, rejects shell scripts/Windows command files, and restricts cwd to configured workspace roots. It freezes fixed argv and an exact explicit environment: the child inherits **none** of the companion's environment. There is no shell, interpolation, ticket-supplied argv, model-supplied environment or command text. Scripts needing other programs must use operator-approved absolute paths or explicitly configured environment values. Windows environment keys cannot differ only in case.

The registry file is bounded to 1 MiB; each normalized recipe and its private supervisor input are bounded to 2 MiB, checked before dispatch. Timeout defaults to 30 minutes and cannot exceed it. Each stdout/stderr file defaults to 1 MiB, with a configured maximum of 16 MiB each. Both pipes continue draining after the retained byte limit, so truncation does not deadlock the child. Recipe IDs are at most 80 characters. The SHA-256 fingerprint covers normalized registration, including argv, cwd, environment, limits and project allowlist. It does not hash executable/script contents: the operator must protect those files and bump registration when changing their meaning. Changing/removing a recipe does not silently redirect an already submitted job; it fails before spawn.

## Deterministic verification pipelines

An optional top-level `pipelines` array registers a finite verification pass as one ordinary execution recipe ID. `run_submit` selects that ID; the built-in runner executes every eligible step without model calls or individual MCP turns. The existing supervisor owns the runner and its foreground step children, and the existing attempt, continuation, cancellation, recovery and capacity fences still apply. A step retries only through an explicitly registered recovery playbook.

Each step references a registered native-executable recipe. Register an additional Git recipe with empty `argv` and its `cwd` set to the repository root, then add the pipeline to the same registry:

```json
{
  "pipelines": [
    {
      "id": "verify-pipeline",
      "project_ids": ["00000000-0000-4000-8000-000000000001"],
      "source": {
        "recipe_id": "source-git",
        "commit": "0123456789abcdef0123456789abcdef01234567"
      },
      "steps": [
        {
          "id": "checks",
          "recipe_id": "verify",
          "needs": [],
          "on_failure": "stop",
          "toolchain_files": ["G:\\Work\\repo\\package-lock.json"]
        }
      ],
      "timeout_ms": 1800000,
      "max_log_bytes": 1048576
    }
  ]
}
```

The commit must be the exact current Git HEAD, and tracked files must be clean when both processes load the registry. Source identity includes HEAD, its tree object and a SHA-256 digest of every tracked working file's actual bytes, including files hidden by Git index flags. Untracked generated output is excluded. Tracked symbolic links and submodules are rejected. Run verification in a dedicated checkout and declare every additional file consumed by tooling outside the tracked source in `toolchain_files`; those entries must be canonical regular files inside a configured workspace root. The existing trusted foreground-work contract applies to all inputs and commands.

The immutable pipeline fingerprint includes normalized commands and project allowlists, source identity, step/dependency order, stop/proceed rules, executable hashes, declared toolchain-file hashes, and the built-in runner/runtime hashes. Every referenced recipe must allow every pipeline project. Limits are 32 pipelines, 16 steps per pipeline, 64 declared toolchain files per step, a 2 MiB normalized pipeline, and a 30-minute total timeout. Steps execute in declaration order; dependencies must reference earlier unique step IDs. Admission uses the largest declared CPU and memory requirement across the sequential steps.

`on_failure: "stop"` skips all remaining steps after a failed or timed-out step. `"proceed"` permits independent later steps; any step whose dependencies did not pass is recorded as skipped with the failed dependency IDs. Source or toolchain changes always stop further execution. Source, relevant step tooling and runtime identities are checked before and after each executed step, and all identities are checked again before the supervisor publishes its result. Missing or changed identities fail verification. Timeout cleanup that cannot be proved retains unresolved capacity under the existing host rules.

The existing authorized `result` artifact contains a `verification` object with exact identity hashes, ordered step results, exit codes, timeout/failure/skip codes and separate stdout/stderr diagnostics. Each step retains at most 512 diagnostic bytes per stream, with total byte counts and truncation flags. Aggregate stdout/stderr logs share the pipeline capture limits. Reports omit command arguments, environment, source paths and process credentials; captured command output remains untrusted content.

On a Linux step timeout, the runner retains the supervisor-owned process group, publishes the failed `pipeline-report.json` and an exact-attempt `pipeline-timeout.json` marker containing its hash, and waits for outer termination. The supervisor terminates the runner group, including the step and its descendants. If the supervisor exits first, a replacement companion validates the original identity and marker before attempting group termination and publishing the same bounded failure report. Unverifiable cleanup retains capacity. These two immutable files are recovery journals. Cancellation remains a separate primary outcome when it wins the race, while the report retains the timed-out step diagnostics. Total deadlines use monotonic time and are checked after identity validation and immediately before atomic publication; an overdue result cannot be published as passing.

A passing pipeline only satisfies its execution continuation. It does not submit or approve a ticket, replace evidence for current criteria, refresh exact-SHA GitHub CI, or perform independent review. Those operations and their existing validation remain separate. Artifacts identify the source actually checked; a later source revision requires a new pinned pipeline run and current CI/review evidence.

### Exact local verification reuse

Only a pipeline explicitly registered with `"cacheable": true` permits reuse. This is the operator's declaration that verification is deterministic and has no side effects or generated outputs that a later job needs. Ordinary recipes and pipelines without that declaration always execute. Every input must be tracked source or a declared toolchain file, with fixed arguments and environment; work depending on undeclared files, network state, time, randomness or required output effects must remain uncached. The system cannot infer that promise from command text.

The trusted companion checks for reuse before host admission. A hit requires the same project, ticket, actor, current requirements revision, completion condition and registered pipeline fingerprint. That fingerprint pins the exact source revision/tree/tracked bytes, commands, arguments, environment, executables, declared tooling, operating-system/runtime identity and runner. Source and tooling identities are revalidated before lookup and immediately before publication. The lookup inspects only the latest matching actual successful execution; a missing, expired, retired, changed, incomplete or ambiguous candidate is a normal miss and follows ordinary execution. Cached results never become cache sources.

Reuse verifies all three retained canonical artifacts with the existing safe reader, streaming at most 64 KiB per read and requiring the original captured hashes. The result must match its original run/attempt, verified process cleanup and every expected passing pipeline step. The source artifacts remain owned by the original execution. A hit atomically completes the reserved new attempt with those original references and explicit `run.cache` provenance (source run/attempt, exact artifact hashes/sizes and request key). `run_get` and resume packets permit those references only through validated same-project cache provenance. No process starts, no host slot is admitted, and `started_at` stays null; the observation sequence is reserved/completed rather than a new script invocation.

`verification.cache_hit` and `run.cache_miss` audit events attribute the local decision. A hit's evidence references deliberately pin the original artifacts under existing retention checks, including after the ticket closes. Cache publication shares the artifact-retirement lock: an already retired source misses, and a committed hit protects its retained source. Controller, reservation, current claim/authorization, pause and cancellation fences still apply. Cache provenance survives restart in the existing completed observation; no new filesystem publication or schema migration is needed. Reuse satisfies only its execution continuation and never supplies current CI, ticket acceptance, independent review or a claim of billed provider savings.

## Starting the process

Build with `npm run build`. Use a dedicated registered project-admin actor for the trusted companion APIs. The submitting agent still uses its own normal claim and contributor permissions.

```powershell
$env:EXECUTION_RECIPES_FILE = 'G:\Work\operator\recipes.json'
node dist/execution-companion-cli.js --sqlite 'G:\Work\operator\tickets.sqlite' --actor ACTOR_UUID --project PROJECT_UUID --capacity 'G:\Work\operator\host.sqlite' --host workstation --artifacts 'G:\Work\operator\execution-artifacts'
```

For PostgreSQL, first migrate with the schema-owner role, then omit `--sqlite` and supply the normal runtime storage environment (`ticketing_app`). The companion does not run PostgreSQL migrations; SQLite local startup still initializes its schema automatically. The companion forces embeddings off. `--once` processes at most one queued job and exits; without it the process waits between queue checks and continues processing available slots after an individual run becomes unresolved. Use an independent terminal, service or an operator-managed hidden background process so its lifetime is independent of the MCP connection. The CLI prints a startup event with its PID; it never launches itself from MCP.

All dispatchers on the physical host must share the same local HostCapacity SQLite file **and host ID**. A missing host gets the existing two-script/two-agent defaults. Preconfigure immutable host limits through `HostCapacity.configureHost` if required. Separate host files/IDs cannot coordinate physical capacity.

The companion acquires one store-wide controller lease before inspecting or dispatching work. Its 60-second lease renews at most every 10 seconds. Companions for other projects in the same store wait for that controller to release or expire; each invocation processes at most one new job. A permanent controller singleton is locked in the same transaction as run acknowledgment and continuation publication, including the first acquisition. Expired controllers, old reservation tokens, and mismatched immutable attempt/process tokens cannot publish through a replacement. Once the store has used a controller, unfenced legacy direct writes are rejected.

Dispatch persists an immutable attempt and its reservation, admits host capacity, records dispatch intent, then starts a separate bounded supervisor. Each attempt has an immutable process token and append-only observations. Recovery rotates the reservation token while retaining the original attempt ID and observations. No recovery path dispatches that attempt again. Claim expiry/replacement prevents new running acknowledgments and normal owner settlement; a verified recovered result is still retained, with a failed `STALE_AUTHORITY` continuation when current claims, requirements or blockers no longer authorize it.

Capacity admission waits at most 30 seconds, with asynchronous checks at most one second apart. Exhaustion cancels its queued entry and records a pre-start failure. Admission uses the exact script queue ID and never takes another script or agent job. Application/controller and capacity heartbeats retain independent ownership fences. Lease expiry alone never releases an occupied host slot.

## Compact run timeline and next wake

Use the full-profile MCP tool `run_timeline`, or the existing trusted CLI:

```powershell
node dist/cli.js call --sqlite STORE --actor ACTOR --operation run_timeline --input-file timeline.json
```

```json
{
  "project_id": "PROJECT_UUID",
  "run_id": "RUN_UUID",
  "after_sequence": 0,
  "limit": 10,
  "max_tokens": 4096
}
```

The view includes authoritative run/attempt IDs, submitted/current requirement revisions, current ticket revision, claim/controller/reservation status, continuation, cancellation/effect state, and a safe next action. It omits transcripts, checkpoint/note text, artifact contents/references, arbitrary owner/provider/model labels, process identities and all ownership credentials. Native error/signal observations are summarized without exposing arbitrary strings; use authorized `run_get` for the exact recorded result. Aggregate metrics contain numeric attempt/observation counts only. Worker, planner and reviewer catalogs are unchanged.

History uses the existing immutable observation `sequence`, ordered ascending. Pass `page.next_after_sequence` while `has_more` is true. Restart, repeated reads, cancellation and controller replacement cannot reorder or duplicate entries already read. New observations append after the last sequence; current summary fields refresh from one authoritative store snapshot on every call. Separate local observations have their own `observed_at` and may be absent or unavailable.

`limit` is 1–50. `max_tokens` is 512–32768, default 4096, counting the complete canonical success envelope. Entries are removed from the end to fit, setting `truncated_by_budget`; the next sequence always advances when more entries exist. If the required summary and one entry cannot fit, `CONTEXT_TOO_LARGE` reports `required_tokens` without returning a partial page. Each page reads at most `limit + 1` history rows plus the latest observation and existing bounded authority checks; it never loads a transcript. Optional host inspection/reporting uses the existing local APIs, which scan their host/run ledger data; this change does not establish sustained-load performance.

`waiting_reason` distinguishes paused admissions, stale authority, another controller, capacity/budget waits, dispatch, process result, expired ownership, uncertain launch/exit, unresolved effects, and terminal capacity awaiting reconciliation. `next_wake.condition` names the event the operator or companion must observe, with `at` only for an observed lease/deadline. A deadline is an inspection threshold, never proof of exit, capacity release, rollback or permission to relaunch. A terminal result with an occupied host entry still directs reconciliation of the exact original capacity.

Admission blockers apply to queued work and reserved attempts still waiting for host admission. A matching running host entry identifies already admitted work that may drain during pause; current authority is still required before dispatch. Expired controller or reservation ownership directs reconciliation before any pre-launch recommendation.

The view reports execution, continuation, and reconciliation conditions. Operators can inspect registered wake decisions through the trusted wake API described in [Durable wake decisions](durable-wakes.md).

For existing single-host capacity and agent-budget data, configure both `EXECUTION_STATUS_LEDGER_FILE` (absolute operator-owned HostCapacity ledger) and `EXECUTION_STATUS_HOST_ID` on the runtime/CLI. No tool input accepts paths, host IDs, ledger IDs or budget overrides. Only the authorized project and exact run are observed; other projects' queue/resource breakdowns and full usage entries are never returned. The provider reuses HostCapacity inspection/reporting without admitting, settling or invoking work. Remaining budget uses conservative charged-or-reserved accounting, including retained in-flight allowances; it does not estimate unobserved actual usage. Missing/unavailable budgets stay `null`, never zero. Host occupancy and agent budgets remain separate from execution results.

## Operator pause, drain and cancellation

These trusted controls require a project-admin actor and stay out of worker MCP tools. Executor/full expose `run_cancel` with the same administrator requirement and strict idempotency receipts; pause, resume, drain and reconciliation remain trusted local controls. Pause and cancellation requests persist in the ticket store across controller restart. No process ID is accepted from a ticket or cancellation command.

```powershell
# Requests need only the store, actor and project; an existing companion observes cancellation.
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --pause
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --resume
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --cancel RUN_UUID

# Drain and reconciliation also need the normal capacity, host, artifact and recipe configuration.
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --capacity CAPACITY --host HOST --artifacts ROOT --drain
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --capacity CAPACITY --host HOST --artifacts ROOT --reconcile RUN_UUID --evidence EVIDENCE_JSON
```

Pause serializes with reservation and host admission. New reservations/admissions stop while already admitted work completes with existing host slot, resource and timeout limits. Submitted queued work remains queued. A reservation already waiting for capacity waits for resume within its original 30-second admission deadline; expiry retains the existing verified never-started failure behavior. Resume does not change host limits. Drain persists pause and reconciles existing work. Unknown cleanup reports `drained:false`, actionable states and exit code 2. A physically drained project can still have completed runs whose external effects need inspection through `run_get`.

Cancellation is idempotent. Queued/reserved work becomes `CANCELLED_NOT_STARTED`, fails its continuation, and never dispatches. Reserved host capacity is released only after an immutable never-started proof binds its original attempt and exact host execution token; a crash between terminal settlement and proof publication is recovered without relaunch. Dispatched cancellation first records `process_state:requested`. The controller signals the matching supervisor, or a replacement inspects the original attempt and terminates a verified live lineage. Unconfirmed cleanup becomes `process_state:unresolved` and keeps its host slot occupied. Confirmed exit becomes `process_state:exit_confirmed`, with `effects_state:unresolved` until the operator inspects effects already performed. Cancellation never claims rollback or satisfies the exit-code continuation, even if the script finishes successfully while cancellation is pending.

`run_get.reconciliation.cancellation` includes request time/actor, process state, external-effect state and eventual reconciliation note/actor/time. A terminal cancelled run stays `state:unresolved`, `next_step:inspect_side_effects` until its effects are reconciled. Logs, exact observed exit/signal, attempt/process identity, checkpoint, claim and observation history remain intact.

For a job completed or terminated externally, inspect its durable scheduler/process identifiers and partial effects first. Supply a bounded operator-owned JSON file only after confirming exit and reconciling those effects:

```json
{
  "process_exit_confirmed": true,
  "effects_reconciled": true,
  "outcome": {
    "exit_code": null,
    "signal": null,
    "artifacts": ["external:receipt-123"],
    "error_code": "CANCELLED"
  },
  "note": "Scheduler receipt 123 confirms exit; inspected the partial upload and retained its receipt. No rollback."
}
```

These are trusted operator attestations, not facts inferred from PID disappearance or a note alone. Reconciliation acquires the controller fence, preserves the original attempt, journals exact evidence before publishing its observed outcome, and releases matching host capacity. An active controller causes a retryable conflict. Identical evidence is replay-safe; conflicting evidence is rejected. Existing terminal outcomes stay unchanged. The application API `reconcileExecutionCancellation` records effect evidence after exit is already confirmed and refuses unresolved process cleanup.

## Results and files

A detached supervisor receives the immutable approved recipe, exact controller/reservation/attempt credentials, and a same-store connection descriptor once through a private stdin pipe. Connection credentials, recipe environment, arguments and cwd are not persisted in recovery manifests. The supervisor opens its own connection, validates the current claim and execution fences under project/controller transaction locks, consumes the write-once dispatch marker, and calls native spawn synchronously before releasing those locks. A replaced controller cannot launch the recipe. The native script still receives only its explicit registered environment. Closing or crashing the controller after valid launch does not stop the supervisor's bounded timeout, log capture or result journal. Capacity enqueue and admission use the same controller/reservation fence so stale controllers cannot create stranded capacity identities after recovery.

For normal foreground completion, fsynced logs and `result.json` precede the durable application outcome, which precedes capacity release. Exact exit codes and signals are retained, including native Windows exit codes. Continuation success uses the submitted exit condition and fresh authority; it does not accept a ticket or resume a model. Authorized `run_get` returns bounded opaque references:

```text
execution:<run UUID>:<attempt UUID>:stdout
execution:<run UUID>:<attempt UUID>:stderr
execution:<run UUID>:<attempt UUID>:result
```

With `--artifacts ROOT`, private write-once files live under `ROOT/<run UUID>/<attempt UUID>/`:

- `manifest.json`: run/attempt identity, process token and recipe fingerprint only.
- `supervisor.json`, `dispatch.json`, `process.json`: durable supervisor identity, launch intent and native process acknowledgment. Process identity includes PID plus an OS start marker; a bare PID is never sufficient.
- `launch.json`: the supervisor's write-once launch capability. Native dispatch and an explicit database rejection compete for this same file. A rejection stores `no_launch: true`, `DISPATCH_REJECTED`, immutable attempt identity and the exact admitted capacity token; thrown database/native errors do not prove no launch.
- `stdout.log`, `stderr.log`, `result.json`: bounded logs and authoritative direct-child outcome, timing, truncation and cleanup observation.
- `outcome.json`: public result artifact containing exit status, timing, capture counts and hashes, without recovery credentials. The `result` artifact identity addresses this file; private `result.json` is never served by MCP.
- `cancel.json`: an optional bounded cancellation request to the supervisor.
- `termination.json`: immutable recovery-controller process-group termination evidence when the original supervisor is absent.
- `operator-reconciliation.json`: explicit externally confirmed exit/effect evidence, retained separately from original logs and native results.
- `never-started.json`: write-once, fsynced pre-dispatch recovery proof bound to the run, immutable attempt/process identity, recipe fingerprint, and exact host capacity state/execution token captured at admission. It precedes direct pre-start failure and recovered terminal settlement so restart can drain a stranded slot only when the stored outcome and capacity identity match.

Configure the MCP server's `EXECUTION_ARTIFACTS_DIRECTORY` to the same absolute `ROOT` to enable `artifact_read` in the executor or full profile. It accepts `project_id`, an exact published `artifact_id`, a zero-based byte `offset`, `length` (0–65,536 bytes), and `max_tokens` (512–32,768; default 2,048). Responses contain base64 bytes, the stored artifact's SHA-256, the returned range's SHA-256, captured/total/omitted byte counts, and explicit availability. Byte ranges can split a UTF-8 character; base64 preserves those bytes exactly. A zero-length request reads metadata only. New captures hash incrementally; older logs use a bounded streaming hash fallback.

`range.complete` means the whole requested byte range was returned. `response_budget` returns a shorter exact prefix and `next_offset` for continuation; `capture_limit` identifies output discarded after the per-stream recipe cap, and `past_end` identifies a range beyond a complete file. `missing`, `expired`, and `not_configured` return no content. `EXECUTION_ARTIFACT_TTL_MS` defaults to seven days after the private result's finish time; expiry denies reads without deleting files. Missing older public outcome files are reported explicitly. Project membership, the run's published references, immutable attempt identity, and private journal identity are checked before reads. Path/URL references, symlinks, junctions, hard links and cross-project identities are rejected.

`run_get.max_tokens` defaults to 2,048. It retains authoritative status and exit code while omitting large checkpoints or output metadata, with retrieval instructions in `omitted`. Failed executions include an addressable stderr `failure_location`; request the referenced byte range with `artifact_read`. At the smallest budget, run/continuation details also compact with a larger-budget `run_get` retrieval instruction. Artifacts and excerpts are untrusted content; fixed numeric aggregate metrics never label series with their content, identity or credentials.

Client migration: accept `checkpoint: null` and retrieve it through `omitted` before resuming work. A compact `run`/`continuation` keeps status and authoritative process outcome; fetch omitted details with the supplied larger-budget `run_get` request. Existing small run responses retain their full fields. Handle artifact content as base64 bytes, check `range.complete`, and follow `next_offset` when the response budget returns a prefix.

Restrict artifact directories with OS permissions/ACLs; logs may contain secrets and the process token is a trusted recovery credential. Requested file modes apply where supported; configure Windows ACLs separately. Older accepted execution installations retain their original `ROOT/<run UUID>/execution.json` and result/log layout; matching legacy journals are inspected without launching another attempt.

Unverified cleanup retains occupied capacity and an unresolved run even if the direct child has exited. If direct-child close is not observed within 15 seconds after attempted termination, the supervisor exits without inventing completion. Confirmed process-group exit can release physical capacity while external cancellation effects stay unresolved. Natural exit is authoritative only under the foreground recipe contract above. Log retrieval remains separate work.

## Restart and the next safe step

Journals publish a fully written, fsynced temporary file without replacing existing evidence. Never-started cleanup matches the proof's host, queue, run, project, state and execution token in one capacity transaction; a later admission remains occupied. A legacy torn `never-started.json` can gain an immutable `never-started-recovered.json` only while the database still proves the attempt is reserved and undispatched. Terminal attempts without a valid proof retain capacity for manual investigation.

`run_get.reconciliation` exposes `state` (`queued`, `running`, `completed`, `unresolved`), `attempt_id`, and `next_step` through both PostgreSQL and SQLite. The trusted `listExecutionReconciliations` API provides the same state together with the immutable attempt and latest observation; its optional `afterId` cursor scans active runs in immutable ID order. Each companion keeps independent cursors for at most 100 active runs and 100 queued or occupied script entries per pass, wrapping at the end so old unresolved rows cannot starve later recoverable results. Unchanged observations do not append rows on every poll.

| Durable evidence                                                   | Recovery action / next step                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Reserved attempt, before dispatch intent                           | Close as `RECOVERED_NOT_DISPATCHED`; cancel/release only its proven unstarted entry. Never relaunch it.        |
| Dispatch intent without launch/result evidence                     | `unresolved`; inspect launch and side effects. Missing journal or acknowledgment cannot prove non-execution.   |
| Explicit supervisor rejection with a matching no-launch capability | Recover `DISPATCH_REJECTED` and release only the exact proven capacity identity; never relaunch the attempt.   |
| Matching live PID **and OS start marker**                          | `running`; `wait_for_result`. A missing or reused PID leaves side effects unresolved.                          |
| Matching fsynced result with foreground cleanup observation        | Replay the exact outcome, recheck continuation authority, then release the matching host slot.                 |
| Terminal application outcome before capacity release               | Compare the result journal with the exact stored outcome and release its occupied slot without executing work. |
| Missing, partial, mismatched result or unverified cleanup          | `unresolved`; `inspect_side_effects`, preserving pending continuation, attempt history and occupied capacity.  |

The initial dispatch state can expose `inspect_launch`; after inspecting ambiguous evidence the next step is `inspect_side_effects`. The result journal can outlive the controller: actual crash tests cover dispatch, launch acknowledgment and completion-before-database-settlement on both adapters. Completion without a durable journal remains unresolved even if a side effect appears to have happened.

For manual investigation, fence the old controller, inspect exact authorized run/project/attempt IDs and recipe fingerprint, verify process start identity and descendants, and inspect external side effects using their own durable identifiers. Preserve the original observations. Only authoritative matching completion/cleanup evidence permits trusted application recovery and `HostCapacity.takeOver` / `reconcile` with its unchanged original execution token. Neither chat assertions, lease expiry nor PID disappearance authorize `never_started`, capacity release or a fresh run. Any new explicit submission requires the operator to resolve the previous attempt's side effects first; this implementation never retries automatically.

## Controlled upgrade

Stop the MCP runtime/worker and companion, take a consistent backup including SQLite WAL state, migrate with schema-owner privileges, rebuild, then restart and reconnect clients. Do not hot-reload this stack into an old process: the earlier project-memory migration rebuilds a SQLite table, and new adapters require the recovery schema.

Migration identity is the complete filename in `schema_migrations`, not a unique numeric prefix. Preserve the accepted `013_project_memory.sql` / `014_execution_runs.sql` (SQLite `005_project_memory.sql` / `006_execution_runs.sql`) alongside main's independent `013_review_fixes.sql` (SQLite `005_review_fixes.sql`). Their exact names and bytes are retained so either already-applied history upgrades once without replaying ALTERs or losing data. Recovery appends PostgreSQL `015_execution_recovery.sql` and SQLite `007_execution_recovery.sql`. Operator controls append PostgreSQL `016_execution_control.sql` and SQLite `008_execution_control.sql`. Both adapters test main-first and accepted-stack-first upgrade histories, preserving existing tickets, claims, checkpoints, receipts and runs.

## Explicit artifact retention

See [operator artifact retention](artifact-retention.md) to retire an exact expired, unreferenced terminal stdout/stderr capture. Retirement preserves authoritative outcomes, private recovery journals and durable audit/receipt records. It is never automatic or model-controlled.

## Registered recovery playbooks

An operator may add `"recovery": { "signature": "RESOURCE_BUSY", "exit_code": 75, "effects": "none" }` to a pipeline step. This declares that the same pinned foreground command may safely run again after that exact transient failure, with no external effects from the failed attempt. The command must emit only this bounded structured JSON on stderr and exit with the registered code:

```json
{ "kind": "transient_failure", "signature": "RESOURCE_BUSY", "effects": "none", "approval_required": false }
```

The runner validates the complete stderr object (at most 512 captured bytes), never natural-language output. Unknown signatures or effects, required approvals, source/tool changes, uncertain cleanup, cancellation, journal errors, or a repeated failure stop the whole pipeline even when `on_failure` is `proceed`. A known permitted failure gets at most one retry of the exact same command; no alternate recipe, arguments, credentials, permissions, requirements, CI or review policy are changed.

The original step timeout and pipeline deadline include both attempts and recovery overhead. Retry remains inside the original host admission and resource allocation; it never obtains an extra slot or model turn. Each attempt retains its actual exit, signal, errors, bounded diagnostics, runtime, and exact base64 stderr proof with SHA-256 and completeness. Final step status describes the final attempt; a successful retry still exposes the original adverse evidence under `attempts` and `recovery`. Aggregate log counts include both attempts, and the existing result artifact contains the report. Verification reports are bounded to 1 MiB; other execution journals retain their existing bound.

An immutable `pipeline-recovery-start.json` fences the whole invocation. Before another process can start, an immutable `pipeline-recovery-<step>-1.json` records the original failure and retry intent; ordinal 2 records the outcome or a pre-retry refusal. Existing journals are never replaced. An interrupted or ambiguous retry cannot replay when the runner restarts and cannot claim verified cleanup. The trusted companion's existing dispatch, cancellation, capacity, and reconciliation rules remain in force. Operators must register only commands whose no-external-effects contract and foreground lifetime they have verified; an emitted assertion alone does not authorize a recovery.
