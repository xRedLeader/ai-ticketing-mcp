import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Application } from '../src/application.js';
import { DomainError } from '../src/contracts.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { createHttpServer } from '../src/http.js';
import { createMcpServer } from '../src/mcp.js';
import { parseMcpProfile, profileOperations, type McpProfile } from '../src/profiles.js';
import { schemas } from '../src/schemas.js';
import { countReferenceTokens } from '../src/tokens.js';

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
  executor: [
    'project_list',
    'project_get',
    'ticket_list',
    'ticket_context',
    'ticket_get',
    'ticket_history',
    'checkpoint_get',
    'work_claim',
    'work_release',
    'ticket_note',
    'ticket_submit',
    'run_submit',
    'run_wait',
    'run_get',
    'run_cancel',
    'artifact_read',
  ],
  planner: [
    ...shared,
    'idea_create',
    'idea_list',
    'idea_get',
    'idea_triage',
    'spike_schedule',
    'spike_list',
    'spike_get',
    'milestone_list',
    'milestone_get',
    'milestone_create',
    'milestone_update',
    'milestone_complete',
    'ticket_milestone_set',
    'tickets_create',
    'ticket_update',
    'ticket_transition',
    'ticket_link',
    'ticket_note',
    'knowledge_write',
    'ticket_github_refresh',
  ],
  reviewer: [...shared, 'ticket_review', 'ticket_note', 'ticket_github_refresh', 'artifact_read'],
  researcher: [
    'project_list',
    'project_get',
    'idea_get',
    'spike_list',
    'spike_get',
    'spike_claim',
    'spike_complete',
    'ticket_context',
    'ticket_get',
    'ticket_history',
    'checkpoint_get',
    'work_heartbeat',
    'work_release',
    'ticket_checkpoint',
    'ticket_note',
    'run_submit',
    'run_get',
    'run_wait',
    'artifact_read',
  ],
  full: Object.keys(schemas),
};
const prompts = {
  researcher: ['execution', 'handoff'],
  worker: ['execution', 'handoff'],
  executor: ['execution', 'handoff'],
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

it('requires delivery of the current worker guide on each connection before dispatching work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-worker-guide-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerGuideFile = join(directory, 'worker.json');
  const publish = (advice: string) => writeFile(workerGuideFile, JSON.stringify({ advice }));
  const requests: string[] = [];
  let allowListing = false;
  const app = {
    async execute(_actor: string, operation: string) {
      requests.push(operation);
      if (operation === 'project_list' && allowListing) return { projects: [] };
      throw new DomainError('FORBIDDEN', 'Operation denied.');
    },
  } as unknown as Application;
  for (const path of ['resource', 'tool', 'prompt']) {
    await publish('Start from the verified checkpoint.');
    const principal = { actorId: 'worker', scopes: new Set(['ticketing:read', 'ticketing:write']) };
    const server = createMcpServer(app, principal, 'worker', { workerGuideFile });
    const client = new Client({ name: 'worker', version: '1' }, { defaultCacheTtlMs: 600_000 });
    const [front, back] = InMemoryTransport.createLinkedPair();
    const project_id = 'dc71df55-80ee-4ca1-a22d-ecdc40566c79';
    const args = { project_id, ticket_id: 'SELF-1', idempotency_key: 'test-guide' };
    const note = () => client.callTool({ name: 'ticket_note', arguments: { ...args, body: 'Updated' } });
    const list = () => client.callTool({ name: 'project_list', arguments: {} });
    const errorCode = (reply: Awaited<ReturnType<typeof note>>) =>
      (reply.structuredContent?.error as { code: string }).code;
    try {
      await server.connect(back);
      await client.connect(front);
      assert.match(client.getInstructions()!, /ticketing:\/\/guide/);
      assert.doesNotMatch(client.getInstructions()!, /context returned by work_claim/);
      allowListing = false;
      assert.equal(errorCode(await list()), 'FORBIDDEN');
      principal.scopes.delete('ticketing:read');
      await assert.rejects(client.readResource({ uri: 'ticketing://guide' }), /scope/i);
      await assert.rejects(client.getPrompt({ name: 'execution' }), /scope/i);
      principal.scopes.add('ticketing:read');
      assert.equal(errorCode(await note()), 'WORKER_GUIDE_REQUIRED');
      assert.equal(requests.at(-1), 'project_list');
      for (const name of ['work_heartbeat', 'work_release']) {
        const call = await client.callTool({
          name,
          arguments: {
            ...args,
            claim_token: project_id,
            ...(name === 'work_release' ? { reason: 'Handoff' } : {}),
          },
        });
        assert.equal(errorCode(call), 'FORBIDDEN');
        assert.equal(requests.at(-1), name);
      }
      allowListing = true;
      if (path === 'tool') {
        const reply = await list();
        const data = reply.structuredContent?.data as { projects: unknown[]; worker_guide: string };
        assert.deepEqual(data.projects, []);
        assert.match(data.worker_guide, /Start from the verified checkpoint/);
        assert.deepEqual(JSON.parse((reply.content[0] as { text: string }).text), reply.structuredContent);
      } else if (path === 'resource') {
        const resource = await client.readResource({ uri: 'ticketing://guide' });
        assert.match(String(resource.contents[0]?.text), /Start from the verified checkpoint/);
      } else {
        const prompt = await client.getPrompt({ name: 'execution' });
        assert.match(JSON.stringify(prompt.messages), /Start from the verified checkpoint/);
      }
      await publish('Start from the verified checkpoint.');
      assert.equal(errorCode(await note()), 'FORBIDDEN');
      assert.equal(requests.at(-1), 'ticket_note');
      const before = requests.length;
      await rm(workerGuideFile);
      assert.equal(errorCode(await note()), 'WORKER_GUIDE_UNAVAILABLE');
      for (const invalid of [
        Buffer.from([0xff]),
        '{',
        '{}',
        '{"advice":2}',
        JSON.stringify({ advice: '  ' }),
        JSON.stringify({ advice: 'unsafe\0text' }),
        JSON.stringify({ advice: 'x'.repeat(8192) }),
      ]) {
        await writeFile(workerGuideFile, invalid);
        assert.equal(errorCode(await note()), 'WORKER_GUIDE_UNAVAILABLE');
      }
      await publish('Updated guidance');
      assert.equal(errorCode(await note()), 'WORKER_GUIDE_REQUIRED');
      assert.equal(requests.length, before);
      const latest = await client.readResource({ uri: 'ticketing://guide' });
      assert.match(String(latest.contents[0]?.text), /Updated guidance/);
      assert.equal(errorCode(await note()), 'FORBIDDEN');
    } finally {
      await client.close();
      await server.close();
    }
  }
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
  const catalogs = new Map<string, Awaited<ReturnType<Client['listTools']>>['tools']>();
  try {
    for (const profile of Object.keys(expected) as McpProfile[]) {
      const client = new Client({ name: `profile-${profile}`, version: '1.0.0' });
      try {
        const suffix = profile === 'worker' ? '' : `?profile=${profile}`;
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${suffix}`)));
        const { tools } = await client.listTools();
        catalogs.set(profile, tools);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), expected[profile].sort());
        if (profile === 'worker' || profile === 'executor')
          assert.ok(
            countReferenceTokens(
              JSON.stringify(
                tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
              ),
            ) <= 5000,
            `${profile} input catalog exceeds the protocol budget.`,
          );
        assert.deepEqual(
          (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(),
          prompts[profile].sort(),
        );
        if (profile !== 'full') assert.ok(!client.getInstructions()?.includes('work_next'));
        if (profile === 'worker') {
          const guide = await client.readResource({ uri: 'ticketing://guide' });
          const execution = await client.getPrompt({ name: 'execution' });
          const message = execution.messages[0]?.content;
          assert.ok(message?.type === 'text');
          for (const text of [
            client.getInstructions(),
            (guide.contents[0] as { text: string }).text,
            message.text,
          ]) {
            assert.match(String(text), /context returned by work_claim before issuing other ticket reads/);
            assert.match(String(text), /required omission before its dependent action/);
            assert.match(String(text), /requirements, authority, or lease change, read the current state/);
            assert.match(String(text), /replaying a claim receipt, read fresh ticket_context/);
          }
        }
        if (profile === 'executor') {
          const guide = await client.readResource({ uri: 'ticketing://guide' });
          assert.ok(!String((guide.contents[0] as { text: string }).text).includes('changes_since'));
          for (const name of ['execution', 'handoff']) {
            const prompt = await client.getPrompt({ name });
            assert.ok(!JSON.stringify(prompt).includes('work_heartbeat'));
            assert.ok(!JSON.stringify(prompt).includes('ticket_checkpoint'));
          }
        }
        const result = await client.callTool({ name: 'project_list', arguments: {} });
        assert.deepEqual(result.structuredContent, { ok: true, data: { projects: [] }, error: null });
        assert.equal(
          (result.content[0] as { text: string }).text,
          serializeSuccessEnvelope({ projects: [] }),
        );
        const before = executions;
        const mutation =
          profile === 'researcher'
            ? 'spike_claim'
            : profile === 'planner'
              ? 'ticket_note'
              : profile === 'reviewer'
                ? 'ticket_review'
                : 'work_claim';
        const denied = await client.callTool({
          name: mutation,
          arguments: {
            project_id: 'dc71df55-80ee-4ca1-a22d-ecdc40566c79',
            ...(mutation === 'spike_claim'
              ? { spike_id: 'dc71df55-80ee-4ca1-a22d-ecdc40566c79' }
              : { ticket_id: 'TST-1' }),
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
    for (const profile of ['worker', 'executor'])
      for (const tool of catalogs.get(profile)!)
        assert.deepEqual(
          tool.inputSchema,
          catalogs.get('full')!.find(({ name }) => name === tool.name)!.inputSchema,
        );
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
