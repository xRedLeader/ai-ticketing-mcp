# Measuring review efficiency

Run `npm run benchmark:review` on Node 24 to compare the full and compact formats offline. The benchmark passes synthetic tickets through the dispatcher and captures the serialized Responses request. It checks the full request against the frozen baseline, reconstructs the attachments from the candidate and checks evidence for each criterion. It counts every serialized request and mock response using `o200k_base`. CI checks every scenario for regressions, enforces the representative savings threshold, and verifies exact fallback for data without shared chunks.

The cases include approval, missing evidence, missing criterion support, a handoff comment omitting its blocker, a truncated receipt, a wrong binary header and an entropy control. Checking the header requires reading bytes inside a factored chunk. The offline verdict comes from the fixture oracle. For independent decisions and provider usage, use a paired live run.

## Paired live review

The live command uses a fixed synthetic fixture and a fresh run name. Each run issues exactly one invocation per format with identical review instructions, decision schema and model selection. It saves requests before dispatch and retains results from unsuccessful arms. Inspect the findings for every criterion alongside the verdict. A failed feedback check can also mean a reviewer expressed a fact in language outside the fixture scorer.

```sh
npm run benchmark:review:live -- --run release-pass --scenario pass --model gpt-5-mini
npm run benchmark:review:live -- --run release-header --scenario wrong-header --model gpt-5-mini
```

These commands use `REVIEW_OPENAI_API_KEY` and the production Responses endpoint. Each successful native comparison requires both expected findings, the same provider-reported model in both arms, fewer input tokens, and fewer total input-plus-output tokens. Cached input and reasoning output are subsets of those totals. An unchanged packet skips admission before a provider call. Run both cases when evaluating a format change. Each report describes one pair.

To evaluate the same evidence with an authenticated Codex CLI, add `--client codex --codex-bin ABSOLUTE_PATH --model MODEL --effort high`. This opens two ephemeral read-only sessions and checks the trace for unexpected tool use. The client supplies its own system context and output settings. This route records a Codex result with `native_responses_gate_passed: false`.

Artifacts are under `.local/review-benchmarks/RUN/`. They include the fixture expectations, request hashes, responses or JSONL traces, elapsed time, provider usage and per-criterion scoring errors. Missing usage keeps the result inconclusive. Billing and unreported provider retries remain unknown.

## Measured Codex comparison

On November 24, 2026, four isolated Codex invocations requested `gpt-6.2-astra` at high effort. Each reviewer received the same five synthetic criteria. Both formats produced the expected decision and cited the correct observations for every criterion.

| Fixture        | Decision from both formats | Full input + output | Compact input + output |
| -------------- | -------------------------- | ------------------: | ---------------------: |
| Valid receipts | Approve                    |        39,226 + 238 |           25,565 + 203 |
| Wrong header   | Request changes            |        39,230 + 256 |           25,564 + 250 |

The two compact reviews used 51,582 reported tokens in total, down from 78,950 for the two full reviews. Both reviewers of the damaged receipt cited the observed prefix `e37d5cd68b3d10f2` and the required `53594e5448524354`. All four invocations reported zero cached input. These observations cover this client, model selection and pair of fixtures.
