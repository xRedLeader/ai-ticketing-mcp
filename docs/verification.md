# Verification record

## PR #1 optional cleanup in PR #2: 2026-11-18

The remaining query-cache and naming nits are implemented. Query caches use exact text keys within each immutable profile instance and reclaim expired completed entries before live completed LRU entries at capacity. A new regression test first failed on the previous eviction behavior, then passed after the fix; it also verifies that pending work stays coalesced. Existing TTL, capacity, failure-retry, result-isolation, and separate-profile checks still pass.

The history filter and generated omission arguments now use `nonblocking_unanswered`, with no alias for `unanswered_questions`. Schema tests reject the old field and invalid combinations; PostgreSQL and SQLite tests verify the filtered behavior. Package, MCP server, and CLI metadata advance to 2.0.0, with the breaking input change recorded in the release notes.

Local Node 24 validation passed 163 tests (111 unit/SQLite and 52 PostgreSQL), both benchmarks, type checking, build, formatting, and credential scanning. The frozen protocol baseline and workload fixtures were unchanged. Claim packing and receipt retention retain the operating limits measured below.

## PR #2 review follow-up: 2026-11-18

`npm run benchmark:claims` was run against a new disposable PostgreSQL 17.12 database on the local Docker host, using Node 24.22.3 on Windows (32 available logical CPUs, 31.14 GiB host RAM). Application/database resources were not constrained to the earlier 4-vCPU/8-GB target. This measurement used the PR #2 worktree based on `10da326`, with the new benchmark; CI attaches a fresh report to each tested commit.

Each case used three bursts of eight simultaneous claims and eight heartbeats in one project: 24 samples per operation, 96 measured claims and 96 heartbeats overall. Fixtures, pool/tokenizer warmup, replay checks, and assertions were outside the measured intervals. These are application calls with real PostgreSQL I/O, excluding MCP/HTTP transport and embedding inference. The large fixture uses 50 criteria containing deterministic SHA-256 strings to exercise high-entropy context and storage; it is not a representative compression ratio for ordinary prose.

| Case                            | Claim p95 | Heartbeat p95 | Median response tokens | Mean logical receipt result | Mean stored receipt result |
| ------------------------------- | --------: | ------------: | ---------------------: | --------------------------: | -------------------------: |
| Claim only, modest requirements |  141.9 ms |      149.2 ms |                    258 |                       542 B |                      585 B |
| Embedded brief context          |  202.2 ms |      185.2 ms |                  1,502 |                     6,560 B |                    1,589 B |
| Claim only, large requirements  |  142.9 ms |      135.9 ms |                    254 |                       542 B |                      585 B |
| Embedded large context          |  377.8 ms |      335.9 ms |                 24,203 |                    47,945 B |                   48,881 B |

The embedded-large case **missed the ordinary 300 ms p95 target** for both operations. All calls succeeded; assertions checked response budgets, persisted live ownership, lease extension, identical receipt replay, and no extra receipts on retry. Latencies include query/pool/lock waits and packing, not isolated lock-hold measurements. This small single-process burst test does not establish sustained-load capacity or SQLite performance. It supports retaining atomic claims while documenting the cost and the existing claim-only option, not claiming that contention is eliminated.

At an illustrative 10,000 claims/day for 365 days, the stored result data alone projects to 1.99 GiB for claim-only receipts, 5.40 GiB for this repetitive brief fixture, and 166.16 GiB for the high-entropy large fixture. These estimates exclude row/index overhead, non-claim receipts, WAL, backups, and replicas. Receipt retention remains indefinite; the [capacity procedure and thresholds](operations.md#claim-contention-and-receipt-capacity) require measuring the actual content mix and daily table/disk growth. No deletion or post-commit packing change was introduced.

The [release notes](release-notes.md) now collect required custom-adapter methods, MCP behavior changes, embedding reindex requirements, and pending migrations, including changes already merged in PR #1.

Local validation also passed all 162 existing tests (110 unit/SQLite and 52 PostgreSQL), the frozen protocol benchmark, application and benchmark TypeScript checks, production build, formatting, and credential scanning. Published CI status must be checked for the final PR head rather than inferred from an earlier review or this local run.

## Original functional verification: 2026-11-16

Verified on 2026-11-16. The application was built and exercised against real PostgreSQL with pgvector, the official MCP SDK clients, Keycloak, and local Ollama.

## Functional checks

- Strict TypeScript checking and production build.
- Unit checks for input boundaries, embedding protocols and chunking, architecture imports, Conventional Commits, and credential detection.
- PostgreSQL contract checks for rollback, simultaneous claims, automatic work distribution, retries, stale leases, ordered events, search coverage, index freshness, and job fencing.
- Workflow checks for independent/human/self review, requirement invalidation, snapshots, combined dependency/parent cycles, child completion, checkpoint recovery, questions, access control, and archived content.
- MCP interoperability through stdio and OAuth-protected HTTP, including typed tool outputs, resources, and prompts.
- Expired tokens, incorrect audiences, missing scopes, and rejected HTTP origins.
- A real Keycloak service-account token successfully authenticated an MCP client.
- The Compose deployment starts with a separate runtime database role, and the two-agent walkthrough reaches independently approved completion.
- A PostgreSQL custom-format backup restored into a separate database; ordered row hashes matched for identities, projects, permissions, tickets, criteria, relationships, notes, claims, submissions, reviews, knowledge, events, receipts, jobs, and migrations.

## Historical load test: original version, 2026-11-16

These measurements describe the original version. The 100,000-ticket load test was not rerun for the 2026-11-17 changes and does not establish current-version performance.

100,000 synthetic tickets, 768-dimensional synthetic vectors, and 32 concurrent agents. The application and PostgreSQL were each capped at 2 vCPU and 4 GiB. PostgreSQL had 512 MiB shared memory. The underlying Docker VM reported 2 GiB of physical memory; other validation services were stopped during the isolated measurement.

| Operation               | Requests |   p50 |    p95 | Maximum |
| ----------------------- | -------: | ----: | -----: | ------: |
| Ticket reads            |      160 | 16 ms |  86 ms |  132 ms |
| Ticket writes           |      160 | 89 ms | 173 ms |  207 ms |
| Atomic next-work claims |       32 | 97 ms | 163 ms |  168 ms |
| Hybrid retrieval        |      160 | 50 ms | 100 ms |  131 ms |

This measures application operations with real database I/O. It excludes HTTP transport and embedding inference, uses a synthetic corpus, and is not a service-level guarantee. Coverage reporting is cached for five seconds; permissions and returned source revisions are checked on every query.

The tests exposed and fixed a PostgreSQL shared-memory limit, an inefficient queue ordering query, repeated candidate validation, and repeated full index-coverage counts. Reproduce with `npm run benchmark` and a disposable database. Set `BENCHMARK_PROJECT_ID` to reuse a seeded benchmark project; the rerun still adds notes and claims.

## Checks requiring operator infrastructure

Hosted embeddings were verified against an OpenAI-compatible HTTP fixture, without spending against a live hosted API account. Public HTTPS/domain routing and an interactive human login were not exercised; the included local Keycloak server and signed-token authentication were exercised. PostgreSQL remains the production deployment adapter. SQLite now supports local operation with the same contract suite; its performance was not measured by the historical load test above. Replacement adapters must run the exported contract tests.

## Token-efficiency verification: 2026-11-17

Clean verification with Node 24 passed TypeScript checking, the production build, formatting, secret detection, and the Git whitespace/diff check. All 61 tests passed: 23 unit tests and 38 PostgreSQL integration tests. The dependency audit reported zero vulnerabilities, and the Docker runtime image built successfully. The pinned baseline worktree remained clean.

The baseline executes original source commit `a8cd3840cd098cd3107a0f1bc231cf5b5414fc09`. The frozen workflow contract has SHA-256 `31276d92fd46422eea503de7c36d757a84be4f6df0a39b75e2bd02b37a09add4`. Its definitions and captured baseline are tracked in [protocol-workflows.json](../scripts/fixtures/protocol-workflows.json) and [protocol-baseline.json](../scripts/fixtures/protocol-baseline.json).

| Reference measurement        | Baseline | Current |   Change |
| ---------------------------- | -------: | ------: | -------: |
| Complete SDK protocol tokens |  141,387 |  77,548 | -45.152% |
| Canonical model-view tokens  |  101,297 |  56,834 | -43.894% |
| Worker input-catalog tokens  |    8,015 |   4,745 |  ≤ 5,000 |
| Tool calls / round trips     |       78 |      59 |      -19 |

All six workflows passed the role-specific delivered-content assertions and the per-workflow nonregression gate: short descriptions, long descriptions, extensive history, independent review, blocked work, and changed requirements. Workers received current requirements, instructions, policy, blockers, dependencies, and required resume decisions before progressing. Reviewers received current requirement identities and the relevant submission evidence.

These are reproducible reference counts using `js-tiktoken` 1.0.21 with `o200k_base` and ordinary-text encoding. The input catalog is counted once per connection; each tool request and complete SDK result is counted once, including any text/structured duplication. The separate canonical model view counts one result envelope. These counts are not billed tokens; actual client presentation and provider accounting differ. Deterministic embeddings and virtual maintenance intervals exclude model/provider delays.

To reproduce the current comparison, privately set `TEST_DATABASE_URL` to an isolated disposable PostgreSQL database with pgvector, then run:

```sh
npm run benchmark:protocol
```

The harness uses its own temporary schema and writes the current counts, delivery checks, round trips, and measured latencies to the ignored `.local/protocol-benchmark-results.json`. The pinned baseline and workflow contract remain unchanged.

Migration 008 adds a nullable vector input hash without a bulk backfill. Existing null hashes embed once when next processed. A changed embedding-profile identity requires reindexing before semantic indexing is ready; existing indexes and stored operation receipts are retained.

## PR review follow-up: 2026-11-17

The token-efficiency figures above record the pre-review implementation at `540ed2bd7b748aff907c79d30b31de3dfdef7f3a`. The frozen original baseline and workflow contract remain unchanged.

With Node 24.22.3, all 16 focused maintenance/excerpt tests passed. They cover paginated change catch-up, later-page terminal events, missing event metadata, retry cursors, nonadvancing-page backoff, independent heartbeats during a pending catch-up request, and cancellation during each pending request. Excerpt checks cover bounded Unicode windows, preserved query matches, ordinary special-token strings, an exact 200-token limit, and at most 20 encoder calls on an adversarial prefix.

A database-free comparison against that pre-review source used 50,000 DNA emoji before the query and 2,000 test-tube emoji after it. Encoder calls fell from 90 to 18; both results retained the query, remained well-formed Unicode, and contained 199 reference tokens. This focused operation-count check does not establish database or production latency performance.

## Real MCP client measurement: 2026-11-18 UTC

The [installed-client harness](real-client-benchmark.md) exercised all six frozen workflows with Codex CLI `0.169.0-alpha.11.1`, requesting `gpt-6.1-sol` for workers and `gpt-6-astra` for independent review, both at `xhigh`. The measured application runtime was pinned to `e9f3ec7387628299e966ad81420d9f9e6d800ad4`; this is not a measurement of later GitHub, notification, or scheduling changes. Eight actual client invocations include one failed short-workflow attempt and its retry.

| Main-client reported usage           |    Tokens |
| ------------------------------------ | --------: |
| Input                                | 2,320,013 |
| Cached input, included in input      | 2,025,728 |
| Output                               |    12,983 |
| Reasoning output, included in output |     3,300 |

These totals include reported usage from failed attempts. The eight client invocations took 560.232 seconds in aggregate, with individual durations from 51.385 to 114.670 seconds; this includes client/model time and is separate from database latency. Monetary cost, internal provider retries, and additional automatic approval-review usage remain unknown. These measurements do not establish billed savings against the reference baseline.

The immutable original report classified three workflows complete and four attempts failed. Three verdicts were validator defects: comparison against an unnormalized fixture description, discarded prior checkpoint-delivery proof, and target facts overwritten by a prerequisite read. Regression-tested corrections revalidated captured responses and authoritative fixture state offline, yielding six completed workflows without new provider calls. The initial short attempt remains failed. Original failures, usage, transcripts, and reports were retained; the correction is a separate append-only artifact.

The original report SHA-256 is `0173a70afca4d936de5346fb5a41346941d2b5940cf248b98cef2d0b9477b2c0`. Validation checks role-specific responses and required facts acknowledged before dependent mutations; fixture setup and off-model maintenance cannot establish model delivery. Private artifacts remain ignored because raw MCP transcripts contain synthetic claim credentials. The harness and revalidator are committed at `66d4119` with seventeen focused parser and revalidation tests. Client logs do not expose the exact final model rendering, so observed responses and action acknowledgments remain evidence of coordination behavior, not proof of complete model comprehension.

## Self-hosted roadmap verification: 2026-11-18 UTC

[CI run 44223407288](https://github.com/xRedLeader/ai-ticketing-mcp/actions/runs/44223407288) verified application commit `b9486fad01fc6bfbf821d446a66bd21564042d63`: 110 unit/SQLite tests and 52 PostgreSQL integration tests passed, along with strict checking, formatting, credential scanning, production build, semantic commit validation, dependency audit, and the runtime image build. The audit found no vulnerabilities. PostgreSQL and Docker checks ran in GitHub Actions; they were not rerun locally.

| Frozen reference measurement | Original baseline | This CI run |
| ---------------------------- | ----------------: | ----------: |
| Complete SDK protocol tokens |           141,387 |      77,896 |
| Canonical model-view tokens  |           101,297 |      57,184 |
| Worker input catalog         |             8,015 |       4,760 |
| Tool calls / round trips     |                78 |          59 |

The protocol reduction was 44.9058%. All six delivered-information checks and individual nonregression gates passed; the worker catalog remains below 5,000 reference tokens. The original baseline and scenario definitions were not changed. These figures are separate from the real-client usage above and from the historical load benchmark.

Coverage now includes SQLite persistence and upgrades, execution-hint inheritance, exact-commit GitHub evidence and replay, durable signed webhook retries and crash recovery, and opt-in unblocking scheduling on both adapters. Notification tests used local receivers, including timeout, redirect refusal, stalled-receiver isolation, and accepted-before-ack retries. No external receiver was configured. Scheduling tests cover priority, the exact 24-hour aging boundary, deterministic ordering, eligibility, bounded queries, and concurrent claims; the historical 100,000-ticket load test was not rerun for this policy.

The implementation was tracked in six durable `SELF` tickets through real MCP calls with separate worker and reviewer identities. A consistent SQLite backup preceded activation of the pinned application build and matching migrations. Comparing old columns after upgrade verified all 343 preexisting authoritative records unchanged, including historical receipts and evidence. The `SELF` project then opted into `unblocking` through MCP; existing active claims remained excluded from automatic selection. Local transcripts and the live database remain private.
