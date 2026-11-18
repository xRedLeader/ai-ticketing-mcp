import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application.js';
import type { SearchAdapter } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { schemas } from '../src/schemas.js';
import { countReferenceTokens } from '../src/tokens.js';
import { testEmbeddings } from '../src/testing/contracts.js';
import { contextFixture } from './context-fixture.js';

it('releases the read snapshot before bounded full-envelope packing and skips BPE for unchanged context', async () => {
  const fixture = contextFixture();
  let calls = 0;
  let fullCalls = 0;
  const app = createApplication({
    storage: fixture.storage,
    search: {} as SearchAdapter,
    embeddings: testEmbeddings,
    now: () => fixture.now,
    countReferenceTokens: (text) => {
      assert.equal(fixture.state.reading, false);
      assert.equal(fixture.state.mutating, false);
      calls++;
      if (text.includes('mandatory-snapshot-marker')) fullCalls++;
      return countReferenceTokens(text);
    },
  });
  const input = { project_id: fixture.project.id, ticket_id: fixture.ticket.id, detail: 'full' };
  const start = performance.now();
  const result = (await app.execute(fixture.actor.id, 'ticket_context', input)) as any;
  const total = performance.now() - start;
  assert.equal(result.reviews.length, 10);
  assert.equal(result.submissions.length, 10);
  assert.ok(fullCalls <= 2, `Whole-envelope counts: ${fullCalls}`);
  assert.ok(countReferenceTokens(serializeSuccessEnvelope(result)) <= 32768);
  console.log(
    JSON.stringify({
      context_packing: {
        full_envelope_counts: fullCalls,
        total_counter_calls: calls,
        snapshot_ms: +fixture.state.snapshot_ms.toFixed(2),
        cpu_after_snapshot_ms: +(total - fixture.state.snapshot_ms).toFixed(2),
      },
    }),
  );
  calls = 0;
  fullCalls = 0;
  assert.deepEqual(
    await app.execute(fixture.actor.id, 'ticket_context', { ...input, if_none_match: result.fingerprint }),
    { fingerprint: result.fingerprint, not_modified: true },
  );
  assert.equal(calls, 0);
});

it('repairs underestimated section joins with bounded exact full-envelope checks', async () => {
  const fixture = contextFixture();
  let fullCalls = 0;
  const app = createApplication({
    storage: fixture.storage,
    search: {} as SearchAdapter,
    embeddings: testEmbeddings,
    now: () => fixture.now,
    countReferenceTokens: (text) => {
      if (!text.includes('mandatory-snapshot-marker')) return 1;
      fullCalls++;
      return countReferenceTokens(text);
    },
  });
  const result = (await app.execute(fixture.actor.id, 'ticket_context', {
    project_id: fixture.project.id,
    ticket_id: fixture.ticket.id,
    detail: 'full',
    max_tokens: 4096,
  })) as any;
  assert.ok(fullCalls <= 5, `Whole-envelope counts: ${fullCalls}`);
  assert.ok(countReferenceTokens(serializeSuccessEnvelope(result)) <= 4096);
  assert.equal(result.ticket.description, fixture.ticket.description);
  assert.ok(result.omitted.length > 0);
});

it('credits the replaced omission when a small required checkpoint fits near the budget', async () => {
  const fixture = contextFixture();
  fixture.tables.reviews = [];
  fixture.tables.submissions = [];
  fixture.tables.notes![0].body = 'A small checkpoint.';
  const app = createApplication({
    storage: fixture.storage,
    search: {} as SearchAdapter,
    embeddings: testEmbeddings,
    now: () => fixture.now,
  });
  const input = { project_id: fixture.project.id, ticket_id: fixture.ticket.id, detail: 'full' };
  const roomy = await app.execute(fixture.actor.id, 'ticket_context', input);
  const maximum = countReferenceTokens(serializeSuccessEnvelope(roomy)) + 16;
  const bounded = (await app.execute(fixture.actor.id, 'ticket_context', {
    ...input,
    max_tokens: maximum,
  })) as any;
  assert.equal(bounded.latest_checkpoint?.body, 'A small checkpoint.');
  assert.ok(countReferenceTokens(serializeSuccessEnvelope(bounded)) <= maximum);
  assert.equal(
    bounded.omitted.some((entry: any) => entry.section === 'latest_checkpoint'),
    false,
  );
});

it('makes reference-token telemetry opt-in without disabling context budgets', async () => {
  const fixture = contextFixture();
  let calls = 0;
  const app = createApplication({
    storage: fixture.storage,
    search: {} as SearchAdapter,
    embeddings: testEmbeddings,
    countReferenceTokens: () => {
      calls++;
      return 1;
    },
  });
  app.recordReferenceTokens('request', '{}');
  app.recordReferenceTokens('result', '{}');
  assert.equal(calls, 0);
  await app.execute(fixture.actor.id, 'ticket_context', {
    project_id: fixture.project.id,
    ticket_id: fixture.ticket.id,
  });
  assert.ok(calls > 0);
  const enabled = createApplication({
    storage: fixture.storage,
    search: {} as SearchAdapter,
    embeddings: testEmbeddings,
    referenceTokenMetrics: true,
    countReferenceTokens: () => 7,
  });
  enabled.recordReferenceTokens('request', '{}');
  enabled.recordReferenceTokens('result', '{}');
  assert.equal(enabled.metrics.request_reference_tokens, 7);
  assert.equal(enabled.metrics.result_reference_tokens, 7);
});

it('validates the exact unanswered-question history filter combinations', () => {
  const fixture = contextFixture();
  const base = { project_id: fixture.project.id, ticket_id: fixture.ticket.id, nonblocking_unanswered: true };
  assert.equal(schemas.ticket_history.safeParse(base).success, true);
  for (const input of [
    { ...base, kind: 'reviews' },
    { ...base, kind: 'submissions' },
    { ...base, kind: 'github' },
    { ...base, item_id: fixture.ticket.id },
    { ...base, nonblocking_unanswered: false },
    { project_id: fixture.project.id, ticket_id: fixture.ticket.id, unanswered_questions: true },
  ])
    assert.equal(schemas.ticket_history.safeParse(input).success, false);
});
