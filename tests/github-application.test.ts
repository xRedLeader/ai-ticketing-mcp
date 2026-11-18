import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from '../src/application.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture, hasCode } from '../src/testing/contracts.js';
import type { GitHubObservation, GitHubProvider } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';

const configuration = {
  repository: 'xRedLeader/ai-ticketing-mcp',
  required_checks: ['verify'],
  check_app_id: 15368,
};
const head = 'a'.repeat(40),
  changed = 'b'.repeat(40);
const good = (sha = head): GitHubObservation => ({
  head_sha: sha,
  observed_head_sha: sha,
  status: 'passed',
  checks: [
    {
      name: 'verify',
      required_app_id: 15368,
      run_id: 100,
      app_id: 15368,
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/xRedLeader/ai-ticketing-mcp/actions/runs/100',
    },
  ],
});
async function withFixture(
  work: (
    f: Awaited<ReturnType<typeof fixture>>,
    provider: { inspect: GitHubProvider['inspect']; calls: number },
    app: ReturnType<typeof createApplication>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-github-test-'));
  const adapters = createSqliteAdapters(join(directory, 'tickets.sqlite'));
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const provider = {
      calls: 0,
      async inspect() {
        provider.calls++;
        return good();
      },
    };
    const app = createApplication({
      ...adapters,
      now: () => f.clock.now,
      github: { ...configuration, provider },
    });
    await work(f, provider, app);
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('ticketing-github-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

it('authorizes linking, preserves offline idempotent receipts, and retains independent review', async () =>
  withFixture(async (f, provider, app) => {
    const ticket = await f.ticket();
    const input = {
      project_id: f.project.id,
      ticket_id: ticket.id,
      pull_request_number: 1,
      idempotency_key: randomUUID(),
    };
    await assert.rejects(app.execute(f.outsider.id, 'ticket_github_refresh', input), hasCode('FORBIDDEN'));
    await assert.rejects(app.execute(f.reviewer.id, 'ticket_github_refresh', input), hasCode('FORBIDDEN'));
    assert.equal(provider.calls, 0);
    const first = (await app.execute(f.worker.id, 'ticket_github_refresh', input)) as any;
    assert.equal(first.github_evidence.checks, undefined);
    assert.equal(first.evidence_ref.tool, 'ticket_history');
    const exactEvidence = (await app.execute(
      f.worker.id,
      first.evidence_ref.tool,
      first.evidence_ref.arguments,
    )) as any;
    assert.equal(exactEvidence.items[0].id, first.github_evidence.id);
    assert.equal(exactEvidence.items[0].checks.length, 1);
    assert.equal(first.github_evidence.status, 'passed');
    assert.equal(first.ticket.status, 'ready');
    const claim = (await app.execute(f.worker.id, 'work_claim', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      idempotency_key: randomUUID(),
    })) as any;
    const details = (await app.execute(f.worker.id, 'ticket_get', {
      project_id: f.project.id,
      ticket_id: ticket.id,
    })) as any;
    assert.equal(details.github_evidence.id, first.github_evidence.id);
    const submitted = (await app.execute(f.worker.id, 'ticket_submit', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      idempotency_key: randomUUID(),
      expected_revision: claim.ticket.revision,
      claim_token: claim.claim.token,
      summary: 'Verified the criterion.',
      evidence: details.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Observed expected response.',
        references: ['https://example.test/evidence'],
      })),
    })) as any;
    assert.equal(submitted.ticket.status, 'in_review');
    await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
    await assert.rejects(
      app.execute(f.worker.id, 'ticket_review', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        submission_id: submitted.submission.id,
        expected_revision: submitted.ticket.revision,
        idempotency_key: randomUUID(),
        decision: 'approve',
        feedback: 'Self approval.',
      }),
      hasCode('INDEPENDENT_REVIEW_REQUIRED'),
    );
    const refreshed = (await app.execute(f.reviewer.id, 'ticket_github_refresh', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      idempotency_key: randomUUID(),
    })) as any;
    const approved = (await app.execute(f.reviewer.id, 'ticket_review', {
      project_id: f.project.id,
      ticket_id: ticket.id,
      submission_id: submitted.submission.id,
      expected_revision: refreshed.ticket.revision,
      idempotency_key: randomUUID(),
      decision: 'approve',
      feedback: 'Independent review of requirements and evidence.',
    })) as any;
    assert.equal(approved.ticket.status, 'done');
    const calls = provider.calls;
    const offline = createApplication({ storage: f.storage, search: f.search });
    assert.equal(
      serializeSuccessEnvelope(await offline.execute(f.worker.id, 'ticket_github_refresh', input)),
      serializeSuccessEnvelope(first),
    );
    await assert.rejects(
      offline.execute(f.worker.id, 'ticket_github_refresh', { ...input, pull_request_number: 2 }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.equal(provider.calls, calls);
    await f.storage.transaction(f.project.id, async (tx) =>
      tx.remove('members', `${f.project.id}:${f.worker.id}`),
    );
    await assert.rejects(offline.execute(f.worker.id, 'ticket_github_refresh', input), hasCode('FORBIDDEN'));
  }));

it('retains immutable SHA snapshots and marks superseded or changed-head evidence stale', async () =>
  withFixture(async (f, provider, app) => {
    const ticket = await f.ticket();
    const base = { project_id: f.project.id, ticket_id: ticket.id };
    const first = (await app.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      pull_request_number: 1,
      idempotency_key: randomUUID(),
    })) as any;
    provider.inspect = async () => good(changed);
    const next = (await app.execute(f.reviewer.id, 'ticket_github_refresh', {
      ...base,
      idempotency_key: randomUUID(),
    })) as any;
    assert.equal(next.github_evidence.head_sha, changed);
    const old = (await app.execute(f.worker.id, 'ticket_history', {
      ...base,
      kind: 'github',
      item_id: first.github_evidence.id,
    })) as any;
    assert.equal(old.items[0].stale, true);
    assert.equal(old.items[0].head_sha, head);
    assert.equal((await f.storage.get('github_evidence', first.github_evidence.id))?.status, 'passed');
    await assert.rejects(
      f.storage.transaction(f.project.id, async (tx) =>
        tx.put('github_evidence', (await tx.get('github_evidence', first.github_evidence.id))!),
      ),
      hasCode('CONFLICT'),
    );
    await assert.rejects(
      f.storage.transaction(f.project.id, async (tx) =>
        tx.remove('github_evidence', first.github_evidence.id),
      ),
      hasCode('IMMUTABLE_EVIDENCE'),
    );
    for (const [observation, status] of [
      [{ ...good(), observed_head_sha: changed }, 'stale'],
      [{ ...good(), checks: [] }, 'missing'],
      [{ ...good(), checks: [{ ...good().checks[0]!, app_id: 99 }] }, 'missing'],
      [{ ...good(), checks: [{ ...good().checks[0]!, status: 'in_progress', conclusion: null }] }, 'pending'],
      [{ ...good(), checks: [{ ...good().checks[0]!, conclusion: 'failure' }] }, 'failed'],
    ] as const) {
      provider.inspect = async () => observation as GitHubObservation;
      const result = (await app.execute(f.worker.id, 'ticket_github_refresh', {
        ...base,
        idempotency_key: randomUUID(),
      })) as any;
      assert.equal(result.github_evidence.status, status);
    }
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      body: JSON.stringify({ github_evidence: { status: 'passed', head_sha: changed } }),
    });
    const current = (await app.execute(f.worker.id, 'ticket_get', base)) as any;
    assert.equal(current.github_evidence.status, 'failed');
    const other = await f.ticket();
    const scoped = (await app.execute(f.worker.id, 'ticket_history', {
      ...base,
      ticket_id: other.id,
      kind: 'github',
      item_id: first.github_evidence.id,
    })) as any;
    assert.equal(scoped.items.length, 0);
  }));

it('does not hold the write lock during network work and rechecks requirements, binding, and access', async () =>
  withFixture(async (f, provider, app) => {
    const ticket = await f.ticket();
    const base = { project_id: f.project.id, ticket_id: ticket.id };
    let release!: () => void;
    let enter!: () => void;
    let ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.inspect = async () => {
      enter();
      await gate;
      return good();
    };
    const pending = app.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      pull_request_number: 1,
      idempotency_key: randomUUID(),
    });
    await ready;
    const note = (await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      body: 'Write while GitHub is pending.',
    })) as any;
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: note.ticket.revision,
      description: 'Changed requirements during remote work.',
    });
    release();
    await assert.rejects(pending, hasCode('VERSION_CONFLICT'));
    assert.equal((await f.storage.find('github_evidence', { where: { ticket_id: ticket.id } })).length, 0);
    provider.inspect = async () => good();
    await app.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      pull_request_number: 1,
      idempotency_key: randomUUID(),
    });
    ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.inspect = async () => {
      enter();
      await gate;
      return good();
    };
    const changedBinding = app.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      idempotency_key: randomUUID(),
    });
    await ready;
    const second = createApplication({
      storage: f.storage,
      search: f.search,
      github: { ...configuration, provider: { inspect: async () => good(changed) } },
    });
    await second.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      pull_request_number: 2,
      idempotency_key: randomUUID(),
    });
    release();
    await assert.rejects(changedBinding, hasCode('VERSION_CONFLICT'));
    ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoked = app.execute(f.reviewer.id, 'ticket_github_refresh', {
      ...base,
      idempotency_key: randomUUID(),
    });
    await ready;
    await f.storage.transaction(f.project.id, async (tx) =>
      tx.remove('members', `${f.project.id}:${f.reviewer.id}`),
    );
    release();
    await assert.rejects(revoked, hasCode('FORBIDDEN'));
    assert.equal((await f.storage.find('github_evidence', { where: { ticket_id: ticket.id } })).length, 2);
  }));

it('rejects an older overlapping observation when newer evidence for the same binding committed first', async () =>
  withFixture(async (f, provider, app) => {
    const ticket = await f.ticket();
    const base = { project_id: f.project.id, ticket_id: ticket.id };
    await app.execute(f.worker.id, 'ticket_github_refresh', {
      ...base,
      pull_request_number: 1,
      idempotency_key: randomUUID(),
    });
    let enter!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.inspect = async () => {
      enter();
      await gate;
      return { ...good(), checks: [{ ...good().checks[0]!, status: 'in_progress', conclusion: null }] };
    };
    const old = app.execute(f.worker.id, 'ticket_github_refresh', { ...base, idempotency_key: randomUUID() });
    await ready;
    const freshApp = createApplication({
      storage: f.storage,
      search: f.search,
      github: { ...configuration, provider: { inspect: async () => good() } },
    });
    const newest = (await freshApp.execute(f.reviewer.id, 'ticket_github_refresh', {
      ...base,
      idempotency_key: randomUUID(),
    })) as any;
    release();
    await assert.rejects(old, hasCode('VERSION_CONFLICT'));
    const current = (await app.execute(f.worker.id, 'ticket_get', base)) as any;
    assert.equal(current.github_evidence.id, newest.github_evidence.id);
    assert.equal(current.github_evidence.status, 'passed');
    assert.equal((await f.storage.find('github_evidence', { where: { ticket_id: ticket.id } })).length, 2);
  }));
