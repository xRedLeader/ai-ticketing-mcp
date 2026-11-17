# Operations

## Schema and roles

`migrate` applies numbered SQL files atomically and records them in `schema_migrations`. A database advisory lock serializes migration runners. Compose uses `ticketing_owner` for migrations and `ticketing_app` for normal work. The runtime role can read/write application tables but cannot create schema objects. The initial PostgreSQL container script creates roles only on an empty volume; changing `.env` later does not rotate existing database passwords.

Do not run automatic migrations from every HTTP process. Compose runs an explicit migration job before application and worker startup. For another backend, use its adapter-owned migration operation.

## Search and model changes

Writes enqueue durable indexing jobs in the same storage transaction. The worker updates text first, then generates vectors. Provider failures leave text available and retry with exponential delay, capped at one hour. Worker leases expire after five minutes. Completion checks the job token and source revision, preventing a superseded job from deleting new work.

Set `EMBEDDING_PROVIDER=ollama` for `/api/embed`, or `openai` for a provider's `/v1/embeddings`-compatible endpoint. Configure the model, URL, dimensions, and optional API key. Hosted mode requires explicit URL/model/dimensions; vector dimensions must be 1–2000 for the supplied HNSW adapter.

Only one embedding profile is active per process. Its identity covers provider, effective endpoint (or explicit shared-space ID), model, dimensions, revision, and chunking. Endpoint identity changes existing profile IDs: run `migrate` with schema-owner privileges, restart app/worker with matching configuration, then `reindex --actor ADMIN_ID --project PROJECT_ID` before expecting semantic readiness. Reindex also prepares the profile and needs migration credentials. Old indexes/vectors remain for operator-managed rollback; generations never mix. Nullable input hashes alone do not trigger a full backfill.

Use `docker compose exec ollama ollama pull nomic-embed-text` to retry model installation. Raw artifact URLs are never fetched, and the server does not execute agent commands.

## Health and metrics

- `/healthz`: process liveness.
- `/readyz`: storage and search schema connectivity.
- `/metrics`: authenticated system-administrator-only Prometheus metrics for requests/errors/time, indexing, active/expired claims, review backlog, pending jobs, and lag. Numeric embedding counters report provider `embed` invocations, document/query reuse, provider failures, and cache saturation. Reference-token metric accounting is off by default; opt in with `REFERENCE_TOKEN_METRICS=true` to count validated tool inputs (SDK defaults may be materialized), canonical-envelope results, and accounting failures. Context budgets and excerpt limits always remain enforced. These are local reference counts, not billed tokens or exact wire/client costs. No content labels are collected.

Readiness does not imply the embedding provider or identity provider is available; alert on authentication failures, indexing error increases, and growing job lag. HTTP logs include only method, recognized route, status, and duration. Tokens, database URLs, ticket bodies, and evidence are not logged.

## Backup and restore

Use PostgreSQL custom-format backups and protect them as sensitive project data. With the default Compose deployment:

```sh
docker compose exec -T db pg_dump -U ticketing_owner -d ticketing -Fc -f /tmp/ticketing.dump
docker compose cp db:/tmp/ticketing.dump .local/ticketing.dump
```

Restore into a **new, empty database**, never over the live database:

```sh
docker compose exec -T db createdb -U ticketing_owner ticketing_restore
docker compose cp .local/ticketing.dump db:/tmp/ticketing-restore.dump
docker compose exec -T db pg_restore -U ticketing_owner -d ticketing_restore --no-owner --no-privileges /tmp/ticketing-restore.dump
```

Recreate least-privilege runtime grants for the restored database before connecting the application. Check ticket, criterion, submission, review, knowledge, and event counts; run application reads against it before any cutover. Back up the Keycloak database separately, along with encrypted operator configuration and the identities' issuer URL. Search indexes are reconstructible, but audit history, receipts, and primary records are not.

Use `scripts/verify-restore.ts` to compare a source and restored database with `SOURCE_DATABASE_URL` and `RESTORE_DATABASE_URL`; it performs read-only checks. Retention and restoration scheduling belong to the operator. No destructive restore or automatic deletion command is exposed over MCP.

## Benchmarks

Set `BENCHMARK_DATABASE_URL` to a disposable database and run `npm run benchmark`. Default: 100,000 tickets and 32 concurrent clients, testing reads, writes, claims, and hybrid retrieval. The benchmark deliberately uses synthetic 768-dimensional embeddings and excludes provider inference; it is a coordination benchmark, not proof of production model retrieval quality. It reports actual host characteristics and writes ignored `benchmark-results.json`.

The design targets p95 below 300 ms for ordinary operations and one second for retrieval on a 4-vCPU/8-GB application/database machine. Treat those as targets until reproduced on your hardware and vector workload. Project mutations serialize for correctness; high write contention in one project is the first reason to revisit the PostgreSQL adapter's locking strategy.

## Known operating limits

This is one team per deployment with project grants, not multi-tenant SaaS. Local DB credentials confer operator trust. Audit records and idempotency receipts are retained indefinitely. Indexing is eventual; a changed source is omitted from search until its new revision is indexed. Mean-pooled document embeddings trade passage precision for a compact index. A reviewer must validate evidence; the server verifies its presence and attribution, not its truth.

Exact query embeddings coalesce in a 256-entry total pending/resolved cache. Successes live ten minutes; resolved LRU entries are evicted. If every entry is pending, new distinct queries use full-text fallback and report degradation. Documents reuse only exact input hashes within an immutable profile. `EMBEDDING_SPACE_ID` is optional; Compose passes it through without imposing a hosted-service identity. The local example matches Docker/localhost aliases of its single Ollama service.

Run `npm run benchmark:protocol` with disposable `PROTOCOL_DATABASE_URL` or `TEST_DATABASE_URL`. It creates isolated schemas and uses the pinned six-workflow baseline, counting actual SDK catalogs/results/calls and separate canonical-envelope references. It checks per-role delivered requirements/checkpoint/evidence and fails below 40% aggregate savings, above 5,000 worker-catalog tokens, or on any workflow regression. Fixture setup is excluded; workflow retries and reconciliation are counted. Reports default to ignored `.local/protocol-benchmark-results.json`.

Coverage reports include `observed_at` and may lag other workers by up to five seconds. Index writes invalidate the local coverage cache immediately. During upgrades, stop app/worker processes before applying migrations, then start the new versions together.
