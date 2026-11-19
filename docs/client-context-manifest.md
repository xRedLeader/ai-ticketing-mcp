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

A warm context read still calls `ticket_context` and rechecks current server authorization. Only an exact locally retained complete packet supplies `if_none_match`. A matching response returns a fresh copy of that entire packet, including checkpoint identities, revisions and required follow-up bodies. Changed fingerprints trigger full context and required follow-up reads. Failed reads evict the affected entry. A caller-supplied fingerprint cannot replace retained material.

Artifact reuse first calls authorized `artifact_read` with `length:0`. Available status, SHA-256, size and all capture metadata must match the locally retained version. Otherwise the helper reads the requested bytes again. Budget-limited responses are followed with advancing ranges until that request is satisfied or the server explicitly reports a capture gap or end of file. Each page's identity, offset, byte count and SHA-256 are checked; pages from different artifact versions cannot be combined. Unavailable artifacts never fall back to old bytes.

The manifest is private to the actual SDK `Client` and current transport/profile instructions. Another client, a fresh process, or reconnecting with another transport starts with no retained material, including when credentials are the same. Nothing is written to disk or exported for another role. Call `manifest.forget()` when dropping local material or to bound memory in a long-lived client. Current authorization, live claims, expected revisions, and independent review rules continue to control mutations.

The helper makes retained material available to its caller; the caller must actually present it to the relevant worker or reviewer before recording information-delivery proof. A fingerprint, metadata result, another role's prior read, or this helper's return alone does not establish model delivery. Count every actual `Client.callTool` invocation, including metadata checks, required omissions, pagination, fallback reads and failed attempts. Re-presenting a retained packet to a model still consumes that model's input budget.

## Verification

Run with Node 24 and installed project dependencies:

```sh
node --import tsx --test tests/context-manifest.test.ts
```

The real HTTP SDK tests instrument every tool request and complete SDK result, check canonical delivered bodies, and print cold/warm protocol reference-token counts. One local run read context and all required history in six calls (24,205 reference tokens), then reused the exact packet after one authorized check (238 tokens). A 1,300-byte artifact under a 512-token response budget took seven calls (6,428 tokens), then one authorized metadata check (581 tokens). UUIDs and packing boundaries vary between runs. These are synthetic transport measurements, exclude connection/discovery overhead, and do not establish billed or model-input savings. Fresh clients and reconnects repeat all required reads; tests also cover changed requirements/checkpoints, stale mutation rejection, revoked/restored membership, missing local material, and changed/missing artifact captures.

The existing frozen protocol workflow fixtures and worker catalog remain unchanged. Run `node --import tsx scripts/protocol-benchmark.ts` with `PROTOCOL_DATABASE_URL` pointing to a disposable PostgreSQL database to check their existing gates.
