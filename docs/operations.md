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

Readiness does not imply the embedding provider or identity provider is available; alert on authentication failures, indexing error increases, and growing job lag. Ordinary HTTP logs include only method, recognized route, status, and duration. Tokens, database URLs, ticket bodies, and evidence are excluded from those logs. Raw MCP profiling below has a separate content-bearing capture directory.

Built-in adapters also expose `webhook_pending` (all unsent rows, including old destinations), `webhook_failed` (unsent rows with a failure code), and `webhook_attempts` (safely bounded total attempt count) through authenticated `/metrics` and administrator CLI `inspect`. These metrics contain no destination or content labels.

## MCP profiling

Raw MCP capture is enabled by default for CLI stdio and HTTP server processes. For development, configure a private local directory in the server environment and restart the server:

```env
MCP_PROFILE_CAPTURE=true
MCP_PROFILE_DIRECTORY=.local/token-profiles
REFERENCE_TOKEN_METRICS=false
```

An unset `MCP_PROFILE_CAPTURE` defaults to `true`. Set `MCP_PROFILE_CAPTURE=false` to opt out; this creates no capture directory or files. Only literal `true` and `false` are accepted. Existing `.env` settings are preserved by `scripts/setup.mjs`, so an existing explicit `false` remains opted out. Capture records requests, responses and notifications behind the MCP transport for both stdio and HTTP: initialization, discovery, tool calls, prompts, resources and protocol error responses. It adds no tools, prompts, response fields or model-visible logging. Tokenization happens in the offline report command; the existing context-budget checks still run normally. `REFERENCE_TOKEN_METRICS` remains an independent switch for immediate aggregate counting.

Each server process creates a unique run directory under `MCP_PROFILE_DIRECTORY` and prints its location to stderr. Numbered `events-*.jsonl` files store the parsed JSON-RPC messages as serialized JSON strings, with sequence numbers, connection IDs, timestamps, transport and profile. Each HTTP POST gets its own connection ID, so repeated numeric request IDs from different clients cannot collide. Outgoing snapshots have separate send outcomes; a snapshot alone does not prove successful delivery. Authorization headers, environment variables and SDK connection extras are never captured. Requests rejected before the authenticated HTTP MCP transport, and malformed input that the transport cannot parse, have no captured raw body. Existing HTTP status logs and transport diagnostics cover those boundaries without retaining credentials from headers.

Raw payloads preserve exact ticket text and can contain claim credentials or secrets supplied as tool arguments. Use a private local directory; default `.local/` and directories named `token-profiles` are Git-ignored. New files use mode `0600` and directories `0700` where the operating system supports these modes; restrict Windows directory ACLs as appropriate. Reports omit raw message bodies. Do not publish raw captures as CI artifacts or ordinary application logs.

Stop the server gracefully to flush the capture, then run:

```sh
node dist/cli.js profile-report --input .local/token-profiles/RUN_DIRECTORY --output .local/token-report.json
# From a source checkout with development dependencies installed:
npm run profile:report -- --input .local/token-profiles/RUN_DIRECTORY --output .local/token-report.json
```

The command needs no database or provider connection and refuses to overwrite an existing output file. It writes the diagnostic report even when incomplete, returning exit code 0 for a complete report, 2 for an incomplete capture/call history, and 1 if analysis or output writing fails. Reports account for every retained message and correlate individual calls within each connection, keeping discovery, notifications, retries, unmatched requests and orphan responses visible. Counts distinguish serialized JSON-RPC messages, SDK result payloads, and canonical tool-response text. Per-operation totals and server-observed timing support comparisons without loading capture content into an agent's context. The tokenizer is `js-tiktoken/o200k_base`, including ordinary handling of special-token-looking user text. These are reference counts for the captured serialization, not original network framing, client-rendered prompts, provider billing or model comprehension.

Capture performs JSON serialization and asynchronous file I/O, so it has host CPU and disk cost even though it adds no AI input/output tokens. The hot path never waits for disk writes or calls a tokenizer. The defaults bound each process run to eight retained 8 MiB segments and a 16 MiB queue:

```env
MCP_PROFILE_MAX_FILE_BYTES=8388608
MCP_PROFILE_MAX_FILES=8
MCP_PROFILE_MAX_QUEUE_BYTES=16777216
```

Oversized records, full queues, write failures and rotated-out segments are recorded as losses. Sequence gaps, pending sends, unmatched messages and an unclosed run keep an incomplete capture from looking complete. Capture failures do not turn a successful ticket operation into a failure; inspect `run.json` status/counters and content-free stderr diagnostics before trusting totals. HTTP `/metrics` also exports `ai_ticketing_profile_*` numeric counters. Rotation bounds one run, not the number of runs across restarts. Archive or remove closed run directories according to your retention policy; there is no cross-process cleanup service. Analyze closed runs for reproducible totals. Metadata and sequence checks detect inconsistent captures; analysis-time hashes are fingerprints, not authenticated evidence against deliberate edits.

Compose passes these settings to the app, defaults capture to `true`, and retains runs in the `token_profiles` volume at `/app/.local/token-profiles`. Set `MCP_PROFILE_CAPTURE=false` in `.env` to opt out, then recreate the app container to apply it. The image prepares the directory for the unprivileged `node` user. Analyze inside the container with `node dist/cli.js profile-report` or copy a closed run locally. Capture is for MCP server traffic; direct trusted `call --actor`, indexing workers and provider-side requests do not pass through the recorder.

Library consumers can create a recorder with `createProfileRecorder`, supply it as `HttpConfig.profiler`, or wrap a stdio transport before `createMcpServer(...).connect(...)`. The caller owns `recorder.close()` after transports stop. `analyzeProfile(runDirectory)` provides the same offline analysis as the CLI.

## Hot reload for local stdio

Build each candidate in a separate, immutable checkout with `npm run build`. Keep the launcher, active build, and previous build available. Publish the initial server selection using an absolute path to the built CLI:

```powershell
node C:/ticketing/launcher/dist/stdio-hot-reload.js --pointer C:/ticketing/local/mcp-active --select C:/ticketing/build-a/dist/cli.js
```

Set the MCP server command to `node` and its arguments to `C:/ticketing/launcher/dist/stdio-hot-reload.js`, `--pointer`, `C:/ticketing/local/mcp-active`, `--profile`, `worker`. With `STORAGE_ADAPTER=sqlite`, also pass `--sqlite-base C:/ticketing/build-a/dist/cli.js`. Keep the existing actor, database, working directory, and profiling environment. Reconnect the client once to install the launcher. Protect the pointer and builds with the same local account permissions as the MCP configuration: selecting a build authorizes local code execution with the server's environment.

To roll forward or back, repeat the `--select` command with another built CLI. Selection is atomic. Each existing launcher checks for the change on the next request it receives while idle. It replays only the observed MCP handshake and discovery against the candidate. Outstanding requests finish on their original backend. The launcher does not retry calls across a disconnect. Clients must retry uncertain mutations with the original idempotency key.

Look for `mcp_relay_switched` in stderr to verify the new PID and entry. `mcp_relay_rejected` gives the reason and indicates whether the old process remains active. After a transient rejection, run `--select` again for the same build to retry it. `mcp_relay_pinned` gives the reason a session must reconnect before it can switch. Selecting a path stages the switch; it does not prove a connected client has picked it up. MCP requests, results and profiling still come from the actual backend.

Requests wait while a selected build is validated. For SQLite expansion this includes the database copy, shadow startup and discovery, live schema transaction, and final startup and discovery. The default deadline is 15 seconds per startup and discovery probe. Pass `--probe-timeout-ms` to the launcher to tune that deadline from 100 to 120,000 milliseconds. Backup and live apply time are outside the probe deadline. Schedule large schema expansions during a quiet period and allow enough time in the MCP client's request timeout.

An established legacy MCP session can accept added tools when the server advertised `tools.listChanged`. Existing tool definitions and other discovered surfaces must match. The launcher sends `notifications/tools/list_changed` after activation so the client can re-list. A removal, incompatible definition, or capability change requires a reconnect. Confirm re-discovery in the client you use.

New SQLite sessions start the trusted `--sqlite-base` build and validate the selected build after initial tool discovery. Append-only SQL is checked against a private consistent database copy. The actual candidate must start and pass discovery on that copy before the launcher can commit the live changes. The transaction records both the migration names and their SHA-256 checksums. Applied forward migrations remain on disk if you roll the binary back. See [SQLite reload limits](sqlite-hot-reload.md) before writing a migration.

This launcher targets the current stateless ticketing stdio interface. Completion requests flow through normally. The launcher restores the last acknowledged logging level on a replacement, and an unsupported setting does not pin the session. Overlapping logging writes and other unknown or stateful methods pin the session. A cancelled request without a terminal MCP response can defer replacement until reconnect. HTTP deployments use their existing server lifecycle.

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

## Claim contention and receipt capacity

Run `npm run benchmark:claims` with Node 24 and a disposable `BENCHMARK_DATABASE_URL` or `TEST_DATABASE_URL`. It creates and removes its own schema, leaving other schemas alone. The JSON report is written to `.local/claim-benchmark-results.json`; CI uploads it as the `claim-benchmark` artifact for the exact tested commit.

Each case runs three bursts of eight claims plus eight heartbeats in one project (24 samples of each operation). It compares claim-only and embedded-context requests on both modest prose requirements and a large, high-entropy criteria fixture. The large embedded-context responses must contain at least 20,000 reference tokens. Timings include database/pool/lock waits and packing, excluding setup, assertions, retries, transport, and inference. Budget, live ownership, lease renewal, receipt count, and byte-stable retry assertions fail the run on a correctness regression. Latency targets are reported separately and do not gate CI on shared-runner speed. This is a small burst test, not a sustained-load or SQLite result; reproduce it on deployment hardware before setting capacity.

Keep the ordinary-operation target of 300 ms p95. Investigate claims or heartbeats above that target in three consecutive five-minute production windows (or three identical benchmark runs). A failed heartbeat or heartbeat taking over 30 seconds needs immediate investigation, well before the ten-minute lease expires. First reduce simultaneous work in the affected project and inspect database waits/CPU. Clients that already retrieved all required context may use `include_context:false`; otherwise retrieve current context and follow mandatory omission references before execution. Do not move packing after commit as a quick fix: combined-claim failure must still roll back ownership, revisions, events, jobs, and receipts. Any change to that guarantee needs explicit API/retry design and regression tests.

Receipts have **no automatic expiry**. Deleting one can turn a delayed retry into a second mutation, so capacity planning must retain them. Run these read-only PostgreSQL checks off peak and record daily results externally; the size queries inspect stored results and can be expensive on a large table:

```sql
SELECT pg_total_relation_size('receipts') AS receipt_table_index_toast_bytes;

SELECT operation, count(*) AS receipts_last_24h,
       round(avg(octet_length(result::text))) AS mean_logical_result_bytes,
       round(avg(pg_column_size(result))) AS mean_stored_result_bytes,
       max(pg_column_size(result)) AS max_stored_result_bytes
FROM receipts
WHERE created_at >= now() - interval '24 hours'
GROUP BY operation;
```

Estimate annual result growth as `daily_receipts * mean_stored_result_bytes * 365`; separately budget row/index overhead, other operations, WAL, backups, and replicas. The benchmark reports a 10,000-claims/day illustration, not a traffic forecast. Logical JSON size and PostgreSQL stored size differ with compression, so use your own content mix and measured total table growth. SQLite operators should record database plus WAL file size daily instead of using PostgreSQL size estimates.

Use the larger of recent daily growth and the planned workload estimate to calculate remaining days of disk headroom. Investigate at 70% disk use or fewer than 30 days of headroom; expand capacity or reduce incoming work before 85% use or seven days of headroom. These are starting operator thresholds, not installed alerts. Backups and read-only archives do not replace online idempotency records. A future retention mechanism must preserve retry fencing (for example, durable tombstones and an explicit retry horizon); there is no safe receipt-pruning command today.

## Known operating limits

This is one team per deployment with project grants, not multi-tenant SaaS. Local DB credentials confer operator trust. Audit records and idempotency receipts are retained indefinitely. Indexing is eventual; a changed source is omitted from search until its new revision is indexed. Mean-pooled document embeddings trade passage precision for a compact index. A reviewer must validate evidence; the server verifies its presence and attribution, not its truth.

Exact query embeddings coalesce in a 256-entry total pending/resolved cache per immutable profile instance, keyed by query text. Successes live ten minutes from completion; capacity pressure evicts expired resolved entries before live resolved LRU entries. Pending entries are never evicted. If every entry is pending, new distinct queries use full-text fallback and report degradation. Documents reuse only exact input hashes within an immutable profile. `EMBEDDING_SPACE_ID` is optional; Compose passes it through without imposing a hosted-service identity. The local example matches Docker/localhost aliases of its single Ollama service.

Run `npm run benchmark:protocol` with disposable `PROTOCOL_DATABASE_URL` or `TEST_DATABASE_URL`. It creates isolated schemas and uses the pinned six-workflow baseline, counting actual SDK catalogs/results/calls and separate canonical-envelope references. It checks per-role delivered requirements/checkpoint/evidence and fails below 40% aggregate savings, above 5,000 worker-catalog tokens, or on any workflow regression. Fixture setup is excluded; workflow retries and reconciliation are counted. Reports default to ignored `.local/protocol-benchmark-results.json`.

Coverage reports include `observed_at` and may lag other workers by up to five seconds. Index writes invalidate the local coverage cache immediately. During upgrades, stop app/worker processes before applying migrations, then start the new versions together.
