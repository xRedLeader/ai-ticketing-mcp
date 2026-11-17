# MCP and workflow

The official SDK supplies stdio and stateless Streamable HTTP. Modern and legacy protocol negotiation are handled by the SDK. Durable change tracking uses `changes_since`; it does not depend on transport sessions or server-push subscriptions.

Every tool returns structured `{ ok, data, error }` plus JSON text for clients that consume text results. Domain failures set MCP `isError`. Input schemas reject unknown fields. All writes require `idempotency_key`; edits and submissions also require `expected_revision` where advertised.

Success JSON uses stable recursive object-key ordering and preserves array order. Reference-token budgets count one canonical `{ ok, data, error }` envelope as sent in the text result; the SDK's additional structured copy and transport framing are measured separately.

## Capability profiles

The default profile is `worker`. Select `stdio --profile worker|planner|reviewer|full` or connect to `/mcp?profile=planner`. HTTP profiles are stateless; empty, unknown, or repeated `profile` parameters are rejected. OAuth tokens still target the unqueried `/mcp` resource.

Every profile includes `project_list`, `project_get`, `ticket_list`, `ticket_context`, `ticket_get`, `ticket_history`, `search`, `knowledge_get`, `checkpoint_get`, and `changes_since`.

| Profile               | Additional tools                                                                                        | Prompts            |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| `worker` (16 tools)   | `work_claim`, `work_heartbeat`, `work_release`, `ticket_checkpoint`, `ticket_note`, `ticket_submit`     | execution, handoff |
| `planner` (16 tools)  | `tickets_create`, `ticket_update`, `ticket_transition`, `ticket_link`, `ticket_note`, `knowledge_write` | planning           |
| `reviewer` (12 tools) | `ticket_review`, `ticket_note`                                                                          | verification       |
| `full` (26 tools)     | All tools below, including project administration and `work_next`                                       | all four           |

Profiles are not an access-control boundary. They select tool exposure; every operation retains its OAuth scope and project-role checks. Resources remain independently authorized and available in every profile. Guides and prompts follow the selected profile; the tool surface works without either.

## Tools

| Group                      | Tools                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Projects                   | `project_list`, `project_get`, `project_create`, `project_update`, `member_set`                                      |
| Tickets                    | `tickets_create`, `ticket_list`, `ticket_get`, `ticket_update`, `ticket_transition`, `ticket_link`, `ticket_history` |
| Coordination               | `work_next`, `work_claim`, `work_heartbeat`, `work_release`, `ticket_checkpoint`                                     |
| Collaboration and evidence | `ticket_note`, `ticket_submit`, `ticket_review`                                                                      |
| Retrieval                  | `ticket_context`, `search`, `knowledge_get`, `knowledge_write`, `checkpoint_get`                                     |
| Changes                    | `changes_since`                                                                                                      |

`tickets_create` accepts 1–50 tickets atomically, defaulting to backlog. Use `ready` to queue execution. Each ticket needs 1–50 criteria. Priority 1 is highest; 5 is lowest. Work selection orders by priority, creation time, then identifier, and respects declared capabilities, labels, assignment, blockers, and active claims.

Ticket lifecycle: `backlog → ready → in_progress → in_review → done`, plus `cancelled` and reopening. `ticket_transition` prepares, cancels, or reopens; it cannot mark work done. Blocking links point from prerequisite (`source_id`) to dependent (`target_id`). Parent completion requires all children done or cancelled. A cancelled prerequisite still blocks its dependents until the link is removed or replaced. Parent and dependency relationships may not form a combined cycle.

`work_claim` returns a token, expiry, compact ticket receipt, and brief context by default. `include_context:false` returns ownership alone. Heartbeat at least every three minutes; claims last ten minutes. Retrying an identical claim returns its original receipt and context snapshot, even after expiry; it never renews ownership. A new claim attempt needs a new key. Checkpoints return the new ticket revision so submission can chain without another read.

Requirement edits revoke claims and invalidate affected reviews, completed dependent tickets, and parent approvals. Metadata edits still increment the ticket revision. Read current state after a revision conflict. Questions marked blocking prevent claims and submissions until an answer references their identifier. Checkpoints are immutable notes, and complete history can be paged with `ticket_history`.

## Completion policies

- `self`: a valid submission completes the ticket.
- `independent`: another identity with verifier/admin permissions must approve.
- `human`: a different, registered human verifier/admin must approve.

Submissions require passing evidence and at least one reference for every current criterion. References are stored; they are not executed or fetched. Independent approval checks identity separation, not whether two credentials secretly belong to the same person. Operators control identity registration and grants.

## Context and retrieval

Context uses local `o200k_base` reference-token budgets: brief 4,096 (default), standard 8,192, full 32,768. `max_tokens` overrides the budget from 512 to 32,768 on `ticket_context` and `work_claim`. Count one canonical success envelope, including omission metadata and claim-receipt siblings. Current requirements, criteria, project instructions/policy, blockers, dependencies, and visible ownership are never silently truncated. `CONTEXT_TOO_LARGE` reports `required_tokens`, `max_tokens`, selected ticket/project IDs, and permitted retrieval calls. Read `ticket_get` plus `project_get`, then claim explicitly with `include_context:false` and a fresh key. A failed combined claim rolls back all claim, revision, event, job, and receipt changes.

Optional context prioritizes the latest checkpoint, unanswered nonblocking questions, latest review, and latest submission evidence, followed by bounded history at higher detail. Historical requirement snapshots remain in `ticket_history`. Each omission includes `retrieve_with` and executable `arguments`: fetch omitted checkpoints and latest rejection feedback marked `required_before:execution` before resumed work, and omitted submission evidence marked `required_before:review` before review. Checkpoint references identify an exact immutable checkpoint; `ticket_history` accepts `item_id` scoped to project, ticket, and kind. `ticket_get` returns current requirements/state without history. Context never invokes semantic search.

For paged unanswered nonblocking questions, call `ticket_history` with `kind:'notes'` and `unanswered_questions:true`, without `item_id`. Results use creation-time/ID ascending order and support ordinary offset paging. Context omission references restart at offset zero because answering an already delivered question can shift the filtered positions; clients deduplicate questions by IDs already received. Ordinary history and exact-item retrieval retain their existing behavior.

A client retaining full context may send its fingerprint as `if_none_match`. The server rebuilds and authorizes state before returning `{fingerprint,not_modified:true}`. Fingerprints cover permissions, requirements, project/dependency/history changes, effective lease expiration, detail, and budget. There is no server context cache or partial delta.

Knowledge records carry author, kind, revision, and archive state. Policy records require admin permissions. Retrieved text is data and cannot override an agent's governing instructions.

Search combines lexical and semantic ranks with reciprocal rank fusion. It defaults to three results with query-centered excerpts of at most 200 reference tokens, source IDs/revisions, and explicit retrieval calls. It reports coverage and degradation when embeddings are unavailable, busy, or incomplete. Cancelled tickets and archived knowledge are excluded. Filters and source revisions are checked against primary storage. Indexing is eventual; retrieve the source directly for authoritative state.

Resources: `ticketing://guide`, `ticketing://project/{project_id}`, `ticketing://ticket/{project_id}/{id}`, and `ticketing://knowledge/{project_id}/{id}`. Prompts: planning, execution, handoff, verification. The tool surface remains sufficient without resources or prompts.

## Errors and limits

Handle `VERSION_CONFLICT` by rereading and reconciling; `CLAIM_EXPIRED` by reclaiming; `IDEMPOTENCY_CONFLICT` by correcting logical request identity; and `DEPENDENCY_BLOCKED` by resolving the listed blockers. Do not blindly retry authorization or validation failures.

Lists allow up to 100 records, batches 50 tickets, and HTTP request bodies 4 MiB. Graph traversal is bounded to 10,000 reachable tickets and fails explicitly above that limit. Evidence, notes, knowledge, and criteria have schema-advertised size limits. Notes and reviews are durable; the initial version has no hard-delete tool or automatic audit retention policy.

Historical checkpoints have their own search documents and `ticketing://checkpoint/{project_id}/{id}` resources. Coverage counts are timestamped snapshots cached for at most five seconds; authorization and source-revision checks are never served from that cache.

Submissions preserve an immutable snapshot of the title, description, and criterion text alongside evidence. Later requirement edits cannot erase what an earlier reviewer approved. The snapshot is null only for records predating the snapshot migration. `ticket_list` accepts `parent_id` to discover child work; context reports incomplete children separately from execution blockers.

Mutation receipts retain identifiers, status, revisions, created note/submission/review IDs, and claim credentials without echoing requirements or evidence. Existing receipts remain immutable and are projected deterministically on authorized replay. Legacy claims identify omitted context with `context_omitted:legacy_receipt`; fetch current context explicitly. `RECEIPT_UNAVAILABLE` identifies a committed operation whose receipt cannot be projected: never reexecute it or replace its key.

## Changed defaults

| Setting                 | Previous                   | Current                       |
| ----------------------- | -------------------------- | ----------------------------- |
| List page size          | 25                         | 10                            |
| `work_next` candidates  | 5                          | 1                             |
| Search results          | 10                         | 3                             |
| `changes_since` events  | 100                        | 25                            |
| `ticket_context` detail | `standard`                 | `brief`                       |
| Related knowledge       | Implicit search in context | Explicit `search` when needed |
