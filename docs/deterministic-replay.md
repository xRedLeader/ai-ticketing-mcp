# Offline deterministic policy replay

Replay retained real-client benchmark reports without running a client, model, provider, server, or policy activation. Node 24 and the repository's installed dependencies are required:

The client traces contain retrievals and preserve their recorded schedule. Scheduling replay uses a separate frozen queue snapshot.

```sh
node --import tsx scripts/deterministic-replay.ts \
  --report /private/real-client-runs/study/report.json \
  --out /private/replay-study.json
```

`--out` must be a new file. Keep it private: it contains exact original report and raw model JSONL bytes as base64, including synthetic claim credentials. SHA-256 hashes bind these snapshots to their original paths. Original reports, rejected calls, failed attempts, partial JSONL, and databases are never rewritten. Missing or inconsistent raw evidence prevents successful revalidation; it is not repaired or discarded.

The input is the existing `real-client-benchmark.ts` report format and frozen `scripts/fixtures/protocol-workflows.json` contract. Each attempt's original artifact directory must remain available. Existing `revalidateAttempt` checks the fixture database read-only, exact current requirements, successful observed submission, independent review when required, and complete delivery/maintenance evidence. It retains authoritative source hashes and original failures. Self-policy completions may count as successful completed workflows, but cannot count as independently accepted outcomes. An acceptance denominator requires a current submission and approval from a distinct reviewer; an old revision, incomplete evidence, or a recorded `completed` label is insufficient.

Each workflow reports separate rows:

| Row                | Meaning                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observed_actual`  | Authoritatively revalidated completion and original measured elapsed/usage, including all failed and interrupted attempts.                                                    |
| `simulated_policy` | Deterministic `repeat-read-cache-v1` opportunities and stale-response regressions over retained calls. Counterfactual completion, elapsed, and provider usage remain unknown. |

The policy caches allowlisted read requests within one invocation. Successful reads populate the cache; mutations, unknown operations, and errors clear it. A response must have completed before the repeated request starts; overlapping writes or unknown timing prevent cache reuse. A repeated request predicts the earlier response. Replay compares that prediction with the actual retained response, without normalizing generated metadata or array order. Exact matches are possible avoided requests. Changed results or an access-denied response are explicit `stale_response_regressions`, including the original call index and ID. Results never establish that a live cache is safe; conditional validation and measured follow-up are needed. Original call order and mutation outcomes stay intact, and nothing executes the recommendation.

Request/result byte and local tokenizer counts are transport reference estimates. Canonical envelopes use the existing serializer, and provider usage uses the existing real-client usage fields. Neither reference counts nor repeated reads establish a model discount or provider savings. Cached input remains a subset of input tokens and is never added again. Monetary cost is not inferred.

Elapsed time is each attempt's original `finished_at - started_at`, including setup and failed attempts. Missing intervals remain unknown. Usage totals retain each field's reported known total and unknown-invocation count. Missing raw evidence or a report/raw inconsistency adds `unverified_attempts` and prevents derived averages, even when another attempt was independently accepted. A missing invocation report also prevents a complete usage average. A per-accepted-outcome value is available only when its numerator is fully known and at least one independently accepted current revision exists. A successful retry does not remove earlier failures or their usage.

Compare two recorded reports with the same model configuration:

```sh
node --import tsx scripts/deterministic-replay.ts \
  --baseline /private/before/report.json \
  --report /private/after/report.json \
  --out /private/comparison.json
```

Every workflow appears in `comparison`, including missing workflows, completion regressions, fewer independent acceptances, slower elapsed per accepted outcome, higher usage per accepted outcome, and unknown metrics. An aggregate improvement never hides a workflow regression. These are observed-run comparisons, without a causal claim that the proposed cache caused a difference. Comparisons pin recorded models, effective per-role efforts, runtime revision/hashes, client/version, fixture/contract, prompt layout, and measurement identities. Different configurations are rejected. Model/effort comparisons require explicit budgets and separate measured real runs that preserve their original artifacts and limitations; sustained private live evaluation belongs to SELF-25.

The module exports `replayRetrieval(calls)`, `replayReport(report, authoritativeRevalidations)`, `assertComparableReports(baseline, candidate)`, and `compareReports(baseline, candidate)`. Only the CLI obtains authoritative revalidations directly from the existing read-only validator. Module callers must supply those validator results, keyed by `workflowId/attemptId`; absent proofs never imply acceptance. There is no public package export or production policy setting.

Run the offline checks:

```sh
node --import tsx --test tests/deterministic-replay.test.ts
```

Fixtures reuse the frozen workflow IDs and real-client invocation parser. They cover exact read reuse, external revision changes, rejected reads, write/unknown-operation barriers, invocation isolation, stale acceptance, self-review, failed and incomplete attempts, unknown usage, per-workflow regressions, exact byte snapshots, and exclusive output creation. No test calls a provider.

One local replay of the retained six-workflow `self2-live` artifacts kept all four originally failed attempts and found one independently accepted current revision. Its review workflow contained one exact repeated read: 158 request bytes and 3,765 full SDK-result bytes, with 66 request and 555 canonical-result reference tokens. No stale response appeared in that captured comparison. These are recorded transport opportunities only; counterfactual model usage, elapsed improvement, completion, and savings remain unknown. Synthetic changed-revision and rejected-read fixtures demonstrate why the policy remains a recommendation.

## Scheduling replay

Capture a standalone SQLite backup of the eligible queue at an observed decision. Keep the snapshot and a private observation JSON with `snapshot_sha256`, `observed_at` in UTC, `project_id`, and `actor_id`. Include the original `labels`, `capabilities`, and `limit` when supplied. The replay checks the pinned database bytes, evaluates both scheduling policies through `work_next` on a temporary copy, and reports the ordered candidates with their original requirements revisions.

```sh
node --import tsx scripts/scheduling-replay.ts --snapshot .local/frozen-queue.sqlite --observation .local/queue-observation.json --out .local/queue-replay.json
```

Use snapshots from an execution runtime with the external client-capability registry disabled. The replay uses the supplied actor and capabilities for one queue decision. A changed first candidate shows the effect on ordering at that decision. Completion, elapsed time, and provider usage for the alternate order remain unknown. The retrieval report provides observed outcome and usage metrics.
