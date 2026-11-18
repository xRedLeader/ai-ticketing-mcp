import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture } from '../src/testing/contracts.js';
import { parseCodexInvocation } from '../scripts/real-client-observation.js';
import { revalidateAttempt } from '../scripts/real-client-revalidation.js';

it('revalidates retained observations offline and keeps altered usage or unfinished state failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-revalidation-test-'));
  const database = join(directory, 'fixture.sqlite');
  const a = createSqliteAdapters(database);
  try {
    await a.storage.migrate();
    const f = await fixture(a, 'self');
    const contract = JSON.parse(
      await readFile(new URL('../scripts/fixtures/protocol-workflows.json', import.meta.url), 'utf8'),
    );
    const workflow = contract.workflows.find((item: any) => item.id === 'short');
    const project = (await a.storage.get('projects', f.project.id))!;
    await f.app.execute(f.admin.id, 'project_update', {
      project_id: project.id,
      expected_revision: project.revision,
      name: contract.project.name,
      instructions: contract.project.instructions,
      idempotency_key: randomUUID(),
    });
    await a.storage.transaction('catalog', (tx) => tx.put('actors', { ...f.reviewer, kind: 'agent' }));
    const ticket = await f.ticket({
      description: contract.project.description,
      criteria: [contract.project.criterion],
    });
    const events: any[] = [];
    const call = async (tool: string, args: any) => {
      const id = randomUUID();
      const input = { project_id: project.id, idempotency_key: randomUUID(), ...args };
      const item = { id, type: 'mcp_tool_call', server: 'ai-ticketing', tool, arguments: input };
      events.push({ type: 'item.started', item });
      const data: any = await f.app.execute(f.worker.id, tool as any, input);
      events.push({
        type: 'item.completed',
        item: { ...item, result: { structured_content: { ok: true, data } } },
      });
      return data;
    };
    const claimed = await call('work_claim', { ticket_id: ticket.id, include_context: true });
    const checkpoint = await call('ticket_checkpoint', {
      ticket_id: ticket.id,
      claim_token: claimed.claim.token,
      progress: `${contract.project.description} ${contract.project.instructions.split('. ')[0]}. approval_policy=self`,
      decisions: [],
      remaining: [],
    });
    const current: any = await f.read(ticket.id);
    await call('ticket_submit', {
      ticket_id: ticket.id,
      claim_token: claimed.claim.token,
      expected_revision: checkpoint.ticket.revision,
      summary: 'Prepared fixture evidence.',
      evidence: current.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Owner allowed and outsider denied.',
        references: ['https://example.test/evidence'],
      })),
    });
    events.push({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
    });
    const raw = events.map((event) => JSON.stringify(event)).join('\n');
    const calls = [0, 1].map(() => ({
      consumer: 'maintenance',
      operation: 'work_heartbeat',
      result: { structuredContent: { ok: true } },
    }));
    const maintained = {
      consumer: 'maintenance',
      success: true,
      completed_intervals: 2,
      evidence_complete: true,
      calls,
      wire: [],
      rpc_round_trips: 2,
    };
    const original = {
      role: 'worker',
      model_requested: 'fixture-model',
      exit_code: 0,
      ...parseCodexInvocation(raw, 0),
      maintenance: maintained,
    };
    const attempt = {
      id: 'original-attempt',
      status: 'failed',
      failure: 'Original validator failure retained.',
      artifact_directory: directory,
      invocations: [original],
    };
    const files: Record<string, any> = {
      'worker-fixture.json': { actorId: f.worker.id, projectId: project.id, ticketId: ticket.id, database },
      'worker-request.json': { requested_model: 'fixture-model' },
      'worker-result.json': original,
      'maintenance-result.json': maintained,
      'attempt.json': attempt,
    };
    for (const [name, value] of Object.entries(files))
      await writeFile(join(directory, name), JSON.stringify(value), { flag: 'wx' });
    await writeFile(join(directory, 'worker.jsonl'), raw, { flag: 'wx' });
    await writeFile(
      join(directory, 'maintenance.jsonl'),
      calls.map((record) => JSON.stringify({ kind: 'call', ...record })).join('\n'),
      { flag: 'wx' },
    );
    await a.search.close();
    await a.storage.close();
    const corrected = await revalidateAttempt(attempt, workflow, contract);
    assert.equal(corrected.effective_status, 'completed', corrected.errors.join('\n'));
    assert.equal(corrected.original_status, 'failed');
    assert.equal(corrected.original_failure, attempt.failure);
    assert.equal(corrected.provider_invocations_added, 0);
    assert.ok(corrected.artifact_sha256['worker-result.json']);
    const altered = {
      ...attempt,
      invocations: [{ ...original, usage: { ...original.usage, input_tokens: 101 } }],
    };
    assert.equal((await revalidateAttempt(altered, workflow, contract)).effective_status, 'failed');
    const db = new DatabaseSync(database);
    try {
      db.prepare("UPDATE tickets SET status='in_progress' WHERE id=?").run(ticket.id);
    } finally {
      db.close();
    }
    const unfinished = await revalidateAttempt(attempt, workflow, contract);
    assert.equal(unfinished.effective_status, 'failed');
    assert.ok(unfinished.errors.some((error) => error.includes('Authoritative ticket did not complete')));
  } finally {
    await a.search.close();
    await a.storage.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-revalidation-test-'));
    await rm(directory, { recursive: true });
  }
});
