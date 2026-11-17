# Adapter development

The application owns workflow, permissions, review policy, graph validation, and context assembly. MCP is a transport over those operations. PostgreSQL types and SQL appear only in the default adapter, its migrations, and backend-specific operational scripts.

## Interfaces

`StorageAdapter` provides typed reads, consistent read-only snapshots, bounded filtered queries, an ordered work-candidate query, atomic transactions, durable job leasing, migration, health, metrics, and shutdown. `Transaction` adds record writes and removal. Dates cross this boundary as UTC ISO strings, identifiers as strings, and events as safe integer sequences. JSON fields contain validated evidence or metadata.

`SearchAdapter` prepares an embedding profile, indexes text and vectors, retrieves candidates, reports coverage, checks health, and closes. It can share a database with storage or use a separate service. Search returns source identifiers and revisions; the application rechecks access, archive state, and revision against authoritative storage before returning text.

`EmbeddingProvider` exposes its model/profile/dimensions and generates query/document vectors. The supplied HTTP implementation supports Ollama and OpenAI-compatible APIs. Document inputs are split into 6,000-character pieces; normalized mean pooling includes every piece in one document vector. This favors a small index over passage-level semantic precision. Changing the chunking algorithm requires a new profile and reindexing.

## Required storage guarantees

- `transaction(scope, callback)` serializes mutations within the scope and commits all records together. Exceptions roll everything back. Uncommitted writes cannot become visible outside the transaction.
- `readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T>` is required. It supplies one consistent read-only view without taking the project mutation lock. PostgreSQL uses a read-only repeatable-read transaction. Standalone context collects and authorizes its source data in this snapshot, then releases it before fingerprinting and token packing; combined claims retain their atomic mutation transaction.
- A project is a write scope. Project counters, tickets, claims, receipts, indexing jobs, and audit events commit together. Catalog operations use a separate scope.
- Event sequence allocation must occur under the scope lock. A plain auto-increment sequence allocated before commit is insufficient: concurrent commits can otherwise cause polling clients to skip events.
- A receipt key identifies actor, project scope, operation, and idempotency key. Preserve its result and input hash durably. The initial implementation does not expire receipts.
- Claims have unique ticket ownership. Lease replacements change the token. Domain checks run inside the same transaction as the write.
- Job leasing must be atomic across workers. Completion must match both lease token and revision so an old worker cannot remove a newer indexing job.
- `workCandidates` returns ordered, potentially eligible tickets. Prefiltering in the adapter improves speed; the application still checks workflow eligibility inside the transaction.
- `unansweredQuestions(projectId,ticketId,blocking,limit,offset)` returns only unanswered questions matching the exact blocking flag, ordered by creation time and ID. Multiple answers cannot duplicate results. Context reads and authorization use the supplied snapshot or mutation-transaction reader.
- `find` supports equality, null, `in`, and `gt`, stable ordering, offset, and bounded limits. No arbitrary SQL crosses the interface.

A non-SQL backend can implement these operations using its native transactions and conditional writes. A backend unable to supply the guarantees is not a compatible production adapter. Do not emulate a transaction by saving records one by one without atomic rollback.

Existing custom storage adapters must add `readSnapshot` before upgrading. Use a native consistent read-only snapshot or equivalent view; routing it through the project mutation lock defeats the standalone-context concurrency guarantee.

## Wiring a replacement

```ts
import { createApplication } from 'ai-ticketing-mcp';
import { MyStorage, MySearch } from './my-adapter.js';
import { MyEmbeddings } from './my-embeddings.js';

const storage = new MyStorage(configuration);
const search = new MySearch(configuration);
const embeddings = new MyEmbeddings(configuration);

await storage.migrate(); // Run separately with migration privileges in production.
await search.configure(embeddings.profile);
const application = createApplication({ storage, search, embeddings });
```

Use the exported `createMcpServer`, `createHttpServer`, and authentication helpers to attach transports, or invoke `application.execute(actorId, operation, input)` in your own authenticated host. Identity must come from trusted authentication, never caller-supplied tool arguments.

The bundled CLI chooses PostgreSQL. A custom entry point imports and registers your adapter explicitly; there is no dynamic plugin download or hidden global registry. Each adapter owns migrations and connection lifecycle. Migrating existing records between engines is separate from implementing a compatible adapter and needs a verified export/import process.

## Contract suite

```ts
import { registerAdapterContractTests } from 'ai-ticketing-mcp/testing';

registerAdapterContractTests('my backend', async () => {
  const storage = new MyStorage(testConfiguration);
  const search = new MySearch(testConfiguration);
  return {
    storage,
    search,
    dispose: async () => {
      await search.close();
      await storage.close();
    },
  };
});
```

Run with Node's test runner against an isolated real backend. The suite checks rollback, claim races, retry deduplication, stale revisions and tokens, ordered events, search freshness, and job fencing. Add backend-specific failure and restoration tests before claiming production support.

`indexVector` accepts an optional fourth exact-input SHA-256 hash. Optional `reuseVector` must atomically match profile/hash, reject newer revisions and archived documents, and invalidate coverage; adapters without it embed normally. Hash the raw `${title}\n${text}` input. Legacy nullable hashes are not backfilled without embedding.

Endpoint identity contributes to the default profile. Set an explicit shared `EMBEDDING_SPACE_ID` only for actual aliases of the same embedding space; empty means unset. Change `EMBEDDING_REVISION` when weights change behind unchanged identity, then configure and rebuild. Budget enforcement uses local `o200k_base`; applications may inject `countReferenceTokens(serialized)` for deterministic checks. Optional metric accounting is disabled by default; set `ApplicationOptions.referenceTokenMetrics:true` to enable it. This switch never disables context budgets or excerpt limits.
