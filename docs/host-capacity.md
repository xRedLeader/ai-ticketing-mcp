# Local host capacity companion

`HostCapacity` is an optional callable dispatcher companion in `dist/host-capacity.js` (Node 24+). It makes no model calls, runs no reasoning/retry loop, and changes no MCP tools or ticket-storage adapters. Its private local SQLite file also holds the real [SELF-10 usage ledger](usage-budget.md). Every dispatcher for one physical host must use the same file and host ID. SQLite must be on a local filesystem; separate files or different host IDs cannot coordinate the same machine.

```ts
import { HostCapacity } from './dist/host-capacity.js';

const host = new HostCapacity('.local/dispatch.sqlite');
host.configureHost('workstation'); // Two agent invocations AND two script jobs by default.
// Or configure immutable limits before first use:
// host.configureHost('workstation', {
//   agent_slots: 2, script_slots: 2, cpu_millis: 4000,
//   memory_bytes: 8 * 1024 ** 3, lease_ms: 60_000, script_timeout_ms: 1_800_000,
// });

host.createRun({
  run_id: 'implementation',
  project_id: 'project',
  work: [{ ticket_id: 'ticket', requirements_revision: 1 }],
  limits: { max_provider_tokens: 10000 },
});
host.enqueue('workstation', {
  queue_id: 'worker-1',
  run_id: 'implementation',
  kind: 'agent',
  created_at: Date.parse('2026-11-18T12:00:00Z'),
  priority: 3,
  resources: { cpu_millis: 1000, memory_bytes: 1024 ** 3 },
  admission: {
    attempt_id: 'worker-1',
    ticket_id: 'ticket',
    requirements_revision: 1,
    actor_id: 'worker',
    role: 'worker',
    provider: 'provider',
    model: 'model',
    allowance: { provider_tokens: 2000, runtime_ms: 60_000, cost_usd_micros: null },
  },
});
host.enqueue('workstation', {
  queue_id: 'check-1',
  run_id: 'checks',
  project_id: 'project',
  kind: 'script',
  created_at: Date.now(),
  timeout_ms: 60_000,
});

const admission = host.claimNext('workstation', 'dispatcher-process-1');
if (admission.admitted) {
  // Launch exactly once here. Persist lease + request.execution_token with
  // native supervisor/provider execution identity before handing off control.
  // Respect request.timeout_ms and heartbeat(admission.lease) while owned.
} else {
  // Return control or await a bounded asynchronous wake-up, then revalidate
  // ticket eligibility before another claimNext. No model call is needed.
  await host.waitForChange('workstation', admission.revision, { timeout_ms: 30_000 });
}
host.close();
```

Agent admission validates the run's project/work identity and invokes the actual `UsageBudget.admit` within the same `BEGIN IMMEDIATE` transaction that saves its occupied host slot. Provider-token/runtime/cost reservations and slot/resource occupancy cannot half-commit or race across processes. An attempt can only be queued once across hosts in the file. Request replay never returns launch permission. Standalone `UsageBudget` remains available, but capacity-managed dispatchers must use `HostCapacity`; its public interface intentionally exposes no raw `admit`, `runInvocation`, or `settle`. Drain or reconcile existing standalone invocations before enabling host management: their physical host cannot be inferred from SELF-10 records.

Scripts need trusted `project_id`, an opaque coordination `run_id`, and a timeout bounded by the host's `script_timeout_ms`. The default script timeout and maximum are 30 minutes; SELF-10's default agent invocation timeout remains 15 minutes. An explicit script timeout above the configured maximum is rejected. Scripts need no usage-budget run, provider, model, or token allowance. They consume script slots and declared resources, and remain runnable when an agent budget requires attention. They never charge an agent invocation or token quota. For agents, project identity always comes from the usage run. CPU/memory values are explicit host-supervisor estimates in millicores and bytes; omitted values are zero, and absent host resource limits mean only the separate slot limits apply. This is admission accounting: the native supervisor must enforce process/resource/time limits. The ledger cannot terminate a process or enforce provider caps.

The trusted dispatcher supplies authenticated coordination snapshots for eligibility, priority, original ticket `created_at`, scheduling policy, and unfinished direct-dependent counts. `setEligible` changes queued eligibility; a claim does not itself claim a ticket or refresh coordination state. Recheck eligibility and obtain the normal ticket claim before launching; reconcile a confirmed no-start if that claim fails. All queued entries for a project must use one policy; refresh a policy only after its queue drains. Within each project, `priority_age` uses strict priority, creation time, ticket ID, and queue ID. `unblocking` keeps strict priority, then the at-least-24-hour FIFO group, then younger work by unfinished direct-dependent count descending and creation/ID ties. Selection uses one fixed timestamp. Across eligible projects, least recently served wins, with project ID as a deterministic initial/tie order. This prevents a busy high-priority project from starving another project while preserving priority/aging within each project.

Work that can never fit configured CPU/memory limits is rejected at enqueue. A denied SELF-10 run is latched `needs_attention` by the existing budget policy, and other eligible projects still progress. A temporarily non-fitting fair request reserves the next opening of the slot kind or scarce resources it needs; smaller competing jobs cannot repeatedly displace it. Independent slot kinds and jobs using none of those scarce resources may continue. This can intentionally leave spare resources idle until existing work terminates. Fairness requires continuously eligible work, finite observed executions, and eventual reconciliation of abandoned slots.

`claimNext` returns either one durable launch permission or `waiting` with revision, per-item reasons and `retry_after_ms:1000`. Unchanged saturated checks do not change the revision. `waitForChange` uses asynchronous exponential backoff (100ms to 1s), durable revision reads across processes, a bounded timeout, and optional abort signal; it never busy-waits or invokes a model. Callers must await this or the returned delay before retrying. Queue/lease/reconciliation changes wake waiters within the polling bound; lease expiry is also observed during checks.

Cancellation, timeout, owner heartbeat loss, process failure, and host restart never free an occupied slot or refund usage themselves. `cancel` changes an occupied entry to `reconciling`; an expired lease does likewise. Heartbeats cannot extend past the request runtime allowance. After restart, call `takeOver(hostId, queueId, expectedGeneration, newOwnerId)`: it rotates ownership generation/token, invalidates former-owner heartbeats and settlements, and returns `start_allowed:false`. The original `execution_token` stays fixed, so a supervisor can find the original process/provider request. There is no automatic replay of an invocation whose launch is uncertain.

Release requires a current fenced lease and an independent terminal observation from the trusted native supervisor/provider, never a worker's assertion that it finished:

```ts
host.reconcile(lease, {
  source: 'authenticated-provider-terminal-event',
  execution_token: originalExecutionToken,
  observed_at: Date.now(),
  state: 'terminated',
  settlement: {
    outcome: 'failed',
    runtime_ms: 1200,
    usage: { input_tokens: 100, output_tokens: 50 },
    usage_source: 'provider-request-123-final-usage',
  },
});
// For scripts, supply script_result:{outcome:'failed',runtime_ms:1200}
// instead of settlement. It must confirm the native process has terminated.
```

`state:'never_started'` requires supervisor-confirmed cancelled outcome, zero runtime, and (for agents) observed zero input/output usage. Stale ownership, mismatched execution identity, future/pre-admission timestamps, invalid usage, and conflicting reconciliation replay fail without release. Agent settlement and slot release commit together; identical reconciliation replay is harmless. Terminal unknown provider usage keeps SELF-10's full allowance charged and latches attention, even though confirmed termination allows the physical slot to be reused by other work. Snapshot provenance and process termination are the trusted host's responsibility: this local operator API validates identity/consistency and does not authenticate caller-supplied observations. Keep the ledger and its API out of untrusted workers' reach.

Verification: `node --import tsx --test --test-concurrency=1 tests/host-capacity.test.ts tests/usage-budget.test.ts`. Tests use durable real SQLite, concurrent Node processes, and injected write failures to verify atomic admission/release, restart fencing, resources, scripts, deterministic fairness, and waiting.
