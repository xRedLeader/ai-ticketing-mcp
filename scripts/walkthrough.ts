import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/mcp.js';
import type { Actor } from '../src/contracts.js';
import type { McpProfile } from '../src/profiles.js';

try {
  process.loadEnvFile();
} catch {
  /* Environment variables may be supplied directly. */
}
process.env.DATABASE_URL ??= `postgresql://ticketing_app:${process.env.APP_DB_PASSWORD}@127.0.0.1:${process.env.DB_PORT ?? 5432}/ticketing`;
if (process.env.EMBEDDING_URL === 'http://ollama:11434') process.env.EMBEDDING_URL = 'http://127.0.0.1:11434';
const app = createRuntime();
const clients: Client[] = [];
async function connect(actor: Actor, profile: McpProfile) {
  const server = createMcpServer(
    app,
    {
      actorId: actor.id,
      scopes: new Set(['ticketing:read', 'ticketing:write']),
    },
    profile,
  );
  const client = new Client({ name: actor.name, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const result = response.structuredContent as any;
  if (!result?.ok) throw new Error(JSON.stringify(result?.error ?? response));
  return result.data;
}
try {
  const identities = ['operator', 'builder', 'verifier'].map((name, i): Actor => ({
    id: randomUUID(),
    issuer: 'local',
    subject: `walkthrough-${name}-${randomUUID()}`,
    name,
    kind: i === 0 ? 'human' : 'agent',
    system_admin: i === 0,
  }));
  await app.storage.transaction('catalog', async (tx) => {
    for (const actor of identities) await tx.put('actors', actor);
  });
  const [operator, builder, verifier] = await Promise.all(
    identities.map((actor, index) => connect(actor, (['full', 'worker', 'reviewer'] as const)[index]!)),
  );
  const project = await call(operator!, 'project_create', {
    key: 'DEMO' + randomUUID().slice(0, 6).toUpperCase(),
    name: 'Two-agent walkthrough',
    instructions: 'Demonstrate durable handoffs and independent evidence review.',
    idempotency_key: randomUUID(),
  });
  for (const [i, role] of [
    [1, 'contributor'],
    [2, 'verifier'],
  ] as const)
    await call(operator!, 'member_set', {
      project_id: project.id,
      actor_id: identities[i]!.id,
      role,
      idempotency_key: randomUUID(),
    });
  const created = await call(operator!, 'tickets_create', {
    project_id: project.id,
    idempotency_key: randomUUID(),
    tickets: [
      {
        title: 'Document the safe claim protocol',
        description: 'Explain leases, heartbeats, and stale worker rejection.',
        status: 'ready',
        criteria: ['Document ten-minute leases.', 'Explain why old claim tokens cannot submit.'],
      },
    ],
  });
  const ticket = created.tickets[0];
  const claimed = await call(builder!, 'work_claim', {
    project_id: project.id,
    ticket_id: ticket.id,
    idempotency_key: randomUUID(),
  });
  const checkpoint = await call(builder!, 'ticket_checkpoint', {
    project_id: project.id,
    ticket_id: ticket.id,
    claim_token: claimed.claim.token,
    idempotency_key: randomUUID(),
    progress: 'Documented claim expiration and fencing.',
    remaining: ['Independent review'],
    references: ['https://github.com/xRedLeader/ai-ticketing-mcp/blob/main/docs/mcp.md'],
  });
  const current = claimed.context;
  const submitted = await call(builder!, 'ticket_submit', {
    project_id: project.id,
    ticket_id: ticket.id,
    claim_token: claimed.claim.token,
    expected_revision: checkpoint.ticket.revision,
    idempotency_key: randomUUID(),
    summary: 'Workflow documentation covers both requirements.',
    evidence: current.criteria.map((criterion: any) => ({
      criterion_id: criterion.id,
      result: 'pass',
      summary: 'Covered by the MCP workflow documentation.',
      references: ['https://github.com/xRedLeader/ai-ticketing-mcp/blob/main/docs/mcp.md'],
    })),
  });
  const reviewContext = await call(verifier!, 'ticket_context', {
    project_id: project.id,
    ticket_id: ticket.id,
  });
  for (const omitted of reviewContext.omitted)
    if (omitted.required_before === 'review') await call(verifier!, omitted.retrieve_with, omitted.arguments);
  const review = await call(verifier!, 'ticket_review', {
    project_id: project.id,
    ticket_id: ticket.id,
    submission_id: submitted.submission.id,
    expected_revision: reviewContext.ticket.revision,
    idempotency_key: randomUUID(),
    decision: 'approve',
    feedback:
      'Demo verifier checked that evidence exists for every criterion. This walkthrough demonstrates the protocol, not independent execution of external checks.',
  });
  await app.indexOnce(100);
  const context = await call(verifier!, 'ticket_context', {
    project_id: project.id,
    ticket_id: ticket.id,
    detail: 'standard',
  });
  console.log(
    JSON.stringify(
      {
        project_id: project.id,
        ticket_id: ticket.id,
        ticket_key: ticket.key,
        status: review.ticket.status,
        checkpoint: context.latest_checkpoint?.body,
        verification: 'Independent MCP identity',
        indexed_jobs_processed: app.metrics.indexed,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await app.storage.close();
}
