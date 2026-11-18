import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const filename = process.env.MCP_BENCH_FIXTURE;
assert.ok(filename, 'An explicit isolated benchmark fixture is required.');
const config = JSON.parse(await readFile(filename, 'utf8'));
assert.equal(config.version, 1);
assert.equal(resolve(config.database), join(dirname(resolve(filename)), 'fixture.sqlite'));
assert.equal(process.env.ACTOR_ID, config.actorId, 'No inherited actor fallback is permitted.');
const load = (name) => import(pathToFileURL(join(config.runtimeRoot, 'dist', name)).href);
const [{ createApplication }, { createSqliteAdapters }, { createMcpServer }, { DomainError }] =
  await Promise.all([
    load('application.js'),
    load('adapters/sqlite.js'),
    load('mcp.js'),
    load('contracts.js'),
  ]);
const { storage, search } = createSqliteAdapters(config.database);
await storage.migrate();
const actor = await storage.get('actors', config.actorId);
const project = await storage.get('projects', config.projectId);
assert.ok(actor && !actor.system_admin && actor.kind === 'agent');
assert.equal(project?.name, config.projectName, 'The server must open its seeded fixture project.');
let now = Date.parse(config.clock);
let changed = (await storage.get('tickets', config.ticketId)).requirements_revision > 1;
let staleCheckpoint = false;
let stopping = false;
const app = createApplication({ storage, search, now: () => new Date(now) });
const execute = app.execute.bind(app);
app.execute = async (actorId, operation, input) => {
  let sharedState = JSON.parse(await readFile(config.maintenanceState, 'utf8'));
  now = Date.parse(sharedState.clock);
  if (config.channel === 'model' && ['ticket_checkpoint', 'ticket_submit'].includes(operation)) {
    const needed = config.workflow.change && !staleCheckpoint ? 1 : 2;
    for (;;) {
      if (stopping) throw new Error('Benchmark MCP connection closed.');
      const state = JSON.parse(await readFile(config.maintenanceState, 'utf8'));
      if (state.status === 'failed')
        throw new DomainError(
          'BENCHMARK_MAINTENANCE_FAILED',
          'The observed maintenance sidecar failed. Stop and report this run as incomplete.',
        );
      if (state.completed_intervals >= needed) {
        sharedState = state;
        now = Date.parse(state.clock);
        break;
      }
      await delay(10);
    }
  }
  let result;
  try {
    result = await execute(actorId, operation, input);
  } catch (error) {
    if (config.workflow.change && operation === 'ticket_checkpoint' && error.code === 'CLAIM_EXPIRED')
      staleCheckpoint = true;
    throw error;
  }
  if (config.workflow.change && operation === 'work_heartbeat' && !changed) {
    const ticket = await storage.get('tickets', config.ticketId);
    await execute(config.adminId, 'ticket_update', {
      project_id: config.projectId,
      ticket_id: ticket.id,
      expected_revision: ticket.revision,
      idempotency_key: randomUUID(),
      criteria: ['The access check also rejects a revoked project member without revealing ticket data.'],
    });
    changed = true;
  }
  if (config.workflow.blocking && operation === 'ticket_note' && input.kind === 'answer') {
    await storage.transaction(config.projectId, async (tx) => {
      const prerequisite = await tx.get('tickets', config.prerequisiteId);
      if (prerequisite.status !== 'done')
        await tx.put('tickets', { ...prerequisite, status: 'done', revision: prerequisite.revision + 1 });
    });
  }
  return result;
};
const server = createMcpServer(
  app,
  { actorId: config.actorId, scopes: new Set(['ticketing:read', 'ticketing:write']) },
  config.role,
);
await server.connect(new StdioServerTransport());
let closing;
const close = () => {
  stopping = true;
  return (closing ??= (async () => {
    await server.close();
    await search.close();
    await storage.close();
  })());
};
process.stdin.once('end', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
