import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it, type TestContext } from 'node:test';
import { modelReview } from '../examples/review-dispatch.mjs';

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'review-preflight-'));
  t.after(async () => {
    assert.equal(dirname(workspace), resolve(tmpdir()));
    assert(basename(workspace).startsWith('review-preflight-'));
    await rm(workspace, { force: true, recursive: true });
  });
  const evidenceRoot = join(workspace, 'evidence');
  await mkdir(evidenceRoot);
  const packets: any[] = [],
    coverage: any[] = [];
  const instructions: string[] = [];
  const receipt = async (name: string, text = 'receipt') => {
    await writeFile(join(evidenceRoot, name), text);
    return 'evidence/' + name;
  };
  const review = (
    references: string[][],
    preflight = true,
    criteria = references.map((_, i) => ({ id: 'c' + i })),
  ) =>
    modelReview(
      {
        workspace,
        evidenceRoot,
        reviewEvidencePreflight: preflight,
        reportEvidenceCoverage: (value: unknown) => coverage.push(value),
      },
      {
        detail: { ticket: { title: 'test', description: 'test' }, criteria, blockers: [] },
        submission: {
          summary: 'test',
          evidence: references.map((refs, i) => ({ criterion_id: 'c' + i, references: refs })),
        },
      },
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        packets.push(JSON.parse(body.input));
        instructions.push(body.instructions);
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify({ decision: 'approve', feedback: 'fixture' }) },
              ],
            },
          ],
        });
      },
    );
  return { workspace, evidenceRoot, packets, coverage, receipt, review, instructions };
}

it('admits a late readable receipt after URLs, missing files and excluded paths; shares it across criteria', async (t) => {
  const f = await fixture(t);
  const links = Array.from({ length: 8 }, (_, i) => 'https://example.test/' + i + '.json');
  const misses = Array.from({ length: 10 }, (_, i) => 'evidence/missing-' + i + '.txt');
  const secret = join(f.workspace, 'private.txt');
  await writeFile(secret, 'private-content-sentinel');
  const last = await f.receipt('actual.txt', 'actual receipt');
  await f.review([[...links, ...misses, secret, last], [last]]);
  assert.equal(f.packets.length, 1);
  const delivered = f.packets[0].attachments;
  assert.match(f.instructions[0]!, /Some citations have no complete attachment/);
  assert.equal(delivered.length, 8);
  assert.deepEqual(
    delivered.filter((a: any) => a.text),
    [{ reference: last, size: 14, complete: true, text: 'actual receipt' }],
  );
  assert(!JSON.stringify(delivered).includes('private-content-sentinel'));
  assert.deepEqual(f.coverage, [[{ criterion_id: 'c0', statuses: ['external', 'missing', 'complete'] }]]);
});

it('requests repair without a provider call only for unmapped criteria or definitely absent receipts', async (t) => {
  const f = await fixture(t);
  const refs = [['evidence/absent.json']];
  const decision = await f.review(refs, true, [{ id: 'c0' }, { id: 'unmapped' }]);
  assert.equal(decision.decision, 'request_changes');
  assert.match(decision.feedback, /c0, unmapped/);
  assert(!decision.feedback.includes(f.workspace));
  assert.equal(f.packets.length, 0);
  await f.review(refs, false);
  assert.equal(f.packets.length, 1);
  assert.deepEqual(f.packets[0].attachments, [{ reference: 'evidence/absent.json', unavailable: true }]);
});

it('routes ambiguous, truncated, inaccessible, external and deferred-only criteria to manual review', async (t) => {
  const f = await fixture(t);
  const truncated = await f.receipt('large.txt', 'x'.repeat(16_385));
  const receipts = await Promise.all(Array.from({ length: 9 }, (_, i) => f.receipt(i + '.txt')));
  await link(join(f.evidenceRoot, '0.txt'), join(f.workspace, 'other-link.txt'));
  const tests = [
    { refs: [[truncated]], reason: 'truncated' },
    { refs: [['evidence/absent.json', 'https://example.test/claim']], reason: 'external' },
    { refs: [['evidence/absent-dir/receipt.json']], reason: 'unavailable' },
    { refs: [[receipts[0]!]], reason: 'unavailable' },
    { refs: [[truncated, ...receipts.slice(1, 8)], [receipts[8]!]], reason: 'deferred' },
  ];
  for (const item of tests) {
    await assert.rejects(f.review(item.refs), (error: any) => {
      assert.equal(error.code, 'REVIEW_EVIDENCE_INCOMPLETE');
      assert.match(error.message, new RegExp(item.reason));
      assert(!error.message.includes(f.workspace));
      return true;
    });
  }
  assert.equal(f.packets.length, 0);
});
