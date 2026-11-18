import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Application } from '../src/application.js';
import { DomainError } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { createHttpServer } from '../src/http.js';
import { parseMcpProfile, profileOperations, type McpProfile } from '../src/profiles.js';
import { schemas } from '../src/schemas.js';

const shared = [
  'project_list',
  'project_get',
  'ticket_list',
  'ticket_context',
  'ticket_get',
  'ticket_history',
  'search',
  'knowledge_get',
  'checkpoint_get',
  'changes_since',
];
const expected = {
  worker: [
    ...shared,
    'work_claim',
    'work_heartbeat',
    'work_release',
    'ticket_checkpoint',
    'ticket_note',
    'ticket_submit',
  ],
  planner: [
    ...shared,
    'tickets_create',
    'ticket_update',
    'ticket_transition',
    'ticket_link',
    'ticket_note',
    'knowledge_write',
    'ticket_github_refresh',
  ],
  reviewer: [...shared, 'ticket_review', 'ticket_note', 'ticket_github_refresh'],
  full: Object.keys(schemas),
};
const prompts = {
  worker: ['execution', 'handoff'],
  planner: ['planning'],
  reviewer: ['verification'],
  full: ['planning', 'execution', 'handoff', 'verification'],
};

it('keeps the exact immutable profile catalogs and validates explicit profile names', () => {
  assert.equal(parseMcpProfile(undefined), 'worker');
  for (const profile of Object.keys(expected) as McpProfile[]) {
    assert.equal(parseMcpProfile(profile), profile);
    assert.deepEqual([...profileOperations[profile]].sort(), expected[profile].sort());
    assert.equal(new Set(profileOperations[profile]).size, profileOperations[profile].length);
    assert.ok(Object.isFrozen(profileOperations[profile]));
  }
  for (const profile of ['', 'Worker', 'unknown', '__proto__', ' worker'])
    assert.throws(() => parseMcpProfile(profile), { code: 'INVALID_INPUT' });
});

it('serializes recursively ordered JSON envelopes while preserving standard JSON values', () => {
  const left = { z: [{ b: 2, a: 1 }, 7], a: { y: 'literal <|endoftext|>', x: 1 } };
  const right = { a: { x: 1, y: 'literal <|endoftext|>' }, z: [{ a: 1, b: 2 }, 7] };
  assert.equal(serializeSuccessEnvelope(left), serializeSuccessEnvelope(right));
  assert.equal(serializeSuccessEnvelope(left), serializeSuccessEnvelope(JSON.parse(JSON.stringify(left))));
  assert.notEqual(serializeSuccessEnvelope([1, 2]), serializeSuccessEnvelope([2, 1]));
  const data = {
    missing: undefined,
    date: new Date('2026-01-02T03:04:05Z'),
    number: new Number(4),
    values: [undefined, NaN, Infinity],
    custom: { toJSON: () => ({ z: 2, a: 1 }) },
  };
  assert.deepEqual(
    JSON.parse(serializeSuccessEnvelope(data)),
    JSON.parse(JSON.stringify({ ok: true, data, error: null })),
  );
  assert.throws(() => serializeSuccessEnvelope(1n), TypeError);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => serializeSuccessEnvelope(cycle), TypeError);
});

it('serves profile-specific HTTP catalogs and prompts without changing scope authorization', async () => {
  let executions = 0;
  const app = {
    async execute(_actor: string, operation: string) {
      executions++;
      if (operation === 'project_list') return { projects: [] };
      throw new DomainError('FORBIDDEN', 'Project access denied.');
    },
  } as unknown as Application;
  const server = createHttpServer(app, {
    publicUrl: 'http://127.0.0.1',
    issuer: 'http://127.0.0.1/issuer',
    authenticate: async () => ({ actorId: 'actor', scopes: new Set(['ticketing:read']) }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const profile of Object.keys(expected) as McpProfile[]) {
      const client = new Client({ name: `profile-${profile}`, version: '1.0.0' });
      try {
        const suffix = profile === 'worker' ? '' : `?profile=${profile}`;
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${suffix}`)));
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
          expected[profile].sort(),
        );
        assert.deepEqual(
          (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(),
          prompts[profile].sort(),
        );
        if (profile !== 'full') assert.ok(!client.getInstructions()?.includes('work_next'));
        const result = await client.callTool({ name: 'project_list', arguments: {} });
        assert.deepEqual(result.structuredContent, { ok: true, data: { projects: [] }, error: null });
        assert.equal(
          (result.content[0] as { text: string }).text,
          serializeSuccessEnvelope({ projects: [] }),
        );
        const before = executions;
        const mutation =
          profile === 'planner' ? 'ticket_note' : profile === 'reviewer' ? 'ticket_review' : 'work_claim';
        const denied = await client.callTool({
          name: mutation,
          arguments: {
            project_id: 'dc71df55-80ee-4ca1-a22d-ecdc40566c79',
            ticket_id: 'TST-1',
            idempotency_key: 'scope-test',
            ...(mutation === 'ticket_review'
              ? {
                  expected_revision: 1,
                  submission_id: 'dc71df55-80ee-4ca1-a22d-ecdc40566c79',
                  decision: 'approve',
                  feedback: 'Checked',
                }
              : mutation === 'ticket_note'
                ? { body: 'Note' }
                : {}),
          },
        });
        assert.equal(denied.isError, true);
        assert.equal((denied.structuredContent as any).error.code, 'INSUFFICIENT_SCOPE');
        assert.equal(executions, before);
        if (profile !== 'full') {
          await assert.rejects(
            client.callTool({ name: 'project_create', arguments: {} }),
            /not found|unknown tool/i,
          );
          assert.equal(executions, before);
        }
        await assert.rejects(
          client.readResource({ uri: 'ticketing://project/dc71df55-80ee-4ca1-a22d-ecdc40566c79' }),
          /access denied/i,
        );
      } finally {
        await client.close();
      }
    }
    for (const query of ['profile=', 'profile=unknown', 'profile=worker&profile=worker']) {
      const response = await fetch(`${base}/mcp?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: string }).error, 'INVALID_INPUT');
    }
    const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
    };
    assert.equal(metadata.resource, 'http://127.0.0.1/mcp');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
