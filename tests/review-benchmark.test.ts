import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
// @ts-expect-error standalone benchmark runs directly on Node.
import {
  captureReviewBenchmarkPair,
  inspectReviewPacket,
  mockReviewDecision,
  reconstructReviewInput,
  runReviewBenchmark,
  scoreReviewDecision,
} from '../scripts/review-benchmark.mjs';
// @ts-expect-error portable synthetic fixture runs directly on Node.
import { createReviewFixture } from '../scripts/fixtures/review-fixture.mjs';

it('pins four distinct raw receipt bodies', () => {
  const fixture = createReviewFixture('pass');
  assert.deepEqual(
    Object.fromEntries(
      fixture.files.map((file: { reference: string; text: string }) => [
        file.reference,
        createHash('sha256').update(file.text).digest('hex'),
      ]),
    ),
    {
      'evidence/cache.json': '6b20e7846d170f646461d2100539e2b8af8d479fcbd34d9da6f7b0497bb81957',
      'evidence/scope.json': '06f4df4836a7537473a370599f9329ebdb40ce7e5d0755fa512f22203e2b2f28',
      'evidence/retry.json': 'd7fa75442c03bf84c0bd65fb41ee27f6d6af45c9372ecdc391a3aa086423fe10',
      'evidence/handoff.json': '9a74e8c86eab88ff0a32489e0923705f79bcb6029c8b749cffd82b388fbd81fe',
    },
  );
});

it('benchmarks every actual request and response with no regressions and useful representative savings', async () => {
  const report = await runReviewBenchmark();
  assert.equal(report.workflows.length, 7);
  assert.equal(report.totals.full.calls, 7);
  assert.equal(report.totals.compact.calls, 7);
  assert.ok(report.totals.compact.tokens < report.totals.full.tokens);
  assert.equal(
    report.workflows.find((entry: { scenario: string }) => entry.scenario === 'entropy').saved_tokens,
    0,
  );
});

it('rejects semantic omissions even when a serializer returns a smaller valid packet', async () => {
  const pair = await captureReviewBenchmarkPair('pass');
  const packet = JSON.parse(reconstructReviewInput(pair.packets.compact.request.input));
  assert.equal(new Set(packet.attachments.map((entry: { text: string }) => entry.text)).size, 4);
  const samples = packet.attachments.map((entry: { text: string }) => JSON.parse(entry.text));
  assert.equal(new Set(samples.map((receipt: { sample_hex: string }) => receipt.sample_hex)).size, 4);
  assert.equal(
    new Set(samples.map((receipt: { sample_hex: string }) => receipt.sample_hex.slice(0, 8192))).size,
    1,
  );
  for (const sample of samples)
    assert.equal(
      createHash('sha256').update(Buffer.from(sample.sample_hex, 'hex')).digest('hex'),
      sample.sample_sha256,
    );
  const retry = packet.attachments.find((entry: { reference: string }) =>
    entry.reference.endsWith('/retry.json'),
  );
  const receipt = JSON.parse(retry.text);
  delete receipt.checks.bounded_retry;
  retry.text = JSON.stringify(receipt);
  const assessment = inspectReviewPacket(JSON.stringify(packet));
  assert.equal(assessment.decision, 'request_changes');
  assert.equal(
    assessment.findings.find((entry: { criterion: string }) => entry.criterion === 'RETRY-BOUND').outcome,
    'unsupported',
  );
  packet.attachments = packet.attachments.filter(
    (entry: { reference: string }) => !entry.reference.endsWith('/scope.json'),
  );
  assert.equal(
    inspectReviewPacket(JSON.stringify(packet)).findings.find(
      (entry: { criterion: string }) => entry.criterion === 'AUTH-SCOPE',
    ).outcome,
    'unsupported',
  );
});

it('checks the actual posted comment rather than the blocker mentioned elsewhere', async () => {
  const pair = await captureReviewBenchmarkPair('comment-blocker');
  for (const format of ['full', 'compact']) {
    const packet = pair.packets[format];
    assert.match(packet.request.input, /DELIVERY-HOLD/);
    assert.equal(packet.decision.decision, 'request_changes');
    assert.match(packet.decision.feedback, /HANDOFF-DISCLOSURE/);
  }
});

it('does not treat a truthful-looking affirmative criterion label as negative feedback', () => {
  const { expected } = createReviewFixture('missing-criterion');
  const valid = mockReviewDecision(expected);
  assert.equal(
    scoreReviewDecision(
      { decision: 'request_changes', feedback: 'RETRY-BOUND passed; no changes needed.' },
      expected,
    ).pass,
    false,
  );
  assert.equal(
    scoreReviewDecision({ decision: 'request_changes', feedback: 'RETRY-BOUND' }, expected).pass,
    false,
  );
  assert.equal(
    scoreReviewDecision(
      { decision: 'request_changes', feedback: 'RETRY-BOUND is not missing bounded retry evidence.' },
      expected,
    ).pass,
    false,
  );
  assert.equal(
    scoreReviewDecision(
      { decision: 'request_changes', feedback: 'RETRY-BOUND is missing something.' },
      expected,
    ).pass,
    false,
  );
  assert.equal(scoreReviewDecision(valid, expected).pass, true);
});

it('requires concrete positive proof in every supported criterion, including the encoded header', () => {
  const { expected } = createReviewFixture('pass');
  assert.equal(scoreReviewDecision({ decision: 'approve', feedback: 'Looks good.' }, expected).pass, false);
  const decision = mockReviewDecision(expected);
  assert.equal(scoreReviewDecision(decision, expected).pass, true);
  for (const [observation, contradiction] of [
    ['discloses DELIVERY-HOLD', 'does not disclose DELIVERY-HOLD'],
    ['release:write denied', 'release:write was not denied'],
    ['sample_hex begins 53594e5448524354', 'sample_hex does not begin 53594e5448524354'],
    ['sample_hex begins 53594e5448524354', "sample_hex doesn't begin 53594e5448524354"],
  ]) {
    assert.equal(
      scoreReviewDecision(
        { ...decision, feedback: decision.feedback.replace(observation, contradiction) },
        expected,
      ).pass,
      false,
    );
  }
  assert.equal(
    scoreReviewDecision(
      { ...decision, feedback: decision.feedback.replace('53594e5448524354', 'unknown') },
      expected,
    ).pass,
    false,
  );
  const negative = createReviewFixture('wrong-header').expected;
  const feedback = mockReviewDecision(negative);
  assert.equal(scoreReviewDecision(feedback, negative).pass, true);
  assert.equal(
    scoreReviewDecision(
      { ...feedback, feedback: feedback.feedback.replace(/CACHE-FRESH:[\s\S]*?(?=AUTH-SCOPE:)/, '') },
      negative,
    ).pass,
    false,
  );
});

it('requires the observed and expected prefixes in negative header feedback', () => {
  const { expected } = createReviewFixture('wrong-header');
  const decision = mockReviewDecision(expected);
  const feedbackWith = (header: string) => decision.feedback.replace(/SAMPLE-HEADER:.*$/, header);
  const observed = 'e37d5cd68b3d10f2';
  const required = '53594e5448524354';
  assert.equal(
    scoreReviewDecision(
      {
        ...decision,
        feedback: feedbackWith(
          `SAMPLE-HEADER: wrong prefix; observed_prefix=${observed}, expected_prefix=${required}.`,
        ),
      },
      expected,
    ).pass,
    true,
  );
  for (const header of [
    'SAMPLE-HEADER: cache.json sample header is wrong.',
    `SAMPLE-HEADER: wrong prefix; observed_prefix=deadbeefdeadbeef, expected_prefix=${required}.`,
    `SAMPLE-HEADER: wrong prefix; observed_prefix=${observed}.`,
    `SAMPLE-HEADER: wrong prefix; observed_prefix=${required}, expected_prefix=${observed}.`,
    `SAMPLE-HEADER: wrong prefix; observed_prefix=${observed}, expected_prefix=${required}, observed_prefix=deadbeefdeadbeef.`,
  ]) {
    assert.equal(
      scoreReviewDecision({ ...decision, feedback: feedbackWith(header) }, expected).pass,
      false,
      header,
    );
  }
});

it('requires both observed and maximum counts in supported retry feedback', () => {
  const { expected } = createReviewFixture('pass');
  const decision = mockReviewDecision(expected);
  assert.equal(scoreReviewDecision(decision, expected).pass, true);
  for (const counts of [
    'observed_attempts=7, max_attempts=3',
    'observed_attempts=3, max_attempts=7',
    'observed_attempts=3',
    'max_attempts=3',
    'observed_attempts=3.5, max_attempts=3',
    'observed_attempts=3, max_attempts=3, observed_attempts=7',
  ]) {
    const feedback = decision.feedback.replace('observed_attempts=3, max_attempts=3', counts);
    assert.equal(scoreReviewDecision({ ...decision, feedback }, expected).pass, false, counts);
  }
});

it('makes the sole wrong-header fact depend on a referenced dictionary chunk in both compact packets', async () => {
  const positive = await captureReviewBenchmarkPair('pass');
  const negative = await captureReviewBenchmarkPair('wrong-header');
  const receipts = [];
  for (const pair of [positive, negative]) {
    const wire = JSON.parse(pair.packets.compact.request.input);
    assert.equal(wire.format, 'review-packet-v1');
    const encoded = wire.packet.attachments.find(
      (attachment: { reference: string }) => attachment.reference === 'evidence/cache.json',
    );
    const original = pair.packets.compact.reconstructedPacket.attachments.find(
      (attachment: { reference: string }) => attachment.reference === 'evidence/cache.json',
    );
    const receipt = JSON.parse(original.text);
    receipts.push(receipt);
    const sampleStart = original.text.indexOf('"sample_hex": "') + '"sample_hex": "'.length;
    let offset = 0;
    let headerIndex;
    for (const part of encoded.text.parts) {
      if (offset === sampleStart) {
        assert.equal(
          typeof part,
          'number',
          'The actual header must be a dictionary reference, not a literal',
        );
        headerIndex = part;
      }
      offset += typeof part === 'string' ? part.length : wire.hexChunks[part].length;
    }
    assert.equal(typeof headerIndex, 'number');
    assert.equal(wire.hexChunks[headerIndex], receipt.sample_hex.slice(0, 256));
    assert.equal(
      createHash('sha256').update(Buffer.from(receipt.sample_hex, 'hex')).digest('hex'),
      receipt.sample_sha256,
    );
    assert.equal(
      new Set(
        pair.packets.compact.reconstructedPacket.attachments.map(
          (attachment: { text: string }) => JSON.parse(attachment.text).sample_hex,
        ),
      ).size,
      4,
    );
  }
  assert.deepEqual(receipts[0].checks, receipts[1].checks);
  assert.equal(receipts[0].sample_hex.slice(0, 16), '53594e5448524354');
  assert.notEqual(receipts[1].sample_hex.slice(0, 16), '53594e5448524354');
  assert.equal(receipts[1].sample_hex.slice(0, 256), receipts[0].sample_hex.slice(256, 512));
  assert.equal(receipts[1].sample_hex.slice(256), receipts[0].sample_hex.slice(256));
  assert.deepEqual(
    negative.expected.findings
      .filter((finding: { outcome: string }) => finding.outcome === 'unsupported')
      .map((finding: { criterion: string }) => finding.criterion),
    ['SAMPLE-HEADER'],
  );
  assert.equal(inspectReviewPacket(negative.packets.compact.request.input).decision, 'request_changes');
});

it('does not let a truncated receipt prove a fact beyond its excerpt', async () => {
  const pair = await captureReviewBenchmarkPair('truncated', { model: 'synthetic-review-model' });
  for (const format of ['full', 'compact']) {
    assert.equal(pair.packets[format].request.model, 'synthetic-review-model');
    const retry = pair.packets[format].reconstructedPacket.attachments.find((entry: { reference: string }) =>
      entry.reference.endsWith('/retry.json'),
    );
    assert.equal(retry.complete, false);
    assert.equal(Buffer.byteLength(retry.text), 16_384);
    assert.equal(pair.packets[format].decision.decision, 'request_changes');
  }
});
