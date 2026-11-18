# Operations

## Schema and roles

`migrate` applies numbered SQL files atomically and records them in `schema_migrations`. PostgreSQL uses a database advisory lock to serialize migration runners. Compose uses `ticketing_owner` for migrations and `ticketing_app` for normal work. The runtime role can read/write application tables but cannot create schema objects. The initial PostgreSQL container script creates roles only on an empty volume; changing `.env` later does not rotate existing database passwords.

Do not run automatic migrations from every HTTP process. Compose runs an explicit migration job before application and worker startup. For another backend, use its adapter-owned migration operation.

## SQLite local operation

Select `STORAGE_ADAPTER=sqlite` and `SQLITE_PATH` for the persistent file, or use the CLI's `--sqlite PATH` convenience flag. SQLite stdio bootstraps its schema automatically. `EMBEDDING_PROVIDER=none` avoids external inference; SQLite search always uses FTS5 and explicitly reports full-text-only capability. SQLite stdio drains its durable indexing queue with one in-flight background indexOnce call and awaits it during shutdown; no separate worker is needed. PostgreSQL and HTTP deployments keep the existing worker command.

With Node 24 and dependencies installed, run `npm run build`, then start local MCP stdio with the full tool profile for initial project setup:

```sh
node dist/cli.js stdio --sqlite .local/ticketing.sqlite --profile full
```

Without `--actor` or `ACTOR_ID`, this local stdio command creates or reuses a stable agent identity with administrator access in that database. This identity trusts the local operator and does not enable automatic HTTP authentication.

After setup, use the default worker tool profile for execution on the same database:

```sh
node dist/cli.js stdio --sqlite .local/ticketing.sqlite
```

Profiles change the exposed tools; the trusted local identity and its permissions remain unchanged.

Keep the database on a local filesystem. WAL mode allows coherent read snapshots alongside a writer, but only one write transaction can commit at a time across all projects. Long-lived snapshots retain WAL pages. Synchronous SQLite statements run on the Node event loop; use PostgreSQL for workloads requiring greater write concurrency or a shared database service.

The database, `-wal`, and `-shm` files contain trusted local state, including claim credentials. Protect them with operating-system permissions. New database files use owner-only permissions where supported; existing permissions are preserved. A local operator who can access the file can administer its contents. Close both storage and search handles before copying the database alone for an offline backup; copying a live main file without its WAL can omit committed work. Restore into a separate file and verify reads before switching clients. Existing files, receipts, and audit history are never reset by startup.

## Search and model changes

Writes enqueue durable indexing jobs in the same storage transaction. The worker updates text first, then generates vectors. Provider failures leave text available and retry with exponential delay, capped at one hour. Worker leases expire after five minutes. Completion checks the job token and source revision, preventing a superseded job from deleting new work.

Set `EMBEDDING_PROVIDER=ollama` for `/api/embed`, or `openai` for a provider's `/v1/embeddings`-compatible endpoint. Configure the model, URL, dimensions, and optional API key. Hosted mode requires explicit URL/model/dimensions; vector dimensions must be 1–2000 for the supplied HNSW adapter.

Only one embedding profile is active per process. Its identity covers provider, effective endpoint (or explicit shared-space ID), model, dimensions, revision, and chunking. Endpoint identity changes existing profile IDs: run `migrate` with schema-owner privileges, restart app/worker with matching configuration, then `reindex --actor ADMIN_ID --project PROJECT_ID` before expecting semantic readiness. Reindex also prepares the profile and needs migration credentials. Old indexes/vectors remain for operator-managed rollback; generations never mix. Nullable input hashes alone do not trigger a full backfill.

Use `docker compose exec ollama ollama pull nomic-embed-text` to retry model installation. Raw artifact URLs are never fetched, and the server does not execute agent commands.

## Durable signed notifications

Webhooks are disabled by default. An operator can set both `TICKETING_WEBHOOK_URL` and a private `TICKETING_WEBHOOK_SECRET` of at least 32 bytes. Configure the same destination on mutation processes and workers. URLs require HTTPS, except literal `http://127.0.0.1` or `http://[::1]` for a local receiver; embedded credentials and fragments are rejected. The destination comes only from operator configuration. Redirects are never followed.

Selected committed events enqueue an immutable delivery in the same transaction: `ticket.created`, `ticket.updated`, `ticket.transitioned`, `ticket.invalidated`, `ticket.linked`, `ticket.checkpointed`, `ticket.note_added`, `ticket.submitted`, `ticket.reviewed`, `ticket.github_evidence_refreshed`, `work.claimed`, and `work.released`. Payloads contain only `schema_version:1`, `delivery_id`, `event_id`, `project_id`, `entity_id`, `event_type`, `seq`, `ticket_revision`, `requirements_revision`, and `occurred_at`. Titles, notes, event data, actor content, claim tokens, receiver URLs, and signing secrets are excluded. Receivers use authenticated tools to fetch current details.

Each POST has `X-Ticketing-Delivery` (the stable delivery UUID), `X-Ticketing-Timestamp` (attempt time in Unix seconds), and `X-Ticketing-Signature` (`sha256=` followed by hex HMAC-SHA256 of `timestamp + '.' + exact request body`). Verify the signature with the shared secret using constant-time comparison, apply a receiver-side timestamp tolerance, and deduplicate by delivery UUID. A crash after receiver acceptance can produce a second delivery with the same ID and body. A secret rotation for the same URL signs pending bodies with the new secret; coordinate receiver acceptance during rotation.

The worker runs indexing and delivery loops independently. Configured stdio also drains notifications with one in-flight delivery. Each attempt times out after five seconds, accepts only 2xx as success, and stores only safe failure codes such as `HTTP_503`, `TIMEOUT`, or `NETWORK_ERROR`. Retries continue with exponential delay from two seconds, capped at one hour; there is no attempt limit. Expiring leases recover interrupted work and stale acknowledgements cannot mark a newly leased row complete. Shutdown waits for in-flight bounded work. Receiver failures cannot roll back committed ticket operations or stall indexing.

The SHA256 fingerprint of the canonical URL binds queued rows to their original destination. Changing the URL leaves old rows pending; it never forwards them to the new URL. Restoring the old URL resumes those deliveries. Retain `changes_since` polling as the recovery source: notifications are hints, and claim expiry itself does not emit an event. PostgreSQL migration 011 and SQLite migration 003 preserve existing data and history. Delivery rows are retained after success; include them in backups.

## Health and metrics

- `/healthz`: process liveness.
- `/readyz`: storage and search schema connectivity.
- `/metrics`: authenticated system-administrator-only Prometheus metrics for requests/errors/time, indexing, active/expired claims, review backlog, pending jobs, and lag. Numeric embedding counters report provider `embed` invocations, document/query reuse, provider failures, and cache saturation. Reference-token metric accounting is off by default; opt in with `REFERENCE_TOKEN_METRICS=true` to count validated tool inputs (SDK defaults may be materialized), canonical-envelope results, and accounting failures. Context budgets and excerpt limits always remain enforced. These are local reference counts, not billed tokens or exact wire/client costs. No content labels are collected.

Readiness does not imply the embedding provider or identity provider is available; alert on authentication failures, indexing error increases, and growing job lag. HTTP logs include only method, recognized route, status, and duration. Tokens, database URLs, ticket bodies, and evidence are not logged.

Built-in adapters also expose `webhook_pending` (all unsent rows, including old destinations), `webhook_failed` (unsent rows with a failure code), and `webhook_attempts` (safely bounded total attempt count) through authenticated `/metrics` and administrator CLI `inspect`. These metrics contain no destination or content labels.

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
