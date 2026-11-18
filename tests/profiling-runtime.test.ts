import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Application } from '../src/application.js';
import { DomainError } from '../src/contracts.js';
import { createHttpServer } from '../src/http.js';
import { createProfileRecorder } from '../src/profiling.js';

async function records(directory: string) {
  const files = (await readdir(directory)).filter((name) => /^events-\d+\.jsonl$/.test(name)).sort();
  return (await Promise.all(files.map((name) => readFile(join(directory, name), 'utf8'))))
    .flatMap((text) => text.trim().split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}
async function removeFixture(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('ticketing-profile-runtime-'));
  await rm(directory, { recursive: true, force: true });
}

it('captures HTTP discovery, tools, prompts and resources without changing any MCP result or recording headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-profile-runtime-'));
  const recorder = await createProfileRecorder({ directory });
  const received: unknown[] = [];
  const bearer = 'Bearer header-only-test-value';
  try {
    for (const profiler of [undefined, recorder]) {
      const app = {
        async execute(_actor: string, operation: string) {
          assert.equal(operation, 'project_list');
          return { projects: [] };
        },
      } as unknown as Application;
      const server = createHttpServer(app, {
        publicUrl: 'http://127.0.0.1',
        issuer: 'http://127.0.0.1/issuer',
        authenticate: async (authorization) => {
          if (authorization !== bearer) throw new DomainError('UNAUTHENTICATED', 'Missing token.');
          return { actorId: 'fixture-actor', scopes: new Set(['ticketing:read']) };
        },
        profiler,
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
      const client = new Client({ name: 'capture-parity', version: '1.0.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: bearer } } }),
        );
        received.push({
          catalog: await client.listTools(),
          prompts: await client.listPrompts(),
          prompt: await client.getPrompt({ name: 'execution' }),
          resource: await client.readResource({ uri: 'ticketing://guide' }),
          result: await client.callTool({ name: 'project_list', arguments: {} }),
        });
        assert.equal((await client.callTool({ name: 'ticket_get', arguments: {} })).isError, true);
        await assert.rejects(client.callTool({ name: 'missing_tool', arguments: {} }));
        const unauthorized = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(unauthorized.status, 401);
      } finally {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }
    await recorder.close();
    assert.deepEqual(received[0], received[1]);
    const events = await records(recorder.runDirectory);
    const messages = events
      .filter((item) => item.type === 'message')
      .map((item) => ({ ...item, rpc: JSON.parse(item.payload) }));
    for (const method of [
      'initialize',
      'tools/list',
      'tools/call',
      'prompts/list',
      'prompts/get',
      'resources/read',
    ])
      assert.ok(
        messages.some((item) => item.direction === 'incoming' && item.rpc.method === method),
        method,
      );
    assert.ok(messages.some((item) => item.direction === 'outgoing' && item.rpc.error));
    assert.equal(JSON.stringify(events).includes(bearer), false);
    assert.ok(new Set(messages.map((item) => item.connection_id)).size > 1);
    const output = join(directory, 'report.json');
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'profile-report',
        '--input',
        recorder.runDirectory,
        '--output',
        output,
      ],
      {
        env: { ...process.env, DATABASE_URL: '', STORAGE_ADAPTER: 'invalid-not-needed-for-report' },
        windowsHide: true,
      },
    );
    const report = await readFile(output, 'utf8');
    assert.ok(report.includes('tools/call'));
    assert.equal(report.includes('header-only-test-value'), false);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          'profile-report',
          '--input',
          recorder.runDirectory,
          '--output',
          output,
        ],
        { windowsHide: true },
      ),
    );
    assert.equal(await readFile(output, 'utf8'), report);
    const manifestPath = join(recorder.runDirectory, 'run.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'open' }));
    const incompleteOutput = join(directory, 'incomplete.json');
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          'profile-report',
          '--input',
          recorder.runDirectory,
          '--output',
          incompleteOutput,
        ],
        { windowsHide: true },
      ),
      (error: any) => error.code === 2,
    );
    assert.equal(JSON.parse(await readFile(incompleteOutput, 'utf8')).complete, false);
  } finally {
    await recorder.close();
    await removeFixture(directory);
  }
});

it('defaults stdio capture on, preserves explicit opt-out, and flushes without stdout pollution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-profile-runtime-'));
  const captures = join(directory, 'captures');
  try {
    const brokenDiagnostic = join(directory, 'broken-diagnostic.cjs');
    await writeFile(
      brokenDiagnostic,
      `const fs = require('node:fs');
const original = fs.write;
fs.write = (...args) => args[0] === 2
  ? process.nextTick(() => args.at(-1)(new Error('fixture diagnostic failure')))
  : original(...args);
require('node:module').syncBuiltinESMExports();
process.stderr.write = () => { throw new Error('fixture broken stderr stream'); };
`,
    );
    const results: unknown[] = [];
    for (const enabled of ['false', 'unset', 'true', 'broken-stderr']) {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined &&
            !/^(MCP_PROFILE_|REFERENCE_TOKEN_|TICKETING_|EMBEDDING_|ACTOR_ID|DATABASE_URL)/.test(key),
        ),
      ) as Record<string, string>;
      Object.assign(env, {
        STORAGE_ADAPTER: 'sqlite',
        EMBEDDING_PROVIDER: 'none',
        MCP_PROFILE_DIRECTORY: captures,
      });
      if (enabled === 'false' || enabled === 'true') env.MCP_PROFILE_CAPTURE = enabled;
      if (enabled === 'false') env.MCP_PROFILE_MAX_FILE_BYTES = 'ignored-while-disabled';
      const client = new Client({ name: 'stdio-capture-parity', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...(enabled === 'broken-stderr' ? ['--no-warnings', '--require', brokenDiagnostic] : []),
          '--import',
          'tsx',
          'src/cli.ts',
          'stdio',
          '--sqlite',
          join(directory, `${enabled}.sqlite`),
        ],
        env,
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        results.push({
          catalog: await client.listTools(),
          result: await client.callTool({ name: 'project_list', arguments: {} }),
        });
      } finally {
        await client.close();
      }
      if (enabled === 'false') await assert.rejects(readdir(captures), { code: 'ENOENT' });
    }
    for (const result of results.slice(1)) assert.deepEqual(results[0], result);
    const runs = await readdir(captures);
    assert.equal(runs.length, 3);
    for (const run of runs) {
      const events = await records(join(captures, run));
      assert.ok(
        events.some((item) => item.type === 'message' && JSON.parse(item.payload).method === 'tools/call'),
      );
      assert.ok(events.some((item) => item.type === 'send_result' && item.outcome === 'sent'));
    }
  } finally {
    await removeFixture(directory);
  }
});
