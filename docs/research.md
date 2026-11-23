# Research spikes

Research gathers evidence before an idea's delivery decision. It has its own discovery, claim and completion tools; it never enters ordinary delivery selection, submission/review, dependencies, parent relationships or milestones. Project contributors and admins may schedule and execute research; readers and verifiers may inspect it. Profiles expose tools without granting additional authority.

Connect a planner with `--profile planner` and a researcher with `--profile researcher` (or HTTP `/mcp?profile=researcher`). The default worker and executor catalogs are unchanged.

1. `spike_schedule` accepts `project_id`, `idea_id`, a clear `question`, `time_budget_ms` (1 ms to seven days), an optional `assignee_id` and optional registered `execution_hints`. All mutations require an `idempotency_key`.
2. `spike_list` discovers research separately, optionally filtering `idea_id`. `spike_get` returns the question, budget, latest claim and durable findings. Both honor project membership and include completed or exhausted research.
3. `spike_claim` takes `spike_id`, with optional `client_id`, `include_context` and `max_tokens`. Its claim receipt uses the spike ID as `ticket.id`; use that ID and claim token with `ticket_checkpoint`, `work_heartbeat`, `work_release` and registered execution tools. Recover checkpoint/history references from the returned context before resuming.
4. `spike_complete` takes `spike_id`, the current `expected_revision`, current `claim_token`, `findings`, at least one `evidence` reference, and a `recommendation` of `promote`, `park` or `decline`. The current research result, audit event, ownership release and retry receipt commit atomically. Completed results are immutable.

The elapsed budget starts on the first successful claim. Its timestamp survives release, handoff, reclaim and server restart; pausing does not extend the deadline. Reads expose `budget.first_claimed_at`, `deadline` and `exhausted`. A claim retry returns its original receipt without granting a new start or extending the budget.

Exhaustion prevents new claims and managed agent/script/continuation starts. Deadline checks occur after database reads and immediately before trusted launch callbacks. A queued run discovered after exhaustion is durably cancelled as `never_started` with `SPIKE_BUDGET_EXHAUSTED`; the companion does not launch it. Already-started work retains the existing observation, cancellation and reconciliation controls. Budget exhaustion does not kill a process, erase findings or prove termination.

Research can checkpoint and record its result after exhaustion. Completing findings requires the last still-retained claim token, current project authority and current revision. An expired lease can finalize exhausted research only when that exact actor/token remains its current owner. A replaced or explicitly released claim has no completion right. Explicitly released, unowned research that later exhausts remains visible with its checkpoints; a planner may park or decline the idea without inventing a completed finding. Settle or cancel managed runs and reconcile continuation invocations before completing the result.

Completion is a recommendation and never creates delivery work or changes the idea's disposition. An authorized planner still uses `idea_triage`. Promotion may supply optional `spike_ids`; each must identify completed research for that same idea and project. Those evidence links commit with every resulting ticket's source-idea provenance. Omitting `spike_ids` preserves ordinary direct promotion. Parked and declined ideas retain their research, findings and checkpoints through `spike_list` and `spike_get`.

Mutation receipts are compact; fetch the full question and evidence through `spike_get`. Native execution artifact citations in questions, findings and evidence retain their logs. New citations to retired artifacts are rejected. Research prose, evidence and recommendations remain untrusted project data.
