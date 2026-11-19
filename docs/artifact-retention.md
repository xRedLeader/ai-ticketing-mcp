# Explicit artifact retention

An operator can retire one unreferenced terminal stdout/stderr capture. Nothing runs automatically, and no MCP profile exposes deletion. Use the same store, absolute artifact root and artifact TTL as the MCP service:

```powershell
node dist/execution-companion-cli.js --sqlite STORE --actor ADMIN --project PROJECT --artifacts ABSOLUTE_ROOT --retire execution:RUN_UUID:ATTEMPT_UUID:stdout
```

PostgreSQL uses the configured `DATABASE_URL` instead of `--sqlite`. Migrate with schema-owner credentials before restarting services; this adds PostgreSQL `023_artifact_retention.sql` or SQLite `015_artifact_retention.sql`. The trusted SDK equivalent is `Application.retireExecutionArtifact(actorId, projectId, artifactId)`.

Retirement requires current project-admin authority, a published exact run/attempt identity, completed reconciliation, and an unchanged trusted `result.json`. Both the journal's finish time and durable run settlement must have passed the configured TTL. The journal must confirm cleanup, match the authoritative outcome, and contain the exact capture size and SHA-256. Missing legacy proofs, changed files, links, unresolved effects or uncertain ownership refuse deletion.

Active ticket work pins its run. Canonical artifact/run/attempt identities in stored ticket content, notes, criterion evidence, review feedback, project instructions, non-execution receipts and audit data also pin it, including across projects. Current and immutable historical knowledge text, structured fact key/value, verification evidence and ticket/checkpoint sources remain pins even after edits or archival. These are explicit identity/provenance checks; the system does not infer artifact references from arbitrary remote URLs. Use canonical artifact identities when citing execution output.

Pin checks run through database `EXISTS` queries. Only actual reference writers and artifact/run retrieval acquire the shared artifact lock; retirement acquires its exclusive counterpart. Normal heartbeats do not acquire that lock. SQLite retains its existing write serialization. New references to retired execution identities or memory sources are rejected even on a service without filesystem artifact configuration. Identical committed mutation receipts retain their original authorized replay behavior.

The immutable retirement decision and `artifact.retired` audit event commit before unlink. A second authorized transaction rechecks references, root identity, file identity, hash and expiry, then unlinks that exact file and records `artifact.deleted`. A crash between phases leaves the file protected by a durable decision; repeat the same explicit command after restart. A crash after unlink resumes with the file already absent. Retired reads return explicit `expired` metadata, including the original capture hash and size, without bytes. Changing the configured root or TTL can refuse a pending retry; restore the original configuration before retrying.

The command never removes directories, receipts, submissions, knowledge revisions, execution history, `outcome.json`, or private recovery journals such as `result.json`, `pipeline-report.json` and `pipeline-timeout.json`. Temporary files are refused: current writers do not publish enough lifetime proof to authorize deleting an orphan safely. No recursive deletion or caller-supplied filesystem path is accepted.

Pinned artifacts remain readable after the configured TTL. Authorized reads first honor immutable retirement decisions, then check durable pins only when the ordinary artifact read would expire. Pinned reads return available bytes and hashes with no scheduled expiry; unpinned reads retain their normal expiry. The same rule applies to bounded run status, omission recovery and failure-location evidence.
