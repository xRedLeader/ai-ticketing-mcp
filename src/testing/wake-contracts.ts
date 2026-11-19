import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../application.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';
import type { Event, WakeDecision } from '../contracts.js';

export function registerWakeContractTests(
  name: string,
  factory: () => Promise<ContractAdapters & { reopen: () => Promise<ContractAdapters> }>,
) {
  const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} wakes: ${title}`, async () => {
      const f = await setup();
      try {
        await work(f);
      } finally {
        await f.dispose?.();
      }
    });
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const target = await f.ticket();
    const register = (extra = {}) =>
      f.app.registerWakeCondition(f.admin.id, f.project.id, {
        ticket_id: target.id,
        condition: { kind: 'events', types: ['ticket.note_added'] },
        ...extra,
      });
    const evaluate = (input = {}) => f.app.evaluateWakeConditions(f.admin.id, f.project.id, input);
    const get = () => f.app.getWakeCondition(f.admin.id, f.project.id, target.id);
    const claimWake = (expected_generation = 0) =>
      f.app.claimWakeDecision(f.admin.id, f.project.id, { ticket_id: target.id, expected_generation });
    const finish = (decision: WakeDecision) =>
      f.app.finishWakeDecision(f.admin.id, f.project.id, {
        ticket_id: target.id,
        generation: decision.generation,
        token: decision.token,
      });
    const note = (ticket_id = target.id) =>
      f.call(f.worker.id, 'ticket_note', {
        ticket_id,
        body: 'Private ticket content must not enter wake payloads.',
      });
    const append = (type: string, data = {}, entity_id = target.id) =>
      f.storage.transaction(f.project.id, async (tx) => {
        const project = (await tx.get('projects', f.project.id))!;
        project.event_seq++;
        await tx.put('projects', project);
        const event: Event = {
          id: `${project.id}:${project.event_seq}`,
          project_id: project.id,
          seq: project.event_seq,
          actor_id: f.worker.id,
          entity_id,
          type,
          data,
          created_at: f.clock.now.toISOString(),
        };
        await tx.put('events', event);
        return event;
      });
    const drain = async () => {
      for (let pass = 0; pass < 100; pass++) {
        await evaluate({ event_limit: 2 });
        if ((await get()).cursor === (await f.storage.get('projects', f.project.id))!.event_seq) return;
      }
      assert.fail('Wake cursor did not catch up.');
    };
    return { ...f, ...adapters, target, register, evaluate, get, claimWake, finish, note, append, drain };
  }
  check(
    'requires explicit authorized registration and ignores unrelated changes and heartbeats',
    async (f) => {
      assert.equal((await f.evaluate()).evaluated, 0);
      await f.note();
      assert.equal((await f.evaluate()).evaluated, 0);
      await assert.rejects(
        f.app.registerWakeCondition(f.worker.id, f.project.id, {
          ticket_id: f.target.id,
          condition: { kind: 'events', types: ['ticket.note_added'] },
        }),
        hasCode('FORBIDDEN'),
      );
      await assert.rejects(
        f.register({ condition: { kind: 'events', types: ['work.heartbeat'] } }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(
        f.register({ condition: { kind: 'continuation', continuation_id: randomUUID() } }),
        hasCode('INVALID_REFERENCE'),
      );
      const foreign = await fixture({ storage: f.storage, search: f.search });
      await assert.rejects(f.register({ ticket_id: (await foreign.ticket()).id }), hasCode('NOT_FOUND'));
      const registration = await f.register();
      assert.deepEqual(await f.register(), registration);
      const unrelated = await f.ticket();
      await f.note(unrelated.id);
      const claim = await f.claim(f.target.id);
      const before = (await f.storage.get('projects', f.project.id))!.event_seq;
      for (let index = 0; index < 3; index++)
        await f.call(f.worker.id, 'work_heartbeat', {
          ticket_id: f.target.id,
          claim_token: claim.claim.token,
        });
      assert.equal((await f.storage.get('projects', f.project.id))!.event_seq, before);
      await f.append('work.heartbeat');
      await f.drain();
      assert.deepEqual((await f.get()).pending, []);
      assert.equal(await f.claimWake(), null);
      await assert.rejects(
        f.app.getWakeCondition(f.outsider.id, f.project.id, f.target.id),
        hasCode('FORBIDDEN'),
      );
      await assert.rejects(
        f.app.claimWakeDecision(f.worker.id, f.project.id, {
          ticket_id: f.target.id,
          expected_generation: 0,
        }),
        hasCode('FORBIDDEN'),
      );
    },
  );
  check(
    'coalesces paged bursts, suppresses duplicates and fences active generations while retaining new reasons',
    async (f) => {
      await f.register();
      for (let index = 0; index < 5; index++) await f.note();
      const latest = async () =>
        (
          await f.storage.find('events', {
            where: { project_id: f.project.id, type: 'ticket.note_added' },
            order: [{ field: 'seq', direction: 'desc' }],
            limit: 1,
          })
        )[0]!;
      const event = await latest();
      await f.append(event.type, event.data);
      await f.append(event.type, event.data);
      assert.equal((await f.evaluate({ event_limit: 2 })).events, 2);
      assert.equal(await f.claimWake(), null);
      await f.drain();
      const pending = (await f.get()).pending;
      await Promise.all([f.evaluate(), f.evaluate()]);
      assert.deepEqual((await f.get()).pending, pending);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.kind === 'event' && pending[0]!.count, 5);
      assert.equal(JSON.stringify(pending).includes('Private'), false);
      const attempts = await Promise.allSettled([f.claimWake(), f.claimWake()]);
      const decisions = attempts
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter(Boolean);
      assert.equal(decisions.length, 1);
      assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
      const first = decisions[0]!;
      assert.equal(first.generation, 1);
      await f.note();
      await f.drain();
      assert.equal(await f.claimWake(1), null);
      assert.equal((await f.get()).pending.length, 1);
      assert.equal(await f.finish({ ...first, token: randomUUID() }), false);
      assert.equal(await f.finish(first), true);
      assert.equal(await f.finish(first), true);
      await f.drain();
      const second = (await f.claimWake(1))!;
      assert.equal(second.generation, 2);
      assert.equal(await f.finish(first), false);
      assert.equal(await f.finish(second), true);
      await f.drain();
      const duplicate = await latest();
      await f.append(duplicate.type, duplicate.data);
      await f.drain();
      assert.equal(await f.claimWake(2), null);
      const audit = await f.storage.find('events', {
        where: { project_id: f.project.id, type: 'wake.claimed' },
      });
      assert.equal(audit.length, 2);
      assert.equal(JSON.stringify(audit).includes(first.token), false);
    },
  );
  for (const exit_code of [0, 1])
    check(
      `recovers ${exit_code ? 'failure' : 'satisfaction'} and missed deadline through restart and bounded unrelated backlog`,
      async (f) => {
        const app = createApplication({
          storage: f.storage,
          search: f.search,
          now: () => f.clock.now,
          executionRecipes: [{ id: 'validation', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
        });
        const claim = await f.claim(f.target.id);
        const receipt = (await app.execute(f.worker.id, 'run_submit', {
          project_id: f.project.id,
          ticket_id: f.target.id,
          claim_token: claim.claim.token,
          recipe_id: 'validation',
          idempotency_key: randomUUID(),
          checkpoint: { progress: 'Waiting for validation.' },
          completion_condition: { kind: 'exit_code', exit_code: 0 },
        })) as any;
        const deadline = new Date(f.clock.now.getTime() + 1000).toISOString();
        await f.register({
          condition: { kind: 'continuation', continuation_id: receipt.continuation_id },
          deadline,
        });
        for (let index = 0; index < 9; index++)
          await f.append('ticket.updated', { revision: index }, randomUUID());
        const reserved = (await app.reserveExecutionRun(f.admin.id, f.project.id, receipt.run_id, 60_000))!;
        await app.startExecutionRun(
          f.admin.id,
          f.project.id,
          reserved.id,
          reserved.reservation_token!,
          60_000,
        );
        const outcome = { exit_code, signal: null, artifacts: ['private-result-content'], error_code: null };
        for (let index = 0; index < 2; index++)
          assert.equal(
            await app.settleExecutionRun(
              f.admin.id,
              f.project.id,
              reserved.id,
              reserved.reservation_token!,
              outcome,
            ),
            true,
          );
        assert.equal(
          (await f.storage.find('events', { where: { project_id: f.project.id, type: 'run.settled' } }))
            .length,
          1,
        );
        f.clock.now = new Date(f.clock.now.getTime() + 2000);
        const reopened = await f.reopen();
        const fresh = createApplication({ ...reopened, now: () => f.clock.now });
        const get = () => fresh.getWakeCondition(f.admin.id, f.project.id, f.target.id);
        assert.equal(
          (await fresh.evaluateWakeConditions(f.admin.id, f.project.id, { event_limit: 2 })).events,
          2,
        );
        assert.equal((await get()).pending.length, 2);
        assert.equal(
          await fresh.claimWakeDecision(f.admin.id, f.project.id, {
            ticket_id: f.target.id,
            expected_generation: 0,
          }),
          null,
        );
        for (
          let index = 0;
          index < 10 &&
          (await get()).cursor !== (await reopened.storage.get('projects', f.project.id))!.event_seq;
          index++
        )
          await fresh.evaluateWakeConditions(f.admin.id, f.project.id, { event_limit: 2 });
        const decision = (await fresh.claimWakeDecision(f.admin.id, f.project.id, {
          ticket_id: f.target.id,
          expected_generation: 0,
        }))!;
        assert.deepEqual(decision.reasons.map((reason) => reason.kind).sort(), ['continuation', 'deadline']);
        const terminal = decision.reasons.find((reason) => reason.kind === 'continuation')!;
        assert.equal(terminal.kind === 'continuation' && terminal.status, exit_code ? 'failed' : 'satisfied');
        assert.equal(JSON.stringify(decision).includes('private-result-content'), false);
        const again = await f.reopen();
        const reconnected = createApplication({ ...again, now: () => f.clock.now });
        assert.deepEqual(
          (await reconnected.getWakeCondition(f.admin.id, f.project.id, f.target.id)).active,
          decision,
        );
        assert.equal(
          await reconnected.claimWakeDecision(f.admin.id, f.project.id, {
            ticket_id: f.target.id,
            expected_generation: 1,
          }),
          null,
        );
        assert.equal(
          await reconnected.finishWakeDecision(f.admin.id, f.project.id, {
            ticket_id: f.target.id,
            generation: 1,
            token: decision.token,
          }),
          true,
        );
        await reconnected.evaluateWakeConditions(f.admin.id, f.project.id);
        assert.equal(
          await reconnected.claimWakeDecision(f.admin.id, f.project.id, {
            ticket_id: f.target.id,
            expected_generation: 1,
          }),
          null,
        );
      },
    );
  check('preserves pending signals on rearm and enforces exact monotonic revisions', async (f) => {
    const registration = await f.register({ deadline: f.clock.now.toISOString() });
    await assert.rejects(f.register({ expected_revision: registration.revision }), hasCode('WAKE_PENDING'));
    await f.drain();
    const first = (await f.claimWake())!;
    await assert.rejects(
      f.register({ expected_revision: (await f.get()).revision }),
      hasCode('WAKE_PENDING'),
    );
    await f.finish(first);
    await f.drain();
    const drained = await f.get();
    const rearmed = await f.register({ expected_revision: drained.revision });
    assert.equal(rearmed.generation, 1);
    assert.ok(rearmed.revision > drained.revision);
    await assert.rejects(f.register({ expected_revision: drained.revision }), hasCode('VERSION_CONFLICT'));
    await f.note();
    await assert.rejects(f.register({ expected_revision: rearmed.revision }), hasCode('WAKE_PENDING'));
    await f.drain();
    assert.equal((await f.get()).pending.length, 1);
  });
  check('bounds registration pages and refuses to advance across missing durable events', async (f) => {
    await f.register();
    const other = await f.ticket();
    await f.app.registerWakeCondition(f.admin.id, f.project.id, {
      ticket_id: other.id,
      condition: { kind: 'events', types: ['ticket.note_added'] },
    });
    const page = await f.evaluate({ limit: 1, event_limit: 1 });
    assert.equal(page.evaluated, 1);
    assert.equal(page.has_more, true);
    assert.equal((await f.evaluate({ limit: 1, after: page.next_cursor! })).has_more, false);
    await f.drain();
    const before = await f.get();
    const missing = await f.append('ticket.note_added', { note_id: randomUUID() });
    await f.storage.transaction(f.project.id, (tx) => tx.remove('events', missing.id));
    await assert.rejects(f.evaluate(), hasCode('EVENT_GAP'));
    assert.equal((await f.get()).cursor, before.cursor);
    assert.deepEqual((await f.get()).pending, before.pending);
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) => tx.remove('wake_conditions', f.target.id)),
      hasCode('IMMUTABLE_WAKE'),
    );
  });
}
