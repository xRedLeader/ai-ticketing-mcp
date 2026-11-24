# Claim handoff

A handoff is a durable checkpoint offer followed by the named recipient's explicit acknowledgment. The source remains the only claim owner until acknowledgment commits. It keeps heartbeating its existing token while waiting; offering never releases ownership or gives the recipient that token.

The source uses the worker or full profile's existing `ticket_checkpoint`:

```json
{
  "project_id": "<project UUID>",
  "ticket_id": "TASK-42",
  "claim_token": "<source's own live token>",
  "idempotency_key": "<fresh source key>",
  "progress": "Investigation is complete; implementation remains.",
  "remaining": ["Implement the owner check and verify each current criterion."],
  "decisions": ["Preserve the current trust boundary."],
  "references": ["execution:<run UUID>:<attempt UUID>:result"],
  "handoff": {
    "recipient_id": "<authorized recipient UUID>",
    "workspace_id": "run-1-attempt-1",
    "commit": "<exact 40-character lowercase Git commit>"
  }
}
```

`workspace_id` is an opaque identity of at most 80 word, dot or hyphen characters, excluding `.` and `..`. The server preserves this identity and commit as untrusted checkpoint data; it never opens a workspace or executes a path. Retain and independently verify the corresponding trusted [local worktree record](worktree-isolation.md) before filesystem work or publication. Execution references must name artifacts published by this exact ticket, project, run and attempt. Other checkpoint citations remain untrusted evidence. No host or provider work is launched.

Resolve active queued/reserved/running registered execution before offering. An explicit assignment to the source must be cleared through normal authorized `ticket_update` first. Handoff never redirects assignment, client, model, effort, operating-system or environment pins. The recipient must have current contributor/admin authority and support the current capabilities and exact pinned choices.

The offer's `checkpoint.id` is the acknowledgment identity. The named recipient uses its own authenticated worker/full session and a fresh key:

```json
{
  "project_id": "<project UUID>",
  "ticket_id": "TASK-42",
  "handoff_checkpoint_id": "<offered checkpoint UUID>",
  "idempotency_key": "<fresh recipient key>",
  "max_tokens": 4096
}
```

`ticket_id` and complete context are mandatory for acknowledgment; `include_context:false` is rejected. Inside the existing project transaction, the server rechecks both actors' current project authority, the exact live source generation, unchanged ticket/requirements revisions, blockers, assignment, current capabilities and fresh client matching. Any new source publication or other ticket revision invalidates the offer; source heartbeats can continue without invalidating it. Releasing or expiring the source claim, changing criteria, or revoking either actor prevents acceptance. Only successful acknowledgment replaces the claim with a new recipient token. The old token then cannot checkpoint, submit evidence, release or renew ownership.

The acknowledgment receipt includes `handoff.checkpoint_id`, `handoff.source_actor_id`, the new claim and complete budgeted current context. Its handoff checkpoint is either inline or identified by an executable `required_before:execution` retrieval. Follow every required omission, paging `ticket_history` until `has_more:false`, before resuming. Fetch artifact bytes through an authorized executor/full `artifact_read` when their contents are needed; checkpoint artifact identities do not prove their contents. A context-budget or validation failure rolls back the entire acknowledgment and leaves the previous owner unchanged. Increase `max_tokens` after a budget error rather than bypassing context.

If acknowledgment's response is lost, reconnect and retry the exact request with the same key. The stored receipt returns only while its recipient token is still the current live claim and current project authority permits it. After release, expiry, reassignment or requirements invalidation, replay returns `HANDOFF_STALE` or the current authorization error without a token. Claim and heartbeat receipts for a ticket with handoff history are similarly fenced once their generation stops being current. Read fresh `ticket_context` before continuing; an old receipt never restores authority.

Private immutable `claim_handoffs` rows retain the source token's hash and revision pins. These internal values and the old source token never enter recipient contexts, checkpoint metadata or acknowledgment receipts. Public handoff details use the existing durable checkpoint and artifact-reference pinning. Apply additive PostgreSQL migration `027_claim_handoffs.sql` or SQLite migration `019_claim_handoffs.sql` before using the feature; custom storage adapters must implement the new table and immutable put/remove behavior. Failed or interrupted attempts preserve the durable claim/offer/receipt evidence for normal recovery.

## Verification

The exported handoff contract suite runs real HTTP SDK clients against SQLite and PostgreSQL. It covers small-budget rollback, required worker-visible retrieval, inline large-budget context, a new application/session recovering a lost acknowledgment response, stale receipt and old-publication rejection, authorization/requirements/lease changes, exact execution pins, artifact identities, and concurrent acknowledgment/publication races. Execution state fixtures make no native or provider launches. Both worker and executor input catalogs remain at or below 5,000 reference tokens; no MCP operations were added.

```sh
node --import tsx --test tests/handoff.test.ts
TEST_DATABASE_URL=<disposable PostgreSQL URL> node --import tsx --test tests/integration/handoff.test.ts
```
