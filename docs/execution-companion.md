# Durable local script companion

The optional companion runs operator-registered finite foreground scripts in a separate Node 24+ process. Start it independently of the MCP server/client: closing the submitting chat or MCP connection does not terminate that process. It makes no model calls, uses no agent token budget, and never retries an execution. MCP `run_submit` selects only a registered recipe ID and atomically stores its checkpoint, immutable recipe fingerprint and exit-code continuation; `run_get` reads that exact authorized project run later. These tools use the `full` MCP profile.

## Trusted host contract

Recipes, executables, script files, workspaces, environment and artifact directory are operator-owned. Register only finite foreground work that waits for its children, never detaches/backgrounds work, and never escapes the supervisor. This is a trusted local execution boundary, not an OS sandbox for untrusted scripts. A normal exit, including a nonzero exit, is authoritative under this contract. CPU/memory declarations are HostCapacity admission estimates, not OS resource enforcement.

Timeout, cancellation and lost ownership attempt to terminate the direct child through Node's child handle. A child handle cannot prove the whole process tree stopped. Such executions, and exits observed with an external/native signal, remain running/reserved in the application and occupied/reconciling in HostCapacity even when the direct child's exit was observed. There is no bare-PID `taskkill`, automatic rerun or automatic lease release. Restart reconciliation preserves these unresolved executions. OS process-tree containment is not provided: a natural foreground exit relies on the registered recipe contract, and `cleanup_verified` is not independent OS tree proof.

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
- `cancel.json`: an optional bounded cancellation request to the supervisor.
- `never-started.json`: write-once, fsynced pre-dispatch recovery proof bound to the run, immutable attempt/process identity, recipe fingerprint, and exact host capacity state/execution token captured at admission. It precedes direct pre-start failure and recovered terminal settlement so restart can drain a stranded slot only when the stored outcome and capacity identity match.

Restrict artifact directories with OS permissions/ACLs; logs may contain secrets and the process token is a trusted recovery credential. Requested file modes apply where supported; configure Windows ACLs separately. Older accepted execution installations retain their original `ROOT/<run UUID>/execution.json` and result/log layout; matching legacy journals are inspected without launching another attempt.

Timeout, cancellation, native signals and unverified cleanup retain occupied capacity and an unresolved run even if the direct child is known to have exited. If direct-child close is not observed within 15 seconds after attempted termination, the supervisor exits without inventing a completion. A normal exit is authoritative only under the finite foreground recipe contract above. Retrieving log bodies/ranges through MCP remains separate work; this companion exposes references and exact run metadata.

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

Migration identity is the complete filename in `schema_migrations`, not a unique numeric prefix. Preserve the accepted `013_project_memory.sql` / `014_execution_runs.sql` (SQLite `005_project_memory.sql` / `006_execution_runs.sql`) alongside main's independent `013_review_fixes.sql` (SQLite `005_review_fixes.sql`). Their exact names and bytes are retained so either already-applied history upgrades once without replaying ALTERs or losing data. Recovery appends PostgreSQL `015_execution_recovery.sql` and SQLite `007_execution_recovery.sql`. Both adapters test main-first and accepted-stack-first upgrade histories, preserving existing tickets, claims, checkpoints, receipts and runs.
