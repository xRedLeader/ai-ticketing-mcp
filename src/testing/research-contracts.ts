import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication } from '../application.js';
import { createHttpServer } from '../http.js';
import { ClientCapabilities } from '../client-capabilities.js';
import { DomainError, type ExecutionJob } from '../contracts.js';
import type { StorageAdapter, Transaction, Reader } from '../contracts.js';
import { readOperations, type Operation } from '../schemas.js';
import { fixture, hasCode, type ContractAdapters } from './contracts.js';

export interface ResearchAdapters extends ContractAdapters {
  reopen(): Promise<ContractAdapters>;
}

export function registerResearchContractTests(name: string, factory: () => Promise<ResearchAdapters>) {
  async function setup(t: import('node:test').TestContext) {
    const adapters = await factory();
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const directory = await mkdtemp(join(tmpdir(), 'research-artifacts-'));
    t.after(async () => {
      await adapters.dispose?.();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('research-artifacts-'));
      await rm(directory, { recursive: true });
    });
    const clients = new ClientCapabilities({
      clients: [
        {
          id: 'research-test',
          actor_ids: [f.worker.id, f.other.id],
          project_ids: [f.project.id],
          operating_system: 'fixture',
          tools: [],
          environments: ['local'],
          models: [{ id: 'fixture-model', efforts: [] }],
          expires_at: new Date(f.clock.now.getTime() + 86400000).toISOString(),
        },
      ],
    });
    const options = {
      now: () => f.clock.now,
      clientCapabilities: clients,
      executionRecipes: adapters.storage.executionRuns
        ? [{ id: 'research', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }]
        : [],
      executionArtifacts: { directory },
    };
    let app = createApplication({ ...adapters, ...options });
    const call = (actor: string, operation: Operation, input: Record<string, unknown> = {}): Promise<any> =>
      app.execute(actor, operation, {
        project_id: f.project.id,
        ...(!readOperations.has(operation) ? { idempotency_key: randomUUID() } : {}),
        ...input,
      });
    const idea = await call(f.worker.id, 'idea_create', {
      title: 'Investigate indexing',
      problem: 'Slow indexing.',
      proposal: 'Reuse documents.',
      why: 'Save time.',
    });
    const schedule = (input: Record<string, unknown> = {}) =>
      call(f.worker.id, 'spike_schedule', {
        idea_id: idea.id,
        question: 'Does unchanged input reuse its indexed document?',
        time_budget_ms: 1000,
        ...input,
      });
    const claim = (id: string, input: Record<string, unknown> = {}) =>
      call(f.worker.id, 'spike_claim', { spike_id: id, include_context: false, ...input });
    const get = (id: string) => call(f.worker.id, 'spike_get', { spike_id: id });
    const submitRun = (id: string, token: string) =>
      call(f.worker.id, 'run_submit', {
        ticket_id: id,
        claim_token: token,
        recipe_id: 'research',
        checkpoint: { progress: 'Measure document reuse.' },
        completion_condition: { kind: 'exit_code', exit_code: 0 },
      });
    const complete = async (id: string, token: string, input: Record<string, unknown> = {}) => {
      const current = await get(id);
      return call(f.worker.id, 'spike_complete', {
        spike_id: id,
        claim_token: token,
        expected_revision: current.ticket.revision,
        findings: 'Unchanged documents can be reused.',
        evidence: ['tests:document-reuse'],
        recommendation: 'promote',
        ...input,
      });
    };
    const restart = async () => {
      const reopened = await adapters.reopen();
      app = createApplication({ ...reopened, ...options });
      return app;
    };
    const artifact = async (run: ExecutionJob) => {
      const attempt = (await f.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
      const path = join(directory, run.id, attempt.id);
      await mkdir(path, { recursive: true });
      const outcome = {
        run_id: run.id,
        attempt_id: attempt.id,
        exit_code: 0,
        signal: null,
        error_code: null,
      };
      const bytes = JSON.stringify(outcome) + '\n';
      await writeFile(join(path, 'outcome.json'), bytes);
      await writeFile(
        join(path, 'result.json'),
        JSON.stringify({
          ...outcome,
          process_token: attempt.process_token,
          recipe_fingerprint: run.recipe_fingerprint,
          cleanup_verified: true,
          finished_at: f.clock.now.getTime(),
          sha256: { result: createHash('sha256').update(bytes).digest('hex') },
        }),
      );
      return { attempt, reference: `execution:${run.id}:${attempt.id}:result` };
    };
    return {
      ...f,
      app,
      call,
      idea,
      schedule,
      claim,
      get,
      submitRun,
      complete,
      restart,
      artifact,
      directory,
      make: (storage: StorageAdapter) =>
        createApplication({
          storage,
          search: f.search,
          ...options,
          executionRecipes: storage.executionRuns ? options.executionRecipes : [],
        }),
    };
  }

  it(`${name} research: real MCP catalogs, intake, independent discovery, claim and checkpoint resume`, async (t) => {
    const f = await setup(t);
    await f.call(f.admin.id, 'member_set', { actor_id: f.outsider.id, role: 'reader' });
    const server = createHttpServer(f.app, {
      publicUrl: 'http://127.0.0.1',
      issuer: 'https://research.invalid',
      authenticate: async (authorization) => ({
        actorId: authorization!.slice(7).split(':')[0]!,
        scopes: new Set(
          authorization!.endsWith(':read') ? ['ticketing:read'] : ['ticketing:read', 'ticketing:write'],
        ),
      }),
    });
    const clients: Client[] = [];
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const client of clients) await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const connect = async (profile: string, actor = f.worker.id) => {
      const client = new Client({ name: 'research-contract', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp?profile=${profile}`),
          { requestInit: { headers: { Authorization: `Bearer ${actor}` } } },
        ),
      );
      const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
        const result = await client.callTool({
          name,
          arguments: { project_id: f.project.id, idempotency_key: randomUUID(), ...input },
        });
        const envelope = result.structuredContent as any;
        if (!envelope.ok) throw new DomainError(envelope.error.code, envelope.error.message);
        return envelope.data;
      };
      return { client, call };
    };
    const planner = await connect('planner'),
      researcher = await connect('researcher'),
      worker = await connect('worker');
    const guide = await researcher.client.readResource({ uri: 'ticketing://guide' });
    for (const name of ['execution', 'handoff']) {
      const prompt = await researcher.client.getPrompt({ name });
      const text = JSON.stringify(prompt);
      assert.ok(text.includes('spike_claim') && text.includes('spike_complete'));
      assert.equal(/work_claim|ticket_submit|changes_since/.test(text), false);
    }
    assert.equal(/work_claim|ticket_submit|changes_since/.test(JSON.stringify(guide)), false);
    assert.ok((await researcher.client.listTools()).tools.some((tool) => tool.name === 'spike_claim'));
    assert.equal(
      (await worker.client.listTools()).tools.some((tool) => tool.name.startsWith('spike_')),
      false,
    );
    const scheduled = await planner.call('spike_schedule', {
      idea_id: f.idea.id,
      question: 'Measure reuse?',
      time_budget_ms: 5000,
    });
    assert.equal('question' in scheduled, false);
    assert.equal(
      (await researcher.client.callTool({ name: 'spike_list', arguments: { project_id: f.project.id } }))
        .isError,
      undefined,
    );
    assert.deepEqual(await f.call(f.worker.id, 'ticket_list'), { tickets: [] });
    assert.deepEqual(await f.call(f.worker.id, 'work_next'), { tickets: [] });
    await assert.rejects(
      worker.call('work_claim', { ticket_id: scheduled.id, include_context: false }),
      hasCode('NOT_CLAIMABLE'),
    );
    f.clock.now = new Date(f.clock.now.getTime() + 2000);
    const claimed = await researcher.call('spike_claim', { spike_id: scheduled.id });
    const anchor = (await f.get(scheduled.id)).budget.first_claimed_at;
    assert.equal(anchor, f.clock.now.toISOString());
    await researcher.call('ticket_checkpoint', {
      ticket_id: scheduled.id,
      claim_token: claimed.claim.token,
      progress: 'Measured first sample.',
      remaining: ['Measure another sample.'],
    });
    await researcher.call('work_release', {
      ticket_id: scheduled.id,
      claim_token: claimed.claim.token,
      reason: 'Pause research.',
    });
    const resumed = await researcher.call('spike_claim', { spike_id: scheduled.id });
    assert.equal((await f.get(scheduled.id)).budget.first_claimed_at, anchor);
    assert.notEqual(resumed.claim.token, claimed.claim.token);
    assert.ok(JSON.stringify(resumed.context).includes('Measured first sample.'));
    const reader = await connect('researcher', f.outsider.id);
    await assert.rejects(reader.call('spike_claim', { spike_id: scheduled.id }), hasCode('FORBIDDEN'));
    const readonly = await connect('researcher', `${f.worker.id}:read`);
    await assert.rejects(
      readonly.call('spike_claim', { spike_id: scheduled.id }),
      hasCode('INSUFFICIENT_SCOPE'),
    );
    const result = await researcher.call('spike_complete', {
      spike_id: scheduled.id,
      claim_token: resumed.claim.token,
      expected_revision: (await f.get(scheduled.id)).ticket.revision,
      findings: 'The sample is inconclusive.',
      evidence: ['tests:sample'],
      recommendation: 'park',
    });
    assert.equal(result.recommendation, 'park');
  });

  it(`${name} research: deadlines survive restart and exhausted researchers can record durable results`, async (t) => {
    const f = await setup(t),
      spike = await f.schedule();
    const key = randomUUID();
    const [claimed, retry] = await Promise.all([
      f.claim(spike.id, { idempotency_key: key }),
      f.claim(spike.id, { idempotency_key: key }),
    ]);
    assert.deepEqual(claimed, retry);
    const first = await f.get(spike.id);
    await f.restart();
    f.clock.now = new Date(f.clock.now.getTime() + 700000);
    assert.equal((await f.get(spike.id)).budget.exhausted, true);
    assert.equal((await f.get(spike.id)).budget.deadline, first.budget.deadline);
    await assert.rejects(f.claim(spike.id), hasCode('SPIKE_BUDGET_EXHAUSTED'));
    const resultKey = randomUUID();
    const result = await f.complete(spike.id, claimed.claim.token, { idempotency_key: resultKey });
    assert.equal(result.recommendation, 'promote');
    assert.equal('findings' in result, false);
    assert.equal((await f.get(spike.id)).spike.findings, 'Unchanged documents can be reused.');
    assert.equal((await f.call(f.worker.id, 'idea_get', { idea_id: f.idea.id })).idea.status, 'submitted');
    const exact = {
      spike_id: spike.id,
      claim_token: claimed.claim.token,
      expected_revision: first.ticket.revision,
      findings: 'Unchanged documents can be reused.',
      evidence: ['tests:document-reuse'],
      recommendation: 'promote',
      idempotency_key: resultKey,
    };
    assert.deepEqual(await f.call(f.worker.id, 'spike_complete', exact), result);
    await f.restart();
    assert.deepEqual((await f.get(spike.id)).spike.evidence, ['tests:document-reuse']);
    await assert.rejects(f.complete(spike.id, claimed.claim.token), hasCode('INVALID_STATE'));
  });

  it(`${name} research: failed claim packing cannot start or consume the research timebox`, async (t) => {
    const f = await setup(t),
      spike = await f.schedule({ question: 'Required research question. '.repeat(500) });
    await assert.rejects(
      f.claim(spike.id, { include_context: true, max_tokens: 512 }),
      hasCode('CONTEXT_TOO_LARGE'),
    );
    assert.equal((await f.get(spike.id)).budget.first_claimed_at, null);
    assert.equal(await f.storage.get('claims', spike.id), null);
    await f.claim(spike.id);
    assert.equal((await f.get(spike.id)).budget.first_claimed_at, f.clock.now.toISOString());
  });

  it(`${name} research: legacy ticket updates preserve research classification`, async (t) => {
    const f = await setup(t),
      spike = await f.schedule();
    const legacy = { ...(await f.storage.get('tickets', spike.id))! };
    delete legacy.work_kind;
    await f.storage.transaction(f.project.id, (tx) =>
      tx.put('tickets', { ...legacy, title: 'Legacy metadata update' }),
    );
    assert.equal((await f.storage.get('tickets', spike.id))?.work_kind, 'research');
    assert.deepEqual(await f.call(f.worker.id, 'work_next'), { tickets: [] });
    await assert.rejects(
      f.call(f.worker.id, 'work_claim', { ticket_id: spike.id, include_context: false }),
      hasCode('NOT_CLAIMABLE'),
    );
    await f.claim(spike.id);
  });

  it(`${name} research: budget fences every script and direct-agent new admission while permitting settlement`, async (t) => {
    const f = await setup(t);
    if (!f.storage.executionRuns) {
      t.skip('Optional executionRuns capability is unavailable.');
      return;
    }
    const spike = await f.schedule(),
      claimed = await f.claim(spike.id);
    const token = claimed.claim.token;
    const queued = await f.submitRun(spike.id, token),
      reserved = await f.submitRun(spike.id, token),
      running = await f.submitRun(spike.id, token);
    const controller = (await f.app.acquireExecutionController(
      f.admin.id,
      f.project.id,
      randomUUID(),
      60000,
    ))!;
    const reserve = (id: string) =>
      f.app.reserveExecutionRun(f.admin.id, f.project.id, id, 60000, controller);
    const r1 = (await reserve(reserved.run_id))!,
      r2 = (await reserve(running.run_id))!;
    assert.ok(
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        r2.id,
        r2.reservation_token!,
        60000,
        controller,
      ),
    );
    const attempt = (await f.storage.find('execution_attempts', { where: { run_id: r2.id } }))[0]!;
    let launches = 0;
    await f.app.dispatchClientExecution(f.worker.id, f.project.id, spike.id, token, () => {
      launches++;
    });
    f.clock.now = new Date(f.clock.now.getTime() + 1001);
    await assert.rejects(f.submitRun(spike.id, token), hasCode('SPIKE_BUDGET_EXHAUSTED'));
    assert.deepEqual(
      (await f.app.listExecutionRuns(f.admin.id, f.project.id)).map((run) => run.id),
      [queued.run_id],
    );
    assert.equal(await reserve(queued.run_id), null);
    const expired = (await f.storage.get('execution_jobs', queued.run_id))!;
    assert.equal(expired.status, 'failed');
    assert.equal(expired.error_code, 'SPIKE_BUDGET_EXHAUSTED');
    assert.equal(
      (await f.storage.get('execution_cancellations', queued.run_id))?.process_state,
      'never_started',
    );
    assert.equal(
      await f.app.admitExecutionRun(
        f.admin.id,
        f.project.id,
        r1.id,
        r1.reservation_token!,
        controller,
        () => {
          launches++;
        },
      ),
      false,
    );
    assert.equal(
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        r1.id,
        r1.reservation_token!,
        60000,
        controller,
      ),
      null,
    );
    assert.equal(
      await f.app.dispatchExecutionRun(
        f.admin.id,
        f.project.id,
        r2.id,
        r2.reservation_token!,
        attempt.id,
        attempt.process_token,
        r2.recipe_fingerprint,
        controller,
        () => {
          launches++;
        },
      ),
      false,
    );
    await assert.rejects(
      f.app.dispatchClientExecution(f.worker.id, f.project.id, spike.id, token, () => {
        launches++;
      }),
      hasCode('SPIKE_BUDGET_EXHAUSTED'),
    );
    assert.equal(launches, 1);
    assert.ok(
      await f.app.heartbeatExecutionRun(
        f.admin.id,
        f.project.id,
        r2.id,
        r2.reservation_token!,
        60000,
        controller,
      ),
    );
    assert.ok(
      await f.app.settleExecutionRun(
        f.admin.id,
        f.project.id,
        r2.id,
        r2.reservation_token!,
        { exit_code: 0, signal: null, error_code: null, artifacts: [] },
        controller,
      ),
    );
    await assert.rejects(f.complete(spike.id, token), hasCode('EXECUTION_PENDING'));
    await f.app.cancelExecutionRun(f.admin.id, f.project.id, r1.id);
    await f.complete(spike.id, token);
  });

  for (const duringAdmission of [false, true])
    it(`${name} research: wake continuation fences deadline ${duringAdmission ? 'between admission and launch' : 'before admission'} and allows reconciliation`, async (t) => {
      const f = await setup(t);
      if (!f.storage.executionRuns || !f.storage.wakeDecisions) {
        t.skip('Optional executionRuns, wakeDecisions capability is unavailable.');
        return;
      }
      const spike = await f.schedule(),
        claimed = await f.claim(spike.id);
      const submitted = await f.submitRun(spike.id, claimed.claim.token);
      const reserved = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60000))!;
      await f.app.startExecutionRun(
        f.admin.id,
        f.project.id,
        reserved.id,
        reserved.reservation_token!,
        60000,
      );
      const { reference } = await f.artifact(reserved);
      await f.app.settleExecutionRun(f.admin.id, f.project.id, reserved.id, reserved.reservation_token!, {
        exit_code: 0,
        signal: null,
        error_code: null,
        artifacts: [reference],
      });
      await f.app.registerWakeCondition(f.admin.id, f.project.id, {
        ticket_id: spike.id,
        condition: { kind: 'continuation', continuation_id: submitted.continuation_id },
      });
      await f.app.evaluateWakeConditions(f.admin.id, f.project.id, { ticket_id: spike.id });
      const row = await f.app.getWakeCondition(f.admin.id, f.project.id, spike.id);
      const decision = (await f.app.claimWakeDecision(f.admin.id, f.project.id, {
        ticket_id: spike.id,
        expected_generation: row.generation,
      }))!;
      if (!duringAdmission) f.clock.now = new Date(f.clock.now.getTime() + 1001);
      let admissions = 0,
        launches = 0;
      const fence = { ticket_id: spike.id, generation: decision.generation, token: decision.token };
      const dispatched = await f.app.dispatchWakeContinuation(
        f.admin.id,
        f.project.id,
        fence,
        () => {
          admissions++;
          f.clock.now = new Date(f.clock.now.getTime() + 1001);
          return {
            state: 'starting',
            invocation: { host_id: 'fixture', queue_id: 'research', execution_token: randomUUID() },
          };
        },
        () => {
          launches++;
        },
      );
      assert.equal(dispatched.code, 'SPIKE_BUDGET_EXHAUSTED');
      assert.equal(admissions, Number(duringAdmission));
      assert.equal(launches, 0);
      if (duringAdmission)
        assert.equal(await f.app.completeWakeContinuation(f.admin.id, f.project.id, fence, () => true), true);
      await f.complete(spike.id, claimed.claim.token);
    });

  it(`${name} research: delivery lifecycle, queues, relationships and milestones reject research identities`, async (t) => {
    const f = await setup(t),
      spike = await f.schedule(),
      ticket = await f.ticket();
    for (const operation of [
      'ticket_update',
      'ticket_transition',
      'ticket_submit',
      'ticket_review',
    ] as const) {
      const args =
        operation === 'ticket_update'
          ? { title: 'Wrong lifecycle' }
          : operation === 'ticket_transition'
            ? { status: 'ready', reason: 'Wrong lifecycle' }
            : operation === 'ticket_submit'
              ? {
                  claim_token: randomUUID(),
                  summary: 'Wrong',
                  evidence: [
                    {
                      criterion_id: randomUUID(),
                      result: 'pass',
                      summary: 'Wrong',
                      references: ['test:wrong'],
                    },
                  ],
                }
              : { submission_id: randomUUID(), decision: 'approve', feedback: 'Wrong' };
      await assert.rejects(
        f.call(operation === 'ticket_review' ? f.reviewer.id : f.worker.id, operation, {
          ticket_id: spike.id,
          expected_revision: 1,
          ...args,
        }),
        hasCode('RESEARCH_ONLY'),
      );
    }
    await assert.rejects(
      f.call(f.worker.id, 'ticket_link', {
        source_id: spike.id,
        target_id: ticket.id,
        kind: 'blocks',
        action: 'add',
      }),
      hasCode('RESEARCH_ONLY'),
    );
    await assert.rejects(
      f.call(f.worker.id, 'ticket_update', {
        ticket_id: ticket.id,
        expected_revision: 1,
        parent_id: spike.id,
      }),
      hasCode('RESEARCH_ONLY'),
    );
    if (f.storage.milestones) {
      const milestone = await f.call(f.worker.id, 'milestone_create', {
        name: 'Delivery only',
        outcome: 'Accepted delivery',
        exit_criteria: ['Accepted'],
      });
      await assert.rejects(
        f.call(f.worker.id, 'ticket_milestone_set', {
          ticket_id: spike.id,
          milestone_id: milestone.id,
          expected_milestone_id: null,
        }),
        hasCode('RESEARCH_ONLY'),
      );
    }
    assert.equal((await f.call(f.worker.id, 'ticket_list')).tickets.length, 1);
    await f.storage.transaction(f.project.id, async (tx) => {
      const hidden = (await tx.get('tickets', spike.id))!;
      await tx.put('tickets', { ...hidden, status: 'in_review' });
    });
    assert.deepEqual(await f.call(f.reviewer.id, 'work_next', { mode: 'review' }), { tickets: [] });
  });

  it(`${name} research: evidence links promote atomically and cross-project/source evidence is denied`, async (t) => {
    const f = await setup(t),
      spike = await f.schedule(),
      claimed = await f.claim(spike.id);
    const input = {
      idea_id: f.idea.id,
      expected_revision: 1,
      action: 'promote',
      rationale: 'Use measured findings.',
      spike_ids: [spike.id],
      tickets: [
        {
          title: 'Implement reuse',
          description: 'Use the findings.',
          criteria: ['Reuse unchanged documents.'],
        },
      ],
      idempotency_key: randomUUID(),
    };
    await assert.rejects(f.call(f.worker.id, 'idea_triage', input), hasCode('INVALID_REFERENCE'));
    await f.complete(spike.id, claimed.claim.token);
    const promoted = await f.call(f.worker.id, 'idea_triage', input);
    assert.deepEqual(promoted.tickets[0].spike_ids, [spike.id]);
    assert.deepEqual(await f.call(f.worker.id, 'idea_triage', input), promoted);
    assert.deepEqual((await f.read(promoted.tickets[0].ticket_id)).source_idea.spike_ids, [spike.id]);
    assert.ok((await f.get(spike.id)).spike.findings);
    const foreign = (await f.app.execute(f.admin.id, 'project_create', {
      key: `R${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      name: 'Other project',
      idempotency_key: randomUUID(),
    })) as any;
    await assert.rejects(
      f.call(f.worker.id, 'spike_get', { project_id: foreign.id, spike_id: spike.id }),
      hasCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.call(f.admin.id, 'spike_get', { project_id: foreign.id, spike_id: spike.id }),
      hasCode('NOT_FOUND'),
    );
    await assert.rejects(
      f.call(f.admin.id, 'spike_schedule', {
        project_id: foreign.id,
        idea_id: f.idea.id,
        question: 'Wrong project?',
        time_budget_ms: 1000,
      }),
      hasCode('NOT_FOUND'),
    );
  });

  it(`${name} research: findings and evidence conservatively pin artifacts and completed rows are immutable`, async (t) => {
    const f = await setup(t);
    if (!f.storage.artifactRetention) {
      t.skip('Optional artifactRetention capability is unavailable.');
      return;
    }
    const spike = await f.schedule(),
      claimed = await f.claim(spike.id);
    const run = randomUUID(),
      attempt = randomUUID(),
      reference = `execution:${run}:${attempt}:stdout`;
    await f.complete(spike.id, claimed.claim.token, { findings: reference, evidence: [reference] });
    assert.equal(
      await f.storage.transaction(f.project.id, (tx) =>
        tx.artifactPinned!({
          run_id: run,
          attempt_id: attempt,
          ticket_id: randomUUID(),
          checkpoint_id: randomUUID(),
        }),
      ),
      true,
    );
    const stored = (await f.storage.get('research_spikes', spike.id))!;
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) =>
        tx.put('research_spikes', { ...stored, findings: 'Changed' }),
      ),
    );
    await assert.rejects(f.storage.transaction(f.project.id, (tx) => tx.remove('research_spikes', spike.id)));
    const next = await f.schedule(),
      nextClaim = await f.claim(next.id),
      prior = (await f.storage.get('research_spikes', next.id))!;
    await assert.rejects(
      f.storage.transaction(f.project.id, (tx) =>
        tx.put('research_spikes', { ...prior, first_claimed_at: null }),
      ),
    );
    await f.complete(next.id, nextClaim.claim.token);
  });

  for (const kind of ['direct', 'script', 'capacity'] as const)
    it(`${name} research: ${kind} launch samples deadline after awaited spike lookup`, async (t) => {
      const f = await setup(t);
      if (!f.storage.executionRuns) {
        t.skip('Optional executionRuns capability is unavailable.');
        return;
      }
      const spike = await f.schedule(),
        claimed = await f.claim(spike.id);
      const submitted = await f.submitRun(spike.id, claimed.claim.token);
      const controller = (await f.app.acquireExecutionController(
        f.admin.id,
        f.project.id,
        randomUUID(),
        60000,
      ))!;
      const run = (await f.app.reserveExecutionRun(
        f.admin.id,
        f.project.id,
        submitted.run_id,
        60000,
        controller,
      ))!;
      if (kind === 'script')
        await f.app.startExecutionRun(
          f.admin.id,
          f.project.id,
          run.id,
          run.reservation_token!,
          60000,
          controller,
        );
      const attempt = (await f.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
      let reads = 0,
        launches = 0;
      const wrapped = new Proxy(f.storage, {
        get(target, property) {
          if (property === 'transaction')
            return (scope: string, work: (tx: Transaction) => Promise<unknown>) =>
              target.transaction(scope, (tx) =>
                work(
                  new Proxy(tx, {
                    get(reader, field) {
                      if (field === 'get')
                        return async (table: Parameters<Transaction['get']>[0], id: string) => {
                          const result = await reader.get(table, id);
                          if (table === 'research_spikes' && ++reads === (kind === 'direct' ? 1 : 2))
                            f.clock.now = new Date(f.clock.now.getTime() + 1001);
                          return result;
                        };
                      const value = Reflect.get(reader, field);
                      return typeof value === 'function' ? value.bind(reader) : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const boundary = f.make(wrapped);
      const launch = (): undefined => {
        launches++;
      };
      if (kind === 'direct')
        await assert.rejects(
          boundary.dispatchClientExecution(f.worker.id, f.project.id, spike.id, claimed.claim.token, launch),
          hasCode('SPIKE_BUDGET_EXHAUSTED'),
        );
      else if (kind === 'script')
        assert.equal(
          await boundary.dispatchExecutionRun(
            f.admin.id,
            f.project.id,
            run.id,
            run.reservation_token!,
            attempt.id,
            attempt.process_token,
            run.recipe_fingerprint,
            controller,
            launch,
          ),
          false,
        );
      else
        assert.equal(
          await boundary.admitExecutionRun(
            f.admin.id,
            f.project.id,
            run.id,
            run.reservation_token!,
            controller,
            launch,
          ),
          false,
        );
      assert.equal(launches, 0);
      assert.equal((await f.get(spike.id)).budget.exhausted, true);
    });

  it(`${name} research: exhausted queued work settles without a live claim and completion preserves current ownership`, async (t) => {
    const f = await setup(t);
    if (!f.storage.executionRuns) {
      t.skip('Optional executionRuns capability is unavailable.');
      return;
    }
    const spike = await f.schedule(),
      claimed = await f.claim(spike.id);
    const queued = await f.submitRun(spike.id, claimed.claim.token);
    await assert.rejects(f.complete(spike.id, claimed.claim.token), hasCode('EXECUTION_PENDING'));
    f.clock.now = new Date(f.clock.now.getTime() + 700000);
    assert.ok(
      (await f.app.listExecutionRuns(f.admin.id, f.project.id)).some((run) => run.id === queued.run_id),
    );
    assert.equal(await f.app.reserveExecutionRun(f.admin.id, f.project.id, queued.run_id, 60000), null);
    assert.equal(
      (await f.storage.get('execution_jobs', queued.run_id))?.error_code,
      'SPIKE_BUDGET_EXHAUSTED',
    );
    await f.complete(spike.id, claimed.claim.token);
    const next = await f.schedule(),
      first = await f.claim(next.id);
    await f.call(f.worker.id, 'work_release', {
      ticket_id: next.id,
      claim_token: first.claim.token,
      reason: 'Transfer before expiry.',
    });
    const second = await f.call(f.other.id, 'spike_claim', { spike_id: next.id, include_context: false });
    f.clock.now = new Date(f.clock.now.getTime() + 1001);
    await assert.rejects(f.complete(next.id, first.claim.token), hasCode('CLAIM_EXPIRED'));
    await f.call(f.other.id, 'spike_complete', {
      spike_id: next.id,
      claim_token: second.claim.token,
      expected_revision: (await f.get(next.id)).ticket.revision,
      findings: 'Preserved by the new owner.',
      evidence: ['tests:owner'],
      recommendation: 'park',
    });
    const released = await f.schedule(),
      owner = await f.claim(released.id);
    await f.call(f.worker.id, 'work_release', {
      ticket_id: released.id,
      claim_token: owner.claim.token,
      reason: 'Explicitly abandon ownership.',
    });
    f.clock.now = new Date(f.clock.now.getTime() + 1001);
    await assert.rejects(f.complete(released.id, owner.claim.token), hasCode('CLAIM_EXPIRED'));
    assert.equal((await f.get(released.id)).budget.exhausted, true);
    assert.equal((await f.get(released.id)).spike.completed_at, null);
  });

  it(`${name} research: retired artifact references cannot enter new questions or results`, async (t) => {
    const f = await setup(t);
    if (!f.storage.executionRuns || !f.storage.artifactRetention) {
      t.skip('Optional executionRuns, artifactRetention capability is unavailable.');
      return;
    }
    const spike = await f.schedule(),
      claimed = await f.claim(spike.id),
      submitted = await f.submitRun(spike.id, claimed.claim.token);
    const run = (await f.app.reserveExecutionRun(f.admin.id, f.project.id, submitted.run_id, 60000))!;
    const attempt = (await f.storage.find('execution_attempts', { where: { run_id: run.id } }))[0]!;
    await f.app.cancelExecutionRun(f.admin.id, f.project.id, run.id);
    const reference = `execution:${run.id}:${attempt.id}:stdout`;
    await f.storage.transaction(f.project.id, (tx) =>
      tx.put('artifact_retirements', {
        id: reference,
        project_id: f.project.id,
        run_id: run.id,
        attempt_id: attempt.id,
        ticket_id: spike.id,
        checkpoint_id: run.checkpoint_id,
        actor_id: f.admin.id,
        requested_at: f.clock.now.toISOString(),
        expires_at: f.clock.now.toISOString(),
        size_bytes: 0,
        sha256: '0'.repeat(64),
        root_identity: 'fixture',
        file_identity: 'fixture',
      }),
    );
    await assert.rejects(f.schedule({ question: reference }), hasCode('ARTIFACT_RETIRED'));
    await assert.rejects(
      f.complete(spike.id, claimed.claim.token, { findings: reference }),
      hasCode('ARTIFACT_RETIRED'),
    );
    await assert.rejects(
      f.complete(spike.id, claimed.claim.token, { evidence: [reference] }),
      hasCode('ARTIFACT_RETIRED'),
    );
    assert.equal((await f.get(spike.id)).spike.completed_at, null);
  });

  it(`${name} research: plain intake, claims and completion require no execution, wake, milestone or retention tables`, async (t) => {
    const f = await setup(t);
    const forbidden = new Set([
      'execution_jobs',
      'execution_attempts',
      'execution_observations',
      'execution_controllers',
      'execution_cancellations',
      'execution_admissions',
      'continuations',
      'wake_conditions',
      'artifact_retirements',
      'milestones',
      'milestone_memberships',
    ]);
    const guard = <R extends Reader>(reader: R): R =>
      new Proxy(reader, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === 'get' || property === 'find')
            return (table: string, ...args: unknown[]) => {
              assert.equal(forbidden.has(table), false, `Plain research queried optional table ${table}`);
              assert.ok(typeof value === 'function');
              return value.call(target, table, ...args);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const wrapped = new Proxy(f.storage, {
      get(target, property) {
        if (['executionRuns', 'wakeDecisions', 'artifactRetention', 'milestones'].includes(String(property)))
          return undefined;
        if (property === 'transaction')
          return (scope: string, work: (tx: Transaction) => Promise<unknown>) =>
            target.transaction(scope, (tx) => work(guard(tx)));
        if (property === 'readSnapshot')
          return (work: (reader: Reader) => Promise<unknown>) =>
            target.readSnapshot((reader) => work(guard(reader)));
        return Reflect.get(guard(target), property);
      },
    });
    const app = f.make(wrapped);
    const call = (operation: Operation, input: Record<string, unknown> = {}): Promise<any> =>
      app.execute(f.worker.id, operation, {
        project_id: f.project.id,
        ...(!readOperations.has(operation) ? { idempotency_key: randomUUID() } : {}),
        ...input,
      });
    const spike = await call('spike_schedule', {
      idea_id: f.idea.id,
      question: 'Can plain research finish?',
      time_budget_ms: 1000,
    });
    const claimed = await call('spike_claim', { spike_id: spike.id });
    const result = await call('spike_complete', {
      spike_id: spike.id,
      claim_token: claimed.claim.token,
      expected_revision: claimed.ticket.revision,
      findings: 'Research needs no execution module.',
      evidence: ['tests:plain'],
      recommendation: 'park',
    });
    assert.equal(result.recommendation, 'park');
    assert.equal(
      (await call('spike_get', { spike_id: spike.id })).spike.findings,
      'Research needs no execution module.',
    );
  });
}
