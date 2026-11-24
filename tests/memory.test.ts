import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectMemory } from '../src/memory.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { fixture } from '../src/testing/contracts.js';
import type { Knowledge, Reader } from '../src/contracts.js';

it('visits shared ancestors once across distinct branches and retains their contradiction provenance', async () => {
  const now = new Date().toISOString();
  const ticketSource = { kind: 'ticket' as const, id: 'ticket', revision: 1 };
  const documents: Knowledge[] = [];
  let sourceReads = 0;
  for (let index = 0; index < 40; index++) {
    const sources: Knowledge['sources'] =
      index < 2
        ? [ticketSource]
        : documents.slice(-2).map((item) => ({
            kind: 'knowledge',
            id: item.id,
            revision: item.revision,
          }));
    documents.push({
      id: `fact-${index}`,
      project_id: 'project',
      title: 'Database fact',
      body: 'Supported fact.',
      kind: 'decision',
      fact: { key: index < 2 ? 'database.mode' : `derived-${index}`, value: index === 1 ? 'no' : 'yes' },
      get sources() {
        assert.ok(++sourceReads <= 40 * 4, 'Shared ancestors were repeatedly traversed.');
        return sources;
      },
      status: 'accepted',
      verification: {
        state: 'verified',
        actor_id: 'reviewer',
        verified_at: now,
        evidence: 'Checked sources.',
      },
      expires_at: null,
      supersedes: [],
      revision: 1,
      archived: false,
      actor_id: 'author',
      updated_at: now,
    });
  }
  const reader = {
    async find(table: string) {
      return table === 'knowledge' ? documents : [];
    },
    async get() {
      return { id: 'ticket', project_id: 'project', requirements_revision: 1, status: 'ready' };
    },
  } as unknown as Reader;
  const inspect = await inspectMemory(reader, 'project', now);
  const result = await inspect(documents.at(-1)!);
  assert.equal(result.validity, 'disputed');
  assert.equal(result.trusted_reuse, false);
  assert.deepEqual(
    result.contradictions.sort((a, b) => a.knowledge_id.localeCompare(b.knowledge_id)),
    documents
      .slice(0, 2)
      .map((item) => ({ knowledge_id: item.id, revision: 1, fact: item.fact, sources: [ticketSource] })),
  );
});

for (const overflow of ['knowledge', 'knowledge_revisions'])
  it(`fails closed when ${overflow} exceeds the bounded validity scan`, async () => {
    const calls: string[] = [];
    const reader = {
      async find(table: string, query: { limit: number }) {
        calls.push(table);
        assert.equal(query.limit, 1001);
        return table === overflow ? Array(1001).fill({}) : [];
      },
    } as unknown as Reader;
    const inspect = await inspectMemory(reader, 'project', new Date().toISOString());
    assert.deepEqual(await inspect({} as Knowledge), {
      validity: 'unavailable',
      trusted_reuse: false,
      contradictions: [],
    });
    assert.deepEqual(calls, ['knowledge', 'knowledge_revisions']);
  });

it('persists expiry and supersession through SQLite close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-memory-'));
  const filename = join(directory, 'store.sqlite');
  let adapters = createSqliteAdapters(filename);
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    f.clock.now = new Date('2026-11-19T12:00:00.000Z');
    const ticket = await f.ticket();
    const write = async (key: string, value: string, extra: Record<string, unknown> = {}) => {
      const input = {
        title: 'Database fact',
        body: value,
        kind: 'decision',
        fact: { key, value },
        sources: [{ kind: 'ticket', id: ticket.id, revision: ticket.requirements_revision }],
        ...extra,
      };
      const proposal = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
      return (await f.call(f.reviewer.id, 'knowledge_write', {
        ...input,
        knowledge_id: proposal.id,
        expected_revision: proposal.revision,
        status: 'accepted',
        verification: { state: 'verified', evidence: 'Read the source and checked the fact.' },
      })) as any;
    };
    const expiring = await write('expiring', 'yes', { expires_at: '2026-11-19T12:00:01Z' });
    const old = await write('database.mode', 'old');
    const replacement = await write('database.mode', 'new', {
      supersedes: [{ id: old.id, revision: old.revision }],
    });
    await adapters.search.close();
    await adapters.storage.close();
    adapters = createSqliteAdapters(filename);
    await adapters.storage.migrate();
    const app = createApplication({ ...adapters, now: () => new Date('2026-11-19T12:00:01.000Z') });
    const read = (id: string) =>
      app.execute(f.worker.id, 'knowledge_get', {
        project_id: f.project.id,
        knowledge_id: id,
      }) as Promise<any>;
    assert.equal((await read(expiring.id)).validity, 'expired');
    assert.equal((await read(old.id)).validity, 'superseded');
    assert.equal((await read(replacement.id)).trusted_reuse, true);
    assert.deepEqual((await read(replacement.id)).supersedes, [{ id: old.id, revision: old.revision }]);
  } finally {
    await adapters.search.close();
    await adapters.storage.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-memory-'));
    await rm(directory, { recursive: true });
  }
});
