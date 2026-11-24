import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import {
  benchmarkPromptParts,
  createPromptLayout,
  discoverPromptCatalog,
  prefixCacheObservation,
} from '../scripts/real-client-prefix.js';
import type { Usage } from '../scripts/real-client-observation.js';

const catalog = [
  {
    name: 'read',
    description: 'private catalog text',
    inputSchema: {
      type: 'object',
      required: ['first', 'second'],
      properties: { first: { type: 'string' }, second: { type: 'string' } },
    },
  },
  {
    name: 'write',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] } },
    },
  },
];
const authority = {
  actor_id: 'private-actor',
  project_id: 'private-project',
  profile: 'worker' as const,
  session_id: 'session-1',
  runtime_sha256: '1'.repeat(64),
  contract_sha256: '2'.repeat(64),
};
const input = {
  role: 'worker' as const,
  instructions: 'Read current authorized requirements before acting.',
  server_instructions: 'Current role policy, read from MCP initialize.',
  catalog,
  task: 'private task description',
  authority,
};

it('canonicalizes equivalent object keys and the outer named catalog without changing semantic arrays', () => {
  const original = createPromptLayout(input);
  const reordered = createPromptLayout({
    ...input,
    catalog: [
      catalog[1]!,
      {
        inputSchema: {
          properties: { second: { type: 'string' }, first: { type: 'string' } },
          required: ['first', 'second'],
          type: 'object',
        },
        description: 'private catalog text',
        name: 'read',
      },
    ],
  });
  assert.equal(original.prompt, reordered.prompt);
  assert.deepEqual(original.provenance, reordered.provenance);
  const changed = createPromptLayout({
    ...input,
    catalog: [
      { ...catalog[0]!, inputSchema: { ...catalog[0]!.inputSchema, required: ['second', 'first'] } },
      catalog[1]!,
    ],
  });
  assert.notEqual(original.provenance.catalog_sha256, changed.provenance.catalog_sha256);
  const tuple = structuredClone(catalog);
  tuple[1]!.inputSchema.properties!.steps!.prefixItems.reverse();
  assert.notEqual(
    original.provenance.prefix_sha256,
    createPromptLayout({ ...input, catalog: tuple }).provenance.prefix_sha256,
  );
  assert.deepEqual(catalog[0]!.inputSchema.required, ['first', 'second']);
});

it('separates stable prefix, changing task, current authority and exact prompt identities without retained facts', () => {
  const original = createPromptLayout(input);
  const task = createPromptLayout({ ...input, task: 'a new required task' });
  assert.equal(original.provenance.prefix_sha256, task.provenance.prefix_sha256);
  assert.notEqual(original.provenance.task_sha256, task.provenance.task_sha256);
  assert.notEqual(original.provenance.context_sha256, task.provenance.context_sha256);
  for (const update of [
    { actor_id: 'another-actor' },
    { project_id: 'another-project' },
    { session_id: 'new-connection' },
    { runtime_sha256: '3'.repeat(64) },
    { contract_sha256: '4'.repeat(64) },
  ]) {
    const changed = createPromptLayout({ ...input, authority: { ...authority, ...update } });
    assert.equal(changed.provenance.prefix_sha256, original.provenance.prefix_sha256);
    assert.notEqual(changed.provenance.authority_sha256, original.provenance.authority_sha256);
    assert.notEqual(changed.provenance.context_sha256, original.provenance.context_sha256);
    assert.notEqual(changed.provenance.prompt_sha256, original.provenance.prompt_sha256);
  }
  const prefix = Buffer.from(original.prompt).subarray(0, original.provenance.prefix_bytes).toString();
  for (const privateText of [
    'private task description',
    'private-actor',
    'private-project',
    'private catalog text',
    input.server_instructions,
  ])
    assert.ok(!prefix.includes(privateText));
  assert.ok(original.prompt.indexOf('Stable harness role') < original.prompt.indexOf('Current task:'));
  assert.ok(original.prompt.includes('Read all current required instructions and facts'));
  assert.ok(!task.prompt.includes(input.task));
  assert.equal(original.provenance.model_catalog_order, 'not_observable');
  assert.equal(original.provenance.provider_prefix_cache_key, 'not_observable');
});

it('invalidates stable prefix for changed role instructions, policy and complete tool definitions', () => {
  const original = createPromptLayout(input).provenance;
  for (const changed of [
    { ...input, instructions: input.instructions + ' Check fresh evidence.' },
    { ...input, server_instructions: input.server_instructions + ' New policy.' },
    { ...input, catalog: [{ ...catalog[0]!, annotations: { readOnlyHint: true } }, catalog[1]!] },
    { ...input, role: 'reviewer' as const, authority: { ...authority, profile: 'reviewer' as const } },
  ])
    assert.notEqual(createPromptLayout(changed).provenance.prefix_sha256, original.prefix_sha256);
  assert.throws(() => createPromptLayout({ ...input, authority: { ...authority, profile: 'reviewer' } }));
  assert.throws(() => createPromptLayout({ ...input, catalog: [catalog[0]!, catalog[0]!] }), /unique/);
});

it('preserves the frozen workflow behavior while keeping project discovery in changing task material', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../scripts/fixtures/protocol-workflows.json', import.meta.url), 'utf8'),
  );
  const instructions = new Set<string>();
  for (const workflow of contract.workflows) {
    const parts = benchmarkPromptParts('worker', workflow, contract.project.name);
    instructions.add(parts.instructions);
    assert.ok(parts.task.includes(`Discover the project named ${JSON.stringify(contract.project.name)}`));
    for (const required of [
      'Read complete current requirements',
      'Copy all prior checkpoint decisions verbatim',
      'every CURRENT received criterion',
      'two virtual heartbeat/change intervals',
      'https://example.test/access-check-evidence',
    ])
      assert.ok(parts.task.includes(required));
    assert.equal(parts.task.includes('observe CLAIM_EXPIRED'), Boolean(workflow.change));
    assert.equal(parts.task.includes('observe the rejected claim'), Boolean(workflow.blocking));
    assert.equal(parts.task.includes('Stop at in_review'), Boolean(workflow.review));
    assert.ok(!parts.instructions.includes(contract.project.name));
  }
  assert.equal(instructions.size, 1);
  const reviewer = benchmarkPromptParts('reviewer', {}, contract.project.name);
  for (const required of [
    'exact latest submission evidence',
    'every actual criterion ID',
    'Do not claim or resubmit',
    'successful ticket_review',
  ])
    assert.ok(reviewer.task.includes(required));
});

it('observes every catalog page on one current SDK connection without executing tools', async () => {
  const requests: unknown[] = [];
  const client = {
    transport: {},
    getInstructions: () => 'current role policy',
    async listTools(args?: unknown) {
      requests.push(args);
      return requests.length === 1 ? { tools: [catalog[0]], nextCursor: 'next' } : { tools: [catalog[1]] };
    },
  };
  const observed = await discoverPromptCatalog(client as unknown as Client);
  assert.deepEqual(observed.catalog, catalog);
  assert.deepEqual(requests, [undefined, { cursor: 'next' }]);
  assert.equal(observed.server_instructions, 'current role policy');
  const looping = {
    ...client,
    async listTools() {
      return { tools: [], nextCursor: 'same' };
    },
  };
  await assert.rejects(discoverPromptCatalog(looping as unknown as Client), /did not advance/);
  const swapped = {
    ...client,
    async listTools() {
      swapped.transport = {};
      return { tools: [] };
    },
  };
  await assert.rejects(
    discoverPromptCatalog(swapped as unknown as Client),
    /connection or role policy changed/,
  );
});

it('keeps cached input a reported subset of total input with unknown costs and no layout savings claim', () => {
  const usage: Usage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: null,
    output_tokens: 20,
    reasoning_output_tokens: 5,
  };
  const observed = prefixCacheObservation(usage);
  assert.equal(observed.total_input_tokens, 100);
  assert.equal(observed.cached_input_tokens_subset, 40);
  assert.equal(observed.uncached_input_tokens, 60);
  assert.equal(observed.monetary_cost.usd, null);
  assert.equal(observed.layout_savings, 'not_established');
  assert.equal(prefixCacheObservation({ ...usage, cached_input_tokens: null }).uncached_input_tokens, null);
  const inconsistent = prefixCacheObservation({ ...usage, cached_input_tokens: 101 });
  assert.equal(inconsistent.cached_subset_status, 'reported_inconsistent');
  assert.equal(inconsistent.uncached_input_tokens, null);
});
