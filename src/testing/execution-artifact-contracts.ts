import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createApplication } from '../application.js';
import { serializeSuccessEnvelope } from '../envelope.js';
import { countReferenceTokens } from '../tokens.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerExecutionArtifactContracts(name: string, factory: () => Promise<ContractAdapters>) {
  const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} artifacts: ${title}`, async () => {
      const f = await setup();
      try {
        await work(f);
      } finally {
        if (f.dispose) await f.dispose();
        else {
          await f.storage.close();
          await f.search.close();
        }
        await rm(f.directory, { recursive: true, force: true });
      }
    });
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters),
      directory = await mkdtemp(join(tmpdir(), 'ticketing-artifact-'));
    const app = createApplication({
      ...adapters,
      now: () => f.clock.now,
      referenceTokenMetrics: true,
      executionRecipes: [{ id: 'fixture', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
      executionArtifacts: { directory, ttl_ms: 1000 },
    });
    const ticket = await f.ticket(),
      claim = await f.claim(ticket.id);
    const receipt = (await app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'fixture',
      checkpoint: { progress: '漢'.repeat(12000) },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    const run = (await app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60000))!;
    await app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60000);
    const attempt = (await f.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
    const path = join(directory, run.id, attempt.id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const content = Buffer.from('🧪漢字é\n'.repeat(50000)),
      refs = ['stdout', 'stderr', 'result'].map((name) => `execution:${run.id}:${attempt.id}:${name}`);
    await writeFile(join(path, 'stdout.log'), content, { mode: 0o600 });
    await writeFile(join(path, 'stderr.log'), 'fixture.ts:7: failure\n', { mode: 0o600 });
    const journal = {
      run_id: run.id,
      attempt_id: attempt.id,
      process_token: attempt.process_token,
      recipe_fingerprint: run.recipe_fingerprint,
      finished_at: f.clock.now.getTime(),
      bytes: { stdout: content.length, stderr: 22 },
      total_bytes: { stdout: content.length + 500, stderr: 22 },
      truncated: { stdout: true, stderr: false },
      exit_code: 7,
      sha256: {
        stdout: createHash('sha256').update(content).digest('hex'),
        stderr: createHash('sha256').update('fixture.ts:7: failure\n').digest('hex'),
        result: createHash('sha256')
          .update(JSON.stringify({ exit_code: 7 }))
          .digest('hex'),
      },
    };
    await writeFile(join(path, 'result.json'), JSON.stringify(journal), { mode: 0o600 });
    await writeFile(join(path, 'outcome.json'), JSON.stringify({ exit_code: 7 }), { mode: 0o600 });
    await app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
      exit_code: 7,
      signal: null,
      error_code: null,
      artifacts: refs,
    });
    const read = (changes: Record<string, unknown> = {}, actor = f.worker.id) =>
      app.execute(actor, 'artifact_read', {
        project_id: f.project.id,
        artifact_id: refs[0],
        offset: 7,
        length: 391,
        ...changes,
      }) as Promise<any>;
    return { ...f, ...adapters, app, directory, path, content, refs, run, attempt, read };
  }
  check('retrieves exact Unicode byte ranges and hashes with encoded response budgets', async (f) => {
    const exact = await f.read();
    assert.deepEqual(Buffer.from(exact.range.data, 'base64'), f.content.subarray(7, 398));
    assert.equal(exact.range.sha256, createHash('sha256').update(f.content.subarray(7, 398)).digest('hex'));
    assert.equal(exact.sha256, createHash('sha256').update(f.content).digest('hex'));
    assert.equal(exact.range.complete, true);
    assert.equal(exact.omitted_bytes, 500);
    const bounded = await f.read({ offset: 0, length: 65536, max_tokens: 512 });
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(bounded)) <= 512);
    assert.equal(bounded.range.unavailable_reason, 'response_budget');
    assert.equal(bounded.range.next_offset, bounded.range.returned_length);
    assert.ok(bounded.range.returned_length > 0 && bounded.range.returned_length < 65536);
    assert.deepEqual(
      Buffer.from(bounded.range.data, 'base64'),
      f.content.subarray(0, bounded.range.returned_length),
    );
    const next = await f.read({ offset: bounded.range.next_offset, length: 19 });
    assert.deepEqual(
      Buffer.from(next.range.data, 'base64'),
      f.content.subarray(bounded.range.next_offset, bounded.range.next_offset + 19),
    );
    const status = (await f.app.execute(f.worker.id, 'run_get', {
      project_id: f.project.id,
      run_id: f.run.id,
      max_tokens: 1024,
    })) as any;
    assert.equal(status.run.exit_code, 7);
    assert.equal(status.checkpoint, null);
    assert.ok(
      status.omitted.some(
        (item: any) => item.section === 'checkpoint' && item.retrieve_with === 'checkpoint_get',
      ),
    );
    assert.equal(status.failure_location.arguments.artifact_id, f.refs[1]);
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(status)) <= 1024);
    const compact = (await f.app.execute(f.worker.id, 'run_get', {
      project_id: f.project.id,
      run_id: f.run.id,
      max_tokens: 512,
    })) as any;
    assert.equal(compact.run.exit_code, 7);
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(compact)) <= 512);
  });
  check('makes captured gaps, past-end, missing and expired artifacts explicit', async (f) => {
    const gap = await f.read({ offset: f.content.length - 3, length: 20 });
    assert.equal(gap.range.returned_length, 3);
    assert.equal(gap.range.complete, false);
    assert.equal(gap.range.unavailable_reason, 'capture_limit');
    assert.equal(
      (await f.read({ offset: f.content.length + 501, length: 1 })).range.unavailable_reason,
      'past_end',
    );
    const disabled = createApplication({ storage: f.storage, search: f.search });
    const unavailable = (await disabled.execute(f.worker.id, 'artifact_read', {
      project_id: f.project.id,
      artifact_id: f.refs[0],
    })) as any;
    assert.equal(unavailable.status, 'not_configured');
    const past = await f.read({ artifact_id: f.refs[1], offset: 999, length: 10 });
    assert.equal(past.range.unavailable_reason, 'past_end');
    const journal = JSON.parse(await readFile(join(f.path, 'result.json'), 'utf8'));
    delete journal.sha256;
    await writeFile(join(f.path, 'result.json'), JSON.stringify(journal));
    assert.equal((await f.read()).sha256, createHash('sha256').update(f.content).digest('hex'));
    const safe = await f.read({ artifact_id: f.refs[2], offset: 0, length: 1024 });
    assert.deepEqual(JSON.parse(Buffer.from(safe.range.data, 'base64').toString()), { exit_code: 7 });
    assert.ok(!JSON.stringify(safe).includes(f.attempt.process_token));
    await rm(join(f.path, 'stdout.log'));
    assert.equal((await f.read()).status, 'missing');
    f.clock.now = new Date(f.clock.now.getTime() + 1000);
    const expired = await f.read({ artifact_id: f.refs[1] });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.range.unavailable_reason, 'expired');
    assert.equal(expired.range.data, '');
  });
  check(
    'rejects cross-project, traversal, unpublished identities and linked files without telemetry labels',
    async (f) => {
      await assert.rejects(f.read({}, f.outsider.id), hasCode('FORBIDDEN'));
      const other = await fixture({ storage: f.storage, search: f.search });
      await assert.rejects(f.read({ project_id: other.project.id }, other.worker.id), hasCode('NOT_FOUND'));
      for (const artifact_id of [
        '../../result.json',
        `execution:${f.run.id}:../stdout`,
        `https://example.com/${f.refs[0]}`,
        f.refs[0] + ':extra',
      ])
        await assert.rejects(f.read({ artifact_id }), hasCode('INVALID_INPUT'));
      await assert.rejects(
        f.read({ artifact_id: `execution:${f.run.id}:${randomUUID()}:stdout` }),
        hasCode('INVALID_REFERENCE'),
      );
      await assert.rejects(f.read({ offset: -1 }), hasCode('INVALID_INPUT'));
      await assert.rejects(f.read({ length: 65537 }), hasCode('INVALID_INPUT'));
      const moved = `${f.path}-real`;
      await rename(f.path, moved);
      try {
        await symlink(moved, f.path, 'junction');
        await assert.rejects(f.read(), hasCode('INVALID_ARTIFACT'));
      } finally {
        await rm(f.path, { force: true });
        await rename(moved, f.path);
      }
      const log = join(f.path, 'stdout.log'),
        linked = join(f.path, 'stdout-real.log');
      await rename(log, linked);
      try {
        await link(linked, log);
        await assert.rejects(f.read(), hasCode('INVALID_ARTIFACT'));
      } finally {
        await rm(log, { force: true });
        await rename(linked, log);
      }
      const journal = JSON.parse(await readFile(join(f.path, 'result.json'), 'utf8'));
      journal.process_token = randomUUID();
      await writeFile(join(f.path, 'result.json'), JSON.stringify(journal));
      await assert.rejects(f.read(), hasCode('INVALID_ARTIFACT'));
      f.app.recordReferenceTokens('result', 'credential=secret-content');
      assert.ok(Object.values(f.app.metrics).every((value) => typeof value === 'number'));
      assert.ok(!JSON.stringify(f.app.metrics).includes('secret-content'));
      assert.ok(!JSON.stringify(f.app.metrics).includes(f.refs[0]!));
    },
  );
}
