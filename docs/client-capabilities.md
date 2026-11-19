# Registered client capabilities

Set `CLIENT_CAPABILITIES_FILE` to an absolute operator-owned JSON file to constrain agent work to registered client installations. Each record binds support to exact actor and project IDs; project membership and normal claim eligibility are still required. MCP clients cannot register themselves or grant tool/provider permissions by advertising support.

```json
{
  "clients": [
    {
      "id": "workstation-codex",
      "actor_ids": ["11111111-1111-4111-8111-111111111111"],
      "project_ids": ["22222222-2222-4222-8222-222222222222"],
      "operating_system": "windows",
      "tools": ["git", "node"],
      "environments": ["local", "container"],
      "models": [{ "id": "registered-model", "efforts": ["medium", "high"] }],
      "expires_at": "2026-11-20T00:00:00.000Z"
    }
  ]
}
```

Replace the example identities, support choices and expiry with verified values. A client ID identifies one installation/environment, with one actual operating system. Models declare their supported efforts independently; effort support on another model never satisfies a pinned pair. Empty effort lists support clients without an effort option. Tool/skill tags use existing ticket `capabilities`; labels retain their existing filtering behavior. Records must have an explicit expiry, and registry files are limited to 1 MiB/128 clients. Restrict OS permissions/ACLs to the operator. Replace the file atomically to update or revoke registrations; active processes reload changed files and deny removed, changed or expired selections before admission.

Projects and tickets may pin `execution_hints` fields `client_id`, `operating_system`, `environment`, `model` and `effort`. Ticket fields override the corresponding project defaults. `work_next` and `work_claim` optionally accept `client_id`, which cannot override a project/ticket pin. Matching filters normal eligible work first, then checks fresh authorized clients, exact choices and all required tools. Clients and unpinned models/environments are chosen in lexical ID order. Unsupported explicit requests return bounded actionable mismatch details; automatic selection skips incompatible work. `work_claim.claim.execution` contains the selected client fingerprint and exact model/effort, OS, environment, required tools and requirements revision. Claim receipts and owner-visible ticket details retain that snapshot.

With no registry, existing model/effort hints and claims retain their advisory behavior. New client/OS/environment requests require a registry and fail closed if none is configured. Enabling registration for a project requires existing workers to release/reclaim legacy claims before registered dispatch.

Trusted dispatchers use the same registry for the application and local host ledger:

```ts
import { loadClientCapabilities, createApplication } from './dist/index.js';
import { HostCapacity } from './dist/host-capacity.js';

const clients = loadClientCapabilities('/operator/clients.json');
const app = createApplication({ storage, search, clientCapabilities: clients });
const host = new HostCapacity('/operator/host.sqlite', clients);

await app.dispatchClientExecution(actorId, projectId, ticketId, claimToken, (execution) => {
  host.enqueue(hostId, {
    ...agentRequest,
    execution,
    admission: { ...agentRequest.admission, model: execution.model },
  });
  const admitted = host.claimNext(hostId, dispatcherId, {
    kind: 'agent',
    queue_ids: [agentRequest.queue_id],
  });
  if (admitted.admitted) {
    // Launch synchronously with execution's exact choices and persist its native/provider identity.
    // Retain the lease/execution token and use the existing heartbeat and reconciliation protocol.
  }
});
```

Create/configure the existing host and usage run before admission. `dispatchClientExecution` holds the project's existing transaction lock while checking membership, live claim, assignment, blockers, current requirements and exact pinned choices through synchronous host admission/launch. On each later dispatch attempt, reenter this boundary before calling `claimNext`; eligibility can change while queued. Do not launch asynchronously after its callback returns. A failed or uncertain database commit must never trigger an automatic launch retry.

`HostCapacity` checks the selected client again immediately before budget/slot admission in its existing SQLite transaction. Pinned model, requirements revision and registry fingerprint must match; expired/revoked queued clients get `unsupported_execution:<reason>` and cannot reserve budget or block compatible work. Existing slot, resource, project fairness and budget rules remain authoritative under concurrency. Already running work retains its occupied slot until the existing termination/reconciliation proof releases it; registry expiry is not proof a process stopped. Capability matching itself makes no provider calls and creates no agent retry loop.
