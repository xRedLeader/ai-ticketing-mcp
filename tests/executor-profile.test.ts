import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import { createHttpServer } from '../src/http.js';
import { ExecutionCompanion } from '../src/execution-companion.js';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';
import { HostCapacity } from '../src/host-capacity.js';
import { profileOperations } from '../src/profiles.js';
import { countReferenceTokens } from '../src/tokens.js';
import { fixture } from '../src/testing/contracts.js';

for (const transport of ['http', 'stdio'] as const)
  it(`executor ${transport} SDK recovers disconnected runs, omissions and exact failure evidence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-executor-'));
    const filename = join(directory, 'tickets.sqlite');
    const adapters = createSqliteAdapters(filename);
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const config = {
      workspace_roots: [directory],
      recipes: [
        {
          id: 'fixture',
          project_ids: [f.project.id],
          executable: process.execPath,
          argv: [
            '-e',
            'process.stdout.write("exact stdout 🧪");process.stderr.write("fixture.ts:7: failure\\n");process.exitCode=7',
          ],
          cwd: directory,
          env: {},
          timeout_ms: 10000,
        },
      ],
    };
    const recipes = new ExecutionRecipeRegistry(config);
    const recipesFile = join(directory, 'recipes.json');
    await writeFile(recipesFile, JSON.stringify(config));
    const artifacts = join(directory, 'artifacts');
    const app = createApplication({
      ...adapters,
      executionRecipes: recipes.metadata(),
      executionArtifacts: { directory: artifacts },
    });
    const capacity = new HostCapacity(join(directory, 'capacity.sqlite'));
    capacity.configureHost('test');
    const server = createHttpServer(app, {
      publicUrl: 'http://127.0.0.1',
      issuer: 'http://127.0.0.1/issuer',
      authenticate: async (authorization) => ({
        actorId: authorization === `Bearer ${f.admin.id}` ? f.admin.id : f.worker.id,
        scopes: new Set(['ticketing:read', 'ticketing:write']),
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const connect = async (actorId = f.worker.id) => {
      const client = new Client({ name: 'executor-test', version: '1' });
      if (transport === 'http')
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp?profile=executor`),
            { requestInit: { headers: { Authorization: `Bearer ${actorId}` } } },
          ),
        );
      else {
        const env = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        const stdio = new StdioClientTransport({
          command: process.execPath,
          args: [
            '--import',
            'tsx',
            'src/cli.ts',
            'stdio',
            '--sqlite',
            filename,
            '--actor',
            actorId,
            '--profile',
            'executor',
          ],
          env: {
            ...env,
            MCP_PROFILE_CAPTURE: 'false',
            EMBEDDING_PROVIDER: 'none',
            EXECUTION_RECIPES_FILE: recipesFile,
            EXECUTION_ARTIFACTS_DIRECTORY: artifacts,
          },
          stderr: 'pipe',
        });
        let stderr = '';
        stdio.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        try {
          await client.connect(stdio);
        } catch (error) {
          throw new Error(stderr, { cause: error });
        }
      }
      return client;
    };
    let client: Client | undefined;
    try {
      client = await connect();
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(({ name }) => name).sort(), [...profileOperations.executor].sort());
      const tokens = countReferenceTokens(
        JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ),
      );
      assert.ok(tokens <= 5000, `Executor input catalog: ${tokens}`);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args });
        assert.ok(!result.isError, JSON.stringify(result));
        return (result.structuredContent as any).data;
      };
      const ticket = await f.ticket();
      const claim = await call('work_claim', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        idempotency_key: randomUUID(),
      });
      const progress = Array.from({ length: 500 }, (_, index) => 'checkpoint-' + index).join(' ');
      const input = {
        project_id: f.project.id,
        ticket_id: ticket.id,
        claim_token: claim.claim.token,
        idempotency_key: randomUUID(),
        recipe_id: 'fixture',
        checkpoint: { progress },
        completion_condition: { kind: 'exit_code', exit_code: 0 },
      };
      const submitted = await call('run_submit', input);
      assert.deepEqual(await call('run_submit', input), submitted);
      const denied = await client.callTool({
        name: 'run_cancel',
        arguments: { project_id: f.project.id, run_id: submitted.run_id, idempotency_key: randomUUID() },
      });
      assert.equal((denied.structuredContent as any).error.code, 'FORBIDDEN');
      await client.close();
      client = await connect();
      const queued = await call(submitted.retrieval.tool, {
        ...submitted.retrieval.arguments,
        max_tokens: 512,
      });
      assert.equal(queued.run.status, 'queued');
      const context = await call('ticket_context', {
        project_id: f.project.id,
        ticket_id: ticket.id,
        max_tokens: 1024,
      });
      const required = context.omitted.filter((omitted: any) => omitted.required_before === 'execution');
      assert.ok(required.length > 0);
      for (const omitted of required) {
        assert.ok(profileOperations.executor.includes(omitted.retrieve_with));
        const recovered = await call(omitted.retrieve_with, omitted.arguments);
        assert.ok(JSON.stringify(recovered).includes(progress));
      }
      assert.equal(
        await new ExecutionCompanion({
          application: app,
          recipes,
          capacity,
          actor_id: f.admin.id,
          project_id: f.project.id,
          host_id: 'test',
          artifacts_directory: artifacts,
        }).runOnce(),
        true,
      );
      const result = await call('run_wait', {
        project_id: f.project.id,
        run_id: submitted.run_id,
        timeout_ms: 0,
        max_tokens: 1024,
      });
      assert.equal(result.run.exit_code, 7);
      assert.equal(result.run.status, 'failed');
      assert.equal(result.checkpoint, null);
      for (const omitted of [...queued.omitted, ...result.omitted]) {
        assert.ok(profileOperations.executor.includes(omitted.retrieve_with));
        const recovered = await call(omitted.retrieve_with, omitted.arguments);
        if (omitted.section === 'checkpoint') assert.equal(recovered.body, progress);
      }
      const failure = await call(result.failure_location.tool, result.failure_location.arguments);
      const bytes = Buffer.from('fixture.ts:7: failure\n');
      assert.deepEqual(Buffer.from(failure.range.data, 'base64'), bytes);
      assert.equal(failure.range.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(failure.range.complete, true);
      await client.close();
      client = await connect(f.admin.id);
      const cancellation = {
        project_id: f.project.id,
        run_id: submitted.run_id,
        idempotency_key: randomUUID(),
      };
      const cancelled = await call('run_cancel', cancellation);
      assert.deepEqual(await call('run_cancel', cancellation), cancelled);
      assert.equal(cancelled.effects_state, 'unresolved');
      const recovery = await call(cancelled.retrieval.tool, cancelled.retrieval.arguments);
      assert.equal(recovery.reconciliation.next_step, 'inspect_side_effects');
    } finally {
      await client?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      capacity.close();
      await adapters.storage.close();
      await adapters.search.close();
      assert.ok(directory.startsWith(join(tmpdir(), 'ticketing-executor-')));
      await rm(directory, { recursive: true, force: true });
    }
  });
