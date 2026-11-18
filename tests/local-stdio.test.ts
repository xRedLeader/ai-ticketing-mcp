import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';

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
