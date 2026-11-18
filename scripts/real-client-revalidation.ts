import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  aggregateUsage,
  parseCodexInvocation,
  parsePartialMaintenanceLedger,
  validateRole,
  type ExpectedWorkflow,
} from './real-client-observation.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Offline only: reads original observations and authoritative fixture state, never executes a client. */
export async function revalidateAttempt(attempt: any, workflow: any, contract: any) {
  const directory = attempt.artifact_directory;
  const hashes: Record<string, string> = {};
  const read = async (name: string) => {
    const value = await readFile(join(directory, name), 'utf8');
    hashes[name] = sha256(value);
    return value;
  };
  const errors: string[] = [];
  const invocations: any[] = [];
  const proofs: any = {};
  let target: any;
  try {
    const config = JSON.parse(await read('worker-fixture.json'));
    assert.equal(
      resolve(config.database),
      resolve(directory, 'fixture.sqlite'),
      'Only the original attempt fixture database may be read.',
    );
    const databaseBefore = await readFile(config.database);
    hashes['fixture.sqlite'] = sha256(databaseBefore);
    let walBefore: Buffer | null = null;
    try {
      walBefore = await readFile(config.database + '-wal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (walBefore) hashes['fixture.sqlite-wal'] = sha256(walBefore);
    const db = new DatabaseSync(config.database, { readOnly: true });
    try {
      const project: any = db.prepare('SELECT * FROM projects WHERE id=?').get(config.projectId);
      const ticket: any = db
        .prepare('SELECT * FROM tickets WHERE id=? AND project_id=?')
        .get(config.ticketId, config.projectId);
      assert.ok(project && ticket, 'Authoritative target project/ticket missing.');
      assert.equal(project.name, contract.project.name);
      assert.equal(project.instructions, contract.project.instructions);
      assert.equal(project.policy, workflow.policy);
      const seededDescription =
        workflow.description === 'long'
          ? contract.project.long_description_paragraph.repeat(contract.project.long_description_repetitions)
          : contract.project.description;
      assert.equal(
        ticket.description,
        seededDescription.trim(),
        'Stored requirements no longer match the production-normalized frozen seed.',
      );
      const worker: any = db.prepare('SELECT * FROM actors WHERE id=?').get(config.actorId);
      const reviewers: any[] = db.prepare("SELECT * FROM actors WHERE name='reviewer'").all();
      assert.equal(worker?.kind, 'agent');
      assert.equal(worker?.system_admin, 0);
      assert.equal(reviewers.length, 1);
      const reviewer = reviewers[0];
      assert.equal(reviewer.kind, 'agent');
      assert.equal(reviewer.system_admin, 0);
      assert.notEqual(reviewer.id, worker.id);
      target = {
        project_id: project.id,
        ticket_id: ticket.id,
        requirements_revision: ticket.requirements_revision,
        worker_id: worker.id,
        reviewer_id: reviewer.id,
      };
      const expected: ExpectedWorkflow = {
        workflow,
        project,
        ticket,
        description: ticket.description,
        workerId: worker.id,
        reviewerId: reviewer.id,
        prerequisiteId: config.prerequisiteId,
        contract,
      };
      for (const role of workflow.review ? ['worker', 'reviewer'] : ['worker']) {
        const original = attempt.invocations.find((item: any) => item.role === role);
        assert.ok(original, `Original ${role} invocation missing.`);
        const request = JSON.parse(await read(`${role}-request.json`));
        await read(`${role}-result.json`);
        const actor = JSON.parse(await read(`${role}-fixture.json`));
        assert.equal(actor.actorId, role === 'worker' ? worker.id : reviewer.id);
        assert.equal(actor.projectId, project.id);
        assert.equal(actor.ticketId, ticket.id);
        assert.equal(request.requested_model, original.model_requested);
        const observation = parseCodexInvocation(await read(`${role}.jsonl`), original.exit_code ?? null);
        assert.deepEqual(
          observation.usage,
          original.usage,
          'Revalidation cannot alter reported provider usage.',
        );
        const validation = validateRole(observation, role as 'worker' | 'reviewer', expected);
        for (const call of observation.calls) {
          if (
            !['ticket_checkpoint', 'ticket_submit', 'ticket_review', 'ticket_note', 'work_claim'].includes(
              call.tool,
            )
          )
            continue;
          assert.equal(call.arguments.project_id, project.id, 'Mutation targeted another project.');
          if (call.tool !== 'work_claim')
            assert.ok(
              [ticket.id, ticket.key].includes(call.arguments.ticket_id),
              'Mutation targeted another ticket.',
            );
          if (!call.envelope?.ok) continue;
          assert.equal(call.envelope.data.ticket?.id, ticket.id, 'Mutation returned another ticket.');
          if (call.tool === 'work_claim') {
            assert.equal(call.envelope.data.claim?.actor_id, worker.id);
            assert.equal(call.envelope.data.claim?.ticket_id, ticket.id);
          }
        }
        invocations.push({
          role,
          success: validation.success,
          errors: validation.errors,
          proofs: validation.proofs,
          usage: observation.usage,
          identical_mutation_retries: observation.identical_mutation_retries,
          approval_review_usage: observation.approval_review_usage,
        });
        errors.push(...validation.errors);
      }
      const maintenance = JSON.parse(await read('maintenance-result.json'));
      assert.equal(maintenance.consumer, 'maintenance');
      assert.equal(maintenance.success, true, 'Maintenance did not complete.');
      assert.equal(maintenance.completed_intervals, 2);
      assert.equal(maintenance.evidence_complete, true);
      assert.deepEqual(
        maintenance,
        attempt.invocations.find((item: any) => item.role === 'worker').maintenance,
        'Original maintenance result changed.',
      );
      const ledger = parsePartialMaintenanceLedger(await read('maintenance.jsonl'));
      assert.deepEqual(ledger.errors, []);
      assert.deepEqual(ledger.calls, maintenance.calls);
      assert.deepEqual(ledger.wire, maintenance.wire);
      assert.equal(
        maintenance.calls.filter(
          (call: any) => call.operation === 'work_heartbeat' && call.result?.structuredContent?.ok,
        ).length,
        2,
      );
      proofs.maintenance = {
        success: true,
        completed_intervals: 2,
        rpc_round_trips: maintenance.rpc_round_trips,
        evidence_complete: true,
      };
      assert.equal(ticket.status, 'done', 'Authoritative ticket did not complete.');
      assert.equal(ticket.requirements_revision, workflow.change || workflow.blocking ? 2 : 1);
      const criteria: any[] = db
        .prepare('SELECT * FROM criteria WHERE project_id=? AND ticket_id=? ORDER BY position,id')
        .all(project.id, ticket.id);
      assert.equal(criteria.length, 1);
      assert.equal(
        criteria[0].text,
        workflow.change
          ? 'The access check also rejects a revoked project member without revealing ticket data.'
          : contract.project.criterion,
      );
      const submission: any = db
        .prepare(
          'SELECT * FROM submissions WHERE project_id=? AND ticket_id=? ORDER BY ticket_revision DESC,id DESC LIMIT 1',
        )
        .get(project.id, ticket.id);
      assert.ok(submission, 'Authoritative submission missing.');
      assert.equal(submission.actor_id, worker.id);
      assert.equal(submission.requirements_revision, ticket.requirements_revision);
      const evidence = JSON.parse(submission.evidence);
      assert.ok(
        criteria.every((criterion) =>
          evidence.some(
            (item: any) =>
              item.criterion_id === criterion.id && item.result === 'pass' && item.references?.length,
          ),
        ),
      );
      const workerRaw = parseCodexInvocation(
        await read('worker.jsonl'),
        attempt.invocations.find((item: any) => item.role === 'worker').exit_code,
      );
      assert.ok(
        workerRaw.calls.some(
          (call) =>
            call.tool === 'ticket_submit' &&
            call.envelope?.ok &&
            call.envelope.data.submission?.id === submission.id,
        ),
        'Persisted submission did not come from the observed worker.',
      );
      if (workflow.review) {
        assert.equal(ticket.approved_submission_id, submission.id);
        const review: any = db
          .prepare(
            'SELECT * FROM reviews WHERE submission_id=? ORDER BY ticket_revision DESC,id DESC LIMIT 1',
          )
          .get(submission.id);
        assert.equal(review?.actor_id, reviewer.id);
        assert.equal(review?.decision, 'approve');
        const reviewerRaw = parseCodexInvocation(
          await read('reviewer.jsonl'),
          attempt.invocations.find((item: any) => item.role === 'reviewer').exit_code,
        );
        assert.ok(
          reviewerRaw.calls.some(
            (call) =>
              call.tool === 'ticket_review' &&
              call.envelope?.ok &&
              call.envelope.data.review?.id === review.id,
          ),
        );
      }
      proofs.authoritative_state = {
        status: ticket.status,
        requirements_revision: ticket.requirements_revision,
        criterion_ids: criteria.map((item) => item.id),
        submission_id: submission.id,
        independent_review: !!workflow.review,
      };
    } finally {
      db.close();
    }
    assert.equal(
      sha256(await readFile(config.database)),
      hashes['fixture.sqlite'],
      'Fixture database changed during read-only revalidation.',
    );
    if (walBefore)
      assert.equal(
        sha256(await readFile(config.database + '-wal')),
        hashes['fixture.sqlite-wal'],
        'Fixture WAL changed during read-only revalidation.',
      );
    await read('attempt.json');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    attempt_id: attempt.id,
    original_status: attempt.status,
    original_failure: attempt.failure ?? null,
    effective_status: errors.length ? 'failed' : 'completed',
    target,
    invocations,
    errors,
    proofs,
    artifact_sha256: hashes,
    provider_invocations_added: 0,
    provider_usage_unchanged: true,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      'original-report': { type: 'string' },
      'original-sha256': { type: 'string' },
      reason: { type: 'string' },
    },
  });
  assert.match(values.run ?? '', /^[a-zA-Z0-9_-]+$/);
  assert.ok(
    values['original-report'] && values['original-sha256'] && values.reason,
    'Provide immutable original report/hash and correction reason.',
  );
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const root = join(repo, '.local', 'real-client-runs', values.run!);
  const originalPath = resolve(values['original-report']!);
  const originalText = await readFile(originalPath, 'utf8');
  assert.equal(
    sha256(originalText),
    values['original-sha256']!.toLowerCase(),
    'Original report snapshot hash mismatch.',
  );
  const original = JSON.parse(originalText);
  assert.ok(
    original.workflows.every((workflow: any) =>
      workflow.attempts.every((attempt: any) => attempt.status !== 'running'),
    ),
    'An original attempt is still running.',
  );
  const contractText = await readFile(join(repo, 'scripts/fixtures/protocol-workflows.json'), 'utf8');
  assert.equal(sha256(contractText), original.scenario_contract_sha256);
  assert.equal(sha256(await readFile(join(root, 'server.mjs'))), original.fixture_server_sha256);
  const actualRuntime: Record<string, string> = {};
  const visit = async (directory: string, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name), prefix + entry.name + '/');
      else actualRuntime[prefix + entry.name] = sha256(await readFile(join(directory, entry.name)));
    }
  };
  await visit(join(root, 'runtime'));
  assert.deepEqual(actualRuntime, original.runtime_hashes, 'Pinned runtime changed.');
  const contract = JSON.parse(contractText);
  const workflows: any[] = [];
  for (const workflow of original.workflows) {
    const definition = contract.workflows.find((item: any) => item.id === workflow.id);
    const attempts = [];
    for (const attempt of workflow.attempts)
      attempts.push(await revalidateAttempt(attempt, definition, contract));
    workflows.push({ id: workflow.id, attempts });
  }
  const usage = aggregateUsage(
    original.workflows.flatMap((workflow: any) =>
      workflow.attempts.flatMap((attempt: any) => attempt.invocations),
    ),
  );
  assert.deepEqual(usage, original.usage, 'Original usage totals are inconsistent.');
  const report = {
    version: 1,
    kind: 'append_only_offline_revalidation',
    created_at: new Date().toISOString(),
    reason: values.reason,
    original_report: originalPath,
    original_report_sha256: sha256(originalText),
    validator_sha256: Object.fromEntries(
      await Promise.all(
        ['real-client-observation.ts', 'real-client-revalidation.ts'].map(async (name) => [
          name,
          sha256(await readFile(join(repo, 'scripts', name))),
        ]),
      ),
    ),
    scenario_contract_sha256: original.scenario_contract_sha256,
    original_completed_workflows: original.completed_workflows,
    original_failed_attempts: original.failed_attempts,
    original_retry_attempts: original.retry_attempts,
    effective_completed_workflows: workflows.filter((workflow) =>
      workflow.attempts.some((attempt: any) => attempt.effective_status === 'completed'),
    ).length,
    provider_invocations_added: 0,
    provider_usage_unchanged: true,
    usage,
    approval_review_usage: { status: 'not_separately_reported_by_cli', usage: null },
    monetary_cost: original.monetary_cost,
    workflows,
  };
  const corrections = join(root, 'corrections');
  await mkdir(corrections, { recursive: true, mode: 0o700 });
  const destination = join(corrections, `revalidation-${randomUUID()}.json`);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(sha256(await readFile(originalPath)), values['original-sha256']!.toLowerCase());
  console.log(
    JSON.stringify({
      report: destination,
      effective_completed_workflows: report.effective_completed_workflows,
      original_failed_attempts: report.original_failed_attempts,
      provider_invocations_added: 0,
      usage,
    }),
  );
  if (report.effective_completed_workflows !== contract.workflows.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
