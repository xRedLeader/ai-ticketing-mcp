# Optional local model routing

`scripts/model-routing.ts` is an opt-in host companion for an explicitly selected worker model/effort. It does not change server defaults, install a dispatcher, choose a route automatically, or promote an experiment. `src/model-routing.ts` contains its policy decision checks. Use `runModelRoute` for execution; the pure decision helper alone does not verify artifacts or admit an invocation.

The scope is `protocol-workflows-v1`: the frozen `short`, `long`, `history`, `review`, `blocked`, and `requirements_change` coordination workflows. The declared capabilities are `coordination_claim`, `coordination_resume`, `coordination_review`, `coordination_blockers`, and `coordination_changes`. These fixtures qualify coordination behavior only. Five fixtures check authoritative self-policy completion; the `review` fixture also requires a separate reviewer. Synthetic coordination evidence does not qualify a general coding route or prove implementation quality.

An explicit `route_id` selects an allowlisted OpenAI model/effort pair. `model_pin` and `effort_pin` must match it. Requested capabilities must be both allowlisted and covered by this scope. A mismatch, unknown route, disabled alternate routing, failed artifact check, or budget rejection stops the invocation and returns the reason. There is no fallback or automatic retry.

## Budgeted real-client evaluation

Use the existing [real-client harness](real-client-benchmark.md) for both a matched baseline and candidate. Keep the runtime build, contract, CLI version, harness source, server fixture, and reviewer model/effort fixed. Vary only the intended worker model/effort. The historical `self2-live` report has different runtime/client provenance and does not qualify a current route.

For example, a coordinator can explicitly provision one [UsageBudget](usage-budget.md) run with work identities `pinned:short` through `pinned:requirements_change` and the equivalent `candidate:*` identities, all at scope revision `1`. These identify evaluation workloads, not independently accepted production tickets. Budget limits and per-call reservations must be chosen and authorized before starting provider work. Both roles reserve from the same ledger.

```powershell
# Baseline; add the same explicit --runtime, --revision and --codex-bin to both arms.
tsx scripts/real-client-benchmark.ts --run pinned --model gpt-6.1-sol --effort xhigh --reviewer-model gpt-6-astra --reviewer-effort xhigh --budget-db STUDY.sqlite --budget-run STUDY --invocation-token-allowance AUTHORIZED_PER_CALL_TOKENS
# Candidate
tsx scripts/real-client-benchmark.ts --run candidate --model gpt-6.1-sol --effort high --reviewer-model gpt-6-astra --reviewer-effort xhigh --budget-db STUDY.sqlite --budget-run STUDY --invocation-token-allowance AUTHORIZED_PER_CALL_TOKENS
```

All three budget flags are required together. The harness stores them, the timeout, and separate worker/reviewer efforts in the report. It admits each role before opening its maintenance sidecar or launching Codex, then settles every successful, failed, and partial call. Attempt IDs are `RUN:ATTEMPT_UUID:ROLE`; work IDs are `RUN:WORKFLOW`, revision `1`. Explicit retries link to the preceding settled role admission. A denied call starts neither Codex nor the maintenance sidecar. Resume preserves the pinned budget configuration and timeout. Standalone unbudgeted benchmark runs remain available, but cannot qualify routing evidence.

Pin each completed report's SHA-256, retain its original runtime/artifact directory and study SQLite ledger, and call `verifyRoutingEvaluation({ report, sha256 })`. Verification rereads all raw invocations, including failures and retries, checks their usage and request model/effort, detects omitted attempt directories and role logs, revalidates every attempt against its read-only fixture state, verifies runtime and harness hashes, and compares the report's budget snapshot against the retained ledger's actual role admissions and settlements. An unbudgeted report, unsettled or omitted admission, changed snapshot, or study ledger requiring attention cannot qualify.

The gate requires all six workflows to complete in both arms, a fixed reviewer and matched evaluation environment, no increase in failed attempts, no workflow token regression, and the policy's minimum aggregate reported input-plus-output token reduction. Failed attempts contribute to all usage totals. Unknown input/output usage prevents promotion. Cached input, cache writes, reasoning, provider retries, monetary cost, and approval-review usage remain separately known or unknown; reference tokens are never substituted for provider usage. The CLI does not report the actual provider model identity or separately report approval-review usage.

## Explicit companion invocation

Create a versioned policy from the verified baseline's `environment` and fixed `reviewer`, the explicit route allowlist, and pinned baseline/candidate report references. `enabled` must be explicit. Set `minimum_token_reduction` to the required measured reduction (for example `0.1` for ten percent); its default is zero. No alternate qualifies until its actual artifacts pass the gate.

```typescript
import { UsageBudget } from '../src/usage-budget.js';
import { runModelRoute } from '../scripts/model-routing.js';

const ledger = new UsageBudget(localLedgerPath);
try {
  const decision = await runModelRoute(
    policy,
    {
      route_id: 'candidate',
      model_pin: 'gpt-6.1-sol',
      effort_pin: 'high',
      required_capabilities: ['coordination_claim'],
    },
    ledger,
    explicitlyProvisionedRunId,
    { attempt_id, ticket_id, requirements_revision, actor_id, allowance },
    async (route, signal) => launchExistingClientAndObserveUsage(route, signal),
  );
  // Persist/display the complete decision, including denials and unknown usage.
} finally {
  ledger.close();
}
```

The callback uses the existing launched-client arguments and passes through the selected effort and cancellation signal. Return an observed `UsageBudgetSettlement` without `runtime_ms`; the ledger measures runtime. Report failed calls as failed and preserve absent provider fields as `null`. A thrown callback records a failed attempt with unknown usage and surfaces the error. Reusing an admitted attempt identity never invokes the callback again.

The returned decision includes the full explicit configuration, policy revision, requested pins/capabilities, selected route, pinned evaluation proofs, per-workflow and aggregate known/unknown usage, retained study admissions, execution admission, and current execution ledger report. The host must keep this result visible when a route is denied or a client fails. The execution ledger is required even after evaluation succeeds.

This is a local single-host trust boundary: evidence must stay on trusted storage. Admission allowances are estimates, not provider-enforced token caps; an admitted call may exceed its reservation. The existing timeout and cancellation behavior still apply. No real model trial is run by unit tests, and deterministic tests never count as promotion evidence.
