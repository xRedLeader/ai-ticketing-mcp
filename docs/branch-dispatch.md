# Parallel branches and verified joins

`BranchDispatcher` is an opt-in trusted-host API. It dispatches native `work_claim` receipts through the existing registered-client, usage-budget and `HostCapacity` checks. It adds no MCP tools, provider, command runner or autonomous scheduling loop. The operator supplies a synchronous `launch(context, invocation)` callback; that callback starts work and returns immediately so independent branches can run concurrently.

Apply PostgreSQL `031_branch_dispatches.sql` or SQLite `023_branch_dispatches.sql` before enabling this API. Both built-in adapters advertise `branchDispatches: true`. Custom adapters can omit the capability and retain ordinary workflow behavior. Exhaustive TypeScript `Tables` mappings must add `branch_dispatches` when upgrading the exported adapter contract.

Construct the dispatcher with `application`, a shared `capacity`, worker `actor_id`, `project_id`, `host_id` and `launch`. Call `runOnce` with up to 128 already claimed branches:

```ts
const results = await dispatcher.runOnce([
  {
    ticket_id: claimed.ticket.id,
    claim_token: claimed.claim.token,
    budget_run_id: budgetRun,
    provider: 'registered-provider',
    allowance: { provider_tokens: 1000, runtime_ms: 60_000, cost_usd_micros: null },
    // Optional: pin an earlier getDependencyJoin snapshot.
    join_identity: join.identity,
  },
]);
```

The launcher receives the current registered execution selection, worker/ticket/requirements identities and verified join snapshot. The invocation contains the original host, deterministic queue ID and random execution token. The host owns containment, claim/capacity heartbeats and independent exit/usage observation. Ticket text never supplies executable authority. Scheduling and native claims remain the caller's responsibility; each branch failure is returned separately so other eligible branches can progress.

`Application.getDependencyJoin(actorId, projectId, ticketId)` reads one authorized snapshot of existing blocking links and direct children. `ready` requires every branch to be `done` with its approved submission belonging to the same project/ticket and current requirements revision, matching milestone acceptance. The snapshot includes those exact submission IDs and evidence; its SHA-256 `identity` binds this proof to the target's current requirements. Failed, cancelled, pending and superseded branches never satisfy a join. Failed or cancelled observed attempts expose retry state, while accepted current evidence supersedes prior attempt failures. Ordinary parent cancellation/completion semantics are unchanged; the stricter accepted-child rule applies to this managed dispatch seam.

The application validates this proof again under the project mutation lock before admission and synchronous launch. Dependency edits already use the existing cycle checks and transitive invalidation; there is no second graph. Native review policy remains authoritative. Process exit, host success, worker messages and duplicate completion events never accept branch evidence or integrate a join.

One durable ticket-store fence binds each attempt to its claim, requirements, join, budget run, host and capacity-ledger identity. It commits before local admission. Concurrent schedulers, separate hosts and replacement claims cannot overlap unresolved ownership. Host ledgers have stable random identities; preserve the same ledger file, including WAL state, across restarts. Never clone a ledger into independent active authorities. A changed/missing original ledger or uncertain launch requires attention rather than takeover.

`waiting` means no capacity admission occurred. `running` means the synchronous callback returned. `needs_attention` retains uncertain admission/launch ownership and never replays the callback; an error or crash can occur after native launch but before ticket-store finalization. Replays preserve that ambiguity. `settled` reports reconciled native outcome, not ticket acceptance. Keep the exact invocation for supervisor reconciliation.

Call `dispatcher.reconcile(invocation, observation)` with independent exact execution-token exit and usage proof. It also recovers an admission that committed locally before the ticket transaction rolled back, even if the old native claim expired or was replaced. Lease expiry and claim release never prove exit. Repeated identical settlement is idempotent, and stale proof cannot finish a replacement attempt.

`reconcileNeverAdmitted(originalRequest)` can finish only the exact original ledger/host/budget/claim when it has no admission or budget attempt; it cancels only that never-admitted queued entry. New-claim retries on the same authority perform this cleanup before replacing an old fence. Unknown or occupied predecessors remain fenced. An explicit retry needs a fresh native claim and `retry_of` set to the original settled queue ID; no automatic retry is scheduled.

Managed branches and managed wake continuations exclude each other's unresolved ownership. Direct `dispatchClientExecution` calls are also rejected while a managed fence exists. That older API is a trusted synchronous callback without durable ownership for an unmanaged launch: a direct launch made first cannot be retroactively proven terminated. Do not mix unmanaged direct launch and managed branch dispatch for the same ticket. The repository has no production direct-agent launcher using that older seam.

Custom adapters must serialize all fence reservation, launch and reconciliation transitions under the existing project transaction and preserve every field, including JSON `dispatch`. Reject deleting these records with `IMMUTABLE_BRANCH_DISPATCH`. Run `registerBranchDispatchContractTests` from `src/testing/branch-dispatch-contracts.ts` against a reopenable store; execution-history queries remain guarded by the separate optional `executionRuns` capability.
