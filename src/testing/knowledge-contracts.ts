import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, hasCode, type ContractAdapters, testEmbeddings } from './contracts.js';
import { createApplication } from '../application.js';

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
    const source = (id: string, revision: number) => ({ kind: 'ticket' as const, id, revision });
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
    const acceptFact = async (
      f: Awaited<ReturnType<typeof fixture>>,
      input: Record<string, unknown> = {},
    ) => {
      const ticket = await f.ticket();
      const proposed = (await f.call(f.worker.id, 'knowledge_write', {
        ...content,
        fact: { key: 'database.transactions', value: 'required' },
        sources: [source(ticket.id, ticket.requirements_revision)],
        ...input,
      })) as any;
      const accepted = (await f.call(f.reviewer.id, 'knowledge_write', {
        ...content,
        ...input,
        knowledge_id: proposed.id,
        expected_revision: proposed.revision,
        status: 'accepted',
        verification: evidence,
      })) as any;
      return { ticket, accepted, document: await read(f, accepted.id) };
    };

    check('invalidates changed, missing and transitively stale evidence before reuse', async (f) => {
      const a = await acceptFact(f);
      assert.equal(a.document.trusted_reuse, true);
      assert.equal((await read(f, a.accepted.id, a.accepted.revision)).trusted_reuse, true);
      const b = await acceptFact(f, {
        fact: { key: 'database.savepoints', value: 'required' },
        sources: [{ kind: 'knowledge', id: a.accepted.id, revision: a.accepted.revision }],
      });
      assert.equal(b.document.trusted_reuse, true);
      await f.app.indexOnce(1000);
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: a.ticket.id,
        expected_revision: a.ticket.revision,
        description: 'Current changed requirement.',
      });
      for (const id of [a.accepted.id, b.accepted.id]) {
        const current = await read(f, id);
        assert.equal(current.validity, 'stale');
        assert.equal(current.trusted_reuse, false);
      }
      const results = (await f.app.execute(f.worker.id, 'search', {
        project_id: f.project.id,
        query: 'database',
        kind: 'knowledge',
      })) as any;
      assert.equal(
        results.results.some((hit: any) => [a.accepted.id, b.accepted.id].includes(hit.id)),
        false,
      );
      const missing = await acceptFact(f, { fact: { key: 'missing', value: 'source' } });
      await f.storage.transaction(f.project.id, async (tx) => {
        const stored = (await tx.get('knowledge', missing.accepted.id))!;
        await tx.put('knowledge', { ...stored, sources: [source(randomUUID(), 1)] });
      });
      assert.equal((await read(f, missing.accepted.id)).trusted_reuse, false);
    });

    check('retains expiry and supersession across application restart and immutable history', async (f) => {
      const expires_at = new Date(f.clock.now.getTime() + 1000).toISOString();
      const expiring = await acceptFact(f, { expires_at });
      assert.equal(expiring.document.trusted_reuse, true);
      const original = await acceptFact(f, { fact: { key: 'database.mode', value: 'old' } });
      const replacement = await acceptFact(f, {
        fact: { key: 'database.mode', value: 'new' },
        supersedes: [{ id: original.accepted.id, revision: original.accepted.revision }],
      });
      assert.equal(replacement.document.trusted_reuse, true);
      f.clock.now = new Date(f.clock.now.getTime() + 1000);
      const restarted = createApplication({ storage: f.storage, search: f.search, now: () => f.clock.now });
      const reread = (id: string) =>
        restarted.execute(f.worker.id, 'knowledge_get', {
          project_id: f.project.id,
          knowledge_id: id,
        }) as Promise<any>;
      assert.equal((await reread(expiring.accepted.id)).validity, 'expired');
      assert.equal((await reread(expiring.accepted.id)).expires_at, expires_at);
      assert.equal((await reread(original.accepted.id)).validity, 'superseded');
      await f.call(f.worker.id, 'knowledge_write', {
        ...content,
        knowledge_id: replacement.accepted.id,
        expected_revision: replacement.accepted.revision,
        archived: true,
      });
      assert.equal((await reread(original.accepted.id)).validity, 'superseded');
      assert.equal((await reread(original.accepted.id)).trusted_reuse, false);
      assert.deepEqual((await read(f, replacement.accepted.id, replacement.accepted.revision)).supersedes, [
        { id: original.accepted.id, revision: original.accepted.revision },
      ]);
    });

    check(
      'returns supported contradictions with both provenances and never silently chooses a winner',
      async (f) => {
        const a = await acceptFact(f);
        const b = await acceptFact(f, { fact: { key: 'database.transactions', value: 'forbidden' } });
        for (const [left, right] of [
          [a, b],
          [b, a],
        ]) {
          const document = await read(f, left!.accepted.id, left!.accepted.revision);
          assert.equal(document.validity, 'disputed');
          assert.equal(document.trusted_reuse, false);
          assert.deepEqual(document.contradictions, [
            {
              knowledge_id: right!.accepted.id,
              revision: right!.accepted.revision,
              fact: right!.document.fact,
              sources: right!.document.sources,
            },
          ]);
          assert.deepEqual(document.sources, left!.document.sources);
        }
        await f.app.indexOnce(1000);
        const search = (await f.app.execute(f.worker.id, 'search', {
          project_id: f.project.id,
          query: 'database',
          kind: 'knowledge',
        })) as any;
        for (const hit of search.results) {
          assert.equal(hit.memory.validity, 'disputed');
          assert.equal(hit.memory.contradiction_count, 1);
          assert.equal(hit.memory.trusted_reuse, false);
        }
        assert.equal(search.results.length, 2);
        await f.call(f.worker.id, 'ticket_transition', {
          ticket_id: b.ticket.id,
          expected_revision: b.ticket.revision,
          status: 'cancelled',
          reason: 'Source withdrawn.',
        });
        const remaining = await read(f, a.accepted.id);
        assert.equal(remaining.trusted_reuse, true);
        assert.deepEqual(remaining.contradictions, []);
      },
    );

    check(
      'hides archived support from search and enforces revoked access and current requirements',
      async (f) => {
        const a = await acceptFact(f);
        const b = await acceptFact(f, {
          fact: { key: 'dependent', value: 'database secret' },
          sources: [{ kind: 'knowledge', id: a.accepted.id, revision: a.accepted.revision }],
        });
        const c = await acceptFact(f, { fact: { key: 'dependent', value: 'public' } });
        assert.equal((await read(f, c.accepted.id)).validity, 'disputed');
        const contextInput = { project_id: f.project.id, ticket_id: a.ticket.id };
        const before = (await f.app.execute(f.worker.id, 'ticket_context', contextInput)) as any;
        await f.app.indexOnce(1000);
        await f.call(f.worker.id, 'knowledge_write', {
          ...content,
          knowledge_id: a.accepted.id,
          expected_revision: a.accepted.revision,
          archived: true,
        });
        assert.equal((await read(f, b.accepted.id)).trusted_reuse, false);
        const searchInput = { project_id: f.project.id, query: 'database', kind: 'knowledge' };
        const hits = ((await f.app.execute(f.worker.id, 'search', searchInput)) as any).results;
        assert.deepEqual(
          hits.map((hit: any) => hit.id),
          [c.accepted.id],
        );
        const publicFact = await read(f, c.accepted.id);
        assert.equal(publicFact.trusted_reuse, true);
        assert.deepEqual(publicFact.contradictions, []);
        assert.equal(JSON.stringify(publicFact).includes('database secret'), false);
        const after = (await f.app.execute(f.worker.id, 'ticket_context', contextInput)) as any;
        for (const field of ['ticket', 'criteria', 'project_instructions'])
          assert.deepEqual(after[field], before[field]);
        assert.equal('memory' in after, false);
        await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'none' });
        await assert.rejects(read(f, b.accepted.id), hasCode('FORBIDDEN'));
        await assert.rejects(read(f, a.accepted.id, a.accepted.revision), hasCode('FORBIDDEN'));
        await assert.rejects(f.app.execute(f.worker.id, 'search', searchInput), hasCode('FORBIDDEN'));
      },
    );

    check('rechecks revoked access after a delayed search provider returns candidates', async (f) => {
      const a = await acceptFact(f);
      await f.app.indexOnce(1000);
      const search = new Proxy(f.search, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'search')
            return async (...args: any[]) => {
              const candidates = await value.apply(target, args);
              await f.call(f.admin.id, 'member_set', { actor_id: f.worker.id, role: 'none' });
              return candidates;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const app = createApplication({ storage: f.storage, search, embeddings: testEmbeddings });
      await assert.rejects(
        app.execute(f.worker.id, 'search', {
          project_id: f.project.id,
          query: 'database',
          kind: 'knowledge',
        }),
        hasCode('FORBIDDEN'),
      );
      await assert.rejects(read(f, a.accepted.id), hasCode('FORBIDDEN'));
    });

    check('keeps ticket-only and empty searches free of memory scans and project write locks', async (f) => {
      await f.ticket();
      await f.app.indexOnce(1000);
      const storage = new Proxy(f.storage, {
        get(target, key) {
          if (key === 'transaction')
            return () => {
              throw new Error('Search acquired the project write lock.');
            };
          if (key === 'readSnapshot')
            return (work: any) =>
              target.readSnapshot((reader) =>
                work(
                  new Proxy(reader, {
                    get(source, field) {
                      const value = Reflect.get(source, field);
                      if (field === 'find')
                        return (table: string, ...args: any[]) => {
                          assert.notEqual(table, 'knowledge');
                          assert.notEqual(table, 'knowledge_revisions');
                          return value.call(source, table, ...args);
                        };
                      return typeof value === 'function' ? value.bind(source) : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const app = createApplication({ storage, search: f.search });
      const ticketOnly = (await app.execute(f.worker.id, 'search', {
        project_id: f.project.id,
        query: 'database',
        kind: 'ticket',
      })) as any;
      assert.equal(ticketOnly.results.length, 1);
      assert.deepEqual(
        (
          (await app.execute(f.worker.id, 'search', {
            project_id: f.project.id,
            query: 'no-such-symbol-abcdef',
          })) as any
        ).results,
        [],
      );
    });

    check(
      'validates supersession references and requires current reviewed replacement support',
      async (f) => {
        const original = await acceptFact(f);
        const other = await fixture({ storage: f.storage, search: f.search });
        const foreign = await acceptFact(other);
        for (const [target, code] of [
          [{ id: foreign.accepted.id, revision: foreign.accepted.revision }, 'INVALID_REFERENCE'],
          [{ id: original.accepted.id, revision: original.accepted.revision + 1 }, 'VERSION_CONFLICT'],
        ] as const)
          await assert.rejects(
            f.call(f.worker.id, 'knowledge_write', {
              ...content,
              fact: { key: 'replacement', value: 'yes' },
              supersedes: [target],
            }),
            hasCode(code),
          );
        await assert.rejects(
          f.call(f.worker.id, 'knowledge_write', {
            ...content,
            knowledge_id: original.accepted.id,
            expected_revision: original.accepted.revision,
            supersedes: [{ id: original.accepted.id, revision: original.accepted.revision }],
          }),
          hasCode('INVALID_REFERENCE'),
        );
        const proposal = (await f.call(f.worker.id, 'knowledge_write', {
          ...content,
          sources: original.document.sources,
          fact: { key: 'replacement', value: 'yes' },
          expires_at: new Date(f.clock.now.getTime() - 1000).toISOString(),
          supersedes: [{ id: original.accepted.id, revision: original.accepted.revision }],
        })) as any;
        assert.equal((await read(f, original.accepted.id)).trusted_reuse, true);
        await assert.rejects(
          f.call(f.reviewer.id, 'knowledge_write', {
            ...content,
            knowledge_id: proposal.id,
            expected_revision: proposal.revision,
            status: 'accepted',
            verification: evidence,
          }),
          hasCode('INVALID_REFERENCE'),
        );
        assert.equal((await read(f, original.accepted.id)).trusted_reuse, true);
        assert.equal((await read(f, proposal.id)).revision, proposal.revision);
      },
    );

    check('invalidates checkpoint-derived facts when the parent requirements change', async (f) => {
      const ticket = await f.ticket();
      const claim = await f.claim(ticket.id);
      const result = (await f.call(f.worker.id, 'ticket_checkpoint', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        progress: 'Checked current database requirements.',
      })) as any;
      const a = await acceptFact(f, {
        sources: [
          { kind: 'checkpoint', id: result.checkpoint.id, revision: result.checkpoint.ticket_revision },
        ],
      });
      assert.equal(a.document.trusted_reuse, true);
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: result.ticket.revision,
        criteria: ['New requirements must be verified.'],
      });
      assert.equal((await read(f, a.accepted.id)).validity, 'stale');
    });

    check(
      'requires evidence for every current ticket criterion even when supported memory matches',
      async (f) => {
        const a = await acceptFact(f);
        const claim = await f.claim(a.ticket.id);
        assert.equal((await read(f, a.accepted.id)).trusted_reuse, true);
        await assert.rejects(
          f.call(f.worker.id, 'ticket_submit', {
            ticket_id: a.ticket.id,
            claim_token: claim.claim.token,
            expected_revision: claim.ticket.revision,
            summary: 'A matching memory fact exists.',
            evidence: [
              {
                criterion_id: randomUUID(),
                result: 'pass',
                summary: 'Memory matches.',
                references: ['memory:matched'],
              },
            ],
          }),
          hasCode('EVIDENCE_INCOMPLETE'),
        );
        assert.equal((await f.read(a.ticket.id)).ticket.status, 'in_progress');
      },
    );

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
      await f.call(f.admin.id, 'member_set', { actor_id: f.other.id, role: 'verifier' });
      await f.call(f.admin.id, 'project_update', {
        expected_revision: f.project.revision,
        reviewer_actor_id: f.other.id,
      });
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
