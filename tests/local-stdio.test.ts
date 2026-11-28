import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { fixture } from '../src/testing/contracts.js';

it('reloads advice on a pinned stdio connection while maintaining its SQLite claim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-pinned-guide-'));
  const database = join(directory, 'tickets.sqlite');
  const guide = join(directory, 'worker.json');
  const pointer = join(directory, 'active');
  const entry = join(directory, 'cli.js');
  const client = new Client(
    { name: 'guide-test', version: '1' },
    { capabilities: { roots: { listChanged: true } } },
  );
  const adapters = createSqliteAdapters(database);
  t.after(async () => {
    await client.close();
    await adapters.search.close();
    await adapters.storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  await adapters.storage.migrate();
  const f = await fixture(adapters);
  const ticket = await f.ticket();
  await writeFile(entry, `import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)})`);
  await writeFile(pointer, entry);
  await writeFile(guide, JSON.stringify({ advice: 'First advice.' }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/stdio-hot-reload.ts', '--pointer', pointer, '--profile', 'worker'],
    env: {
      NODE_OPTIONS: `--import=${import.meta.resolve('tsx')}`,
      STORAGE_ADAPTER: 'sqlite',
      SQLITE_PATH: database,
      ACTOR_ID: f.worker.id,
      EMBEDDING_PROVIDER: 'none',
      MCP_PROFILE_CAPTURE: 'false',
      MCP_WORKER_GUIDE_FILE: guide,
    },
    stderr: 'pipe',
  });
  let logs = '';
  transport.stderr?.on('data', (chunk) => {
    logs += chunk.toString();
  });
  await client.connect(transport);
  await client.sendRootsListChanged();
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })).structuredContent as any;
  assert.match((await call('project_list', {})).data.worker_guide, /First advice/);
  const args = { project_id: f.project.id, ticket_id: ticket.id };
  const claimed = await call('work_claim', { ...args, idempotency_key: randomUUID() });
  assert.equal(claimed.ok, true);
  const claim_token = claimed.data.claim.token;
  await writeFile(guide + '.next', JSON.stringify({ advice: 'Updated advice.' }));
  await rename(guide + '.next', guide);
  const note = { ...args, idempotency_key: randomUUID(), body: 'Checked after publication.' };
  assert.equal((await call('ticket_note', note)).error.code, 'WORKER_GUIDE_REQUIRED');
  assert.equal(
    (await call('work_heartbeat', { ...args, claim_token, idempotency_key: randomUUID() })).ok,
    true,
  );
  assert.match((await call('project_list', {})).data.worker_guide, /Updated advice/);
  const written = await call('ticket_note', note);
  assert.equal(written.ok, true);
  assert.deepEqual(await call('ticket_note', note), written);
  await rm(guide);
  assert.equal(
    (await call('ticket_note', { ...note, idempotency_key: randomUUID() })).error.code,
    'WORKER_GUIDE_UNAVAILABLE',
  );
  assert.equal(
    (await call('work_release', { ...args, claim_token, idempotency_key: randomUUID(), reason: 'Handoff' }))
      .ok,
    true,
  );
  assert.match(logs, /mcp_relay_pinned/);
  assert.equal(logs.match(/mcp_relay_ready/g)?.length, 1);
  assert.doesNotMatch(logs, /mcp_relay_switched/);
});

it('bootstraps a durable local agent and indexes eventual SQLite search without an external worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-stdio-test-'));
  const filename = join(directory, 'tickets.sqlite');
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.STORAGE_ADAPTER = 'sqlite';
  env.SQLITE_PATH = filename;
  env.EMBEDDING_PROVIDER = 'none';
  delete env.ACTOR_ID;
  delete env.TICKETING_GITHUB_REPOSITORY;
  let projectId: string | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new Client({ name: 'local-stdio-test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/cli.ts', 'stdio', '--sqlite', filename, '--profile', 'full'],
        env,
        stderr: 'pipe',
      });
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const response = result.structuredContent as any;
        assert.equal(response?.ok, true, JSON.stringify(response?.error));
        return response.data;
      };
      try {
        await client.connect(transport);
        if (attempt === 0) {
          const project = await call('project_create', {
            key: 'LOCAL',
            name: 'Local stdio',
            policy: 'self',
            execution_hints: { model: 'future/model', effort: 'xhigh' },
            idempotency_key: randomUUID(),
          });
          projectId = project.id;
          const created = await call('tickets_create', {
            project_id: projectId,
            idempotency_key: randomUUID(),
            tickets: [
              {
                title: 'Lexical search',
                description: 'Distinctive durable local search proof.',
                criteria: ['Search finds this task.'],
                status: 'ready',
              },
            ],
          });
          let found = false;
          for (let poll = 0; poll < 40; poll++) {
            const result = await call('search', { project_id: projectId, query: 'Distinctive' });
            assert.match(result.degraded, /disabled/);
            if (result.results.some((item: any) => item.id === created.tickets[0].id)) {
              found = true;
              break;
            }
            await delay(100);
          }
          assert.equal(found, true, 'No inline worker indexed the ticket.');
          const current = await call('ticket_get', {
            project_id: projectId,
            ticket_id: created.tickets[0].id,
          });
          assert.deepEqual(current.effective_execution_hints, { model: 'future/model', effort: 'xhigh' });
        } else
          assert.ok(
            (await call('project_list', {})).projects.some((project: any) => project.id === projectId),
          );
      } finally {
        await client.close();
      }
    }
    const adapters = createSqliteAdapters(filename);
    try {
      await adapters.storage.migrate();
      const actors = await adapters.storage.find('actors', {
        where: { issuer: 'local-stdio', subject: 'local-mcp' },
      });
      assert.equal(actors.length, 1);
      assert.equal(actors[0]!.kind, 'agent');
      assert.equal(actors[0]!.system_admin, true);
    } finally {
      await adapters.search.close();
      await adapters.storage.close();
    }
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('ticketing-stdio-test-'));
    await rm(target, { recursive: true, force: true });
  }
});
