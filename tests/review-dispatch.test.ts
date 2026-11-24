import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture } from '../src/testing/contracts.js';
// @ts-expect-error The standalone dispatcher runs directly on Node.
import { openLedger, ReviewLaunchError, scanReviews } from '../examples/review-dispatch.mjs';

it('recovers an abruptly interrupted review and discards a superseded approval', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-review-restart-'));
  const ledgerPath = join(directory, 'review.sqlite');
  const sqlitePath = join(directory, 'tickets.sqlite');
  const adapters = createSqliteAdapters(sqlitePath);
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'verifier' });
    await f.call(f.admin.id, 'project_update', {
      expected_revision: f.project.revision,
      reviewer_actor_id: f.other.id,
    });
    const submit = async () => {
      const ticket = await f.ticket();
      const claim = await f.claim(ticket.id);
      return f.submit(ticket.id, claim.claim.token);
    };
    const interrupted = await submit();
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
        import { openLedger, scanReviews } from ${JSON.stringify(new URL('../examples/review-dispatch.mjs', import.meta.url).href)};
        import { createRuntime } from ${JSON.stringify(new URL('../src/runtime.ts', import.meta.url).href)};
        const [sqlite, ledger, projectId, reviewerId] = process.argv.slice(1);
        const app = createRuntime({ STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: sqlite });
        await scanReviews({ app, db: openLedger(ledger), projectId, reviewerId, now: () => 100_000,
          review() { throw new Error('review must not run before the crash'); },
          report(event) { if (event === 'started') process.exit(86); }
        });`,
        sqlitePath,
        ledgerPath,
        f.project.id,
        f.other.id,
      ],
      { timeout: 15_000, encoding: 'utf8', windowsHide: true },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 86, child.stderr);

    const db = openLedger(ledgerPath);
    try {
      const ledgerState = (id: string) =>
        db.prepare('SELECT state, decision, attempts FROM review_dispatch WHERE submission_id=?').get(id);
      assert.deepEqual(
        { ...ledgerState(interrupted.submission.id) },
        {
          state: 'started',
          decision: null,
          attempts: 1,
        },
      );
      t.diagnostic('Dispatcher exited after persisting started with no decision');
      const fresh = await submit();
      let clock = 100_000;
      let supersededTicketId: string | undefined;
      const options = { app: f.app, db, projectId: f.project.id, reviewerId: f.other.id, now: () => clock };
      const scan = () =>
        scanReviews({
          ...options,
          async review({ detail }: { detail: Awaited<ReturnType<typeof f.read>> }) {
            if (detail.ticket.id === supersededTicketId) {
              await f.call(f.worker.id, 'ticket_update', {
                ticket_id: detail.ticket.id,
                expected_revision: detail.ticket.revision,
                criteria: ['New criterion after the reviewer started.'],
              });
            }
            return { decision: 'approve', feedback: 'The submitted evidence meets the original criterion.' };
          },
        });
      const status = async (id: string) => (await f.read(id)).ticket.status;
      for (let n = 0; n < 4; n++) {
        clock += 5_000;
        await scan();
        assert.equal(await status(interrupted.ticket.id), 'in_review');
      }
      assert.equal(await status(fresh.ticket.id), 'done');
      t.diagnostic('Four scans left the held attempt alone while a new submission reached done');

      const superseded = await submit();
      supersededTicketId = superseded.ticket.id;
      clock += 10_000;
      await scan();
      assert.equal(await status(superseded.ticket.id), 'ready');
      const reviews = (await f.app.execute(f.worker.id, 'ticket_history', {
        project_id: f.project.id,
        ticket_id: superseded.ticket.id,
        kind: 'reviews',
      })) as { items: unknown[] };
      assert.deepEqual(reviews.items, []);
      t.diagnostic('Changing criteria mid-review returned the ticket to ready with no recorded review');

      assert.equal(await status(interrupted.ticket.id), 'done');
      assert.deepEqual(
        { ...ledgerState(interrupted.submission.id) },
        {
          state: 'finished',
          decision: null,
          attempts: 2,
        },
      );
      t.diagnostic('Restarted dispatcher recovered the interrupted submission on attempt 2');

      t.mock.timers.enable({ apis: ['setInterval'] });
      const contested = await submit();
      const competingLedger = openLedger(ledgerPath);
      const launched = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const running = scanReviews({
        ...options,
        db: competingLedger,
        report: (event: string) => events.push(event),
        async review() {
          launched.resolve();
          await release.promise;
          return { decision: 'request_changes', feedback: 'This old attempt lost the lease.' };
        },
      });
      try {
        await Promise.race([launched.promise, running]);
        for (let n = 0; n < 6; n++) {
          clock += 5_000;
          t.mock.timers.tick(5_000);
        }
        await scan();
        assert.equal(ledgerState(contested.submission.id)?.attempts, 1);
        assert.equal(await status(contested.ticket.id), 'in_review');
        clock += 30_000;
        await scan();
        assert.equal(await status(contested.ticket.id), 'done');
      } finally {
        release.resolve();
        try {
          await running;
        } finally {
          competingLedger.close();
        }
      }
      assert.deepEqual(events, ['started', 'lease_lost']);
      assert.equal(ledgerState(contested.submission.id)?.attempts, 2);
      t.diagnostic(
        'Renewals protected the live attempt and the former owner lost write access after takeover',
      );
    } finally {
      db.close();
    }
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('ticketing-review-restart-'));
    await rm(target, { recursive: true, force: true });
  }
});

it('routes a pending independent submission once and retries recording the durable decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-review-dispatch-'));
  const ledgerPath = join(directory, 'review.sqlite');
  let db = openLedger(ledgerPath);
  try {
    const projectId = 'project',
      reviewerId = 'astra';
    const ticket = {
      id: 'ticket',
      key: 'GAME-2',
      status: 'in_review',
      requirements_revision: 1,
      revision: 2,
    };
    let project = { policy: 'independent', reviewer_actor_id: 'other' };
    let submission = {
      id: 'submission',
      actor_id: 'worker',
      requirements_revision: 1,
      evidence: [] as { references: string[] }[],
    };
    let launches = 0;
    const recorded: Record<string, unknown>[] = [];
    const app = {
      async execute(actor: string, operation: string, input: Record<string, unknown>) {
        assert.equal(actor, reviewerId);
        assert.equal(input.project_id, projectId);
        switch (operation) {
          case 'project_get': {
            return { project, members: [{ actor_id: reviewerId, kind: 'agent', role: 'verifier' }] };
          }
          case 'ticket_list':
            return { tickets: [ticket] };
          case 'ticket_history':
            return { items: [submission] };
          case 'ticket_get':
            return { ticket };
          case 'ticket_review': {
            assert.equal(input.expected_revision, 2);
            assert.equal(input.submission_id, submission.id);
            recorded.push(input);
            if (recorded.length === 1) throw new Error('lost connection before commit');
            ticket.status = 'done';
            return {};
          }
          default:
            throw new Error(`Unexpected operation ${operation}`);
        }
      },
    };
    const scan = () =>
      scanReviews({
        app,
        projectId,
        reviewerId,
        db,
        async review() {
          launches++;
          return { decision: 'approve', feedback: 'The pinned evidence meets the criterion.' };
        },
      });
    await scan();
    assert.equal(launches, 0);
    project = { policy: 'independent', reviewer_actor_id: reviewerId };
    const original = submission;
    submission = { ...original, actor_id: reviewerId };
    await scan();
    assert.equal(launches, 0);
    submission = { ...original, evidence: [{ references: ['execution:project:run:result'] }] };
    await scan();
    assert.equal(launches, 0);
    submission = original;
    await scan();
    db.close();
    db = openLedger(ledgerPath);
    await scan();
    await scan();
    assert.equal(launches, 1);
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded[0], recorded[1]);
    assert.equal(ticket.status, 'done');
  } finally {
    db.close();
    await rm(ledgerPath);
    await rmdir(directory);
  }
});

it('retries launch failures within budget and recovers a current legacy failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-review-retry-'));
  const ledgerPath = join(directory, 'review.sqlite');
  const legacy = new DatabaseSync(ledgerPath);
  legacy.exec(`CREATE TABLE review_dispatch (submission_id TEXT PRIMARY KEY, state TEXT, decision TEXT);
    INSERT INTO review_dispatch VALUES ('legacy-failed', 'failed', NULL), ('already-approved', 'finished', NULL),
      ('legacy-started', 'started', NULL);`);
  legacy.close();
  let db = openLedger(ledgerPath);
  try {
    const reviewerId = 'astra';
    const ticket = {
      id: 'ticket',
      key: 'GAME-5',
      status: 'in_review',
      requirements_revision: 1,
      revision: 2,
    };
    const submission = { id: 'submission', actor_id: 'worker', requirements_revision: 1, evidence: [] };
    let clock = 100_000;
    let launches = 0;
    let recorded = 0;
    let failure: Error | null = new ReviewLaunchError(
      Object.assign(new Error('missing executable'), { code: 'ENOENT' }),
    );
    const log: Record<string, unknown>[] = [];
    const scan = () =>
      scanReviews({
        app: {
          async execute(_actor: string, operation: string) {
            if (operation === 'project_get')
              return {
                project: { policy: 'independent', reviewer_actor_id: reviewerId },
                members: [{ actor_id: reviewerId, kind: 'agent', role: 'verifier' }],
              };
            if (operation === 'ticket_list') return { tickets: [ticket] };
            if (operation === 'ticket_history') return { items: [submission] };
            if (operation === 'ticket_get') return { ticket };
            if (operation === 'ticket_review') {
              recorded++;
              ticket.status = 'done';
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        },
        db,
        projectId: 'project',
        reviewerId,
        now: () => clock,
        async review() {
          launches++;
          if (failure) throw failure;
          return { decision: 'approve', feedback: 'The complete receipt meets both criteria.' };
        },
        report(_event: string, fields: Record<string, unknown>) {
          log.push(fields);
        },
      });
    await scan();
    assert.equal(log.at(-1)?.retryAt, new Date(clock + 5_000).toISOString());
    db.close();
    db = openLedger(ledgerPath);
    await scan();
    assert.equal(launches, 1);
    clock += 5_000;
    await scan();
    clock += 10_000;
    await scan();
    clock += 60_000;
    await scan();
    assert.equal(launches, 3);
    assert.equal(recorded, 0);
    assert.equal(log.at(-1)?.code, 'ENOENT');
    assert.equal(log.at(-1)?.retryAt, null);

    submission.id = 'model-failed';
    failure = new Error('Reviewer started but exited unsuccessfully');
    await scan();
    clock += 60_000;
    await scan();
    assert.equal(launches, 4);

    failure = null;
    submission.id = 'already-approved';
    await scan();
    assert.equal(launches, 4);
    submission.id = 'legacy-failed';
    await scan();
    await scan();
    assert.equal(launches, 5);
    assert.equal(recorded, 1);

    ticket.status = 'in_review';
    submission.id = 'legacy-started';
    await scan();
    assert.equal(launches, 6);
    assert.equal(recorded, 2);

    ticket.status = 'in_review';
    submission.id = 'interrupted-final-attempt';
    db.prepare(
      "INSERT INTO review_dispatch (submission_id, state, attempts, lease_expires_at_ms) VALUES (?, 'started', 3, ?)",
    ).run(submission.id, clock);
    const receipts = log.length;
    await scan();
    await scan();
    assert.equal(launches, 6);
    assert.equal(log.length, receipts + 1);
    assert.equal(log.at(-1)?.code, 'REVIEW_INTERRUPTED');
    assert.equal(log.at(-1)?.retryAt, null);
  } finally {
    db.close();
    await rm(ledgerPath);
    await rmdir(directory);
  }
});
