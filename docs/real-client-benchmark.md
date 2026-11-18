# Real Codex client measurement

This harness invokes the installed Codex CLI once per role and workflow. It does not implement a model loop. The six scenario definitions remain in the unchanged [protocol workflow contract](../scripts/fixtures/protocol-workflows.json); the deterministic reference benchmark remains separate.

Use Node 24, installed dependencies, an authenticated Codex CLI, and an explicit stable build containing `dist`, `migrations`, `package.json`, and `package-lock.json`. The harness copies that build and its migrations together, records its revision and hashes, and verifies the copy on resume. It never opens the real roadmap database or copies authentication files.

Start with the measured short workflow, using a unique run name and the chosen build:

```sh
node --import tsx scripts/real-client-benchmark.ts --run client-study --workflow short --runtime .local/runtime-e9f3ec7 --revision e9f3ec7
```

Continue the same report with the remaining workflows:

```sh
node --import tsx scripts/real-client-benchmark.ts --run client-study --workflow all --resume
```

Successful workflows are never rerun. Failed attempts and their usage remain in the report. An explicit `--retry-failed` creates another immutable attempt; it does not replace a failure. The report records failed-attempt and retry counts. Interrupted invocations are reconciled from their retained JSONL when resumed. There is no automatic model fallback or retry-to-green loop.

For a confirmed validator defect, preserve an immutable original report snapshot and its SHA-256, correct the validator with a regression test, then revalidate the captured observations offline:

```sh
node --import tsx scripts/real-client-revalidation.ts --run client-study --original-report .local/original-report.json --original-sha256 SHA256 --reason "Describe the validator correction"
```

This command makes no provider calls. It creates a new private `corrections/revalidation-UUID.json` artifact with original verdicts and failures, corrected verdicts, source/input hashes, per-mutation delivery proofs, authoritative final-state checks, and unchanged usage totals. It reads the original fixture database in read-only mode, checks the stored description against the production-normalized frozen seed, and never normalizes captured responses. Original reports and per-attempt artifacts remain unchanged. Missing responses, incomplete maintenance evidence, changed usage, or unfinished authoritative state remain failures.

The default worker is `gpt-6.1-sol`, the independent reviewer is `gpt-6-astra`, and both request `xhigh`. Override models on the first command with `--model` and `--reviewer-model`; `--effort` sets the requested effort. A report retains its chosen models. Unsupported models, client failures, missing usage, incomplete delivery, and unfinished tickets are reported explicitly. `--timeout-seconds` bounds each invocation; its default is 600 seconds. `CODEX_BIN` or `--codex-bin` can select an installed native CLI executable.

## Isolation and observations

Every attempt has a fresh SQLite fixture and new worker/reviewer identities. Each model invocation uses an empty temporary working directory, ignores user configuration, disables plugins and shell tools, and completely replaces the `ai-ticketing` MCP server command/environment with the fixture server. No live operator identity is used as a fallback. Fixture-server assertions reject missing configuration or the wrong seeded project.

The invocation retains the read-only sandbox and sets `approval_policy="on-request"` with `approvals_reviewer="auto_review"`. MCP writes go through the native approval reviewer. The harness does not preapprove tools or change machine policy; a rejection remains a failed attempt. The original `never` configuration can reject a required MCP approval before review, which is recorded separately from an unclassified reviewer rejection.

Two virtual maintenance intervals run through an observed SDK sidecar outside model turns. Its discovery, calls, retries, reconciliation reads, and JSON-RPC messages are recorded separately with `consumer:maintenance`. They never establish information delivered to a model, even when the actor ID matches. The fixture's clock is shared between foreground and maintenance requests. These are virtual intervals; the report does not add fictitious minutes to real elapsed time.

Model completeness is checked against its own Codex `item.started`/`item.completed` MCP records before dependent mutations are attempted. Workers must receive current requirements, instructions, policy, blockers, dependencies, and required resume decisions. Reviewers must receive current requirement identities and the actual relevant submission evidence. Successful checkpoint/review arguments must acknowledge required facts received from those responses. Fixture-only knowledge and another consumer's responses cannot satisfy those checks.

Codex's tool-output limit is set to 32,768 tokens. JSONL result logs do not expose the exact final model rendering, so the report records that limitation and checks concrete facts copied into subsequent actions as additional evidence. This demonstrates observed coordination behavior, not that a model understood every token or independently verified an external URL.

## Report and costs

Artifacts are private, ignored files under `.local/real-client-runs/RUN/`. `report.json` aggregates all attempts; each attempt retains raw model JSONL, stderr, request configuration, validation results, maintenance observations, and its fixture database. New attempts record the driver and parser SHA-256 hashes and the approval configuration. Raw fixture logs include synthetic claim credentials and should remain private. The sidecar appends its wire and call records as they occur; interrupted runs retain those records with incomplete counts marked unknown if the final summary is unavailable.

Provider/client usage comes from the last cumulative `turn.completed.usage` event once per invocation, including input, cached input, output, and reasoning fields when reported. Missing fields remain unknown. Failed invocations with reported usage remain in the totals. Identical MCP mutation retries are counted from repeated request identities; provider retries not exposed by the client remain unknown.

Approval-review usage is not separately reported by this CLI and remains unknown. The report does not infer zero review cost or whether that usage is included in the main invocation totals.

Local `o200k_base` reference counts for observed MCP requests, complete results, and canonical envelopes are separate from provider usage. Model-side catalog discovery is not emitted in the client trace and remains unknown; the sidecar's observed discovery is recorded. Monetary cost remains unavailable unless independently established; token references, cached-token counts, and elapsed time are not dollar estimates.
