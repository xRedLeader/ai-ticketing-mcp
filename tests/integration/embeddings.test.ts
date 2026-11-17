import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adapters } from './helpers.js';
import { fixture, testEmbeddings } from '../../src/testing/contracts.js';
import type { SearchDocument } from '../../src/contracts.js';
import { createApplication } from '../../src/application.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('skips provider calls for unchanged source text and preserves optional-adapter fallback', async () => {
  const a = adapters();
  try {
    await a.storage.migrate();
    await a.search.configure(testEmbeddings.profile);
    const f = await fixture(a);
    const ticket = await f.ticket();
    let calls = 0;
    const embeddings = {
      profile: testEmbeddings.profile,
      async embed(text: string) {
        calls++;
        return testEmbeddings.embed(text, 'document');
      },
    };
    const app = createApplication({ storage: a.storage, search: a.search, embeddings });
    await app.indexOnce(10000);
    const before = calls;
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      body: 'Metadata-only progress observation.',
    });
    await app.indexOnce(10000);
    assert.equal(calls, before);
    assert.ok(app.metrics.document_embedding_reuses > 0);
    const current = (await a.storage.get('tickets', ticket.id))!;
    await f.call(f.worker.id, 'ticket_update', {
      ticket_id: ticket.id,
      expected_revision: current.revision,
      description: 'A changed embedding input.',
    });
    await app.indexOnce(10000);
    assert.equal(calls, before + 1);
    await a.storage.pool.query('UPDATE search_vectors SET input_hash=NULL WHERE document_id=$1', [ticket.id]);
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      body: 'Process a pre-migration vector once.',
    });
    await app.indexOnce(10000);
    assert.equal(calls, before + 2);
    const fallback = createApplication({
      storage: a.storage,
      embeddings,
      search: {
        configure: a.search.configure.bind(a.search),
        indexText: a.search.indexText.bind(a.search),
        indexVector: a.search.indexVector.bind(a.search),
        search: a.search.search.bind(a.search),
        coverage: a.search.coverage.bind(a.search),
        health: a.search.health.bind(a.search),
        close: a.search.close.bind(a.search),
      },
    });
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      body: 'The original adapter contract remains usable.',
    });
    await fallback.indexOnce(10000);
    assert.equal(calls, before + 3);
  } finally {
    await a.dispose();
  }
});

it('promotes unchanged vectors, embeds legacy null hashes once, and invalidates coverage', async () => {
  const a = adapters();
  try {
    await a.storage.migrate();
    await a.search.configure(testEmbeddings.profile);
    const f = await fixture(a);
    const created = await f.ticket();
    const ticket = (await a.storage.get('tickets', created.id))!;
    const document: SearchDocument = {
      id: ticket.id,
      project_id: f.project.id,
      kind: 'ticket',
      revision: 1,
      title: ticket.title,
      text: ticket.description,
      archived: false,
    };
    const inputHash = hash(`${document.title}\n${document.text}`);
    await a.search.indexText(document);
    await a.search.indexVector(document, testEmbeddings.profile, [1, 0.2, 0.3]);
    const second = { ...document, revision: 2 };
    await a.search.indexText(second);
    assert.equal(await a.search.reuseVector(second, testEmbeddings.profile, inputHash), false);
    assert.equal((await a.search.coverage(f.project.id, testEmbeddings.profile)).embedded, 0);
    await a.search.indexVector(second, testEmbeddings.profile, [1, 0.2, 0.3], inputHash);
    const third = { ...document, revision: 3 };
    await a.search.indexText(third);
    assert.equal((await a.search.coverage(f.project.id, testEmbeddings.profile)).embedded, 0);
    assert.equal(await a.search.reuseVector(third, testEmbeddings.profile, inputHash), true);
    assert.equal((await a.search.coverage(f.project.id, testEmbeddings.profile)).embedded, 1);
    const row = (
      await a.storage.pool.query(
        'SELECT revision,input_hash,embedding::text FROM search_vectors WHERE document_id=$1 AND profile_id=$2',
        [document.id, testEmbeddings.profile.id],
      )
    ).rows[0];
    assert.equal(row.revision, 3);
    assert.equal(row.input_hash, inputHash);
    assert.equal(row.embedding, '[1,0.2,0.3]');
    const changed = { ...third, revision: 4, text: 'Changed document text' };
    await a.search.indexText(changed);
    assert.equal(
      await a.search.reuseVector(changed, testEmbeddings.profile, hash(`${changed.title}\n${changed.text}`)),
      false,
    );
    assert.equal((await a.search.coverage(f.project.id, testEmbeddings.profile)).embedded, 0);
    await assert.rejects(a.search.indexVector(changed, testEmbeddings.profile, [1, 0.2, 0.3], 'invalid'), {
      code: '23514',
    });
  } finally {
    await a.dispose();
  }
});

it('fences reversed vector completions and refuses archived or different-profile promotion', async () => {
  const a = adapters();
  try {
    await a.storage.migrate();
    await a.search.configure(testEmbeddings.profile);
    const otherProfile = {
      ...testEmbeddings.profile,
      id: hash('other-profile').slice(0, 24),
      model: 'other-profile',
    };
    await a.search.configure(otherProfile);
    const f = await fixture(a);
    const created = await f.ticket();
    const ticket = (await a.storage.get('tickets', created.id))!;
    const latest: SearchDocument = {
      id: ticket.id,
      project_id: f.project.id,
      kind: 'ticket',
      revision: 3,
      title: ticket.title,
      text: ticket.description,
      archived: false,
    };
    const inputHash = hash(`${latest.title}\n${latest.text}`);
    await a.search.indexText(latest);
    await a.search.indexVector(latest, testEmbeddings.profile, [1, 0.2, 0.3], inputHash);
    const stale = { ...latest, revision: 2 };
    await a.search.indexText(stale);
    assert.equal(await a.search.reuseVector(stale, testEmbeddings.profile, inputHash), false);
    await a.search.indexVector(stale, testEmbeddings.profile, [0.3, 0.2, 1], inputHash);
    assert.equal(await a.search.reuseVector(latest, otherProfile, inputHash), false);
    const archived = { ...latest, revision: 4, archived: true };
    await a.search.indexText(archived);
    assert.equal(await a.search.reuseVector(archived, testEmbeddings.profile, inputHash), false);
    assert.equal(await a.search.reuseVector(latest, testEmbeddings.profile, inputHash), false);
    await a.search.indexVector(latest, testEmbeddings.profile, [0.3, 0.2, 1], inputHash);
    const row = (
      await a.storage.pool.query(
        'SELECT revision,embedding::text FROM search_vectors WHERE document_id=$1 AND profile_id=$2',
        [latest.id, testEmbeddings.profile.id],
      )
    ).rows[0];
    assert.deepEqual(row, { revision: 3, embedding: '[1,0.2,0.3]' });
    assert.equal((await a.search.coverage(f.project.id, testEmbeddings.profile)).documents, 0);
    assert.deepEqual(
      await a.search.search(f.project.id, 'database', 10, {
        profile: testEmbeddings.profile,
        vector: [1, 0.2, 0.3],
      }),
      [],
    );
  } finally {
    await a.dispose();
  }
});

it('pages unanswered questions with exact blocking scope despite multiple answers', async () => {
  const a = adapters();
  try {
    await a.storage.migrate();
    await a.search.configure(testEmbeddings.profile);
    const f = await fixture(a);
    const ticket = await f.ticket();
    const ask = async (body: string, blocking: boolean) =>
      (
        (await f.call(f.worker.id, 'ticket_note', {
          ticket_id: ticket.id,
          kind: 'question',
          body,
          blocking,
        })) as any
      ).note;
    const answered = await ask('Answered question', false);
    for (let i = 0; i < 3; i++)
      await f.call(f.worker.id, 'ticket_note', {
        ticket_id: ticket.id,
        kind: 'answer',
        answer_to: answered.id,
        body: `Answer ${i}`,
      });
    const open = [
      await ask('First nonblocking question', false),
      await ask('Second nonblocking question', false),
    ];
    const blocking = await ask('Blocking question', true);
    const sorted = open.map((note) => note.id).sort();
    assert.deepEqual(
      (await a.storage.unansweredQuestions(f.project.id, ticket.id, false, 1, 0)).map((note) => note.id),
      sorted.slice(0, 1),
    );
    assert.deepEqual(
      (await a.storage.unansweredQuestions(f.project.id, ticket.id, false, 1, 1)).map((note) => note.id),
      sorted.slice(1),
    );
    assert.deepEqual(
      (await a.storage.unansweredQuestions(f.project.id, ticket.id, true, 10, 0)).map((note) => note.id),
      [blocking.id],
    );
    assert.deepEqual(await a.storage.unansweredQuestions(f.project.id, f.project.id, false, 10, 0), []);
    await a.storage.transaction(f.project.id, async (tx) => {
      assert.deepEqual(
        (await tx.unansweredQuestions(f.project.id, ticket.id, false, 10, 0)).map((note) => note.id),
        sorted,
      );
    });
    await assert.rejects(a.storage.unansweredQuestions(f.project.id, ticket.id, false, 0, 0), {
      code: 'INVALID_QUERY',
    });
    await assert.rejects(a.storage.unansweredQuestions(f.project.id, ticket.id, false, 10, -1), {
      code: 'INVALID_QUERY',
    });
  } finally {
    await a.dispose();
  }
});
