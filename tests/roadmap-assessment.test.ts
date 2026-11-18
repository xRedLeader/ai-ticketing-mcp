import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  isolatedEnvironment,
  summarizeWire,
  summarizeCalls,
  deliveryProof,
  readExpectations,
  recoverOmissions,
  wireBreakdown,
} from '../scripts/roadmap-assessment.js';

it('isolates inherited service/provider configuration without printing credential values', () => {
  const env = isolatedEnvironment(
    {
      PATH: 'node-path',
      TICKETING_GITHUB_TOKEN: 'fixture',
      TICKETING_WEBHOOK_URL: 'https://unwanted.test',
      GITHUB_TOKEN: 'fixture',
      OPENAI_API_KEY: 'fixture',
      EMBEDDING_PROVIDER: 'openai',
      DATABASE_URL: 'fixture',
      ACTOR_ID: 'operator',
    },
    'disposable.sqlite',
    'fixture-worker',
  );
  assert.deepEqual(env, {
    PATH: 'node-path',
    STORAGE_ADAPTER: 'sqlite',
    SQLITE_PATH: 'disposable.sqlite',
    ACTOR_ID: 'fixture-worker',
    EMBEDDING_PROVIDER: 'none',
  });
});
it('counts exact framed bytes and rejects incomplete or malformed wire data', () => {
  const raw = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":1,"result":{"text":"🧪"}}\n',
  );
  const result = summarizeWire(raw);
  assert.equal(result.bytes, raw.length);
  assert.equal(result.frames, 2);
  assert.equal(result.framing_bytes, 2);
  assert.deepEqual(result.methods, { 'tools/list': 1 });
  assert.ok(result.reference_tokens > 0);
  assert.throws(() => summarizeWire(Buffer.from('{}')), /Incomplete/);
  assert.throws(() => summarizeWire(Buffer.from('{bad}\n')));
});
it('keeps full SDK duplication, canonical envelopes, failures, and latency sample counts distinct', () => {
  const reference = { request_tokens: 4, sdk_result_tokens: 20, canonical_envelope_tokens: 8 };
  const summary: any = summarizeCalls([
    { tool: 'ticket_get', ok: true, elapsed_ms: 2, reference },
    { tool: 'ticket_get', ok: false, elapsed_ms: 4, reference },
  ]);
  assert.equal(summary.ticket_get.calls, 2);
  assert.equal(summary.ticket_get.successes, 1);
  assert.equal(summary.ticket_get.failures, 1);
  assert.equal(summary.ticket_get.latency_ms.samples, 2);
  assert.equal(summary.ticket_get.latency_ms.mean, 3);
  assert.deepEqual(summary.ticket_get.reference, {
    request_tokens: 8,
    sdk_result_tokens: 40,
    canonical_envelope_tokens: 16,
  });
});

const observed = (tool: string, arguments_: any, data: any) => ({
  ok: true,
  tool,
  arguments: arguments_,
  result: { structuredContent: { ok: true, data } },
});
const context = {
  ticket: {
    id: 'ticket',
    key: 'AS-1',
    project_id: 'project',
    title: 'Requirements',
    description: 'Exact requirements.',
    requirements_revision: 2,
    revision: 10,
  },
  criteria: [{ id: 'criterion', text: 'Exact current criterion.' }],
  blockers: [],
  dependencies: [],
  project_instructions: { text: 'Read all required references.' },
  approval_policy: 'independent',
  omitted: [],
};
it('never treats fixture-supplied revisions as information delivered to the client', () => {
  const calls = [observed('ticket_context', { project_id: 'project', ticket_id: 'ticket' }, context)];
  assert.equal(
    deliveryProof([], 'worker', 'planner', 'ticket_update', {
      project_id: 'project',
      ticket_id: 'ticket',
      expected_revision: 11,
    }).success,
    false,
  );
  const result = deliveryProof(calls, 'worker', 'planner', 'ticket_update', {
    project_id: 'project',
    ticket_id: 'ticket',
    expected_revision: 11,
  });
  assert.equal(result.success, false);
  assert.equal(result.facts.ticket_revision_received, false);
});
it('requires review omissions for ticket_review even through the full profile', () => {
  const evidence = {
    id: 'submission',
    actor_id: 'worker',
    requirements_revision: 2,
    evidence: [
      {
        criterion_id: 'criterion',
        result: 'pass',
        summary: 'Complete observed evidence.',
        references: ['https://example.test/evidence'],
      },
    ],
  };
  const omission = {
    retrieve_with: 'ticket_history',
    arguments: { project_id: 'project', ticket_id: 'ticket', kind: 'github', item_id: 'github-evidence' },
    required_before: 'review',
  };
  const calls = [
    observed(
      'ticket_context',
      { project_id: 'project', ticket_id: 'ticket' },
      { ...context, submissions: [evidence], omitted: [omission] },
    ),
  ];
  const args = {
    project_id: 'project',
    ticket_id: 'ticket',
    submission_id: 'submission',
    expected_revision: 10,
  };
  assert.equal(deliveryProof(calls, 'reviewer', 'full', 'ticket_review', args).success, false);
  calls.push(observed('ticket_history', omission.arguments, { items: [{ id: 'github-evidence' }] }));
  assert.equal(deliveryProof(calls, 'reviewer', 'full', 'ticket_review', args).success, true);
});

it('normalizes SQLite row prototypes while preserving exact requirement text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roadmap-assessment-test-'));
  const path = join(directory, 'fixture.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,instructions TEXT,policy TEXT);
CREATE TABLE tickets(id TEXT,project_id TEXT,key TEXT,title TEXT,description TEXT,labels TEXT,capabilities TEXT);
CREATE TABLE criteria(id TEXT,project_id TEXT,ticket_id TEXT,text TEXT,position INTEGER);
CREATE TABLE links(id TEXT,project_id TEXT,source_id TEXT,target_id TEXT,kind TEXT);
INSERT INTO projects VALUES('project','Exact instructions.','independent');
INSERT INTO tickets VALUES('ticket','project','AS-1','Title','  Exact whitespace.  ','[]','[]');
INSERT INTO criteria VALUES('criterion','project','ticket','  Exact criterion.  ',0);`);
    const data = readExpectations(path, 'project');
    assert.equal(data.tickets[0].description, '  Exact whitespace.  ');
    assert.deepEqual(data.tickets[0].criteria[0], {
      id: 'criterion',
      project_id: 'project',
      ticket_id: 'ticket',
      text: '  Exact criterion.  ',
      position: 0,
    });
  } finally {
    db.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('roadmap-assessment-test-'));
    await rm(directory, { recursive: true });
  }
});

it('exhausts omission pages with original filter arguments and rejects duplicates or wrong exact IDs', async () => {
  const calls: any[] = [];
  const route = {
    retrieve_with: 'ticket_history',
    arguments: {
      project_id: 'project',
      ticket_id: 'ticket',
      kind: 'notes',
      nonblocking_unanswered: true,
      limit: 2,
    },
    required_before: 'execution',
  };
  const session: any = {
    async call(tool: string, args: any) {
      calls.push({ tool, args });
      return {
        items:
          (args.offset ?? 0) === 0
            ? [
                { id: 'a', body: 'MARKER_A' },
                { id: 'b', body: 'MARKER_B' },
              ]
            : [{ id: 'c', body: 'MARKER_C' }],
      };
    },
  };
  const recovered = await recoverOmissions(session, { omitted: [route] }, 'test');
  assert.equal(recovered.length, 2);
  assert.equal(recovered[1].data.items[0].body, 'MARKER_C');
  assert.deepEqual(calls[1].args, { ...route.arguments, offset: 2 });
  const repeated: any = {
    async call() {
      return { items: [{ id: 'a' }, { id: 'b' }] };
    },
  };
  await assert.rejects(recoverOmissions(repeated, { omitted: [route] }, 'test'), /Duplicate/);
  const wrong: any = {
    async call() {
      return { items: [{ id: 'wrong' }] };
    },
  };
  await assert.rejects(
    recoverOmissions(
      wrong,
      { omitted: [{ ...route, arguments: { ...route.arguments, item_id: 'expected' } }] },
      'test',
    ),
  );
});

it('keeps initialization and discovery framing separate from per-tool request/result costs', () => {
  const outgoing = Buffer.from(
    '{"jsonrpc":"2.0","id":0,"method":"initialize"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ticket_get","arguments":{}}}\n',
  );
  const incoming = Buffer.from(
    '{"jsonrpc":"2.0","id":0,"result":{}}\n{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}],"structuredContent":{"ok":true}}}\n',
  );
  const result = wireBreakdown(outgoing, incoming);
  assert.equal(result.by_method.initialize.response_frames, 1);
  assert.equal(result.by_method['tools/list'].response_frames, 1);
  assert.equal(result.by_tool.ticket_get.request_frames, 1);
  assert.equal(result.by_tool.ticket_get.response_frames, 1);
  assert.equal(
    Object.values(result.by_method).reduce((sum: number, row: any) => sum + row.response_bytes, 0),
    incoming.length,
  );
});

it('keeps a required paged omission pending until its terminal page is received', () => {
  const args = { project_id: 'project', ticket_id: 'ticket', kind: 'notes', limit: 2 };
  const calls = [
    observed(
      'ticket_context',
      { project_id: 'project', ticket_id: 'ticket' },
      {
        ...context,
        omitted: [{ retrieve_with: 'ticket_history', arguments: args, required_before: 'execution' }],
      },
    ),
    observed('ticket_history', args, { items: [{ id: 'a' }, { id: 'b' }] }),
  ];
  const mutation = { project_id: 'project', ticket_id: 'ticket', expected_revision: 10 };
  assert.equal(
    deliveryProof(calls, 'worker', 'planner', 'ticket_update', mutation).facts.required_omission_recovery,
    false,
  );
  calls.push(observed('ticket_history', { ...args, offset: 2 }, { items: [] }));
  assert.equal(deliveryProof(calls, 'worker', 'planner', 'ticket_update', mutation).success, true);
});
