# Durable local script companion

The optional companion runs operator-registered finite foreground scripts in a separate Node 24+ process. Start it independently of the MCP server/client: closing the submitting chat or MCP connection does not terminate that process. It makes no model calls, uses no agent token budget, and never retries an execution. MCP `run_submit` selects only a registered recipe ID and atomically stores its checkpoint, immutable recipe fingerprint and exit-code continuation; `run_get` reads that exact authorized project run later. These tools use the `full` MCP profile.

## Trusted host contract

Recipes, executables, script files, workspaces, environment and artifact directory are operator-owned. Register only finite foreground work that waits for its children, never detaches/backgrounds work, and never escapes the supervisor. This is a trusted local execution boundary, not an OS sandbox for untrusted scripts. A normal exit, including a nonzero exit, is authoritative under this contract. CPU/memory declarations are HostCapacity admission estimates, not OS resource enforcement.

Timeout, cancellation and lost ownership attempt to terminate the direct child through Node's child handle. A child handle cannot prove the whole process tree stopped. Such executions, and exits observed with an external/native signal, remain running/reserved in the application and occupied/reconciling in HostCapacity even when the direct child's exit was observed. There is no bare-PID `taskkill`, automatic rerun or automatic lease release. OS containment and restart reconciliation belong to SELF-9.

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

Timeout defaults to 30 minutes and cannot exceed it. Each stdout/stderr file defaults to 1 MiB, with a configured maximum of 16 MiB each. Both pipes continue draining after the retained byte limit, so truncation does not deadlock the child. Recipe IDs are at most 80 characters. The SHA-256 fingerprint covers normalized registration, including argv, cwd, environment, limits and project allowlist. It does not hash executable/script contents: the operator must protect those files and bump registration when changing their meaning. Changing/removing a recipe does not silently redirect an already submitted job; it fails before spawn.

## Starting the process

Build with `npm run build`. Use a dedicated registered project-admin actor for the trusted companion APIs. The submitting agent still uses its own normal claim and contributor permissions.

```powershell
$env:EXECUTION_RECIPES_FILE = 'G:\Work\operator\recipes.json'
node dist/execution-companion-cli.js --sqlite 'G:\Work\operator\tickets.sqlite' --actor ACTOR_UUID --project PROJECT_UUID --capacity 'G:\Work\operator\host.sqlite' --host workstation --artifacts 'G:\Work\operator\execution-artifacts'
```

For PostgreSQL, omit `--sqlite` and supply the normal storage environment. The companion forces embeddings off. `--once` processes at most one queued job and exits; without it the process waits between queue checks. Use an independent terminal, service or an operator-managed hidden background process so its lifetime is independent of the MCP connection. The CLI prints a startup event with its PID; it never launches itself from MCP.

All dispatchers on the physical host must share the same local HostCapacity SQLite file **and host ID**. A missing host gets the existing two-script/two-agent defaults. Preconfigure immutable host limits through `HostCapacity.configureHost` if required. Separate host files/IDs cannot coordinate physical capacity.

The ordering is application reservation CAS, HostCapacity admission, application start CAS, ownership recheck, native spawn. Concurrent companions cannot both reserve the same job. Admission uses an exact script queue ID filter and cannot steal agent work or another script; if the next eligible script belongs to another dispatcher, it waits rather than bypassing the existing ordering. Ordinary unfiltered SELF-29 admission is unchanged. A companion processes one job at a time. Capacity admission waits at most 30 seconds; exhaustion records `CAPACITY_TIMEOUT` with no spawn and cancels its queued capacity entry. The wait and normal idle checks are asynchronous, at most one second apart. Application and capacity heartbeats keep their independent fences live.

## Results and files

For verified normal completion, fsynced separate logs and `result.json` precede the durable application terminal result, which precedes capacity release. Exact exit codes and signals are retained, including nonzero/native Windows exit codes. Continuation success uses the submitted expected exit code; an exit result does not itself accept a ticket or resume a model. The authorized exact `run_get` response carries bounded references such as:

```text
execution:<run UUID>:stdout
execution:<run UUID>:stderr
execution:<run UUID>:result
```

These are opaque references, not MCP-visible arbitrary file paths. With `--artifacts ROOT`, the private files are exactly:

```text
ROOT/<run UUID>/execution.json
ROOT/<run UUID>/stdout.log
ROOT/<run UUID>/stderr.log
ROOT/<run UUID>/result.json
```

`execution.json` links the run/recipe fingerprint and original fenced capacity lease. `result.json` retains PID, start/end times, direct-child exit/signal/error, retained byte counts, truncation flags and `cleanup_verified`. Files/directories are created exclusively and never overwritten by retry. Restrict OS permissions/ACLs: raw logs may contain secrets. File modes are requested on platforms that support them; configure Windows ACLs separately.

`cleanup_verified:false` preserves an authentic **direct-child observation only**, not a terminal application result or proof of tree termination. The application run remains running and capacity remains occupied. If close itself is not observed within 15 seconds after a termination attempt, the companion fails closed without inventing an exit result. `execution.json` and whatever logs were captured remain available to the operator. Retrieval of log bodies/ranges through authorized MCP is SELF-15; SELF-7 exposes references and exact run metadata only.

## Crash gaps and trusted reconciliation

Application storage and host capacity are different stores. A process crash can leave a reserved/running job and an occupied or queued capacity entry. Restart discovers new queued application jobs only; it never reclaims, requeues, respawns or releases an abandoned reservation. A crash after terminal application commit but before capacity release leaves the exact terminal result available through `run_get` and an occupied slot. A crash before that commit may leave only local observations, even if the process really exited. SELF-9 must finish application crash recovery; do not report these cases as already handled.

For a **terminal application run** whose matching `result.json` has `cleanup_verified:true`, an operator can finish the terminal-before-release gap without launching anything:

1. Stop/fence the old companion. Read the exact authorized `run_get`; verify terminal status, run/project IDs, recipe fingerprint, exit/signal/error and artifact references against the private files. Verify the finite foreground recipe completed under the host contract. Do not infer termination from lease expiry or a missing/reused PID.
2. Open the shared `HostCapacity` file with its trusted local API. Locate the exact entry with `queue_id === run.id`, `run_id === run.id`, matching `project_id`, `kind === 'script'`, and state `running`/`reconciling`. Compare its lease to `execution.json` and retain the immutable `execution_token`.
3. Fence the old owner with `takeOver(hostId, run.id, entry.lease.generation, operatorOwnerId)`. This returns a new lease and the **same original execution token**, with `start_allowed:false`.
4. Call `reconcile` with that new lease and the preserved token, `source:'trusted-operator-terminal-verification'`, `observed_at:result.finished_at`, `state:'terminated'`, and `script_result:{outcome, runtime_ms:result.finished_at-result.started_at}`. Use `outcome:'succeeded'` for exit 0 without error, otherwise `'failed'`. This releases only the verified matching capacity entry.

If the application is still reserved/running, cleanup is unverified, files disagree, ownership was lost, or a process/tree could still exist, leave it occupied and retain the evidence for SELF-9/operator investigation. `never_started` requires independent proof that no spawn occurred; a crash between admission and start is not that proof. No MCP/client assertion, timeout or stale lease authorizes release.
