import { it } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../application.js';
import type { StorageAdapter, Transaction } from '../contracts.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

type Adapters = ContractAdapters & { runtimeEnv: NodeJS.ProcessEnv; reopen(): Promise<ContractAdapters> };
export function registerArtifactRetentionContracts(name: string, factory: () => Promise<Adapters>) {
  async function setup(exitCode = 0) {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters, 'self');
    const directory = await mkdtemp(join(tmpdir(), 'artifact-retention-'));
    const make = (storage = adapters.storage, search = adapters.search) =>
      createApplication({
        storage,
        search,
        now: () => f.clock.now,
        executionArtifacts: { directory, ttl_ms: 1000 },
        executionRecipes: [{ id: 'fixture', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
      });
    const app = make(),
      ticket = await f.ticket(),
      claim = await f.claim(ticket.id);
    const submitted = (await app.execute(f.worker.id, 'run_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      claim_token: claim.claim.token,
      idempotency_key: randomUUID(),
      recipe_id: 'fixture',
      checkpoint: { progress: 'Verification completed.' },
      completion_condition: { kind: 'exit_code', exit_code: 0 },
    })) as any;
    const run = (await app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60000))!;
    await app.startExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, 60000);
    const [attempt] = await adapters.storage.find('execution_attempts', { where: { run_id: run.id } });
    const path = join(directory, run.id, attempt!.id);
    await mkdir(path, { recursive: true });
    const bytes = Buffer.from('finite verification output\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const refs = ['stdout', 'stderr', 'result'].map((kind) => `execution:${run.id}:${attempt!.id}:${kind}`);
    const journal = {
      run_id: run.id,
      attempt_id: attempt!.id,
      process_token: attempt!.process_token,
      recipe_fingerprint: run.recipe_fingerprint,
      finished_at: f.clock.now.getTime(),
      cleanup_verified: true,
      exit_code: exitCode,
      signal: null,
      error_code: null,
      bytes: { stdout: bytes.length, stderr: bytes.length },
      sha256: { stdout: digest, stderr: digest },
      truncated: { stdout: false, stderr: false },
    };
    for (const kind of ['stdout', 'stderr']) await writeFile(join(path, `${kind}.log`), bytes);
    await writeFile(join(path, 'result.json'), JSON.stringify(journal));
    for (const file of [
      'outcome.json',
      'pipeline-report.json',
      'pipeline-timeout.json',
      `manifest.json.${randomUUID()}.tmp`,
    ])
      await writeFile(join(path, file), 'protected');
    await app.settleExecutionRun(f.admin.id, f.project.id, run.id, run.reservation_token!, {
      exit_code: exitCode,
      signal: null,
      error_code: null,
      artifacts: refs,
    });
    const finish = async (references = ['tests:assertions']) => {
      const current = await f.read(ticket.id);
      await f.call(f.worker.id, 'ticket_submit', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        expected_revision: current.ticket.revision,
        summary: 'Verified.',
        evidence: current.criteria.map((criterion: any) => ({
          criterion_id: criterion.id,
          result: 'pass',
          summary: 'Passed.',
          references,
        })),
      });
      f.clock.now = new Date(f.clock.now.getTime() + 2000);
    };
    const retire = (target = app, actor = f.admin.id) =>
      target.retireExecutionArtifact(actor, f.project.id, refs[0]!);
    const read = (target = app) =>
      target.execute(f.worker.id, 'artifact_read', {
        project_id: f.project.id,
        artifact_id: refs[0],
        length: 12,
      }) as Promise<any>;
    return {
      ...f,
      ...adapters,
      app,
      make,
      directory,
      path,
      bytes,
      journal,
      run,
      ticket,
      attempt: attempt!,
      refs,
      finish,
      retire,
      read,
    };
  }
  const check = (
    title: string,
    test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
    exitCode = 0,
    linuxOnly = false,
  ) =>
    it(
      `${name} artifact retention: ${title}`,
      { skip: linuxOnly && process.platform !== 'linux' },
      async () => {
        const f = await setup(exitCode);
        try {
          await test(f);
        } finally {
          await f.dispose?.();
          if (!f.dispose) {
            await f.storage.close();
            await f.search.close();
          }
          assert.ok(f.directory.startsWith(join(tmpdir(), 'artifact-retention-')));
          await rm(f.directory, { recursive: true, force: true });
        }
      },
    );
  const physicalCheck = (title: string, test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    check(title, test, 0, true);
  const proxy = (
    storage: StorageAdapter,
    intercept: (tx: Transaction, count: number) => Transaction | never,
  ) => {
    let count = 0;
    return new Proxy(storage, {
      get(target, property) {
        if (property === 'transaction')
          return (scope: string, work: (tx: Transaction) => Promise<unknown>) =>
            target.transaction(scope, (tx) => work(intercept(tx, ++count)));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  physicalCheck(
    'deletes only expired unpinned logs, preserves audit/receipts and exposes explicit expired metadata',
    async (f) => {
      await f.finish();
      const receipts = await f.storage.find('receipts', { where: { project_id: f.project.id } });
      const run = await f.storage.get('execution_jobs', f.run.id);
      const result = await f.retire();
      assert.equal(result.removed, true);
      assert.equal(existsSync(join(f.path, 'stdout.log')), false);
      for (const file of [
        'stderr.log',
        'result.json',
        'outcome.json',
        'pipeline-report.json',
        'pipeline-timeout.json',
      ])
        assert.ok(existsSync(join(f.path, file)));
      assert.deepEqual(await f.storage.find('receipts', { where: { project_id: f.project.id } }), receipts);
      assert.deepEqual(await f.storage.get('execution_jobs', f.run.id), run);
      const read = await f.read();
      assert.equal(read.status, 'expired');
      assert.equal(read.range.data, '');
      assert.equal(read.sha256, result.sha256);
      assert.equal((await f.retire()).removed, false);
      assert.equal(
        (await f.storage.find('events', { where: { project_id: f.project.id, type: 'artifact.retired' } }))
          .length,
        1,
      );
      assert.equal(
        (await f.storage.find('events', { where: { project_id: f.project.id, type: 'artifact.deleted' } }))
          .length,
        1,
      );
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.remove('artifact_retirements', f.refs[0]!)),
        hasCode('IMMUTABLE_EXECUTION'),
      );
    },
  );
  check('fails closed for active work, accepted evidence and historical memory sources', async (f) => {
    f.clock.now = new Date(f.clock.now.getTime() + 2000);
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
    await f.finish([f.refs[0]!]);
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
    assert.ok(existsSync(join(f.path, 'stdout.log')));
    const read = await f.read();
    assert.equal(read.status, 'available');
    assert.equal(read.expires_at, null);
    assert.deepEqual(Buffer.from(read.range.data, 'base64'), f.bytes.subarray(0, 12));
    await assert.rejects(
      f.app.execute(f.outsider.id, 'artifact_read', { project_id: f.project.id, artifact_id: f.refs[0] }),
      hasCode('FORBIDDEN'),
    );
  });
  check('rejects new idea citations after an artifact retirement decision', async (f) => {
    if (!f.storage.ideaIntake) return;
    const fields = { title: 'Proposal', problem: 'Problem', proposal: 'Improvement', why: 'Value' };
    const idea = (await f.call(f.worker.id, 'idea_create', fields)) as { id: string };
    await f.finish();
    await f.storage.transaction(f.project.id, (tx) =>
      tx.put('artifact_retirements', {
        id: f.refs[0]!,
        project_id: f.project.id,
        run_id: f.run.id,
        attempt_id: f.attempt.id,
        ticket_id: f.ticket.id,
        checkpoint_id: f.run.checkpoint_id,
        actor_id: f.admin.id,
        requested_at: f.clock.now.toISOString(),
        expires_at: new Date(f.journal.finished_at + 1000).toISOString(),
        size_bytes: f.bytes.length,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        root_identity: 'previous-root',
        file_identity: 'previous-file',
      }),
    );
    for (const field of Object.keys(fields))
      await assert.rejects(
        f.call(f.worker.id, 'idea_create', { ...fields, [field]: f.refs[0] }),
        hasCode('ARTIFACT_RETIRED'),
      );
    await assert.rejects(
      f.call(f.worker.id, 'idea_triage', {
        idea_id: idea.id,
        expected_revision: 1,
        action: 'park',
        rationale: f.refs[0],
      }),
      hasCode('ARTIFACT_RETIRED'),
    );
    assert.equal((await f.storage.get('ideas', idea.id))?.revision, 1);
  });
  check('keeps memory provenance pinned even after archival and unrelated edits', async (f) => {
    await f.finish();
    const checkpoint = (await f.storage.get('notes', f.run.checkpoint_id))!;
    const input = {
      title: 'Retained evidence',
      body: 'Verified source.',
      sources: [{ kind: 'checkpoint', id: f.run.checkpoint_id, revision: checkpoint.ticket_revision }],
    };
    const knowledge = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
    const accepted = (await f.call(f.admin.id, 'knowledge_write', {
      title: input.title,
      body: input.body,
      knowledge_id: knowledge.id,
      expected_revision: knowledge.revision,
      verification: { state: 'verified', evidence: 'Checked the exact checkpoint revision.' },
      status: 'accepted',
    })) as any;
    assert.equal((await f.read()).status, 'available');
    await f.call(f.worker.id, 'knowledge_write', {
      ...input,
      knowledge_id: knowledge.id,
      expected_revision: accepted.revision,
      archived: true,
      sources: [],
    });
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
    assert.equal((await f.read()).status, 'available');
  });
  physicalCheck(
    'serializes cross-project pins and reads with retirement, leaving heartbeat unblocked',
    async (f) => {
      await f.finish();
      const other = await fixture({ storage: f.storage, search: f.search }, 'self');
      const otherTicket = await other.ticket();
      const otherClaim = await other.claim(otherTicket.id);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wrapped = proxy(
        f.storage,
        (tx, count) =>
          new Proxy(tx, {
            get(target, property) {
              if (property === 'artifactPinned' && count === 1)
                return async (query: Parameters<NonNullable<Transaction['artifactPinned']>>[0]) => {
                  entered();
                  await gate;
                  return target.artifactPinned!(query);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
      );
      const retiring = f.retire(f.make(wrapped));
      await ready;
      const heartbeat = other.call(other.worker.id, 'work_heartbeat', {
        ticket_id: otherTicket.id,
        claim_token: otherClaim.claim.token,
      });
      if (name === 'PostgreSQL') await heartbeat;
      let readFinished = false;
      const reading = f.read().then((value) => {
        readFinished = true;
        return value;
      });
      const writing = assert.rejects(
        other.call(other.worker.id, 'ticket_note', { ticket_id: otherTicket.id, body: f.refs[0] }),
        hasCode('ARTIFACT_RETIRED'),
      );
      await delay(20);
      assert.equal(readFinished, false);
      release();
      await retiring;
      await heartbeat;
      await writing;
      assert.equal((await reading).status, 'expired');
    },
  );
  check('protects exact citations from another project', async (f) => {
    await f.finish();
    const other = await fixture({ storage: f.storage, search: f.search }, 'self');
    const ticket = await other.ticket();
    await other.call(other.worker.id, 'ticket_note', { ticket_id: ticket.id, body: f.refs[0] });
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
  });
  check('pins structured memory fact values in immutable historical revisions', async (f) => {
    await f.finish();
    const knowledge = (await f.call(f.worker.id, 'knowledge_write', {
      title: 'Output identity',
      body: 'Stored identity.',
      fact: { key: 'execution.evidence', value: f.refs[0] },
    })) as any;
    await f.call(f.worker.id, 'knowledge_write', {
      title: 'Output identity',
      body: 'Stored identity.',
      knowledge_id: knowledge.id,
      expected_revision: knowledge.revision,
      fact: null,
    });
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
    assert.equal((await f.read()).status, 'available');
  });
  check('keeps unpinned expiry and avoids global pin checks on unexpired reads', async (f) => {
    const wrapped = proxy(
      f.storage,
      (tx) =>
        new Proxy(tx, {
          get(target, property) {
            if (property === 'artifactPinned')
              return () => {
                throw new Error('Unexpected unexpired pin scan');
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    assert.equal((await f.read(f.make(wrapped))).status, 'available');
    await f.finish();
    const expired = await f.read();
    assert.equal(expired.status, 'expired');
    assert.equal(expired.range.data, '');
  });
  check(
    'keeps pinned failure locations and bounded run recovery usable beyond TTL',
    async (f) => {
      await f.finish([f.refs[1]!]);
      const bounded = (await f.app.execute(f.worker.id, 'run_get', {
        project_id: f.project.id,
        run_id: f.run.id,
        max_tokens: 512,
      })) as any;
      assert.equal(bounded.run.exit_code, 7);
      assert.ok(bounded.omitted.length > 0);
      for (const omission of bounded.omitted)
        await f.app.execute(f.worker.id, omission.retrieve_with, omission.arguments);
      const view = (await f.app.execute(f.worker.id, 'run_get', {
        project_id: f.project.id,
        run_id: f.run.id,
      })) as any;
      assert.equal(view.failure_location.tool, 'artifact_read');
      const evidence = (await f.app.execute(
        f.worker.id,
        view.failure_location.tool,
        view.failure_location.arguments,
      )) as any;
      assert.equal(evidence.status, 'available');
      assert.deepEqual(Buffer.from(evidence.range.data, 'base64'), f.bytes);
      assert.equal(evidence.sha256, createHash('sha256').update(f.bytes).digest('hex'));
    },
    7,
  );
  check('preserves terminal logs cited by trusted cancellation reconciliation evidence', async (f) => {
    await f.finish();
    await f.app.cancelExecutionRun(f.admin.id, f.project.id, f.run.id);
    await f.app.reconcileExecutionCancellation(f.admin.id, f.project.id, f.run.id, `Inspected ${f.refs[0]}`);
    await assert.rejects(f.retire(), hasCode('ARTIFACT_PINNED'));
    assert.ok(existsSync(join(f.path, 'stdout.log')));
  });
  physicalCheck('never unlinks a file if the durable decision fails to commit', async (f) => {
    await f.finish();
    const wrapped = proxy(
      f.storage,
      (tx) =>
        new Proxy(tx, {
          get(target, property) {
            if (property === 'put')
              return async (table: string, row: any) => {
                if (table === 'events' && row.type === 'artifact.retired')
                  throw new Error('decision commit failed');
                return target.put(table as any, row);
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    await assert.rejects(f.retire(f.make(wrapped)), /decision commit failed/);
    assert.equal(await f.storage.get('artifact_retirements', f.refs[0]!), null);
    assert.ok(existsSync(join(f.path, 'stdout.log')));
  });
  physicalCheck(
    'resumes a committed decision after process restart and rejects new pins without an artifact root',
    async (f) => {
      await f.finish();
      const crashing = f.make(
        proxy(f.storage, (tx, count) => {
          if (count === 2) throw new Error('simulated crash');
          return tx;
        }),
      );
      await assert.rejects(f.retire(crashing), /simulated crash/);
      assert.ok(existsSync(join(f.path, 'stdout.log')));
      const reopened = await f.reopen();
      const app = f.make(reopened.storage, reopened.search);
      const withoutRoot = createApplication(reopened);
      await assert.rejects(
        withoutRoot.execute(f.worker.id, 'knowledge_write', {
          project_id: f.project.id,
          idempotency_key: randomUUID(),
          title: 'New evidence',
          body: 'Stored fact.',
          fact: { key: 'execution.evidence', value: f.refs[0] },
        }),
        hasCode('ARTIFACT_RETIRED'),
      );
      await assert.rejects(
        withoutRoot.execute(f.worker.id, 'ticket_note', {
          project_id: f.project.id,
          ticket_id: f.ticket.id,
          idempotency_key: randomUUID(),
          body: f.refs[0],
        }),
        hasCode('ARTIFACT_RETIRED'),
      );
      assert.equal((await f.retire(app)).removed, true);
      assert.equal((await f.read(app)).status, 'expired');
      await app.cancelExecutionRun(f.admin.id, f.project.id, f.run.id);
      await assert.rejects(
        app.reconcileExecutionCancellation(f.admin.id, f.project.id, f.run.id, `Inspect ${f.refs[0]}`),
        hasCode('ARTIFACT_RETIRED'),
      );
    },
  );
  physicalCheck('recovers unlink-before-audit-commit failure without deleting another file', async (f) => {
    await f.finish();
    const wrapped = proxy(f.storage, (tx, count) =>
      count !== 2
        ? tx
        : new Proxy(tx, {
            get(target, property) {
              if (property === 'put')
                return async (table: string, row: any) => {
                  if (table === 'events' && row.type === 'artifact.deleted')
                    throw new Error('audit commit failed');
                  return target.put(table as any, row);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
    );
    await assert.rejects(f.retire(f.make(wrapped)), /audit commit failed/);
    assert.equal(existsSync(join(f.path, 'stdout.log')), false);
    assert.equal((await f.retire()).removed, false);
    assert.equal(
      (await f.storage.find('events', { where: { project_id: f.project.id, type: 'artifact.deleted' } }))
        .length,
      1,
    );
  });
  physicalCheck('rejects changed ownership, hard links, protected results and arbitrary paths', async (f) => {
    await f.finish();
    for (const id of [
      f.refs[2]!,
      `${f.refs[0]}/../../out`,
      `execution:${f.run.id}:${f.attempt.id}:manifest.json.${randomUUID()}.tmp`,
    ])
      await assert.rejects(
        f.app.retireExecutionArtifact(f.admin.id, f.project.id, id),
        hasCode('INVALID_INPUT'),
      );
    const outside = join(f.directory, 'outside.log');
    await link(join(f.path, 'stdout.log'), outside);
    await assert.rejects(f.retire(), hasCode('INVALID_ARTIFACT'));
    assert.deepEqual(await readFile(outside), f.bytes);
    await rm(outside);
    const crashing = f.make(
      proxy(f.storage, (tx, count) => {
        if (count === 2) throw new Error('simulated crash');
        return tx;
      }),
    );
    await assert.rejects(f.retire(crashing), /simulated crash/);
    await rename(join(f.path, 'stdout.log'), outside);
    await writeFile(join(f.path, 'stdout.log'), f.bytes);
    await assert.rejects(f.retire(), hasCode('INVALID_ARTIFACT'));
    assert.deepEqual(await readFile(outside), f.bytes);
    assert.ok(existsSync(join(f.path, 'stdout.log')));
  });
  physicalCheck(
    'requires current administrator authority on every restart/retry and trusted expiry proof',
    async (f) => {
      await f.finish();
      await assert.rejects(f.retire(f.app, f.worker.id), hasCode('FORBIDDEN'));
      f.clock.now = new Date(f.journal.finished_at + 500);
      await assert.rejects(f.retire(), hasCode('ARTIFACT_NOT_EXPIRED'));
      f.clock.now = new Date(f.journal.finished_at + 2000);
      await writeFile(join(f.path, 'result.json'), JSON.stringify({ ...f.journal, cleanup_verified: false }));
      await assert.rejects(f.retire(), hasCode('ARTIFACT_NOT_EXPIRED'));
      await writeFile(join(f.path, 'result.json'), JSON.stringify(f.journal));
      const grant = (role: string) => f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role });
      await grant('admin');
      const crashing = f.make(
        proxy(f.storage, (tx, count) => {
          if (count === 2) throw new Error('simulated crash');
          return tx;
        }),
      );
      await assert.rejects(f.retire(crashing, f.other.id), /simulated crash/);
      await grant('contributor');
      await assert.rejects(f.retire(f.app, f.other.id), hasCode('FORBIDDEN'));
      assert.ok(existsSync(join(f.path, 'stdout.log')));
    },
  );
  check('refuses unsupported physical cleanup before creating any retirement decision', async (f) => {
    if (process.platform === 'linux') return;
    await f.finish();
    await assert.rejects(f.retire(), hasCode('UNSUPPORTED_PHYSICAL_CLEANUP'));
    assert.equal(await f.storage.get('artifact_retirements', f.refs[0]!), null);
    assert.ok(existsSync(join(f.path, 'stdout.log')));
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/execution-companion-cli.ts',
          '--actor',
          f.admin.id,
          '--project',
          f.project.id,
          '--artifacts',
          f.directory,
          '--retire',
          f.refs[0]!,
        ],
        {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: 20000,
          env: { ...process.env, ...f.runtimeEnv, EXECUTION_ARTIFACT_TTL_MS: '1' },
        },
      ),
      (error: any) => /UNSUPPORTED_PHYSICAL_CLEANUP/.test(error.stderr),
    );
    assert.equal(await f.storage.get('artifact_retirements', f.refs[0]!), null);
    await f.storage.transaction(f.project.id, async (tx) =>
      tx.put('artifact_retirements', {
        id: f.refs[0]!,
        project_id: f.project.id,
        run_id: f.run.id,
        attempt_id: f.attempt.id,
        ticket_id: f.ticket.id,
        checkpoint_id: f.run.checkpoint_id,
        actor_id: f.admin.id,
        requested_at: f.clock.now.toISOString(),
        expires_at: new Date(f.journal.finished_at + 1000).toISOString(),
        size_bytes: f.bytes.length,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        root_identity: 'prior-linux-root',
        file_identity: 'prior-linux-file',
      }),
    );
    const result = await f.retire();
    assert.equal(result.status, 'retired_pending');
    assert.equal(result.removed, false);
    assert.equal((await f.read()).status, 'expired');
  });
  physicalCheck('anchors the last unlink to its opened parent despite a directory replacement', async (f) => {
    await f.finish();
    const outside = await mkdtemp(join(tmpdir(), 'retention-outside-'));
    const sentinel = join(outside, 'capture');
    await writeFile(sentinel, 'unrelated outside bytes');
    const original = fs.unlinkSync,
      saved = f.path + '.original';
    let swapped = false;
    fs.unlinkSync = ((path: fs.PathLike) => {
      if (String(path).startsWith('/proc/self/fd/') && String(path).endsWith('/capture') && !swapped) {
        fs.renameSync(f.path, saved);
        fs.symlinkSync(outside, f.path);
        swapped = true;
      }
      return original(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      assert.equal((await f.retire()).removed, true);
      assert.equal(await readFile(sentinel, 'utf8'), 'unrelated outside bytes');
    } finally {
      fs.unlinkSync = original;
      syncBuiltinESMExports();
      if (swapped) {
        original(f.path);
        fs.renameSync(saved, f.path);
      }
      assert.ok(outside.startsWith(join(tmpdir(), 'retention-outside-')));
      await rm(outside, { recursive: true, force: true });
    }
  });
  physicalCheck('restores an unexpected source replacement without deleting its bytes', async (f) => {
    await f.finish();
    const original = fs.renameSync;
    let swapped = false;
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (
        String(source).startsWith('/proc/self/fd/') &&
        String(source).endsWith('/stdout.log') &&
        String(target).endsWith('/capture') &&
        !swapped
      ) {
        original(source, join(f.path, 'owned-original.log'));
        fs.writeFileSync(source, 'unrelated replacement');
        swapped = true;
      }
      return original(source, target);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.retire(), hasCode('ARTIFACT_STAGING_CONFLICT'));
      assert.equal(await readFile(join(f.path, 'stdout.log'), 'utf8'), 'unrelated replacement');
      assert.equal(
        await readFile(join(f.path, '.retired-stdout', 'capture'), 'utf8'),
        'unrelated replacement',
      );
      assert.deepEqual(await readFile(join(f.path, 'owned-original.log')), f.bytes);
    } finally {
      fs.renameSync = original;
      syncBuiltinESMExports();
    }
  });
  physicalCheck('resumes a durable staged capture after a crash before unlink', async (f) => {
    await f.finish();
    const original = fs.unlinkSync;
    fs.unlinkSync = ((path: fs.PathLike) => {
      if (String(path).endsWith('/capture')) throw new Error('staged crash');
      return original(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.retire(), /staged crash/);
    } finally {
      fs.unlinkSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(existsSync(join(f.path, '.retired-stdout', 'capture')));
    const reopened = await f.reopen();
    assert.equal((await f.retire(f.make(reopened.storage, reopened.search))).removed, true);
  });
  physicalCheck(
    'fails closed without blocking on substituted FIFO files or missing staging markers',
    async (f) => {
      await f.finish();
      await rename(join(f.path, 'stdout.log'), join(f.path, 'fifo-backup.log'));
      execFileSync('mkfifo', [join(f.path, 'stdout.log')]);
      await assert.rejects(f.retire(), hasCode('INVALID_ARTIFACT'));
      await rm(join(f.path, 'stdout.log'));
      await rename(join(f.path, 'fifo-backup.log'), join(f.path, 'stdout.log'));
      const wrapped = f.make(
        proxy(f.storage, (tx, count) => {
          if (count === 2) throw new Error('before staging');
          return tx;
        }),
      );
      await assert.rejects(f.retire(wrapped), /before staging/);
      await mkdir(join(f.path, '.retired-stdout'), { mode: 0o700 });
      await assert.rejects(f.retire(), hasCode('ARTIFACT_STAGING_CONFLICT'));
      execFileSync('mkfifo', [join(f.path, '.retired-stdout', 'decision.json')]);
      await assert.rejects(f.retire(), hasCode('ARTIFACT_STAGING_CONFLICT'));
      assert.ok(existsSync(join(f.path, 'stdout.log')));
    },
  );
  physicalCheck('runs only through an explicit trusted operator CLI invocation', async (f) => {
    await f.finish();
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/execution-companion-cli.ts',
        '--actor',
        f.admin.id,
        '--project',
        f.project.id,
        '--artifacts',
        f.directory,
        '--retire',
        f.refs[0]!,
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 20000,
        env: { ...process.env, ...f.runtimeEnv, EXECUTION_ARTIFACT_TTL_MS: '1' },
      },
    );
    assert.equal(JSON.parse(result.stdout).removed, true);
    assert.equal(existsSync(join(f.path, 'stdout.log')), false);
  });
}
