# Verification record

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

Hosted embeddings were verified against an OpenAI-compatible HTTP fixture, without spending against a live hosted API account. Public HTTPS/domain routing and an interactive human login were not exercised; the included local Keycloak server and signed-token authentication were exercised. PostgreSQL is the only supported production storage adapter; replacement adapters must run the exported contract tests.

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
