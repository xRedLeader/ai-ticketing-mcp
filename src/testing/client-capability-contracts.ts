import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createApplication } from '../application.js';
import { loadClientCapabilities } from '../client-capabilities.js';
import { HostCapacity } from '../host-capacity.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export function registerClientCapabilityContracts(name: string, factory: () => Promise<ContractAdapters>) {
  const check = (title: string, work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) =>
    it(`${name} capabilities: ${title}`, async () => {
      const f = await setup();
      try {
        await work(f);
      } finally {
        f.capacity.close();
        if (f.dispose) await f.dispose();
        else {
          await f.storage.close();
          await f.search.close();
        }
        await rm(f.directory, { recursive: true, force: true });
      }
    });
  async function setup() {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters),
      directory = await mkdtemp(join(tmpdir(), 'ticketing-client-'));
    const file = join(directory, 'clients.json');
    const config = {
      clients: ['zeta', 'alpha'].map((id) => ({
        id,
        actor_ids: [f.worker.id, f.other.id, f.outsider.id],
        project_ids: [f.project.id],
        operating_system: 'linux',
        tools: ['node', 'git'],
        environments: ['local'],
        models: [{ id: 'model-a', efforts: ['low', 'high'] }],
        expires_at: new Date(f.clock.now.getTime() + 600000).toISOString(),
      })),
    };
    const update = async () => {
      await writeFile(`${file}.next`, JSON.stringify(config));
      await rename(`${file}.next`, file);
    };
    await update();
    const clients = loadClientCapabilities(file),
      app = createApplication({ ...adapters, now: () => f.clock.now, clientCapabilities: clients });
    const capacity = new HostCapacity(join(directory, 'host.sqlite'), clients);
    capacity.configureHost('host', { agent_slots: 1 });
    const claim = (ticket: string, changes = {}, actor = f.worker.id) =>
      app.execute(actor, 'work_claim', {
        project_id: f.project.id,
        ticket_id: ticket,
        idempotency_key: randomUUID(),
        include_context: false,
        ...changes,
      }) as Promise<any>;
    const queue = (ticket: any, receipt: any, id: string, changes: Record<string, unknown> = {}) => {
      capacity.createRun({
        run_id: id,
        project_id: f.project.id,
        work: [{ ticket_id: ticket.id, requirements_revision: ticket.requirements_revision }],
        limits: { max_attempts: 2, max_provider_tokens: 1000, max_runtime_ms: 10000 },
      });
      return capacity.enqueue('host', {
        queue_id: id,
        run_id: id,
        kind: 'agent',
        created_at: Date.now(),
        execution: receipt.claim.execution,
        admission: {
          attempt_id: id,
          ticket_id: ticket.id,
          requirements_revision: ticket.requirements_revision,
          actor_id: receipt.claim.actor_id,
          role: 'worker',
          provider: 'fixture',
          model: receipt.claim.execution.model,
          allowance: { provider_tokens: 100, runtime_ms: 1000, cost_usd_micros: null },
        },
        ...changes,
      });
    };
    return { ...f, ...adapters, app, clients, config, update, file, directory, capacity, claim, queue };
  }
  check(
    'rejects incompatible OS, tools, client, environment, model and exact effort with actionable reasons',
    async (f) => {
      await assert.rejects(
        f.app.execute(f.worker.id, 'work_claim', {
          project_id: f.project.id,
          client_id: 'missing',
          idempotency_key: randomUUID(),
          include_context: false,
        }),
        (error: any) =>
          error.code === 'UNSUPPORTED_EXECUTION' &&
          error.details?.reasons?.[0]?.code === 'CLIENT_NOT_AUTHORIZED',
      );
      for (const [hints, capabilities, code] of [
        [{ operating_system: 'windows' }, [], 'UNSUPPORTED_OS'],
        [{ environment: 'container' }, [], 'UNSUPPORTED_ENVIRONMENT'],
        [{ client_id: 'missing' }, [], 'CLIENT_NOT_AUTHORIZED'],
        [{ model: 'missing' }, [], 'UNSUPPORTED_MODEL'],
        [{ model: 'model-a', effort: 'xhigh' }, [], 'UNSUPPORTED_EFFORT'],
        [{}, ['browser'], 'MISSING_TOOLS'],
      ] as const) {
        const ticket = await f.ticket({
          execution_hints: hints,
          capabilities: [...capabilities],
          priority: 1,
        });
        await assert.rejects(
          f.claim(ticket.id, { capabilities: ['browser', 'git', 'node'] }),
          (error: any) =>
            error.code === 'UNSUPPORTED_EXECUTION' &&
            error.details.reasons.some((reason: any) => reason.code === code && reason.message),
        );
        assert.equal(await f.storage.get('claims', ticket.id), null);
      }
      const supported = await f.ticket({ capabilities: ['git'], priority: 2 });
      const next = (await f.app.execute(f.worker.id, 'work_next', { project_id: f.project.id })) as any;
      assert.deepEqual(
        next.tickets.map((ticket: any) => ticket.id),
        [supported.id],
      );
      const receipt = await f.claim(supported.id);
      assert.equal(receipt.claim.execution.client_id, 'alpha');
      assert.equal(receipt.claim.execution.model, 'model-a');
      assert.deepEqual(receipt.claim.execution.tools, ['git']);
      f.clock.now = new Date(Date.parse(f.config.clients[0]!.expires_at));
      const expired = await f.ticket();
      await assert.rejects(f.claim(expired.id), (error: any) =>
        error.details?.reasons?.every((reason: any) => reason.code === 'CLIENT_STALE'),
      );
    },
  );
  check(
    'retains project and ticket pins, persists selections, and rejects changed choices before dispatch',
    async (f) => {
      await f.app.execute(f.admin.id, 'project_update', {
        project_id: f.project.id,
        expected_revision: 1,
        idempotency_key: randomUUID(),
        execution_hints: {
          client_id: 'zeta',
          model: 'model-a',
          effort: 'high',
          operating_system: 'linux',
          environment: 'local',
        },
      });
      const ticket = await f.ticket({ execution_hints: { effort: 'low' }, capabilities: ['node'] });
      await assert.rejects(
        f.claim(ticket.id, { client_id: 'alpha' }),
        (error: any) => error.details?.reasons?.[0]?.code === 'PINNED_CLIENT_CONFLICT',
      );
      const receipt = await f.claim(ticket.id);
      assert.equal(receipt.claim.execution.client_id, 'zeta');
      assert.equal(receipt.claim.execution.effort, 'low');
      assert.deepEqual((await f.storage.get('claims', ticket.id))!.execution, receipt.claim.execution);
      let dispatched = 0;
      await f.app.dispatchClientExecution(
        f.worker.id,
        f.project.id,
        ticket.id,
        receipt.claim.token,
        (selection) => {
          dispatched++;
          assert.deepEqual(selection, receipt.claim.execution);
        },
      );
      const current = (await f.storage.get('projects', f.project.id))!;
      await f.app.execute(f.admin.id, 'project_update', {
        project_id: f.project.id,
        expected_revision: current.revision,
        idempotency_key: randomUUID(),
        execution_hints: { client_id: 'alpha', model: 'model-a', effort: 'high' },
      });
      await assert.rejects(
        f.app.dispatchClientExecution(f.worker.id, f.project.id, ticket.id, receipt.claim.token, () => {
          dispatched++;
        }),
        hasCode('CLIENT_SELECTION_CHANGED'),
      );
      assert.equal(dispatched, 1);
      f.config.clients.find((client) => client.id === 'zeta')!.models = [
        { id: 'model-a', efforts: ['low'] },
        { id: 'model-b', efforts: ['high'] },
      ];
      await f.update();
      const pair = await f.ticket({
        execution_hints: { client_id: 'zeta', model: 'model-a', effort: 'high' },
      });
      await assert.rejects(
        f.claim(pair.id),
        (error: any) => error.details?.reasons?.[0]?.code === 'UNSUPPORTED_EFFORT',
      );
    },
  );
  check(
    'never grants permissions through support declarations or caller assertions and checks project access first',
    async (f) => {
      const ticket = await f.ticket();
      await assert.rejects(f.claim(ticket.id, {}, f.outsider.id), hasCode('FORBIDDEN'));
      await assert.rejects(
        f.claim(ticket.id, { client_capabilities: { tools: ['admin'] } }),
        hasCode('INVALID_INPUT'),
      );
      const plain = createApplication({ storage: f.storage, search: f.search });
      const pinned = await f.ticket({ execution_hints: { client_id: 'alpha' } });
      await assert.rejects(
        plain.execute(f.worker.id, 'work_claim', {
          project_id: f.project.id,
          ticket_id: pinned.id,
          idempotency_key: randomUUID(),
        }),
        hasCode('UNSUPPORTED_EXECUTION'),
      );
      await rm(f.file);
      await assert.rejects(f.claim(ticket.id, {}, f.outsider.id), hasCode('FORBIDDEN'));
      await assert.rejects(
        f.app.dispatchClientExecution(f.outsider.id, f.project.id, ticket.id, randomUUID(), () => {
          assert.fail('must not dispatch');
        }),
        hasCode('FORBIDDEN'),
      );
    },
  );
  check(
    'serializes concurrent matching with project eligibility and existing host admission capacity',
    async (f) => {
      const ticket = await f.ticket();
      const raced = await Promise.allSettled([f.claim(ticket.id), f.claim(ticket.id, {}, f.other.id)]);
      assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
      const first = raced.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
      const secondTicket = await f.ticket(),
        second = await f.claim(secondTicket.id);
      const results: boolean[] = [];
      await Promise.all(
        [
          [ticket, first.value],
          [secondTicket, second],
        ].map(async ([work, receipt], index) => {
          await f.app.dispatchClientExecution(
            receipt.claim.actor_id,
            f.project.id,
            work.id,
            receipt.claim.token,
            (execution) => {
              assert.deepEqual(execution, receipt.claim.execution);
              f.queue(work, receipt, `dispatch-${index}`);
              results.push(f.capacity.claimNext('host', `owner-${index}`).admitted);
            },
          );
        }),
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(f.capacity.inspect('host').occupied.agent, 1);
      assert.equal(
        f.capacity.report('dispatch-0').totals.invocations +
          f.capacity.report('dispatch-1').totals.invocations,
        1,
      );
      const unclaimed = await f.ticket();
      await assert.rejects(
        f.app.dispatchClientExecution(f.worker.id, f.project.id, unclaimed.id, randomUUID(), () => {
          assert.fail('must not dispatch');
        }),
        hasCode('CLAIM_EXPIRED'),
      );
    },
  );
  check(
    'skips expired or revoked queued clients without reserving capacity or downgrading a pinned model',
    async (f) => {
      const staleTicket = await f.ticket({ execution_hints: { client_id: 'alpha' } }),
        validTicket = await f.ticket({
          execution_hints: { client_id: 'zeta', model: 'model-a', effort: 'high' },
        });
      const stale = await f.claim(staleTicket.id),
        valid = await f.claim(validTicket.id);
      const createdAt = Date.now();
      f.queue(staleTicket, stale, 'stale', { created_at: createdAt - 1 });
      f.queue(validTicket, valid, 'valid', { created_at: createdAt });
      f.config.clients.find((client) => client.id === 'alpha')!.expires_at = new Date(
        Date.now() - 1,
      ).toISOString();
      await f.update();
      const result = f.capacity.claimNext('host', 'owner');
      assert.equal(result.admitted, true);
      if (!result.admitted) assert.fail('compatible client must not be starved');
      assert.equal(result.request.queue_id, 'valid');
      assert.equal(result.request.execution?.effort, 'high');
      assert.equal(f.capacity.report('stale').totals.invocations, 0);
      assert.match(
        f.capacity.inspect('host').entries.find((entry) => entry.queue_id === 'stale')!.reason!,
        /CLIENT_STALE/,
      );
      await assert.rejects(
        f.app.dispatchClientExecution(f.worker.id, f.project.id, staleTicket.id, stale.claim.token, () => {
          assert.fail('must not dispatch');
        }),
        hasCode('CLIENT_SELECTION_CHANGED'),
      );
      f.config.clients = [];
      await f.update();
      const revoked = f.capacity.claimNext('host', 'other');
      assert.equal(revoked.admitted, false);
      assert.match(
        f.capacity.inspect('host').entries.find((entry) => entry.queue_id === 'stale')!.reason!,
        /CLIENT_NOT_AUTHORIZED/,
      );
      assert.equal(f.capacity.report('stale').totals.invocations, 0);
    },
  );
}
