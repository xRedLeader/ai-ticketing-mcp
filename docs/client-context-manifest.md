# Client context manifest

[The SDK example](../examples/context-manifest.ts) retains exact canonical context packets and artifact byte ranges in one client's memory. It uses the existing `ticket_context` fingerprint and stable success-envelope serialization; the server keeps no context cache or delta state. It adds no tools, profile changes, dependencies, or migrations.

Use an already connected official SDK `Client`:

```ts
import { createContextManifest } from '../examples/context-manifest.js';

const manifest = createContextManifest(client);
const packet = await manifest.context({ project_id, ticket_id, max_tokens: 4096 }, 'execution');
// Present packet.context and packet.retrieved to this worker before continuing.

// Executor/full profiles can also retrieve exact evidence bytes.
const pages = await manifest.artifact({ project_id, artifact_id, offset: 0, length: 4096 });
// Present every page; inspect status, truncation and unavailable_reason before treating it as evidence.
```

Use `review` for an independent reviewer's required omissions. Each returned packet includes the current requirements and every paginated retrieval marked `required_before` for that purpose. Optional omission references remain executable in `packet.context.omitted`. Artifact references in a context packet identify evidence; retrieve its bytes separately through `manifest.artifact` whenever the work requires their contents.

A warm context read still calls `ticket_context` and rechecks current server authorization. The helper opts into bound recovery through MCP request metadata `_meta['ticketing/context-manifest']:true`; ordinary reads retain their existing bodies and fingerprints. Bound context, checkpoint and history responses carry an opaque authorization binding from the same authorized snapshot as their data. Every required page must match the initial actor, project role and actual profile, including when credentials switch away and back on one transport. After any required follow-up, a final conditional context read verifies the requirements and authorization again before returning or retaining the packet.

Only an exact locally retained complete packet supplies `if_none_match`. A matching response returns a fresh copy of that entire packet, including checkpoint identities, revisions and required follow-up bodies. Changed fingerprints trigger full context and required follow-up reads. A change during recovery fails closed and clears retained material; call again to obtain the current complete packet. A caller-supplied fingerprint cannot replace retained material.

Artifact reuse first calls authorized `artifact_read` with `length:0`. Available status, SHA-256, size and all capture metadata must match the locally retained version. Every response includes an opaque `authorization_binding` computed after access checks from the authenticated actor, current project role and actual MCP profile; its bytes count toward the response budget. Any mismatch, including a bearer, role or profile change on the same SDK transport, forces full reads. Budget-limited responses are followed with advancing ranges until that request is satisfied or the server explicitly reports a capture gap or end of file. Each page's identity, authorization binding, offset, byte count and SHA-256 are checked; pages from different actors or artifact versions cannot be combined. The helper requires binding-enabled responses and fails closed when the binding is absent. Unavailable artifacts never fall back to old bytes.

The manifest is private to the actual SDK `Client` and current transport/profile instructions. Another client, a fresh process, or reconnecting with another transport starts with no retained material, including when credentials are the same. Nothing is written to disk or exported for another role. Call `manifest.forget()` when dropping local material or to bound memory in a long-lived client. Current authorization, live claims, expected revisions, and independent review rules continue to control mutations.

The helper makes retained material available to its caller; the caller must actually present it to the relevant worker or reviewer before recording information-delivery proof. A fingerprint, metadata result, another role's prior read, or this helper's return alone does not establish model delivery. Count every actual `Client.callTool` invocation, including metadata checks, required omissions, pagination, final context verification, fallback reads and failed attempts. Re-presenting a retained packet to a model still consumes that model's input budget.

## Verification

Run with Node 24 and installed project dependencies:

```sh
node --import tsx --test tests/context-manifest.test.ts
```

The real HTTP SDK tests instrument every tool request and complete SDK result, check canonical delivered bodies, and print cold/warm protocol reference-token counts. One local run read context, all required history and final verification in eight calls (25,773 reference tokens), then reused the exact packet after one authorized check (355 tokens). A 1,300-byte artifact under a 512-token response budget took nine calls (8,602 tokens), then one authorized metadata check (694 tokens). UUIDs and packing boundaries vary between runs. These are synthetic transport measurements, exclude connection/discovery overhead, and do not establish billed or model-input savings. Fresh clients and reconnects repeat all required reads; tests also cover same-transport bearer/profile/role changes, transient identity changes during required context retrieval, requirements changing during recovery, a bearer switch during artifact pagination, changed checkpoints, stale mutation rejection, revoked/restored membership, missing local material, and changed/missing artifact captures.

The existing frozen protocol workflow fixtures and worker catalog remain unchanged. Run `node --import tsx scripts/protocol-benchmark.ts` with `PROTOCOL_DATABASE_URL` pointing to a disposable PostgreSQL database to check their existing gates.
