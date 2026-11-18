import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import pg from 'pg';
import { PostgresStorage, PostgresSearch } from '../src/adapters/postgres.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { fixture } from '../src/testing/contracts.js';
import { countReferenceTokens } from '../src/tokens.js';

const databaseUrl = process.env.BENCHMARK_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set BENCHMARK_DATABASE_URL or TEST_DATABASE_URL to disposable PostgreSQL.');
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run this benchmark with Node 24.');
const schema = `claim_benchmark_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^claim_benchmark_[a-f0-9]{32}$/);
const bootstrap = new pg.Pool({ connectionString: databaseUrl });
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
const storage = new PostgresStorage(isolatedUrl.href);
const search = new PostgresSearch(storage.pool);
const lanes = 8;
const rounds = 3;
const description =
  'Keep ticket updates atomic, preserve retry receipts, and validate ownership before writing. '
    .repeat(50)
    .trim();
const largeCriteria = Array.from({ length: 50 }, (_, criterion) =>
  Array.from({ length: 10 }, (_, part) =>
    createHash('sha256').update(`${criterion}:${part}`).digest('hex'),
  ).join(' '),
);
function stats(values: number[]) {
  assert.ok(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = values.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
}
assert.equal(stats([1, 2, 3, 4, 5]).p95, 5);

try {
  await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await storage.migrate();
  countReferenceTokens('Warm the tokenizer before measuring database operations.');
  const results = [];
  for (const mode of ['claim_only', 'brief', 'claim_only_large', 'large'] as const) {
    const f = await fixture({ storage, search });
    const options = {
      include_context: !mode.startsWith('claim_only'),
      max_tokens: mode === 'large' ? 32768 : 4096,
    };
    const makeTicket = () =>
      f.ticket({ description, ...(mode.endsWith('large') ? { criteria: largeCriteria } : {}) });
    const heartbeatClaims: { ticket: { id: string }; claim: { token: string; expires_at: string } }[] = [];
    for (let lane = 0; lane < lanes; lane++) {
      const ticket = await f.ticket();
      heartbeatClaims.push(
        (await f.call(f.worker.id, 'work_claim', { ticket_id: ticket.id, include_context: false })) as any,
      );
    }
    const warmTicket = await makeTicket();
    await f.call(f.worker.id, 'work_claim', { ticket_id: warmTicket.id, ...options });
    const claimMs: number[] = [];
    const heartbeatMs: number[] = [];
    const tokens: number[] = [];
    const ticketIds: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const tickets = [];
      for (let lane = 0; lane < lanes; lane++) tickets.push(await makeTicket());
      f.clock.now = new Date(f.clock.now.getTime() + 1000);
      const measured = async (samples: number[], work: () => Promise<unknown>) => {
        const start = performance.now();
        try {
          return await work();
        } finally {
          samples.push(performance.now() - start);
        }
      };
      const inputs = tickets.map((ticket) => ({
        ticket_id: ticket.id,
        idempotency_key: randomUUID(),
        ...options,
      }));
      const work = inputs.flatMap((input, lane) => [
        measured(claimMs, () => f.call(f.worker.id, 'work_claim', input)),
        measured(heartbeatMs, () =>
          f.call(f.worker.id, 'work_heartbeat', {
            ticket_id: heartbeatClaims[lane]!.ticket.id,
            claim_token: heartbeatClaims[lane]!.claim.token,
          }),
        ),
      ]);
      const completed = await Promise.allSettled(work);
      assert.equal(
        completed.filter((result) => result.status === 'rejected').length,
        0,
        JSON.stringify(
          completed.filter((result) => result.status === 'rejected').map((result) => String(result.reason)),
        ),
      );
      for (let lane = 0; lane < lanes; lane++) {
        const result = (completed[lane * 2] as PromiseFulfilledResult<any>).value;
        assert.equal(result.ticket.id, tickets[lane]!.id);
        assert.equal((await storage.get('claims', result.ticket.id))?.token, result.claim.token);
        const serialized = serializeSuccessEnvelope(result);
        const count = countReferenceTokens(serialized);
        assert.ok(count <= options.max_tokens);
        if (mode === 'large') assert.ok(count >= 20000, 'Large fixture must exercise a substantial context.');
        if (mode === 'brief')
          assert.ok(count >= 1000, 'Brief fixture must include substantial requirements.');
        if (!options.include_context) assert.equal(result.context_omitted, 'requested');
        else assert.equal(result.context.ticket.description, description);
        tokens.push(count);
        ticketIds.push(result.ticket.id);
        assert.equal(
          serializeSuccessEnvelope(await f.call(f.worker.id, 'work_claim', inputs[lane])),
          serialized,
          'An identical retry must return the stored claim and context.',
        );
      }
      for (const claim of heartbeatClaims) {
        const current = await storage.get('claims', claim.ticket.id);
        assert.equal(current?.token, claim.claim.token);
        assert.ok(Date.parse(current!.expires_at) > Date.now(), 'Heartbeat ownership must remain live.');
        assert.ok(current!.expires_at > claim.claim.expires_at, 'Heartbeat must extend the lease.');
      }
    }
    const receipts = await storage.pool.query(
      `SELECT octet_length(result::text) AS logical_bytes, pg_column_size(result) AS stored_bytes
       FROM receipts WHERE project_id=$1 AND operation='work_claim' AND result->'ticket'->>'id'=ANY($2::text[])`,
      [f.project.id, ticketIds],
    );
    assert.equal(receipts.rowCount, lanes * rounds, 'Retries must not add receipts.');
    assert.equal(claimMs.length, lanes * rounds);
    assert.equal(heartbeatMs.length, lanes * rounds);
    const logicalBytes = stats(receipts.rows.map((row) => row.logical_bytes));
    const storedBytes = stats(receipts.rows.map((row) => row.stored_bytes));
    results.push({
      mode,
      max_tokens: options.max_tokens,
      claim_ms: stats(claimMs),
      heartbeat_ms: stats(heartbeatMs),
      response_tokens: stats(tokens),
      receipt_logical_bytes: logicalBytes,
      receipt_stored_bytes: storedBytes,
      receipt_result_gib_per_10000_claims_per_day_for_365_days: (storedBytes.mean * 10000 * 365) / 2 ** 30,
      within_ordinary_300ms_p95_target: stats(claimMs).p95 < 300 && stats(heartbeatMs).p95 < 300,
    });
  }
  const report = {
    observed_at: new Date().toISOString(),
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktree_dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    host: {
      node: process.version,
      platform: os.platform(),
      cpus: os.availableParallelism(),
      memory_gib: os.totalmem() / 2 ** 30,
    },
    database_version: (await bootstrap.query('SHOW server_version')).rows[0].server_version,
    workload: {
      lanes,
      rounds,
      simultaneous_calls: lanes * 2,
      projects_per_case: 1,
      description_characters: description.length,
      large_criteria: 50,
      large_fixture:
        'Deterministic SHA-256 strings model high-entropy requirements; not a typical text/compression estimate.',
      exclusions:
        'HTTP/MCP transport, provider inference, and setup/replay/assertion time. Latencies include pool/lock waits, queries and packing; not isolated lock time.',
      storage_scope:
        'Stored result datum only; excludes row/index overhead, other receipts, WAL, backups and replicas.',
    },
    results,
  };
  await mkdir('.local', { recursive: true });
  await writeFile('.local/claim-benchmark-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await storage.close();
  try {
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await bootstrap.end();
  }
}
