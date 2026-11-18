# Release notes

## 2.0.0 (unreleased): compact MCP workflows and self-hosted operation

These notes include the breaking changes merged in PR #1 and the self-hosted additions in PR #2. Package, MCP server, and CLI client metadata identify version `2.0.0` because the public input and adapter contracts changed.

### Required migration from the original MCP API

- Custom storage adapters must implement `readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T>` and `unansweredQuestions`. A snapshot must be consistent and read-only without taking the project mutation lock. Standalone context collection releases the snapshot before token packing. Run the exported adapter contract suite before deploying a replacement adapter; see [adapter requirements](adapters.md).
- MCP defaults to the worker profile. Select `full` for the original administrative tool surface, or `planner` / `reviewer` for those roles. Profiles do not grant permissions.
- The `ticket_history` filter is now `nonblocking_unanswered:true`, replacing `unanswered_questions:true` without an alias. It returns only unanswered non-blocking questions; blocking questions remain in context blockers. Generated omission references use the new name. `kind:'notes'` and the prohibition on combining the filter with `item_id` are unchanged.
- Lists and mutation results are compact. Read complete state through `ticket_get` / `project_get`, and page history explicitly. Follow required context omission references before execution or review. Claim retries replay the original receipt and do not renew ownership.
- Default page sizes change: lists 25 to 10, `work_next` 5 to 1, search 10 to 3, and `changes_since` 100 to 25. Context defaults to brief (4,096 reference tokens); related knowledge requires explicit search. See [changed defaults](mcp.md#changed-defaults).
- Embedding identity now includes the endpoint or an explicit shared embedding space. Reindex after an identity change; matching model names alone do not establish compatible vectors.

Stop application/worker processes, back up and verify restoration, apply all pending PostgreSQL migrations (008–012 when upgrading from the original pre-PR-#1 schema), and restart matching application/worker builds. New local SQLite databases apply migrations 001–004 automatically. Existing authoritative records, receipts, and history are retained. Custom adapters enabling GitHub evidence must also implement its immutable storage mapping; `readSnapshot` alone is insufficient.

### Self-hosted additions

PR #2 adds local SQLite/FTS5 operation, immutable GitHub PR/CI evidence, signed notification delivery, opt-in unblocking scheduling, and advisory project/ticket model and effort hints. Notifications remain disabled until configured. SQLite has one writer and is intended for local operation; PostgreSQL remains the shared-service option.

Query embedding caches use exact text keys within each immutable profile instance. At capacity, expired completed entries are reclaimed before live completed LRU entries; in-flight requests stay protected and coalesced. The 256-entry bound and ten-minute TTL from completion remain unchanged.

### Operational follow-up

Combined claims still pack context within the project transaction so an oversized context rolls back ownership, revisions, events, jobs, and receipts together. Moving packing after commit would change that guarantee and needs a separate design. The worker retains idempotency receipts indefinitely by default. If you opt in to pruning, set `RECEIPT_RETENTION_DAYS` to cover your clients' retry window and reconcile old operations before retrying them if their receipt may have been pruned.

Use the new [claim/heartbeat benchmark and receipt capacity procedure](operations.md#claim-contention-and-receipt-capacity) before rollout. CI checks budgets, successful concurrent operations, ownership, and byte-stable replay; its latency measurements are observations, not a production service-level guarantee. See the dated [verification record](verification.md) for measured results and limitations.
