import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HostCapacity } from '../src/host-capacity.js';
import { createExecutionStatusProvider } from '../src/execution-status.js';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { createHttpServer } from '../src/http.js';
import { fixture } from '../src/testing/contracts.js';
import { profileOperations } from '../src/profiles.js';
import { countReferenceTokens } from '../src/tokens.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';

it('observes only exact run/project budget and capacity, without provider/model/host labels or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-status-'));
  const filename = join(directory, 'ledger.sqlite'),
    host = new HostCapacity(filename);
  try {
    host.configureHost('PRIVATE_HOST_LABEL');
    host.createRun({
      run_id: 'run',
      project_id: 'project',
      work: [{ ticket_id: 'ticket', requirements_revision: 1 }],
      limits: { max_attempts: 2, max_provider_tokens: 1000, max_runtime_ms: 10000, max_cost_usd_micros: 500 },
    });
    host.enqueue('PRIVATE_HOST_LABEL', {
      kind: 'agent',
      queue_id: 'run',
      run_id: 'run',
      created_at: Date.now(),
      admission: {
        attempt_id: 'PRIVATE_ATTEMPT_LABEL',
        ticket_id: 'ticket',
        requirements_revision: 1,
        actor_id: 'PRIVATE_ACTOR_LABEL',
        role: 'worker',
        provider: 'PRIVATE_PROVIDER_CREDENTIAL',
        model: 'PRIVATE_MODEL_LABEL',
        allowance: { provider_tokens: 100, runtime_ms: 1000, cost_usd_micros: 50 },
      },
    });
    const admitted = host.claimNext('PRIVATE_HOST_LABEL', 'PRIVATE_OWNER_CREDENTIAL');
    assert.equal(admitted.admitted, true);
    host.enqueue('PRIVATE_HOST_LABEL', {
      kind: 'script',
      queue_id: 'FOREIGN_QUEUE',
      run_id: 'FOREIGN_RUN',
      project_id: 'FOREIGN_PROJECT',
      created_at: Date.now(),
    });
    const provider = createExecutionStatusProvider(filename, 'PRIVATE_HOST_LABEL');
    const result = provider.observe('project', 'run')!;
    assert.equal(result.capacity!.state, 'running');
    assert.ok(result.capacity!.timeout_at);
    assert.deepEqual(result.budget!.remaining, {
      attempts: 1,
      provider_tokens: 900,
      runtime_ms: 9000,
      cost_usd_micros: 450,
    });
    assert.equal(result.budget!.unknown_usage_invocations, 1);
    assert.equal(result.budget!.basis, 'charged_or_reserved');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE_|FOREIGN_|"execution_token"|"lease_token"|"provider"|"model"/);
    if (admitted.admitted) assert.ok(!serialized.includes(admitted.request.execution_token!));
    const foreign = provider.observe('FOREIGN_PROJECT', 'run')!;
    assert.equal(foreign.capacity, null);
    assert.equal(foreign.budget, null);
    const missing = join(directory, 'missing.sqlite');
    assert.equal(createExecutionStatusProvider(missing, 'host').observe('project', 'run'), null);
    assert.equal(existsSync(missing), false);
    assert.throws(() => createExecutionStatusProvider('relative.sqlite', 'host'), /absolute ledger path/);
  } finally {
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('serves the same authorized bounded explanation through full-profile MCP and the trusted CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-timeline-cli-'));
  const filename = join(directory, 'store.sqlite'),
    adapters = createSqliteAdapters(filename);
  await adapters.storage.migrate();
  const f = await fixture(adapters);
  const app = createApplication({
    ...adapters,
    executionRecipes: [{ id: 'test', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
  });
  const ticket = await f.ticket(),
    claim = await f.claim(ticket.id);
  const receipt = (await app.execute(f.worker.id, 'run_submit', {
    project_id: f.project.id,
    ticket_id: ticket.id,
    claim_token: claim.claim.token,
    idempotency_key: randomUUID(),
    recipe_id: 'test',
    checkpoint: { progress: 'PRIVATE_CONTENT' },
    completion_condition: { kind: 'exit_code', exit_code: 0 },
  })) as any;
  await app.setExecutionAdmissions(f.admin.id, f.project.id, true);
  const server = createHttpServer(app, {
    publicUrl: 'http://127.0.0.1',
    issuer: 'http://127.0.0.1/issuer',
    authenticate: async () => ({ actorId: f.worker.id, scopes: new Set(['ticketing:read']) }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'timeline-test', version: '1' });
  try {
    const input = { project_id: f.project.id, run_id: receipt.run_id, limit: 1, max_tokens: 4096 };
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?profile=full`)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'run_timeline'));
    assert.ok(!profileOperations.worker.includes('run_timeline'));
    assert.ok(!profileOperations.planner.includes('run_timeline'));
    assert.ok(!profileOperations.reviewer.includes('run_timeline'));
    const result = await client.callTool({ name: 'run_timeline', arguments: input });
    const envelope = result.structuredContent as any;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.waiting_reason, 'admissions_paused');
    assert.equal(envelope.data.next_wake.condition, 'admissions_resume');
    assert.ok(countReferenceTokens(serializeSuccessEnvelope(envelope.data)) <= input.max_tokens);
    const cli = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
        'call',
        '--sqlite',
        filename,
        '--actor',
        f.worker.id,
        '--operation',
        'run_timeline',
        '--input',
        JSON.stringify(input),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        env: {
          ...process.env,
          EMBEDDING_PROVIDER: 'none',
          EXECUTION_RECIPES_FILE: '',
          EXECUTION_STATUS_LEDGER_FILE: '',
          EXECUTION_STATUS_HOST_ID: '',
        },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const view = JSON.parse(cli.stdout);
    assert.equal(view.run.id, receipt.run_id);
    assert.equal(view.next_wake.condition, 'admissions_resume');
    assert.doesNotMatch(cli.stdout, /PRIVATE_CONTENT|claim_token|reservation_token|process_token/);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await adapters.storage.close();
    await adapters.search.close();
    await rm(directory, { recursive: true, force: true });
  }
});
