import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createApplication } from '../application.js';
import {
  DomainError,
  type StorageAdapter,
  type SearchAdapter,
  type EmbeddingProvider,
  type Actor,
  type Project,
  type Ticket,
  type Policy,
  type GitHubEvidence,
} from '../contracts.js';

export const testEmbeddings: EmbeddingProvider = {
  profile: {
    id: createHash('sha256').update('contract-test-only').digest('hex').slice(0, 24),
    model: 'test-only',
    dimensions: 3,
  },
  async embed(text) {
    return [1, text.includes('database') ? 1 : 0.2, text.includes('security') ? 1 : 0.2];
  },
};
export interface ContractAdapters {
  storage: StorageAdapter;
  search: SearchAdapter;
  dispose?: () => Promise<void>;
}
export async function fixture(adapters: ContractAdapters, policy: Policy = 'independent') {
  const { storage, search } = adapters;
  const clock = { now: new Date() };
  const app = createApplication({ storage, search, embeddings: testEmbeddings, now: () => clock.now });
  const actor = (name: string, kind: Actor['kind'] = 'agent', system_admin = false): Actor => ({
    id: randomUUID(),
    issuer: 'contract-test',
    subject: randomUUID(),
    name,
    kind,
    system_admin,
  });
  const admin = actor('administrator', 'human', true),
    worker = actor('worker'),
    other = actor('other worker'),
    reviewer = actor('reviewer', 'human'),
    outsider = actor('outsider');
  await storage.transaction('catalog', async (tx) => {
    for (const person of [admin, worker, other, reviewer, outsider]) await tx.put('actors', person);
  });
  const createdProject = (await app.execute(admin.id, 'project_create', {
    key: 'T' + randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(),
    name: 'Contract test',
    policy,
    idempotency_key: randomUUID(),
  })) as Project;
  const project = (await storage.get('projects', createdProject.id))!;
  for (const [person, role] of [
    [worker, 'contributor'],
    [other, 'contributor'],
    [reviewer, 'verifier'],
  ] as const)
    await app.execute(admin.id, 'member_set', {
      project_id: project.id,
      actor_id: person.id,
      role,
      idempotency_key: randomUUID(),
    });
  const call = async (actorId: string, operation: any, input: Record<string, unknown> = {}) =>
    app.execute(actorId, operation, { project_id: project.id, idempotency_key: randomUUID(), ...input });
  const ticket = async (overrides: Record<string, unknown> = {}) => {
    const created = (
      (await call(worker.id, 'tickets_create', {
        tickets: [
          {
            title: 'Improve database security',
            description: 'Make the database secure.',
            criteria: ['The access check works.'],
            status: 'ready',
            ...overrides,
          },
        ],
      })) as { tickets: Ticket[] }
    ).tickets[0]!;
    return (await storage.get('tickets', created.id))!;
  };
  const read = async (id: string) =>
    app.execute(worker.id, 'ticket_get', { project_id: project.id, ticket_id: id }) as Promise<any>;
  const claim = async (id?: string, actorId = worker.id) =>
    call(actorId, 'work_claim', id ? { ticket_id: id } : {}) as Promise<any>;
  const submit = async (id: string, claimToken: string, actorId = worker.id) => {
    const current = await read(id);
    return call(actorId, 'ticket_submit', {
      ticket_id: id,
      claim_token: claimToken,
      expected_revision: current.ticket.revision,
      summary: 'Verified the implementation.',
      evidence: current.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Assertion passed.',
        references: ['https://example.test/evidence'],
      })),
    }) as Promise<any>;
  };
  return {
    app,
    storage,
    search,
    clock,
    admin,
    worker,
    other,
    reviewer,
    outsider,
    project,
    call,
    ticket,
    read,
    claim,
    submit,
  };
}
export function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}
/** Import this suite from another adapter package; no PostgreSQL types are exposed. */
export function registerAdapterContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  describe(`${name} adapter contract`, () => {
    const check = (title: string, work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) =>
      it(title, async () => {
        const adapters = await factory();
        try {
          await adapters.storage.migrate();
          await adapters.search.configure(testEmbeddings.profile);
          await work(await fixture(adapters));
        } finally {
          await adapters.dispose?.();
        }
      });
    check('rolls back all records when an atomic operation fails', async (f) => {
      const id = randomUUID();
      await assert.rejects(
        f.storage.transaction(f.project.id, async (tx) => {
          await tx.put('actors', { ...f.worker, id, subject: id });
          throw new Error('rollback');
        }),
      );
      assert.equal(await f.storage.get('actors', id), null);
    });
    check('keeps one read-only snapshot coherent without blocking mutations or other readers', async (f) => {
      const ticket = await f.ticket();
      let entered!: () => void;
      let advance!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        advance = resolve;
      });
      const reading = f.storage.readSnapshot(async (reader) => {
        assert.equal('put' in reader, false);
        assert.equal('remove' in reader, false);
        const before = await reader.get('tickets', ticket.id);
        entered();
        await resume;
        return [before, await reader.get('tickets', ticket.id)];
      });
      await Promise.race([
        ready,
        reading.then(() => {
          throw new Error('Snapshot ended before its first read.');
        }),
      ]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const concurrent = Promise.all([
        f.call(f.worker.id, 'ticket_update', {
          ticket_id: ticket.id,
          expected_revision: ticket.revision,
          priority: 1,
        }),
        f.storage.readSnapshot((reader) => reader.get('projects', f.project.id)),
      ]);
      let completed: boolean;
      try {
        completed = await Promise.race([
          concurrent.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 5000);
          }),
        ]);
      } finally {
        advance();
        clearTimeout(timeout);
      }
      const [before, after] = await reading;
      await concurrent;
      assert.equal(completed, true, 'Snapshot serialized a concurrent mutation or reader.');
      assert.deepEqual(after, before);
      assert.equal(after?.priority, ticket.priority);
      assert.equal((await f.storage.get('tickets', ticket.id))?.priority, 1);
      await assert.rejects(
        f.storage.readSnapshot(async () => {
          throw new Error('abort snapshot');
        }),
        /abort snapshot/,
      );
      assert.equal((await f.storage.readSnapshot((reader) => reader.get('tickets', ticket.id)))?.priority, 1);
    });
    check('grants exactly one concurrent claim', async (f) => {
      const ticket = await f.ticket();
      const attempts = await Promise.allSettled(
        Array.from({ length: 16 }, (_, i) => f.claim(ticket.id, i % 2 ? f.worker.id : f.other.id)),
      );
      assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
      const winner = attempts.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<any>;
      const observer = winner.value.claim.actor_id === f.worker.id ? f.other : f.worker;
      const context = (await f.app.execute(observer.id, 'ticket_context', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        detail: 'brief',
      })) as any;
      assert.equal(context.claim.actor_id, winner.value.claim.actor_id);
      assert.equal(context.claim.token, undefined);
    });
    check(
      'persists advisory execution hints with per-field inheritance and clears local overrides',
      async (f) => {
        const defaults = (await f.call(f.admin.id, 'project_update', {
          expected_revision: f.project.revision,
          execution_hints: { model: ' future/model ', effort: ' xhigh ' },
        })) as any;
        assert.equal(defaults.execution_hints, undefined);
        const ticket = await f.ticket({ execution_hints: { effort: ' high ' } });
        const first = await f.read(ticket.id);
        assert.deepEqual(first.effective_execution_hints, { model: 'future/model', effort: 'high' });
        const input = { project_id: f.project.id, ticket_id: ticket.id, idempotency_key: randomUUID() };
        const claimed = (await f.app.execute(f.worker.id, 'work_claim', input)) as any;
        assert.deepEqual(claimed.context.effective_execution_hints, first.effective_execution_hints);
        const updated = (await f.call(f.worker.id, 'ticket_update', {
          ticket_id: ticket.id,
          expected_revision: claimed.ticket.revision,
          execution_hints: { model: 'custom/model' },
        })) as any;
        assert.equal(updated.requirements_revision, ticket.requirements_revision);
        assert.equal(updated.execution_hints, undefined);
        assert.equal((await f.storage.get('claims', ticket.id))?.token, claimed.claim.token);
        assert.deepEqual((await f.read(ticket.id)).effective_execution_hints, {
          model: 'custom/model',
          effort: 'xhigh',
        });
        assert.deepEqual(await f.app.execute(f.worker.id, 'work_claim', input), claimed);
        const cleared = (await f.call(f.worker.id, 'ticket_update', {
          ticket_id: ticket.id,
          expected_revision: updated.revision,
          execution_hints: null,
        })) as any;
        assert.deepEqual((await f.read(ticket.id)).effective_execution_hints, {
          model: 'future/model',
          effort: 'xhigh',
        });
        const before = (await f.app.execute(f.worker.id, 'ticket_context', {
          project_id: f.project.id,
          ticket_id: ticket.id,
        })) as any;
        await f.call(f.admin.id, 'project_update', {
          expected_revision: defaults.revision,
          execution_hints: {},
        });
        const after = (await f.app.execute(f.worker.id, 'ticket_context', {
          project_id: f.project.id,
          ticket_id: ticket.id,
          if_none_match: before.fingerprint,
        })) as any;
        assert.equal(after.not_modified, false);
        assert.equal(after.effective_execution_hints, undefined);
        assert.equal((await f.read(ticket.id)).ticket.revision, cleared.revision);
        const list = (await f.app.execute(f.worker.id, 'ticket_list', { project_id: f.project.id })) as any;
        assert.equal(list.tickets[0].execution_hints, undefined);
      },
    );
    check('atomically distributes next work to concurrent agents', async (f) => {
      for (let i = 0; i < 16; i++) await f.ticket();
      const claims = await Promise.all(Array.from({ length: 16 }, () => f.claim()));
      assert.equal(new Set(claims.map((result) => result.ticket.id)).size, 16);
    });
    check('deduplicates retries and rejects changed inputs', async (f) => {
      const input = {
        tickets: [{ title: 'One ticket', description: 'One description', criteria: ['One criterion'] }],
        idempotency_key: randomUUID(),
      };
      const [a, b] = await Promise.all([
        f.call(f.worker.id, 'tickets_create', input),
        f.call(f.worker.id, 'tickets_create', input),
      ]);
      assert.deepEqual(a, b);
      await assert.rejects(
        f.call(f.worker.id, 'tickets_create', {
          ...input,
          tickets: [{ ...input.tickets[0], title: 'Different' }],
        }),
        hasCode('IDEMPOTENCY_CONFLICT'),
      );
    });
    check('rejects stale revisions and superseded lease tokens', async (f) => {
      const ticket = await f.ticket();
      const first = await f.claim(ticket.id);
      await assert.rejects(
        f.call(f.worker.id, 'ticket_update', {
          ticket_id: ticket.id,
          expected_revision: ticket.revision,
          title: 'Changed',
        }),
        hasCode('VERSION_CONFLICT'),
      );
      f.clock.now = new Date(f.clock.now.getTime() + 601000);
      const second = await f.claim(ticket.id, f.other.id);
      assert.notEqual(first.claim.token, second.claim.token);
      await assert.rejects(
        f.call(f.worker.id, 'ticket_checkpoint', {
          ticket_id: ticket.id,
          claim_token: first.claim.token,
          progress: 'stale',
        }),
        hasCode('CLAIM_EXPIRED'),
      );
    });
    check('orders durable events without gaps under concurrent writes', async (f) => {
      const ticket = await f.ticket();
      const initial = (await f.app.execute(f.worker.id, 'changes_since', {
        project_id: f.project.id,
      })) as any;
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          f.call(f.worker.id, 'ticket_note', { ticket_id: ticket.id, body: `note ${i}` }),
        ),
      );
      const result = (await f.app.execute(f.worker.id, 'changes_since', {
        project_id: f.project.id,
        cursor: initial.next_cursor,
      })) as any;
      assert.deepEqual(
        result.events.map((e: any) => e.seq),
        Array.from({ length: 12 }, (_, i) => initial.next_cursor + i + 1),
      );
    });
    check('indexes text independently and rejects stale index writes', async (f) => {
      const ticket = await f.ticket();
      const source = (await f.app.sourceDocument(f.storage, 'ticket', ticket.id))!;
      await f.search.indexText(source);
      if (f.search.capabilities?.semantic !== false)
        await f.search.indexVector(source, testEmbeddings.profile, [1, 1, 0.2]);
      assert.ok((await f.search.search(f.project.id, 'database', 10)).some((hit) => hit.id === ticket.id));
      await f.search.indexText({ ...source, revision: source.revision + 1, archived: true });
      await f.search.indexText(source);
      assert.equal((await f.search.search(f.project.id, 'database', 10)).length, 0);
    });
    check('reports index coverage and invalidates snapshots after indexing', async (f) => {
      const ticket = await f.ticket();
      const source = (await f.app.sourceDocument(f.storage, 'ticket', ticket.id))!;
      assert.equal((await f.search.coverage(f.project.id, testEmbeddings.profile)).documents, 0);
      await f.search.indexText(source);
      assert.equal((await f.search.coverage(f.project.id, testEmbeddings.profile)).documents, 1);
      if (f.search.capabilities?.semantic !== false)
        await f.search.indexVector(source, testEmbeddings.profile, [1, 1, 0.2]);
      const complete = await f.search.coverage(f.project.id, testEmbeddings.profile);
      assert.equal(complete.embedded, f.search.capabilities?.semantic === false ? 0 : 1);
      assert.ok(Date.parse(complete.observed_at));
      await f.search.indexText({ ...source, revision: source.revision + 1, archived: true });
      assert.equal((await f.search.coverage(f.project.id, testEmbeddings.profile)).documents, 0);
    });
    check('retains immutable GitHub evidence and its exact SHA/check metadata', async (f) => {
      const ticket = await f.ticket();
      const row: GitHubEvidence = {
        id: randomUUID(),
        project_id: f.project.id,
        ticket_id: ticket.id,
        actor_id: f.worker.id,
        repository: 'example/repository',
        pull_request_number: 1,
        head_sha: 'a'.repeat(40),
        observed_head_sha: 'a'.repeat(40),
        status: 'passed',
        requirements_revision: 1,
        ticket_revision: 1,
        checks: [
          {
            name: 'verify',
            required_app_id: 15368,
            run_id: 1,
            app_id: 15368,
            head_sha: 'a'.repeat(40),
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/example/repository/actions/runs/1',
          },
        ],
        observed_at: f.clock.now.toISOString(),
      };
      await f.storage.transaction(f.project.id, (tx) => tx.put('github_evidence', row));
      assert.deepEqual(await f.storage.readSnapshot((reader) => reader.get('github_evidence', row.id)), row);
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.put('github_evidence', { ...row, status: 'failed' })),
        hasCode('CONFLICT'),
      );
      await assert.rejects(
        f.storage.transaction(f.project.id, (tx) => tx.remove('github_evidence', row.id)),
        hasCode('IMMUTABLE_EVIDENCE'),
      );
      assert.deepEqual(await f.storage.get('github_evidence', row.id), row);
    });
    check('leases each indexing job once and fences stale job completions', async (f) => {
      const ticket = await f.ticket();
      const jobs = await f.storage.leaseJobs(1000, 60000);
      const job = jobs.find((item) => item.entity_id === ticket.id);
      assert.ok(job);
      assert.equal(
        (await f.storage.leaseJobs(1000, 60000)).some((item) => item.id === job.id),
        false,
      );
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        title: 'New title',
      });
      await f.storage.finishJob(job);
      assert.ok(await f.storage.get('jobs', job.id));
    });
  });
}
