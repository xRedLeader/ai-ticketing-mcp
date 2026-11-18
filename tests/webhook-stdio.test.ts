import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { SignedWebhook } from '../src/webhook.js';
import { fixture } from '../src/testing/contracts.js';

it(
  'waits for delivery acknowledgement before closing storage after an indexing loop failure',
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-webhook-worker-'));
    const filename = join(directory, 'tickets.sqlite');
    const server = createServer((req, res) => {
      req.resume();
      setTimeout(() => res.writeHead(204).end(), 200);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/hooks`,
      secret = 'test-only-worker-secret-at-least-32-bytes';
    const adapters = createSqliteAdapters(filename);
    let closed = false;
    try {
      await adapters.storage.migrate();
      const f = await fixture(adapters);
      const app = createApplication({ ...adapters, webhook: new SignedWebhook(url, secret) });
      await app.execute(f.worker.id, 'tickets_create', {
        project_id: f.project.id,
        idempotency_key: randomUUID(),
        tickets: [
          { title: 'lifecycle test', description: 'lifecycle test', criteria: ['Acknowledgement persists.'] },
        ],
      });
      const delivery = (await adapters.storage.find('outbound_deliveries'))[0]!;
      await adapters.search.close();
      await adapters.storage.close();
      closed = true;
      const db = new DatabaseSync(filename);
      try {
        db.exec('DROP TABLE jobs');
      } finally {
        db.close();
      }
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'src/cli.ts', 'worker', '--once', '--sqlite', filename],
          {
            env: {
              ...process.env,
              STORAGE_ADAPTER: 'sqlite',
              SQLITE_PATH: filename,
              EMBEDDING_PROVIDER: 'none',
              TICKETING_WEBHOOK_URL: url,
              TICKETING_WEBHOOK_SECRET: secret,
              TICKETING_GITHUB_REPOSITORY: '',
            },
            timeout: 8000,
            windowsHide: true,
          },
        ),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.equal(error.stderr.includes(secret), false);
          return true;
        },
      );
      const reopened = createSqliteAdapters(filename);
      try {
        assert.ok((await reopened.storage.get('outbound_deliveries', delivery.id))!.sent_at);
      } finally {
        await reopened.search.close();
        await reopened.storage.close();
      }
    } finally {
      if (!closed) {
        await adapters.search.close();
        await adapters.storage.close();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const path = resolve(directory);
      assert.equal(dirname(path), resolve(tmpdir()));
      assert.ok(basename(path).startsWith('ticketing-webhook-worker-'));
      await rm(path, { recursive: true, force: true });
    }
  },
);

it(
  'keeps SQLite stdio mutations and indexing moving while a webhook receiver stalls',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-webhook-stdio-'));
    let accepted!: () => void;
    const receiving = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const server = createServer((req) => {
      req.resume();
      accepted();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const secret = 'test-only-stdio-secret-at-least-32-bytes';
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    Object.assign(env, {
      STORAGE_ADAPTER: 'sqlite',
      SQLITE_PATH: join(directory, 'tickets.sqlite'),
      EMBEDDING_PROVIDER: 'none',
      TICKETING_WEBHOOK_URL: `http://127.0.0.1:${address.port}/hooks?private=destination-secret`,
      TICKETING_WEBHOOK_SECRET: secret,
    });
    delete env.ACTOR_ID;
    delete env.TICKETING_GITHUB_REPOSITORY;
    const client = new Client({ name: 'webhook-stdio-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts', 'stdio', '--profile', 'full'],
      env,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const response = result.structuredContent as any;
        assert.equal(response?.ok, true, JSON.stringify(response?.error));
        return response.data;
      };
      const project = await call('project_create', {
        key: 'HOOK',
        name: 'Webhook test',
        idempotency_key: randomUUID(),
      });
      const create = (title: string) =>
        call('tickets_create', {
          project_id: project.id,
          idempotency_key: randomUUID(),
          tickets: [
            { title, description: title, criteria: ['Receiver cannot block work.'], status: 'ready' },
          ],
        });
      await create('First notification');
      await Promise.race([
        receiving,
        delay(4000).then(() => {
          throw new Error('Inline delivery loop did not start.');
        }),
      ]);
      const started = performance.now();
      const second = await create('Distinctivestalledreceiver');
      let indexed = false;
      for (let poll = 0; poll < 30; poll++) {
        const result = await call('search', { project_id: project.id, query: 'Distinctivestalledreceiver' });
        if (result.results.some((item: any) => item.id === second.tickets[0].id)) {
          indexed = true;
          break;
        }
        await delay(100);
      }
      assert.equal(indexed, true);
      assert.ok(performance.now() - started < 4000, 'Indexing waited for the five-second receiver timeout.');
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(stderr.includes(secret), false);
      assert.equal(stderr.includes('destination-secret'), false);
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith('ticketing-webhook-stdio-'));
      await rm(target, { recursive: true, force: true });
    }
  },
);
