import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { countReferenceTokens } from '../src/tokens.js';
import type { Usage } from './real-client-observation.js';
import type { Client } from '@modelcontextprotocol/client';

export type BenchmarkRole = 'worker' | 'reviewer';
export const PROMPT_LAYOUT = 'stable-role-catalog-identity-then-current-task-v1';
const hash = (value: unknown) => createHash('sha256').update(serializeSuccessEnvelope(value)).digest('hex');
const bytesHash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function discoverPromptCatalog(client: Client) {
  const transport = client.transport;
  const instructions = client.getInstructions();
  assert.ok(transport && instructions, 'Connect to the current role server before observing its catalog.');
  const tools = [] as Awaited<ReturnType<Client['listTools']>>['tools'];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    assert.ok(tools.length <= 256 && cursors.size < 32, 'Prefix catalog discovery exceeded its bounds.');
    if (cursor) {
      assert.ok(!cursors.has(cursor), 'Prefix catalog pagination did not advance.');
      cursors.add(cursor);
    }
  } while (cursor);
  assert.ok(
    client.transport === transport && client.getInstructions() === instructions,
    'Prefix discovery connection or role policy changed.',
  );
  return { server_instructions: instructions, catalog: tools };
}

export function benchmarkPromptParts(role: BenchmarkRole, workflow: any, projectName: string) {
  const instructions = `This is a synthetic coordination benchmark. Use ONLY the ai-ticketing MCP tools. Do not use filesystem, shell, plugins, web, or other servers. Never infer requirements, IDs, decisions, permissions, or submission evidence from this prompt. Read them from actual MCP responses. Follow every required omission reference. Use fresh idempotency keys for logical mutations, retaining a key only for an identical retry. Do not edit repository code. Role: ${role}.`;
  const discovery = `Discover the project named ${JSON.stringify(projectName)} through MCP. `;
  if (role === 'reviewer')
    return {
      instructions,
      task:
        discovery +
        'Find the in-review ticket. Read complete current requirements, instructions, policy, blockers, dependencies, and the exact latest submission evidence through MCP before reviewing. Independently check internal consistency and criterion coverage of this synthetic prepared evidence; approve if all current criteria have passing evidence and a reference. In review feedback quote every actual criterion ID and every submitted evidence reference you checked. Do not claim or resubmit the ticket. Finish only after a successful ticket_review.',
    };
  return {
    instructions,
    task:
      discovery +
      `Read complete current requirements, project instructions/policy, blockers/dependencies and prior checkpoint decisions before progress. ${workflow.blocking ? 'Initially a prerequisite and blocking question prevent claims: observe the rejected claim, read both blockers, and answer the actual blocking question. The external fixture then completes the prerequisite; claim again. ' : ''}Claim work atomically. A separate observed SDK sidecar handles two virtual heartbeat/change intervals outside model turns; do not call routine maintenance tools or wait real minutes. ${workflow.change ? 'After the first claim, deliberately attempt one checkpoint using that initial token. The fixture coordinates the first background interval and a requirement change before processing it; observe CLAIM_EXPIRED. Then reconcile changes, reload current requirements, and reclaim with a fresh key; the sidecar handles the second interval with the new token. ' : ''}Persist one successful checkpoint. In its progress quote the last sentence of the current description and the first sentence of the project instructions; include approval_policy=POLICY. Copy all prior checkpoint decisions verbatim into its decisions array when resuming. Submit passing evidence for every CURRENT received criterion using the latest returned revision. Use the synthetic prepared evidence reference https://example.test/access-check-evidence and summarize authorized-owner and rejected-outsider outcomes; do not fetch the URL. ${workflow.review ? 'Stop at in_review for a separate reviewer.' : 'Stop only when the self-policy submission returns done.'} Report the final ticket key/status and any failures concisely.`,
  };
}

/** No retained cache: only public harness instructions and opaque policy/catalog identities precede task data. */
export function createPromptLayout(input: {
  role: BenchmarkRole;
  instructions: string;
  server_instructions: string;
  catalog: readonly { name: string; [key: string]: unknown }[];
  task: string;
  authority: {
    actor_id: string;
    project_id: string;
    profile: BenchmarkRole;
    session_id: string;
    runtime_sha256: string;
    contract_sha256: string;
  };
}) {
  assert.equal(input.role, input.authority.profile);
  for (const value of [
    input.instructions,
    input.server_instructions,
    input.task,
    input.authority.actor_id,
    input.authority.project_id,
    input.authority.session_id,
  ])
    assert.ok(
      typeof value === 'string' && value.length > 0,
      'Instructions and current authority must be explicit.',
    );
  assert.ok(
    input.catalog.every(({ name }) => typeof name === 'string' && name.length > 0),
    'Catalog tools require names.',
  );
  assert.equal(
    new Set(input.catalog.map(({ name }) => name)).size,
    input.catalog.length,
    'Catalog tool names must be unique.',
  );
  // Only the outer named tool set is unordered; all arrays inside definitions retain their order.
  const catalog = hash(
    [...input.catalog].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  );
  const policy = hash(input.server_instructions);
  const prefix = `Stable harness role instructions (${input.role}):\n${input.instructions}\n\nRole policy SHA-256: ${policy}\nMCP catalog SHA-256: ${catalog}\nThese hashes identify a separate SDK observation; they contain no task facts or authorization.\n`;
  const authority = hash(input.authority);
  const current = `\nCurrent task:\n${input.task}\n\nCurrent authorization/session SHA-256: ${authority}\nRead all current required instructions and facts through this invocation's authorized MCP connection. Prefix identities never authorize reuse of another actor's or project's facts.\n`;
  const prompt = prefix + current;
  const prefixSha256 = bytesHash(prefix);
  const taskSha256 = hash(input.task);
  return {
    prompt,
    provenance: {
      layout: PROMPT_LAYOUT,
      role: input.role,
      role_instructions_sha256: hash(input.instructions),
      server_instructions_sha256: policy,
      catalog_sha256: catalog,
      catalog_tool_count: input.catalog.length,
      prefix_sha256: prefixSha256,
      task_sha256: taskSha256,
      authority_sha256: authority,
      context_sha256: hash({
        prefix_sha256: prefixSha256,
        task_sha256: taskSha256,
        authority_sha256: authority,
      }),
      prompt_sha256: bytesHash(prompt),
      prefix_bytes: Buffer.byteLength(prefix),
      prompt_bytes: Buffer.byteLength(prompt),
      prefix_reference_tokens: countReferenceTokens(prefix),
      prompt_reference_tokens: countReferenceTokens(prompt),
      catalog_source: 'separate SDK discovery under the same fixture actor/profile; not model delivery',
      model_catalog_order: 'not_observable',
      provider_prefix_cache_key: 'not_observable',
    },
  };
}

export function prefixCacheObservation(usage: Usage) {
  const total = usage.input_tokens;
  const cached = usage.cached_input_tokens;
  return {
    total_input_tokens: total,
    cached_input_tokens_subset: cached,
    cache_write_input_tokens: usage.cache_write_input_tokens,
    cached_subset_status:
      total === null || cached === null
        ? 'unknown'
        : cached <= total
          ? 'reported_consistent'
          : 'reported_inconsistent',
    uncached_input_tokens: total !== null && cached !== null && cached <= total ? total - cached : null,
    monetary_cost: { status: 'unavailable', usd: null },
    layout_savings: 'not_established',
  };
}
