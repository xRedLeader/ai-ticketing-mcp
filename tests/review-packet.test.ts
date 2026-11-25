import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { getEncoding } from 'js-tiktoken';
// @ts-expect-error The standalone dispatcher runs directly on Node.
import { buildReviewInput, modelReview } from '../examples/review-dispatch.mjs';
// @ts-expect-error standalone offline calibration runs directly on Node.
import { runChunkBenchmark } from '../scripts/review-chunk-benchmark.mjs';
// @ts-expect-error internal selector runs directly on Node.
import { selectCompactReviewInput } from '../examples/review-packet.mjs';

const encoding = getEncoding('o200k_base');
const countTokens = (input: string) => encoding.encode(input, [], []).length;
const hex = (label: string, length = 4096) =>
  Array.from({ length: Math.ceil(length / 64) }, (_, index) =>
    createHash('sha256').update(`${label}:${index}`).digest('hex'),
  )
    .join('')
    .slice(0, length);
const attachment = (text: string, reference = 'evidence/report.json') => ({
  reference,
  size: Buffer.byteLength(text),
  complete: true,
  text,
});
const fixture = (attachments: unknown[]) => ({
  detail: {
    ticket: { title: 'Verify all criteria', description: 'Independent evidence is required.' },
    criteria: [
      { id: 'one', text: 'The receipt is pinned to the submitted bytes.' },
      { id: 'two', text: 'Every stated limit is independently supported.' },
    ],
    blockers: [{ key: 'WAIT-1', status: 'done' }],
  },
  submission: {
    summary: 'Review these receipts, including any contrary findings.',
    evidence: [
      { criterion_id: 'one', references: ['evidence/report.json'], note: 'Check distinct digests.' },
      { criterion_id: 'two', references: ['evidence/limits.json'], note: 'The limit is disputed.' },
    ],
  },
  attachments,
});

function decode(input: string): string {
  const envelope = JSON.parse(input);
  assert.equal(envelope.format, 'review-packet-v1');
  assert.match(envelope.decoding, /zero-based indices into hexChunks/);
  for (const item of envelope.packet.attachments) {
    if (typeof item.text === 'string' || !Object.hasOwn(item, 'text')) continue;
    assert.deepEqual(Object.keys(item.text), ['parts']);
    item.text = item.text.parts
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        assert.equal(typeof part, 'number');
        assert.ok(Number.isInteger(part) && Number(part) >= 0);
        assert.ok(Number(part) < envelope.hexChunks.length);
        const chunk = envelope.hexChunks[Number(part)];
        assert.match(chunk, /^[0-9a-fA-F]+$/);
        assert.ok([32, 64, 256].includes(chunk.length));
        return chunk;
      })
      .join('');
  }
  return JSON.stringify(envelope.packet);
}

it('keeps the absent and explicit full formats identical to the original production serialization', () => {
  const input = fixture([attachment('{ "number":900719925474099312345678, "key":1, "key":2 }\n')]);
  const { detail, submission, attachments } = input;
  const original = JSON.stringify({
    title: detail.ticket.title,
    description: detail.ticket.description,
    criteria: detail.criteria,
    blockers: detail.blockers,
    summary: submission.summary,
    evidence: submission.evidence,
    attachments,
  });
  assert.equal(buildReviewInput(input), original);
  assert.equal(buildReviewInput(input, 'full'), original);
  for (const mode of ['auto', '', null, false, 1])
    assert.throws(() => buildReviewInput(input, mode), /reviewPacketFormat must be full or compact/);
});

it('round-trips exact JSON source, every criterion, metadata, limits, and distinct digests', () => {
  const payload = hex('shared', 8192);
  const input = fixture(
    [0, 1, 2, 3].map((index) => ({
      ...attachment(
        `{\r\n  "digest":"${hex(`digest-${index}`, 64)}", "limit":${index + 10}, ` +
          `"large":900719925474099312345678, "duplicate":1, "duplicate":${index + 2}, ` +
          `"hex":"${payload.slice(0, 1024)}${hex(`different-${index}`, 256)}${payload.slice(1280)}", ` +
          '"note":"literal \\"parts\\", snowman ☃, braces {} and [0]"\r\n}\n',
        `evidence/report-${index}.json`,
      ),
      parts: ['original metadata'],
      hexChunks: { unchanged: true },
      format: 'original-format',
      decoding: 'original metadata',
    })),
  );
  input.attachments.push(
    attachment(`{"malformed":"${payload.slice(0, 1024)}"`, 'evidence/malformed.json'),
    { ...attachment(`{"partial":"${payload.slice(0, 1024)}"}`), complete: false },
    { reference: 'evidence/missing.json', unavailable: true },
  );
  const untouched = JSON.stringify(input);
  const full = buildReviewInput(input);
  const compact = buildReviewInput(input, 'compact');
  assert.equal(JSON.parse(compact).format, 'review-packet-v1');
  assert.deepEqual(Buffer.from(decode(compact)), Buffer.from(full));
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full) * 0.5);
  assert.ok(countTokens(compact) < countTokens(full) * 0.5);
  assert.equal(JSON.stringify(input), untouched);
  assert.equal(typeof JSON.parse(compact).packet.attachments[4].text, 'string');
  assert.equal(typeof JSON.parse(compact).packet.attachments[5].text, 'string');
  assert.match(compact, /900719925474099312345678/);
  for (let index = 0; index < 4; index++) assert.ok(compact.includes(hex(`digest-${index}`, 64)));
});

it('retains source strings untouched when JSON is incomplete, malformed, escaped, prose, or unhelpful', () => {
  const repeated = hex('same');
  const cases = [
    [
      attachment(`{"payload":"${repeated}"}`),
      { ...attachment(`{"payload":"${repeated}"}`), complete: false },
    ],
    [attachment(`{"payload":"${repeated}",}`), attachment(`{"payload":"${repeated}",}`)],
    [attachment(`prefix ${repeated}`), attachment(`prefix ${repeated}`)],
    [attachment(`{"${repeated}":1}`), attachment(`{"${repeated}":2}`)],
    [
      attachment(JSON.stringify({ prose: `quoted \"${repeated}\"` })),
      attachment(JSON.stringify({ prose: `quoted \"${repeated}\"` })),
    ],
    [attachment(`{"payload":"${hex('unique-one')}"}`), attachment(`{"payload":"${hex('unique-two')}"}`)],
    [attachment(`{"payload":"${repeated}"}`)],
  ];
  for (const attachments of cases) {
    const input = fixture(attachments);
    assert.equal(buildReviewInput(input, 'compact'), buildReviewInput(input));
  }
});

it('reconstructs a contrary header from its actual shorter dictionary reference after isolated edits', () => {
  const magic = '53594e5448524354';
  const shared = magic + hex('edited-header', 8176);
  const texts = [0, 1, 2, 3].map((index) => {
    let sample = Array.from({ length: shared.length / 256 }, (_, offset) => {
      const chunk = shared.slice(offset * 256, (offset + 1) * 256);
      return chunk.slice(0, 96) + hex(`edited-${index}-${offset}`, 2) + chunk.slice(98);
    }).join('');
    if (index === 0) sample = sample.slice(32, 64) + sample.slice(32);
    return JSON.stringify({ digest: hex(`edited-digest-${index}`, 64), hex: sample });
  });
  const input = fixture(texts.map((text, index) => attachment(text, `evidence/header-${index}.json`)));
  const compact = buildReviewInput(input, 'compact');
  assert.equal(decode(compact), buildReviewInput(input));
  const wire = JSON.parse(compact);
  assert.ok(wire.hexChunks[0].length < 256);
  const original = JSON.parse(texts[0]!);
  assert.notEqual(original.hex.slice(0, magic.length), magic);
  const start = texts[0]!.indexOf('"hex":"') + '"hex":"'.length;
  let offset = 0;
  let observedHeader;
  for (const part of wire.packet.attachments[0].text.parts) {
    if (offset === start) {
      assert.equal(typeof part, 'number');
      observedHeader = wire.hexChunks[part].slice(0, magic.length);
    }
    offset += typeof part === 'string' ? part.length : wire.hexChunks[part].length;
  }
  assert.equal(observedHeader, original.hex.slice(0, magic.length));
});

it('fails closed on ambiguous text and bounded-reader violations, and never increases reference tokens', () => {
  const text = `{"payload":"${hex('repeated')}"}`;
  const common = [attachment(text), attachment(text)];
  const cases = [
    [...common, { text: { parts: [0] } }],
    [...common, null],
    [...common, ['array instead of attachment']],
    Array.from({ length: 9 }, () => attachment(text)),
    [
      attachment(`{"payload":"${hex('too-large', 17_000)}"}`),
      attachment(`{"payload":"${hex('too-large', 17_000)}"}`),
    ],
    common.map((item) => ({ ...item, size: item.size - 1 })),
  ];
  for (const attachments of cases) {
    const input = fixture(attachments);
    assert.equal(buildReviewInput(input, 'compact'), buildReviewInput(input));
  }
  const lowTokenInput = {
    detail: { ticket: { title: 't' } },
    submission: {},
    attachments: Array.from({ length: 4 }, () => attachment(`{"hex":"${'a'.repeat(256)}"}`, 'r.json')),
  };
  const full = buildReviewInput(lowTokenInput);
  for (const sizes of [[0], [-1], [16], [Infinity], [32, 64], [64, 256, 32], [256, , 32], [], null])
    assert.throws(() => selectCompactReviewInput(full, sizes), /Unsupported review chunk sizes/);
  const compact = buildReviewInput(lowTokenInput, 'compact');
  const envelope = JSON.parse(buildReviewInput(fixture(common), 'compact'));
  const candidate = JSON.stringify({
    format: envelope.format,
    decoding: envelope.decoding,
    hexChunks: ['a'.repeat(256)],
    packet: {
      ...JSON.parse(full),
      attachments: lowTokenInput.attachments.map((item) => ({
        ...item,
        text: { parts: ['{"hex":"', 0, '"}'] },
      })),
    },
  });
  assert.ok(Buffer.byteLength(candidate) < Buffer.byteLength(full));
  assert.ok(countTokens(candidate) >= countTokens(full));
  assert.equal(compact, full);
  const oversized = fixture(common);
  oversized.detail.ticket.description = 'x'.repeat(512 * 1024);
  assert.equal(buildReviewInput(oversized, 'compact'), buildReviewInput(oversized));
});

it('uses compact only on opt-in while retaining the one-request tool-free advisory policy and input limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-compact-packet-'));
  const evidenceRoot = join(directory, 'evidence');
  const paths = [join(evidenceRoot, 'one.json'), join(evidenceRoot, 'two.json')];
  const privateFile = join(directory, 'private.json');
  try {
    await mkdir(evidenceRoot);
    const text = `{"payload":"${hex('wire')}"}`;
    await Promise.all(paths.map((path) => writeFile(path, text)));
    await writeFile(privateFile, 'private-content-sentinel');
    const input = fixture([]);
    input.submission.evidence[0]!.references = [...paths, privateFile];
    input.submission.evidence[1]!.references = [paths[1]!];
    const requests: Record<string, unknown>[] = [];
    const config = { workspace: directory, evidenceRoot, apiKey: 'header-only-sentinel' };
    const request = async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"decision":"approve","feedback":"Advisory only."}' }],
          },
        ],
      });
    };
    await modelReview(config, input, request);
    await modelReview({ ...config, reviewPacketFormat: 'compact' }, input, request);
    assert.equal(requests.length, 2);
    const [full, compact] = requests;
    assert.equal(decode(String(compact!.input)), full!.input);
    assert.deepEqual({ ...full, input: null }, { ...compact, input: null });
    assert.deepEqual(compact!.tools, []);
    assert.equal(compact!.store, false);
    assert.doesNotMatch(String(compact!.input), /private-content-sentinel|header-only-sentinel/);
    await assert.rejects(
      modelReview({ ...config, reviewPacketFormat: 'invalid' }, input, request),
      /reviewPacketFormat must be full or compact/,
    );
    input.detail.ticket.description = 'x'.repeat(512 * 1024);
    await assert.rejects(
      modelReview({ ...config, reviewPacketFormat: 'compact' }, input, request),
      /manual review/,
    );
    assert.equal(requests.length, 2);
  } finally {
    await Promise.all([...paths, privateFile].map((path) => rm(path, { force: true })));
    await rmdir(evidenceRoot);
    await rmdir(directory);
  }
});

it('calibrates shorter chunks across changed alignment without regressing the original candidate', async () => {
  const report = await runChunkBenchmark({ repeats: 1 });
  assert.equal(report.workflows.length, 15);
  for (const workflow of report.workflows) {
    const original = workflow.results.find(
      (result: { chunk_size: number | string }) => result.chunk_size === 256,
    );
    const adaptive = workflow.results.find(
      (result: { chunk_size: number | string }) => result.chunk_size === 'adaptive',
    );
    assert.equal(
      adaptive.tokens,
      Math.min(...workflow.results.map((result: { tokens: number }) => result.tokens)),
    );
    assert.ok(adaptive.tokens <= original.tokens);
    assert.ok(adaptive.max_chunk_locations_per_pass <= 4096);
    if (adaptive.tokens === original.tokens) assert.equal(adaptive.bytes, original.bytes);
  }
  for (const name of ['shift-32', 'shift-64', 'isolated-edits']) {
    const workflow = report.workflows.find((entry: { name: string }) => entry.name === name);
    const original = workflow.results.find(
      (result: { chunk_size: number | string }) => result.chunk_size === 256,
    );
    const adaptive = workflow.results.find(
      (result: { chunk_size: number | string }) => result.chunk_size === 'adaptive',
    );
    assert.ok(adaptive.tokens < original.tokens * 0.6);
  }
  for (const name of ['entropy', 'unique-high-entropy', 'low-token-density']) {
    const workflow = report.workflows.find((entry: { name: string }) => entry.name === name);
    assert.equal(workflow.results.at(-1).tokens, workflow.full_tokens);
  }
});
