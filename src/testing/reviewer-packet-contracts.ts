import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication } from '../application.js';
import { createHttpServer } from '../http.js';
import { serializeSuccessEnvelope } from '../envelope.js';
import { countReferenceTokens } from '../tokens.js';
import { fixture, type ContractAdapters } from './contracts.js';

export function registerReviewerPacketContracts(name: string, factory: () => Promise<ContractAdapters>) {
  it(`${name} reviewer packets: delivers fresh evidence and executable omissions through an independent SDK client`, async () => {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const app = createApplication({ ...adapters, now: () => f.clock.now });
    const server = createHttpServer(app, {
      publicUrl: 'http://127.0.0.1',
      issuer: 'https://review-fixture.invalid',
      authenticate: async (authorization) => ({
        actorId: authorization === 'Bearer outsider' ? f.outsider.id : f.reviewer.id,
        scopes: new Set(['ticketing:read', 'ticketing:write']),
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const reviewer = new Client({ name: 'fresh-reviewer', version: '1' });
    const outsider = new Client({ name: 'outsider', version: '1' });
    const call = async (tool: string, args: Record<string, unknown>) => {
      const response = await reviewer.callTool({ name: tool, arguments: args });
      assert.equal((response.structuredContent as any).ok, true, JSON.stringify(response));
      assert.equal(
        (response.content[0] as { text: string }).text,
        serializeSuccessEnvelope((response.structuredContent as any).data),
      );
      return (response.structuredContent as any).data;
    };
    try {
      const ticket = await f.ticket({
        criteria: ['Permit the owner.', 'Reject outsiders.'],
        execution_hints: { model: 'worker-private-model' },
      });
      const claim = await f.claim(ticket.id);
      await f.call(f.worker.id, 'ticket_checkpoint', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        progress: 'WORKER_PRIVATE_CONTEXT '.repeat(500),
        decisions: ['Worker implementation choice.'],
      });
      const current = await f.read(ticket.id);
      const evidence = current.criteria.map((criterion: any) => ({
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'Observed exact owner and outsider response 0123456789. '.repeat(70).trim(),
        references: ['https://example.test/opaque-review-evidence'],
      }));
      const submitted = (await f.call(f.worker.id, 'ticket_submit', {
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        expected_revision: current.ticket.revision,
        summary: 'Worker reports success; review independently.',
        evidence,
      })) as any;
      await f.storage.transaction(f.project.id, async (tx) => {
        await tx.put('reviews', {
          id: randomUUID(),
          project_id: f.project.id,
          ticket_id: ticket.id,
          submission_id: submitted.submission.id,
          actor_id: f.reviewer.id,
          decision: 'request_changes',
          feedback: 'CONTRADICTING_REVIEW '.repeat(400),
          ticket_revision: submitted.ticket.revision - 1,
          created_at: f.clock.now.toISOString(),
        });
      });
      await f.call(f.worker.id, 'ticket_note', {
        ticket_id: ticket.id,
        kind: 'question',
        body: 'UNRESOLVED_EVIDENCE_QUESTION '.repeat(300),
      });
      await reviewer.connect(new StreamableHTTPClientTransport(new URL(`${base}?profile=reviewer`)));
      const args = { project_id: f.project.id, ticket_id: ticket.id, max_tokens: 1536 };
      const packet = await call('ticket_context', args);
      assert.deepEqual(packet.criteria, current.criteria);
      assert.equal(packet.ticket.requirements_revision, current.ticket.requirements_revision);
      assert.deepEqual(packet.review_blockers, []);
      assert.equal(packet.ticket.execution_hints, undefined);
      assert.equal(packet.latest_checkpoint, undefined);
      assert.equal(packet.effective_execution_hints, undefined);
      assert.ok(!JSON.stringify(packet).includes('WORKER_PRIVATE_CONTEXT'));
      assert.ok(countReferenceTokens(serializeSuccessEnvelope(packet)) <= args.max_tokens);
      for (const section of ['submissions', 'reviews', 'open_questions']) {
        const omission = packet.omitted.find((item: any) => item.section === section);
        assert.equal(omission?.required_before, 'review', section);
        const history = await call(omission.retrieve_with, omission.arguments);
        assert.ok(history.items.length);
        if (section === 'submissions') assert.deepEqual(history.items[0].evidence, evidence);
        if (section === 'reviews') assert.ok(history.items[0].feedback.includes('CONTRADICTING_REVIEW'));
        if (section === 'open_questions')
          assert.ok(history.items[0].body.includes('UNRESOLVED_EVIDENCE_QUESTION'));
      }
      const full = (await app.execute(f.reviewer.id, 'ticket_context', {
        ...args,
        detail: 'full',
        max_tokens: 32768,
      })) as any;
      assert.ok(full.latest_checkpoint.body.includes('WORKER_PRIVATE_CONTEXT'));
      assert.equal(full.effective_execution_hints.model, 'worker-private-model');
      assert.equal(full.review_blockers, undefined);
      const ownUnchanged = await call('ticket_context', { ...args, if_none_match: packet.fingerprint });
      assert.deepEqual(ownUnchanged, { fingerprint: packet.fingerprint, not_modified: true });
      assert.equal(
        (await call('ticket_context', { ...args, if_none_match: full.fingerprint })).not_modified,
        false,
      );
      await outsider.connect(
        new StreamableHTTPClientTransport(new URL(`${base}?profile=reviewer`), {
          requestInit: { headers: { Authorization: 'Bearer outsider' } },
        }),
      );
      const denied = await outsider.callTool({
        name: 'ticket_context',
        arguments: { ...args, if_none_match: packet.fingerprint },
      });
      assert.equal((denied.structuredContent as any).error.code, 'FORBIDDEN');
      const before = await f.read(ticket.id);
      await f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: before.ticket.revision,
        criteria: ['Replacement criterion.'],
      });
      const changed = await call('ticket_context', { ...args, if_none_match: packet.fingerprint });
      assert.equal(changed.not_modified, false);
      assert.notEqual(changed.criteria[0].id, packet.criteria[0].id);
      assert.ok(changed.review_blockers.some((item: any) => item.code === 'STALE_SUBMISSION'));
      await f.storage.transaction(f.project.id, async (tx) =>
        tx.remove('members', `${f.project.id}:${f.reviewer.id}`),
      );
      const revoked = await reviewer.callTool({
        name: 'ticket_context',
        arguments: { ...args, if_none_match: changed.fingerprint },
      });
      assert.equal((revoked.structuredContent as any).error.code, 'FORBIDDEN');
    } finally {
      await reviewer.close();
      await outsider.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await adapters.dispose?.();
    }
  });
}
