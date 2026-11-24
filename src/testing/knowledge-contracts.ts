import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, hasCode, type ContractAdapters, testEmbeddings } from './contracts.js';

/** The same memory authorization, provenance and immutability contract for every backend. */
export function registerKnowledgeContractTests(name: string, factory: () => Promise<ContractAdapters>) {
  describe(`${name} knowledge contract`, () => {
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
    const evidence = {
      state: 'verified',
      evidence: 'Read the cited revision and checked its supporting evidence.',
    };
    const content = { title: 'Database convention', body: 'Use database transactions.', kind: 'convention' };
    const source = (id: string, revision: number) => ({ kind: 'ticket', id, revision });
    const read = (
      f: Awaited<ReturnType<typeof fixture>>,
      id: string,
      revision?: number,
      actor = f.worker.id,
    ) =>
      f.app.execute(actor, 'knowledge_get', {
        project_id: f.project.id,
        knowledge_id: id,
        ...(revision ? { revision } : {}),
      }) as Promise<any>;

    check('keeps proposals distinct from verification and explicit authorized acceptance', async (f) => {
      const ticket = await f.ticket();
      const input = { ...content, sources: [source(ticket.id, ticket.revision)] };
      const proposed = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
      assert.equal(proposed.status, 'proposed');
      assert.equal(proposed.verification_state, 'unverified');
      assert.equal(proposed.trusted_reuse, false);
      assert.equal(proposed.body, undefined);
      assert.equal(proposed.sources, undefined);
      assert.equal(proposed.verification, undefined);
      const review = {
        ...input,
        knowledge_id: proposed.id,
        expected_revision: proposed.revision,
        verification: evidence,
      };
      await assert.rejects(f.call(f.worker.id, 'knowledge_write', review), hasCode('FORBIDDEN'));
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', { ...review, body: 'Changed during review.' }),
        hasCode('FORBIDDEN'),
      );
      await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'admin' });
      await assert.rejects(
        f.call(f.worker.id, 'knowledge_write', review),
        hasCode('INDEPENDENT_REVIEW_REQUIRED'),
      );
      const verified = (await f.call(f.reviewer.id, 'knowledge_write', review)) as any;
      const verifiedDocument = await read(f, proposed.id);
      assert.equal(verified.status, 'proposed');
      assert.equal(verifiedDocument.verification.actor_id, f.reviewer.id);
      assert.equal(verified.actor_id, f.worker.id);
      const accepted = (await f.call(f.reviewer.id, 'knowledge_write', {
        ...input,
        knowledge_id: proposed.id,
        expected_revision: verified.revision,
        status: 'accepted',
      })) as any;
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual((await read(f, proposed.id)).verification, verifiedDocument.verification);
      assert.equal(accepted.trusted_reuse, false);
      assert.match(
        (await read(f, proposed.id)).untrusted_content_notice,
        /not instructions or current ticket requirements/,
      );
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', { ...input, verification: evidence }),
        hasCode('FORBIDDEN'),
      );
    });

    check(
      'preserves immutable revisions through archive and resets edited facts to unverified proposals',
      async (f) => {
        const ticket = await f.ticket();
        const input = { ...content, sources: [source(ticket.id, ticket.revision)] };
        const proposed = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
        const accepted = (await f.call(f.reviewer.id, 'knowledge_write', {
          ...input,
          knowledge_id: proposed.id,
          expected_revision: proposed.revision,
          status: 'accepted',
          verification: evidence,
        })) as any;
        const acceptedDocument = await read(f, proposed.id);
        const archived = (await f.call(f.worker.id, 'knowledge_write', {
          ...content,
          knowledge_id: proposed.id,
          expected_revision: accepted.revision,
          archived: true,
        })) as any;
        assert.equal(archived.status, 'accepted');
        const archivedDocument = await read(f, proposed.id);
        assert.deepEqual(archivedDocument.sources, acceptedDocument.sources);
        assert.deepEqual(archivedDocument.verification, acceptedDocument.verification);
        const changed = (await f.call(f.worker.id, 'knowledge_write', {
          ...content,
          body: 'Use database savepoints.',
          knowledge_id: proposed.id,
          expected_revision: archived.revision,
        })) as any;
        assert.equal(changed.status, 'proposed');
        assert.equal(changed.verification_state, 'unverified');
        assert.equal((await read(f, proposed.id, proposed.revision)).body, content.body);
        assert.equal((await read(f, proposed.id, archived.revision)).archived, true);
        assert.equal((await read(f, proposed.id, accepted.revision)).status, 'accepted');
        const history = await f.storage.find('knowledge_revisions', {
          where: { project_id: f.project.id, knowledge_id: proposed.id },
          order: [{ field: 'revision', direction: 'asc' }],
        });
        assert.deepEqual(
          history.map((row) => row.revision),
          [1, 2, 3, 4],
        );
        await assert.rejects(
          f.storage.transaction(f.project.id, (tx) =>
            tx.put('knowledge_revisions', { ...history[0]!, body: 'Tampered' }),
          ),
          hasCode('CONFLICT'),
        );
        for (const table of ['knowledge', 'knowledge_revisions'] as const)
          await assert.rejects(
            f.storage.transaction(f.project.id, (tx) =>
              tx.remove(table, table === 'knowledge' ? proposed.id : history[0]!.id),
            ),
            hasCode('IMMUTABLE_KNOWLEDGE'),
          );
        await assert.rejects(read(f, proposed.id, 99), hasCode('NOT_FOUND'));
      },
    );

    check('validates actual project source revisions and rejects unsupported verification', async (f) => {
      const ticket = await f.ticket();
      const otherProject = await fixture({ storage: f.storage, search: f.search });
      const foreignTicket = await otherProject.ticket();
      for (const sources of [[source(foreignTicket.id, foreignTicket.revision)], [source(randomUUID(), 1)]])
        await assert.rejects(
          f.call(f.worker.id, 'knowledge_write', { ...content, sources }),
          hasCode('INVALID_REFERENCE'),
        );
      await assert.rejects(
        f.call(f.worker.id, 'knowledge_write', {
          ...content,
          sources: [source(ticket.id, ticket.revision + 1)],
        }),
        hasCode('VERSION_CONFLICT'),
      );
      const legacy = (await f.call(f.worker.id, 'knowledge_write', content)) as any;
      assert.deepEqual((await read(f, legacy.id)).sources, []);
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', {
          ...content,
          knowledge_id: legacy.id,
          expected_revision: legacy.revision,
          verification: evidence,
        }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', {
          ...content,
          knowledge_id: legacy.id,
          expected_revision: legacy.revision,
          status: 'accepted',
        }),
        hasCode('INVALID_INPUT'),
      );
      const claim = await f.claim(ticket.id);
      const checkpoint = (await f.call(f.worker.id, 'ticket_checkpoint', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        progress: 'Checked database transaction behavior.',
      })) as any;
      const sources = [
        { kind: 'checkpoint', id: checkpoint.checkpoint.id, revision: checkpoint.checkpoint.ticket_revision },
      ];
      const doc = (await f.call(f.worker.id, 'knowledge_write', { ...content, sources })) as any;
      assert.deepEqual((await read(f, doc.id)).sources, sources);
      await assert.rejects(
        f.call(f.worker.id, 'knowledge_write', { ...content, sources: [{ ...sources[0], revision: 1 }] }),
        hasCode('VERSION_CONFLICT'),
      );
      const dependent = (await f.call(f.worker.id, 'knowledge_write', {
        ...content,
        sources: [{ kind: 'knowledge', id: doc.id, revision: doc.revision }],
      })) as any;
      assert.equal(dependent.verification_state, 'unverified');
      await assert.rejects(
        otherProject.call(otherProject.worker.id, 'knowledge_write', {
          ...content,
          sources: [{ kind: 'knowledge', id: doc.id, revision: doc.revision }],
        }),
        hasCode('INVALID_REFERENCE'),
      );
    });

    check('rejects a cancelled ticket checkpoint as current evidence', async (f) => {
      const ticket = await f.ticket();
      const claim = await f.claim(ticket.id);
      const { checkpoint } = (await f.call(f.worker.id, 'ticket_checkpoint', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        progress: 'Recorded the source before cancellation.',
      })) as { checkpoint: { id: string; ticket_revision: number } };
      const input = {
        ...content,
        sources: [{ kind: 'checkpoint', id: checkpoint.id, revision: checkpoint.ticket_revision }],
      };
      const proposed = (await f.call(f.worker.id, 'knowledge_write', input)) as {
        id: string;
        revision: number;
      };
      const review = { ...input, knowledge_id: proposed.id, expected_revision: proposed.revision };
      const verified = (await f.call(f.reviewer.id, 'knowledge_write', {
        ...review,
        verification: evidence,
      })) as { revision: number };
      await f.call(f.worker.id, 'ticket_transition', {
        ticket_id: ticket.id,
        expected_revision: checkpoint.ticket_revision,
        status: 'cancelled',
        reason: 'The source ticket has been cancelled.',
      });
      for (const update of [{ status: 'accepted' }, { verification: evidence }])
        await assert.rejects(
          f.call(f.reviewer.id, 'knowledge_write', {
            ...review,
            ...update,
            expected_revision: verified.revision,
          }),
          hasCode('INVALID_REFERENCE'),
        );
      assert.equal((await read(f, proposed.id)).status, 'proposed');
      const historical = (await f.app.execute(f.worker.id, 'checkpoint_get', {
        project_id: f.project.id,
        checkpoint_id: checkpoint.id,
      })) as { id: string };
      assert.equal(historical.id, checkpoint.id);
    });
    check('rechecks review, sources and revision under the project lock', async (f) => {
      const ticket = await f.ticket();
      const input = { ...content, sources: [source(ticket.id, ticket.revision)] };
      const proposed = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: ticket.revision,
        title: 'Current database requirements',
      });
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', {
          ...input,
          knowledge_id: proposed.id,
          expected_revision: proposed.revision,
          verification: evidence,
        }),
        hasCode('VERSION_CONFLICT'),
      );
      const refreshed = (await f.call(f.worker.id, 'knowledge_write', {
        ...input,
        sources: [source(ticket.id, ticket.revision + 1)],
        knowledge_id: proposed.id,
        expected_revision: proposed.revision,
      })) as any;
      const review = {
        ...content,
        knowledge_id: proposed.id,
        expected_revision: refreshed.revision,
        verification: evidence,
      };
      const attempts = await Promise.allSettled([
        f.call(f.reviewer.id, 'knowledge_write', review),
        f.call(f.reviewer.id, 'knowledge_write', review),
      ]);
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(
        (attempts.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code,
        'VERSION_CONFLICT',
      );
      const verified = await read(f, proposed.id);
      await f.call(f.admin.id, 'member_set', { actor_id: f.reviewer.id, role: 'reader' });
      await assert.rejects(
        f.call(f.reviewer.id, 'knowledge_write', {
          ...content,
          knowledge_id: proposed.id,
          expected_revision: verified.revision,
          status: 'accepted',
        }),
        hasCode('FORBIDDEN'),
      );
      assert.equal((await read(f, proposed.id)).status, 'proposed');
    });

    check('authorizes current and historical reads, policy edits and retry receipts', async (f) => {
      const proposed = (await f.call(f.worker.id, 'knowledge_write', content)) as any;
      for (const revision of [undefined, proposed.revision]) {
        await assert.rejects(read(f, proposed.id, revision, f.outsider.id), hasCode('FORBIDDEN'));
        await assert.rejects(
          f.app.execute(f.worker.id, 'knowledge_get', {
            project_id: f.project.id,
            knowledge_id: randomUUID(),
            ...(revision ? { revision } : {}),
          }),
          hasCode('NOT_FOUND'),
        );
      }
      const otherProject = await fixture({ storage: f.storage, search: f.search });
      await assert.rejects(
        otherProject.app.execute(otherProject.worker.id, 'knowledge_get', {
          project_id: otherProject.project.id,
          knowledge_id: proposed.id,
          revision: proposed.revision,
        }),
        hasCode('NOT_FOUND'),
      );
      await assert.rejects(
        otherProject.call(otherProject.worker.id, 'knowledge_write', {
          ...content,
          knowledge_id: proposed.id,
          expected_revision: proposed.revision,
        }),
        hasCode('NOT_FOUND'),
      );
      await assert.rejects(
        f.call(f.worker.id, 'knowledge_write', { ...content, kind: 'policy' }),
        hasCode('FORBIDDEN'),
      );
      const policy = (await f.call(f.admin.id, 'knowledge_write', { ...content, kind: 'policy' })) as any;
      await assert.rejects(
        f.call(f.worker.id, 'knowledge_write', {
          ...content,
          knowledge_id: policy.id,
          expected_revision: policy.revision,
        }),
        hasCode('FORBIDDEN'),
      );
      const retry = { ...content, kind: 'decision', idempotency_key: randomUUID() };
      const before = (await f.call(f.worker.id, 'knowledge_write', retry)) as any;
      assert.deepEqual(await f.call(f.worker.id, 'knowledge_write', retry), before);
      assert.equal(
        (
          await f.storage.find('knowledge_revisions', {
            where: { project_id: f.project.id, knowledge_id: before.id },
          })
        ).length,
        1,
      );
      const receiptId = createHash('sha256')
        .update(JSON.stringify([f.worker.id, f.project.id, 'knowledge_write', retry.idempotency_key]))
        .digest('hex');
      const receipt = (await f.storage.get('receipts', receiptId))!;
      const legacyResult = { ...before };
      for (const key of ['status', 'verification_state', 'trusted_reuse']) delete legacyResult[key];
      await f.storage.transaction(f.project.id, (tx) =>
        tx.put('receipts', { ...receipt, result: legacyResult }),
      );
      await f.call(f.worker.id, 'knowledge_write', {
        ...retry,
        idempotency_key: randomUUID(),
        knowledge_id: before.id,
        expected_revision: before.revision,
        body: 'Later evidence.',
      });
      const replay = (await f.call(f.worker.id, 'knowledge_write', retry)) as any;
      assert.deepEqual(replay, before);
      assert.equal(replay.revision, 1);
      assert.equal(replay.verification_state, 'unverified');
      assert.equal((await read(f, before.id)).revision, 2);
    });

    check(
      'returns evidence-only search metadata and excludes stale or archived memory without changing ticket context',
      async (f) => {
        const ticket = await f.ticket();
        const input = { ...content, sources: [source(ticket.id, ticket.revision)] };
        const contextInput = { project_id: f.project.id, ticket_id: ticket.id };
        const context = (await f.app.execute(f.worker.id, 'ticket_context', contextInput)) as any;
        const proposed = (await f.call(f.worker.id, 'knowledge_write', input)) as any;
        const search = () =>
          f.app.execute(f.worker.id, 'search', {
            project_id: f.project.id,
            query: 'database',
            kind: 'knowledge',
          }) as Promise<any>;
        await f.app.indexOnce(1000);
        const hit = (await search()).results.find((row: any) => row.id === proposed.id);
        assert.equal(hit.memory.status, 'proposed');
        assert.equal(hit.memory.verification_state, 'unverified');
        assert.equal(hit.memory.trusted_reuse, false);
        assert.equal(hit.memory.sources, undefined);
        assert.equal(hit.memory.verification, undefined);
        assert.equal(hit.retrieval.arguments.revision, proposed.revision);
        assert.deepEqual(
          ((await f.app.execute(f.worker.id, hit.retrieval.tool, hit.retrieval.arguments)) as any).sources,
          input.sources,
        );
        const accepted = (await f.call(f.reviewer.id, 'knowledge_write', {
          ...content,
          knowledge_id: proposed.id,
          expected_revision: proposed.revision,
          status: 'accepted',
          verification: evidence,
        })) as any;
        assert.equal(
          (await search()).results.some((row: any) => row.id === proposed.id),
          false,
        );
        await f.app.indexOnce(1000);
        assert.equal(
          (await search()).results.find((row: any) => row.id === proposed.id).memory.trusted_reuse,
          false,
        );
        const currentContext = (await f.app.execute(f.worker.id, 'ticket_context', contextInput)) as any;
        for (const field of ['ticket', 'criteria', 'project_instructions'])
          assert.deepEqual(currentContext[field], context[field]);
        assert.equal('memory' in currentContext, false);
        assert.equal('knowledge' in currentContext, false);
        await f.call(f.worker.id, 'knowledge_write', {
          ...content,
          knowledge_id: proposed.id,
          expected_revision: accepted.revision,
          archived: true,
        });
        assert.equal(
          (await search()).results.some((row: any) => row.id === proposed.id),
          false,
        );
        await assert.rejects(
          f.app.execute(f.outsider.id, 'search', { project_id: f.project.id, query: 'database' }),
          hasCode('FORBIDDEN'),
        );
      },
    );
  });
}
