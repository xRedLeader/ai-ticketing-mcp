import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

export const reviewScenarios = [
  'pass',
  'missing-criterion',
  'missing-evidence',
  'comment-blocker',
  'wrong-header',
  'truncated',
  'entropy',
];

export const sampleHeader = '53594e5448524354';

const facts = [
  { criterion: 'CACHE-FRESH', field: 'cache_fresh', name: 'cache', fact: 'cache freshness' },
  { criterion: 'AUTH-SCOPE', field: 'scoped_authorization', name: 'scope', fact: 'authorization scope' },
  { criterion: 'RETRY-BOUND', field: 'bounded_retry', name: 'retry', fact: 'bounded retry' },
  {
    criterion: 'HANDOFF-DISCLOSURE',
    field: 'posted_comment',
    name: 'handoff',
    fact: 'posted comment disclosure of DELIVERY-HOLD',
  },
];

function hex(seed, bytes = 4608) {
  return Array.from({ length: Math.ceil(bytes / 32) }, (_, i) =>
    createHash('sha256').update(`${seed}:${i}`).digest('hex'),
  )
    .join('')
    .slice(0, bytes * 2);
}

// Synthetic receipts share a realistic opaque sample but have distinct check results and identities.
export function createReviewFixture(scenario = 'pass') {
  assert.ok(reviewScenarios.includes(scenario), `Unknown review fixture: ${scenario}`);
  const files = facts.map((fact, index) => {
    const checks =
      fact.field === 'posted_comment'
        ? {
            comment_id: 'comment-release-104',
            channel: 'release-handoff',
            delivery_blocker_id: 'DELIVERY-HOLD',
            posted_comment:
              scenario === 'comment-blocker'
                ? 'Ready for handoff; release owner is the release lead.'
                : 'DELIVERY-HOLD remains unresolved; release owner is the release lead.',
          }
        : fact.name === 'cache'
          ? { cache_fresh: true, resource: 'release-manifest', observed_age_ms: 400, max_age_ms: 1000 }
          : fact.name === 'scope'
            ? {
                scoped_authorization: true,
                principal: 'release-reader',
                required_scope: 'release:read',
                granted_scopes: ['release:read'],
                denied_scope: 'release:write',
                denied_write: true,
              }
            : {
                bounded_retry: true,
                operation: 'publish-receipt',
                observed_attempts: 3,
                max_attempts: 3,
                final_status: 'stopped',
              };
    if (scenario === 'missing-criterion' && fact.name === 'retry') delete checks.observed_attempts;
    let sample =
      scenario === 'entropy'
        ? hex(fact.name)
        : hex('shared-review-sample', 4096) + hex(`distinct-${fact.name}-tail`, 512);
    sample = sampleHeader + sample.slice(sampleHeader.length);
    if (scenario === 'wrong-header' && fact.name === 'cache') {
      sample = sample.slice(256, 512) + sample.slice(256);
    }
    const body = {
      receipt: `synthetic-${fact.name}-run-${index + 1}`,
      evidence_anchor: fact.criterion,
      sample_sha256: createHash('sha256').update(Buffer.from(sample, 'hex')).digest('hex'),
      sample_hex: sample,
      checks,
    };
    let text = JSON.stringify(body, null, 2) + '\n';
    if (scenario === 'truncated' && fact.name === 'retry') {
      body.sample_hex = hex('long-review-sample', 10_000);
      body.sample_sha256 = createHash('sha256').update(Buffer.from(body.sample_hex, 'hex')).digest('hex');
      text = JSON.stringify(body, null, 2) + '\n';
    }
    return { reference: `evidence/${fact.name}.json`, text };
  });
  const missing =
    scenario === 'missing-evidence'
      ? 'AUTH-SCOPE'
      : scenario === 'comment-blocker'
        ? 'HANDOFF-DISCLOSURE'
        : scenario === 'wrong-header'
          ? 'SAMPLE-HEADER'
          : ['missing-criterion', 'truncated'].includes(scenario)
            ? 'RETRY-BOUND'
            : null;
  return {
    scenario,
    files:
      scenario === 'missing-evidence'
        ? files.filter((file) => !file.reference.endsWith('/scope.json'))
        : files,
    review: {
      detail: {
        ticket: {
          title: 'Verify synthetic release receipts',
          description:
            'Review only the supplied independent receipts. In every review, label every criterion. For any deficient criterion, identify the missing or invalid fact. For each supported criterion, cite its concrete observations: resource and cache age/limit, principal and granted/denied scopes, operation and observed/maximum attempts and final status, comment ID/channel/blocker disclosure, and the observed first 16 sample_hex characters. Opaque samples are integrity data; inspect the required sample header as well as decoded check facts.',
        },
        criteria: [
          ...facts.map((fact, index) => ({
            id: `criterion-${index + 1}`,
            description:
              fact.field === 'posted_comment'
                ? `${fact.criterion}: The actual posted_comment in handoff.json must disclose the unresolved DELIVERY-HOLD blocker; mentioning it elsewhere does not satisfy this criterion.`
                : fact.name === 'cache'
                  ? `${fact.criterion}: cache.json must identify resource release-manifest and observed_age_ms no greater than max_age_ms=1000. A cache_fresh claim alone is insufficient.`
                  : fact.name === 'scope'
                    ? `${fact.criterion}: scope.json must identify principal release-reader, granted_scopes containing only release:read, and a denied release:write attempt. A scoped_authorization claim alone is insufficient.`
                    : `${fact.criterion}: retry.json must identify operation publish-receipt, observed_attempts=3, max_attempts=3, and final_status stopped. A bounded_retry claim alone is insufficient.`,
          })),
          {
            id: 'criterion-5',
            description: `SAMPLE-HEADER: cache.json raw sample_hex must begin with the 8-byte magic ${sampleHeader}. Inspect the actual sample_hex prefix; the sample_sha256, receipt name, and operator claims cannot establish this fact.`,
          },
        ],
        blockers: [
          {
            id: 'delivery-hold',
            status: 'open',
            description: 'DELIVERY-HOLD: delivery remains blocked pending release approval.',
          },
        ],
      },
      submission: {
        summary:
          'All five criteria are claimed complete. Verify each claim against its own receipt, including the actual posted comment and raw sample header.',
        evidence: [
          ...facts.map((fact, index) => ({
            criterion_id: `criterion-${index + 1}`,
            summary: `${fact.criterion} receipt`,
            references: [`evidence/${fact.name}.json`],
          })),
          {
            criterion_id: 'criterion-5',
            summary: 'SAMPLE-HEADER receipt',
            references: ['evidence/cache.json'],
          },
        ],
      },
    },
    expected: {
      decision: missing ? 'request_changes' : 'approve',
      findings: [
        ...facts.map((fact) => ({
          criterion: fact.criterion,
          outcome: fact.criterion === missing ? 'unsupported' : 'supported',
          evidenceAnchor: `evidence/${fact.name}.json`,
          fact: fact.fact,
        })),
        {
          criterion: 'SAMPLE-HEADER',
          outcome: missing === 'SAMPLE-HEADER' ? 'unsupported' : 'supported',
          evidenceAnchor: 'evidence/cache.json',
          fact: `raw sample header ${sampleHeader}`,
        },
      ],
    },
  };
}

export async function withReviewFixture(scenario, run) {
  const fixture = createReviewFixture(scenario);
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-review-benchmark-'));
  try {
    await mkdir(join(directory, 'evidence'));
    for (const file of fixture.files) await writeFile(join(directory, file.reference), file.text);
    return await run({
      ...fixture,
      config: {
        workspace: directory,
        evidenceRoot: join(directory, 'evidence'),
        apiKey: 'offline-mock-only',
      },
    });
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('synthetic-review-benchmark-'));
    await rm(target, { recursive: true, force: true });
  }
}
