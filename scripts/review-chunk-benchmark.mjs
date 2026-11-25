import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { buildReviewInput, selectCompactReviewInput } from '../examples/review-packet.mjs';
import { createReviewFixture, reviewScenarios } from './fixtures/review-fixture.mjs';
import { reconstructReviewInput } from './review-benchmark.mjs';

const encoding = getEncoding('o200k_base');
const countTokens = (text) => encoding.encode(text, [], []).length;
const sizes = [32, 64, 256, 'adaptive'];
const hex = (seed, length = 8192) =>
  Array.from({ length: Math.ceil(length / 64) }, (_, index) =>
    createHash('sha256').update(`${seed}:${index}`).digest('hex'),
  )
    .join('')
    .slice(0, length);

function inputFor(fixture) {
  const references = [
    ...new Set(fixture.review.submission.evidence.flatMap((item) => item.references)),
  ].slice(0, 8);
  return {
    ...fixture.review,
    attachments: references.map((reference) => {
      const file = fixture.files.find((candidate) => candidate.reference === reference);
      if (!file) return { reference, unavailable: true };
      const bytes = Buffer.from(file.text);
      return {
        reference,
        size: bytes.length,
        complete: bytes.length <= 16_384,
        text: bytes.subarray(0, 16_384).toString('utf8'),
      };
    }),
  };
}

function synthetic(name, samples) {
  const files = samples.map((sample, index) => ({
    reference: `evidence/sample-${index}.json`,
    text:
      `{ "digest":"${hex(`digest-${name}-${index}`, 64)}", "number":900719925474099312345678, ` +
      `"duplicate":1, "duplicate":${index + 2}, "sample_hex":"${sample}" }\n`,
  }));
  return {
    name,
    input: inputFor({
      files,
      review: {
        detail: {
          ticket: { title: `Synthetic ${name}`, description: 'Inspect the actual sample header and limits.' },
          criteria: [{ id: 'header', description: 'The sample must begin 53594e5448524354.' }],
          blockers: [],
        },
        submission: {
          summary: 'Verify every original independently.',
          evidence: [{ criterion_id: 'header', references: files.map((file) => file.reference) }],
        },
      },
    }),
  };
}

export function chunkBenchmarkFixtures() {
  const shared = hex('calibration-shared');
  return [
    ...reviewScenarios.map((name) => ({ name, input: inputFor(createReviewFixture(name)) })),
    ...[16, 32, 64, 256].map((shift) =>
      synthetic(
        `shift-${shift}`,
        [0, 1, 2, 3].map((index) => hex(`prefix-${shift}-${index}`, shift * index) + shared),
      ),
    ),
    synthetic(
      'isolated-edits',
      [0, 1, 2, 3].map((index) =>
        Array.from({ length: shared.length / 256 }, (_, offset) => {
          const chunk = shared.slice(offset * 256, (offset + 1) * 256);
          return chunk.slice(0, 96) + hex(`edit-${index}-${offset}`, 2) + chunk.slice(98);
        }).join(''),
      ),
    ),
    synthetic(
      'short-shared-values',
      Array.from({ length: 4 }, () => shared.slice(0, 256)),
    ),
    synthetic(
      'low-token-density',
      Array.from({ length: 4 }, () => 'a'.repeat(256)),
    ),
    synthetic(
      'unique-high-entropy',
      [0, 1, 2, 3].map((index) => hex(`unique-${index}`)),
    ),
  ];
}

export async function runChunkBenchmark({ repeats = 3 } = {}) {
  assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
  const workflows = [];
  for (const { name, input } of chunkBenchmarkFixtures()) {
    const full = buildReviewInput(input);
    const fullTokens = countTokens(full);
    const results = [];
    for (const size of sizes) {
      const select = () => selectCompactReviewInput(full, size === 'adaptive' ? undefined : [size]);
      const compact = select();
      assert.equal(reconstructReviewInput(compact), full, `${name}/${size}: exact source reconstruction`);
      const bytes = Buffer.byteLength(compact);
      const tokens = countTokens(compact);
      assert.ok(bytes <= Buffer.byteLength(full) && tokens <= fullTokens);
      const wire = JSON.parse(compact);
      const elapsed = [];
      for (let attempt = 0; attempt < repeats; attempt++) {
        const started = performance.now();
        assert.equal(select(), compact);
        elapsed.push(performance.now() - started);
      }
      elapsed.sort((left, right) => left - right);
      results.push({
        chunk_size: size,
        bytes,
        tokens,
        selected_chunk_size: wire.format ? wire.hexChunks[0].length : null,
        saved_percent: Number(((1 - tokens / fullTokens) * 100).toFixed(2)),
        median_ms: Number(elapsed[Math.floor(elapsed.length / 2)].toFixed(2)),
        max_chunk_locations_per_pass: (8 * 16_384) / (size === 'adaptive' ? 32 : size),
      });
    }
    workflows.push({ name, full_tokens: fullTokens, results });
  }
  return {
    scope:
      'Synthetic offline fixtures; exact model-facing input string; warm selector timings include tokenizer work and exclude initial full serialization.',
    tokenizer: 'js-tiktoken/o200k_base ordinary text',
    repeats,
    workflows,
    totals: sizes.map((size) => ({
      chunk_size: size,
      tokens: workflows.reduce(
        (sum, row) => sum + row.results.find((result) => result.chunk_size === size).tokens,
        0,
      ),
      median_ms_sum: Number(
        workflows
          .reduce((sum, row) => sum + row.results.find((result) => result.chunk_size === size).median_ms, 0)
          .toFixed(2),
      ),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await runChunkBenchmark(), null, 2) + '\n');
}
