# AI Ticketing MCP

Headless ticketing built for agents: find useful work, claim it safely, recover context, and finish with evidence. Control it through the Model Context Protocol (MCP).

**One team, multiple projects, many agents.** PostgreSQL is the default implementation; storage, search, and embedding providers are replaceable through exported TypeScript contracts.

## What agents get

- Structured tickets with acceptance criteria, priorities, capabilities, parents, and blocking dependencies.
- Atomic ten-minute claims, heartbeat renewal, stale-worker fencing, and retry-safe mutations.
- Optional [GitHub CI evidence](docs/mcp.md#github-evidence), [durable signed notifications](docs/operations.md#durable-signed-notifications), and [deterministic unblocking scheduling](docs/mcp.md#scheduling).
- Durable checkpoints, blocking questions, decisions, and artifact references.
- One-call context with complete requirements, project instructions, prior work, and explicit retrieval references.
- Self, independent-agent, or human verification policies. Independent review is the default.
- Hybrid text/vector search, using local Ollama or a hosted OpenAI-compatible embedding provider.
- Attributable events and durable polling cursors, without keeping an MCP connection alive.
- Local stdio and OAuth-protected Streamable HTTP; no frontend or agent runtime required.

For automatic server-side traffic capture and offline token reports, see [MCP profiling](docs/operations.md#mcp-profiling). It adds no tools or response fields to the agent's context.

## Quickstart

Install Docker with Compose and Node.js 24 or newer. From a clean checkout:

```sh
npm ci
node scripts/setup.mjs
docker compose --profile auth --profile local-ai up -d --build
```

Setup creates private random passwords in the ignored `.env` file and preserves existing configuration. The first start downloads the embedding model. Check readiness with `docker compose ps` and `docker compose logs model-pull`.

- MCP: `http://localhost:3000/mcp`
- OAuth metadata: `http://localhost:3000/.well-known/oauth-protected-resource/mcp`
- Keycloak: `http://localhost:8080` (administrator `admin`, password from your private `.env`)
- PostgreSQL: localhost port 5432; roles `ticketing_owner` for migrations and `ticketing_app` for runtime.

Run the two-agent walkthrough from the host:

```sh
npm run walkthrough
```

It creates an isolated demo project, connects separate MCP clients, claims work, records a checkpoint, submits evidence, and obtains independent approval. It uses local trusted operator access to register the demo identities. Its final output includes the project and ticket identifiers.

For real users and agents, follow [identity and client setup](docs/authentication.md). The realm contains no preconfigured ordinary users and the application grants no permissions automatically.

## The work loop

1. `project_list` discovers authorized projects; select worker (default), planner, reviewer, or full profile for the task.
2. `work_claim` selects and claims work atomically, returning brief context with current requirements, instructions, policy, blockers, and credentials.
3. Follow required omission references before resumed work or review. Use `ticket_context` for more detail and `ticket_history` for history.
4. `ticket_checkpoint` persists progress and returns the next ticket revision. Heartbeat at least every three minutes.
5. `ticket_submit` supplies passing evidence for every criterion using the latest returned revision.
6. A reviewer reads current requirements and submission evidence, then uses `ticket_review` according to policy.

Use a fresh `idempotency_key` for each logical mutation, reusing it only for an identical retry. Read the latest revision before edits and submission. A changed requirement revokes claims and invalidates affected approvals; an old worker cannot continue with its former token.

Connect with `stdio --profile planner` or `/mcp?profile=reviewer`; OAuth tokens still target `/mcp`. Profiles select tools without changing permissions. Lists and mutation receipts are compact; fetch full current state through `ticket_get` or `project_get`. Existing clients should review the [changed defaults](docs/mcp.md#changed-defaults). The [SDK maintenance example](examples/claim-maintenance.ts) renews ownership independently every two minutes and catches up change pages between model turns, retaining keys across identical retries.

Ticket references accept a UUID or readable key such as `CORE-42`. Project references use UUIDs. Full [tool and workflow behavior](docs/mcp.md) is documented separately.

## Local SQLite

After `npm ci` and `npm run build`, start a local MCP server without PostgreSQL or an embedding service:

```sh
node dist/cli.js stdio --sqlite .local/ticketing.sqlite --profile full
```

Use an absolute file path in MCP client configuration. The server migrates the file and, when no explicit actor is supplied, persists a local agent identity with administrator access. This trusts the local file owner, never impersonates a human reviewer, and does not bootstrap HTTP authentication. Explicit `ACTOR_ID` or `--actor` takes precedence. SQLite stdio indexes its durable queue in the background, so newly created tickets become searchable without another worker. PostgreSQL and HTTP still use the existing worker command.

For other CLI commands, set `STORAGE_ADAPTER=sqlite`, `SQLITE_PATH`, and `EMBEDDING_PROVIDER=none`, or use `--sqlite PATH`. PostgreSQL remains the default. SQLite provides full-text search and reports semantic search as disabled.

## Advisory execution hints

Projects and tickets accept optional `execution_hints` with `model` and `effort` strings. Ticket fields override the corresponding project defaults; `ticket_get` and context expose `effective_execution_hints` only when configured. A provided object replaces the local hints; an omitted object leaves them unchanged. Null, an empty object, or empty/null fields clear local choices so project defaults can apply. Model/effort hints never execute a provider, configure embeddings, grant permissions, or guarantee a model is accepted by the consuming client.

## Extending the system

```ts
import { createApplication } from 'ai-ticketing-mcp';
import type { StorageAdapter, SearchAdapter, EmbeddingProvider } from 'ai-ticketing-mcp/contracts';

const app = createApplication({ storage, search, embeddings });
```

Supply your own adapters and retain the application operations and MCP tools. `ai-ticketing-mcp/postgres` exports the default adapters; `ai-ticketing-mcp/testing` exports reusable contract tests. See [adapter development](docs/adapters.md) for transaction guarantees, migration ownership, and an implementation example.

The package can be consumed from this repository after building; an npm registry release is not required. No alternate production database adapter is advertised until it passes the same tests.

## Development and verification

```sh
npm ci
npm run build
npm test
# Set TEST_DATABASE_URL to a disposable PostgreSQL database with pgvector.
npm run test:integration
npm run check
npm run format:check
# With a disposable database configured, check the frozen protocol benchmark.
npm run benchmark:protocol
# Measure concurrent claims/heartbeats and receipt capacity on PostgreSQL.
npm run benchmark:claims
```

Integration tests require a real database and fail clearly when it is not configured. They exercise claims, races, retries, stale workers, review policies, permissions, search freshness, and both MCP transports. See the [verification record](docs/verification.md) for measured results, the [real-client benchmark](docs/real-client-benchmark.md) for Codex cost/completion measurements, and [operations](docs/operations.md) for backup/restore, rebuilding search, and benchmarks.

Contributions use [Conventional Commits](CONTRIBUTING.md). Public MCP and adapter contracts follow semantic versioning. Licensed under [Apache-2.0](LICENSE).

Before upgrading, read the [release notes and required migrations](docs/release-notes.md).

## Boundaries

The server coordinates work; it does not execute agent commands or independently prove evidence. Binary artifacts stay in external systems. Hosted embedding providers receive indexed text. Retrieval is eventually consistent and reports degraded semantic coverage; authoritative ticket reads remain available while indexing catches up.
