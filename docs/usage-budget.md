# Optional local usage and admission ledger

`UsageBudget` is a deterministic companion for a trusted local dispatcher. It does not call a model, retry work, claim tickets, or add MCP tools. It uses its own private SQLite file and does not change the ticketing database. Build with `npm run build`; the callable entry points are `dist/usage-budget.js` and `node dist/usage-budget-cli.js`. Node 24+ is required.

Every process dispatching a particular run must share the **same local file**. Admission uses SQLite `BEGIN IMMEDIATE`, a five-second busy timeout, WAL, and full synchronous commits. A lock/open/commit error fails the call and must prevent dispatch. This supports concurrent processes on one host; network filesystems, multiple hosts, distributed quotas, and overall executor capacity are outside this capability. The host must protect the ledger and its directory with its normal account permissions; file mode requests do not configure Windows ACLs.

Create a run before unattended work. `work` freezes the planned ticket/requirements-revision identities, including work that never starts. Limits and project identity cannot be changed by reopening the file or replaying creation. Defaults are six admitted invocations and a 15-minute maximum allowance per invocation. The token budget is mandatory. Runtime defaults to six times 15 minutes. Monetary enforcement is optional (`null`); it never implies that unknown cost is zero.

```json
{
  "run_id": "example-2026-11-18",
  "project_id": "project-id",
  "work": [{ "ticket_id": "ticket-id", "requirements_revision": 3 }],
  "limits": {
    "max_attempts": 6,
    "max_provider_tokens": 120000,
    "max_runtime_ms": 5400000,
    "max_cost_usd_micros": null,
    "invocation_timeout_ms": 900000
  }
}
```

```sh
node dist/usage-budget-cli.js create --ledger .local/usage.sqlite --input-file run.json
```

Admit each worker, reviewer, or separately invoked approval reviewer **before** starting it. The identity, role, actor, provider, model, and allowances become immutable. `retry_of` identifies a settled attempt for the same work/revision and role. A retry consumes another attempt and its own allowances; failures, rejection, cancellation, and failed worktree creation do not refund the admitted attempt count.

```json
{
  "attempt_id": "worker-1",
  "ticket_id": "ticket-id",
  "requirements_revision": 3,
  "actor_id": "worker-id",
  "role": "worker",
  "provider": "provider-name",
  "model": "model-name",
  "retry_of": null,
  "allowance": {
    "provider_tokens": 20000,
    "runtime_ms": 900000,
    "cost_usd_micros": null
  }
}
```

```sh
node dist/usage-budget-cli.js admit --ledger .local/usage.sqlite --run example-2026-11-18 --input-file attempt.json
```

Only `{admitted:true,start_allowed:true}` authorizes a new invocation. Exact admission replay returns `start_allowed:false`, even if the original dispatcher crashed before launching. A changed request under the same attempt ID conflicts. There is no automatic replay dispatch or reservation expiry. Exhaustion, an overdue in-flight call, missing metering needed for enforcement, or an observed allowance overrun exposes `needs_attention` and denies subsequent admissions. Denial persists the stop reason. Inspect the ledger and retained invocation evidence; an operator must resolve the underlying work and explicitly create any newly budgeted run. Starting a new run is a new budget, not a refund or automatic resume of the old one.

The direct API also offers `runInvocation(runId, request, callback)`. It commits admission before calling the callback exactly once, supplies an `AbortSignal` at the runtime allowance, measures wall runtime, and records its result. Return a settlement with `outcome:"failed"` or `"rejected"` to retain reported usage from such outcomes. A thrown exception records a failed invocation with unknown usage/cost and stops further admission. Neither this callback nor the CLI implements an agent reasoning loop or automatic retry. A callback must honor the signal and configure native provider/client limits; an abort signal alone cannot stop a remote charge.

Settle once per admitted invocation with the provider's final cumulative observation, including failed or rejected invocations. Do not sum repeated cumulative events or streamed duplicates. Missing usage, retry counts, runtime, reference counts, estimates, and costs stay `null`. For a known zero after a failure before any provider dispatch, explicitly supply zero usage/cost and `no-provider-dispatch` as their observation sources.

```json
{
  "outcome": "succeeded",
  "usage": {
    "input_tokens": 4000,
    "cached_input_tokens": 3000,
    "cache_write_input_tokens": null,
    "output_tokens": 1000,
    "reasoning_output_tokens": 600
  },
  "usage_source": "retained-client-jsonl:final-event",
  "runtime_ms": 120000,
  "provider_retry_count": null,
  "cost_usd_micros": null,
  "cost_source": null,
  "reference_tokens": 7000,
  "estimated_provider_tokens": 8000,
  "estimated_cost_usd_micros": null
}
```

```sh
node dist/usage-budget-cli.js settle --ledger .local/usage.sqlite --run example-2026-11-18 --attempt worker-1 --input-file settlement.json
```

The usage contract is **inclusive input and output**: cached-read and cache-write tokens are disjoint subsets of input; reasoning tokens are a subset of output. Only input plus output contributes to total provider tokens. Normalize providers that exclude cache tokens from their native input field to this inclusive form before settlement, retaining the original observation at `usage_source`. Do not invent missing subset values. Known costs are integer millionths of USD with an observation/billing source, never a price inferred by this ledger. Non-USD costs require separate reporting; currency conversion is not performed here. Estimates and local reference counts have their own fields and cannot release provider-token or monetary reservations. Separately reported approval-review usage belongs to its own admitted invocation only when it is disjoint from another invocation's reported totals. Unexposed internal retries/review usage remain unknown; configure internal retries off or include all exposed retry usage within the invocation's allowance.

Known settled totals replace the corresponding allowances; unknown totals retain the allowances (or the higher known partial usage) and stop admission for each enforced dimension. A monetary budget requires a non-null cost allowance before admission. With monetary enforcement disabled, costs may remain unknown without stopping an otherwise fully metered run. Reservations survive process exit, timeouts, and cancellation because an external invocation might still be running. A settlement is immutable; exact replay is harmless, changed replay conflicts. Retain raw provider evidence independently for reconciliation.

Allowances bound **admission**, not actual provider billing. Concurrent admissions cannot reserve more than configured limits. Already admitted calls may exceed their allowances; an observed overrun stops new calls, but cannot retract in-flight calls. The possible overshoot is the sum of each already admitted call's actual excess above its reserved allowance. There is no finite monetary/token bound unless the provider/client enforces one. Runtime aborts also depend on callback/client cooperation. Reports retain actual overruns rather than clipping them to the reservation.

Record independent acceptance from a trusted authenticated ticketing read, not the runner's declaration of success. Supply the selected snapshot fields below, retaining a reference to the authenticated observation in `source`:

```json
{
  "source": "authenticated-ticket-get:retained-observation",
  "ticket": {
    "id": "ticket-id",
    "project_id": "project-id",
    "requirements_revision": 3,
    "status": "done",
    "approved_submission_id": "submission-id"
  },
  "submission": {
    "id": "submission-id",
    "project_id": "project-id",
    "ticket_id": "ticket-id",
    "actor_id": "worker-id",
    "requirements_revision": 3
  },
  "review": {
    "id": "review-id",
    "project_id": "project-id",
    "ticket_id": "ticket-id",
    "submission_id": "submission-id",
    "actor_id": "reviewer-id",
    "decision": "approve"
  }
}
```

```sh
node dist/usage-budget-cli.js accept --ledger .local/usage.sqlite --run example-2026-11-18 --input-file accepted.json
node dist/usage-budget-cli.js report --ledger .local/usage.sqlite --run example-2026-11-18
```

The companion checks project/ticket/submission/revision consistency, the approved submission, and distinct submitter/reviewer actors. It does not authenticate the supplied snapshot or authorize the reviewer: that remains the trusted host's responsibility using the coordination service. This CLI is an operator boundary, not an untrusted worker permission endpoint. Self-approved work and success-only runner output cannot establish the independent accepted-work denominator. Acceptance is immutable and deduplicated by ticket plus requirements revision. A later requirement revision belongs to a separate work identity and does not rewrite historical acceptance.

Reports retain every invocation and settlement, totals by run, role, and work revision, and the accepted submission/review snapshot for each completed work identity. All token/cache/reasoning, runtime, retry, billing, reference, and estimate metrics expose `known_total` and `unknown_invocations`. In-flight calls count as unknown observations and remain reserved. `budget_charged_or_reserved` is explicitly separate from measured usage. Completion retains planned, independently accepted, and unfinished counts; provider tokens per accepted work includes failures and reviews and is `null` if the denominator is zero or any invocation total is unknown. Unknown is never silently converted to zero for an accepted-work rate.

CLI exit codes: `0` for a successful operation, `2` for denied admission or a report requiring attention, `1` for invalid input/storage/conflict errors. Every command is offline and makes zero paid model calls.
