/**
 * Requires Node 24, installed dependencies, and a private operator-created manifest
 * with sealed runtime builds and consistent SQLite snapshots. Never supply a live
 * database: this assessment mutates only disposable copies in its output directory.
 *
 * From the repository root, choose a fresh private output directory and run:
 * node --import tsx scripts/roadmap-assessment.ts --manifest .local/mythic-30-manifest.json --out .local/assessment-NEW --phase read
 * node --import tsx scripts/roadmap-assessment.ts --manifest .local/mythic-30-manifest.json --out .local/assessment-NEW --phase brief
 * node --import tsx scripts/roadmap-assessment.ts --manifest .local/mythic-30-manifest.json --out .local/assessment-NEW --phase commands
 *
 * Read and brief reports are immutable; commands preserves each uniquely named
 * attempt. Root-provided source snapshots and live database state remain unchanged.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('o200k_base');
const tokens = (text: string) => encoding.encode(text, [], []).length;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function isolatedEnvironment(base: NodeJS.ProcessEnv, database: string, actor: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value === undefined ||
      /^(TICKETING_|GITHUB_|GH_|EMBEDDING_|OLLAMA_|OPENAI_|ANTHROPIC_|OAUTH_|DATABASE_URL$|ACTOR_ID$|SQLITE_PATH$|STORAGE_ADAPTER$|MCP_PROFILE$)/i.test(
        key,
      )
    )
      continue;
    env[key] = value;
  }
  return {
    ...env,
    STORAGE_ADAPTER: 'sqlite',
    SQLITE_PATH: database,
    ACTOR_ID: actor,
    EMBEDDING_PROVIDER: 'none',
  };
}
export function summarizeWire(bytes: Buffer) {
  const text = bytes.toString('utf8');
  assert.ok(bytes.length === 0 || text.endsWith('\n'), 'Incomplete stdio frame.');
  const messages = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const methods: Record<string, number> = {};
  for (const message of messages)
    if (message.method) methods[message.method] = (methods[message.method] ?? 0) + 1;
  return {
    bytes: bytes.length,
    frames: messages.length,
    framing_bytes: messages.length,
    reference_tokens: tokens(text),
    sha256: hash(bytes),
    methods,
  };
}
export function wireBreakdown(requests: Buffer, responses: Buffer) {
  const byMethod: Record<string, any> = {},
    byTool: Record<string, any> = {};
  const pending = new Map<any, { method: string; tool?: string }>();
  const add = (group: Record<string, any>, key: string, direction: string, line: string) => {
    const row = (group[key] ??= {
      request_frames: 0,
      response_frames: 0,
      request_bytes: 0,
      response_bytes: 0,
      request_reference_tokens: 0,
      response_reference_tokens: 0,
    });
    row[direction + '_frames']++;
    row[direction + '_bytes'] += Buffer.byteLength(line + '\n');
    row[direction + '_reference_tokens'] += tokens(line + '\n');
  };
  for (const line of requests.toString('utf8').split('\n').filter(Boolean)) {
    const message = JSON.parse(line),
      method = message.method ?? 'unknown';
    add(byMethod, method, 'request', line);
    if ('id' in message)
      pending.set(message.id, { method, tool: method === 'tools/call' ? message.params?.name : undefined });
    if (method === 'tools/call') add(byTool, message.params.name, 'request', line);
  }
  for (const line of responses.toString('utf8').split('\n').filter(Boolean)) {
    const message = JSON.parse(line),
      request = pending.get(message.id);
    add(byMethod, request?.method ?? message.method ?? 'unpaired', 'response', line);
    if (request?.tool) add(byTool, request.tool, 'response', line);
  }
  return { by_method: byMethod, by_tool: byTool };
}
export function summarizeCalls(calls: any[]) {
  return Object.fromEntries(
    [...new Set(calls.map((call) => call.tool))].sort().map((tool) => {
      const selected = calls.filter((call) => call.tool === tool);
      const latencies = selected.map((call) => call.elapsed_ms).sort((a, b) => a - b);
      return [
        tool,
        {
          calls: selected.length,
          successes: selected.filter((call) => call.ok).length,
          failures: selected.filter((call) => !call.ok).length,
          latency_ms: {
            samples: latencies.length,
            mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
            p50: latencies[Math.ceil(latencies.length * 0.5) - 1],
            p95: latencies[Math.ceil(latencies.length * 0.95) - 1],
            max: latencies.at(-1),
          },
          reference: {
            request_tokens: selected.reduce((sum, call) => sum + call.reference.request_tokens, 0),
            sdk_result_tokens: selected.reduce((sum, call) => sum + call.reference.sdk_result_tokens, 0),
            canonical_envelope_tokens: selected.reduce(
              (sum, call) => sum + call.reference.canonical_envelope_tokens,
              0,
            ),
          },
        },
      ];
    }),
  );
}
const stable = (value: any): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export function deliveryProof(calls: any[], actor: string, profile: string, tool: string, args: any) {
  if (tool === 'project_create')
    return { success: true, facts: { new_project_has_no_existing_requirements: true } };
  const targetIds =
    tool === 'ticket_link' ? [args.source_id, args.target_id] : args.ticket_id ? [args.ticket_id] : [];
  const facts: Record<string, boolean> = {};
  let instructions: any, policy: any, projectRevision: any;
  for (const call of calls.filter((call) => call.ok)) {
    const data = call.result?.structuredContent?.data;
    if (call.tool === 'project_get' && data?.project?.id === args.project_id) {
      instructions = data.project.instructions;
      policy = data.project.policy;
      projectRevision = data.project.revision;
    }
    const context = data?.context ?? (data?.project_instructions ? data : null);
    if (context?.ticket?.project_id === args.project_id) {
      instructions = context.project_instructions?.text;
      policy = context.approval_policy;
    }
  }
  facts.project_instructions_policy =
    typeof instructions === 'string' && ['self', 'independent', 'human'].includes(policy);
  if (tool === 'project_update') facts.project_revision_received = args.expected_revision === projectRevision;
  for (const targetId of targetIds) {
    let ticket: any = {},
      criteria: any[] = [],
      blockers: any,
      dependencies: any,
      claim: any,
      checkpoint: any;
    let pending: any[] = [],
      submissions: any[] = [];
    for (const call of calls.filter((call) => call.ok)) {
      const data = call.result?.structuredContent?.data;
      const context = data?.context ?? (data?.project_instructions ? data : null);
      const incoming = context?.ticket ?? data?.ticket;
      const matches =
        incoming && [incoming.id, incoming.key].includes(targetId) && incoming.project_id === args.project_id;
      if (matches) {
        if (incoming.requirements_revision < (ticket.requirements_revision ?? 0)) continue;
        if (incoming.revision < (ticket.revision ?? 0)) continue;
        if (incoming.requirements_revision > (ticket.requirements_revision ?? 0)) {
          ticket = {};
          criteria = [];
          blockers = undefined;
          dependencies = undefined;
          checkpoint = undefined;
          pending = [];
          submissions = [];
          claim = undefined;
        }
        ticket = { ...ticket, ...incoming };
        criteria = context?.criteria ?? data.criteria ?? criteria;
        blockers = context?.blockers ?? data.blockers ?? blockers;
        dependencies = context?.dependencies ?? data.links ?? dependencies;
        claim = data.claim ?? context?.claim ?? claim;
        if (context) {
          checkpoint = context.latest_checkpoint ?? checkpoint;
          submissions.push(...(context.submissions ?? []));
          pending = (context.omitted ?? [])
            .filter(
              (item: any) => item.required_before === (tool === 'ticket_review' ? 'review' : 'execution'),
            )
            .map((item: any) => ({ ...item, nextOffset: item.arguments?.offset ?? 0 }));
        }
      }
      if (
        call.tool === 'checkpoint_get' &&
        data?.project_id === args.project_id &&
        [data.ticket_id, ticket.key].includes(targetId) &&
        call.arguments.checkpoint_id === data.id
      )
        checkpoint = data;
      if (
        call.tool === 'ticket_history' &&
        call.arguments.project_id === args.project_id &&
        [ticket.id, ticket.key].includes(call.arguments.ticket_id)
      )
        submissions.push(...(data.items ?? []).filter((item: any) => Array.isArray(item.evidence)));
      pending = pending.flatMap((item) => {
        if (item.retrieve_with !== call.tool) return [item];
        if (call.tool === 'ticket_history' && !item.arguments.item_id) {
          const { offset: _wantedOffset, ...wanted } = item.arguments;
          const { offset = 0, ...received } = call.arguments;
          if (
            stable(wanted) !== stable(received) ||
            offset !== item.nextOffset ||
            !Array.isArray(data?.items)
          )
            return [item];
          return data.items.length >= (item.arguments.limit ?? 10)
            ? [{ ...item, nextOffset: offset + data.items.length }]
            : [];
        }
        if (stable(item.arguments) !== stable(call.arguments)) return [item];
        if (item.arguments.item_id && !data?.items?.some((entry: any) => entry.id === item.arguments.item_id))
          return [item];
        if (item.arguments.checkpoint_id && data?.id !== item.arguments.checkpoint_id) return [item];
        return [];
      });
    }
    const prefix = targetIds.length > 1 ? targetId + ':' : '';
    facts[prefix + 'current_requirements'] =
      typeof ticket.title === 'string' &&
      typeof ticket.description === 'string' &&
      Number.isInteger(ticket.requirements_revision) &&
      criteria.length > 0 &&
      criteria.every((item) => typeof item.id === 'string' && typeof item.text === 'string');
    facts[prefix + 'blockers_dependencies'] = Array.isArray(blockers) && Array.isArray(dependencies);
    if (args.expected_revision !== undefined)
      facts[prefix + 'ticket_revision_received'] = args.expected_revision === ticket.revision;
    if (['work_heartbeat', 'work_release', 'ticket_checkpoint', 'ticket_submit'].includes(tool))
      facts[prefix + 'ownership_from_this_client'] =
        claim?.actor_id === actor && claim?.token === args.claim_token;
    facts[prefix + 'required_omission_recovery'] = pending.length === 0;
    if (profile === 'worker' && ['ticket_checkpoint', 'ticket_submit'].includes(tool))
      facts[prefix + 'resume_checkpoint'] =
        !checkpoint ||
        (typeof checkpoint.body === 'string' &&
          Array.isArray(checkpoint.metadata?.remaining) &&
          Array.isArray(checkpoint.metadata?.decisions));
    if (tool === 'ticket_review') {
      const selected = submissions.find((item) => item.id === args.submission_id);
      facts[prefix + 'selected_submission_evidence'] =
        selected?.requirements_revision === ticket.requirements_revision &&
        typeof selected?.actor_id === 'string' &&
        selected?.actor_id !== actor &&
        selected.evidence.length === criteria.length &&
        new Set(selected.evidence.map((item: any) => item.criterion_id)).size === criteria.length &&
        criteria.every((criterion) =>
          selected.evidence.some(
            (item: any) =>
              item.criterion_id === criterion.id &&
              typeof item.summary === 'string' &&
              item.summary.length > 0 &&
              ['pass', 'fail'].includes(item.result) &&
              (args.decision !== 'approve' || item.result === 'pass') &&
              item.references?.length &&
              item.references.every(
                (reference: any) => typeof reference === 'string' && reference.length > 0,
              ),
          ),
        );
    }
  }
  return { success: Object.values(facts).every(Boolean), facts };
}
// The relay captures original Buffer bytes, including MCP newline framing, without reserializing messages.
const relay = `import {spawn} from 'node:child_process';import {openSync,writeSync,closeSync} from 'node:fs';
const [entry,database,actor,profile,incoming,outgoing]=process.argv.slice(2);
const input=openSync(incoming,'wx',0o600),output=openSync(outgoing,'wx',0o600);
const child=spawn(process.execPath,[entry,'stdio','--sqlite',database,'--actor',actor,'--profile',profile],{env:process.env,windowsHide:true,stdio:['pipe','pipe','inherit']});
process.stdin.on('data',chunk=>{writeSync(input,chunk);child.stdin.write(chunk)});process.stdin.on('end',()=>child.stdin.end());child.stdin.on('error',()=>{});
child.stdout.on('data',chunk=>{writeSync(output,chunk);process.stdout.write(chunk)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{process.stderr.write(error.message);process.exitCode=1});child.on('close',code=>{closeSync(input);closeSync(output);process.exitCode=code??1;process.stdin.destroy()});`;

export async function openSession(options: {
  runtime: any;
  database: string;
  actor: string;
  profile: string;
  directory: string;
  label: string;
  entry?: string;
}) {
  await mkdir(options.directory, { mode: 0o700 });
  const relayPath = join(options.directory, 'relay.mjs');
  await writeFile(relayPath, relay, { flag: 'wx', mode: 0o600 });
  const incoming = join(options.directory, 'client-to-server.bin'),
    outgoing = join(options.directory, 'server-to-client.bin');
  const stderr = join(options.directory, 'stderr.txt');
  await writeFile(stderr, '', { flag: 'wx', mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      relayPath,
      options.entry ?? options.runtime.cli,
      options.database,
      options.actor,
      options.profile,
      incoming,
      outgoing,
    ],
    env: isolatedEnvironment(process.env, options.database, options.actor),
    cwd: options.runtime.root,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'roadmap-assessment', version: '1.0.0' });
  const started = performance.now();
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  transport.stderr?.on('data', (chunk) => appendFileSync(stderr, chunk));
  const startupMs = performance.now() - started;
  const discoveryStarted = performance.now();
  let catalog: any;
  try {
    catalog = await client.listTools();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  const discoveryMs = performance.now() - discoveryStarted;
  const calls: any[] = [];
  const checks: any[] = [];
  const callPath = join(options.directory, 'calls.jsonl');
  await writeFile(callPath, '', { flag: 'wx', mode: 0o600 });
  return {
    client,
    catalog,
    calls,
    checks,
    label: options.label,
    actor: options.actor,
    profile: options.profile,
    async call(
      tool: string,
      args: any,
      stage = 'assessment',
      expect: boolean | string[] = true,
    ): Promise<any> {
      if (
        expect === true &&
        catalog.tools.find((item: any) => item.name === tool)?.annotations?.readOnlyHint === false
      ) {
        const proof = deliveryProof(calls, options.actor, options.profile, tool, args);
        checks.push({ before_call_sequence: calls.length, tool, stage, ...proof });
        assert.equal(
          proof.success,
          true,
          `Missing client-delivered facts for ${options.label}/${tool}: ${Object.entries(proof.facts)
            .filter(([, value]) => !value)
            .map(([key]) => key)
            .join(',')}`,
        );
      }
      const began = performance.now();
      let result: any = null,
        failure: any = null;
      try {
        result = await client.callTool({ name: tool, arguments: args });
      } catch (error: any) {
        failure = { code: error.code ?? null, message: error.message };
      }
      const elapsed = performance.now() - began;
      let envelope = result?.structuredContent;
      const text = result?.content?.find((part: any) => part.type === 'text')?.text;
      if (!envelope && text)
        try {
          envelope = JSON.parse(text);
        } catch {}
      let validationError: string | null = null;
      if (envelope && text)
        try {
          assert.deepEqual(JSON.parse(text), envelope);
        } catch {
          validationError = 'Text and structured result disagree or text is malformed.';
        }
      const record = {
        sequence: calls.length,
        role: options.label,
        actor_id: options.actor,
        profile: options.profile,
        measurement_surface: options.entry ? 'injected_dependency_fixture' : 'production_stdio',
        stage,
        tool,
        arguments: args,
        result,
        transport_error: failure,
        validation_error: validationError,
        expected_outcome: expect === true ? 'positive' : 'negative',
        ok: envelope?.ok === true && !result?.isError && !validationError,
        code: envelope?.error?.code ?? failure?.code ?? null,
        elapsed_ms: elapsed,
        reference: {
          request_tokens: tokens(JSON.stringify({ name: tool, arguments: args })),
          sdk_result_tokens: result ? tokens(JSON.stringify(result)) : 0,
          canonical_envelope_tokens: text ? tokens(text) : 0,
        },
      };
      calls.push(record);
      appendFileSync(callPath, JSON.stringify(record) + '\n');
      if (expect === true)
        assert.equal(
          record.ok,
          true,
          `${options.label}/${tool}: ${record.code ?? failure?.message ?? 'invalid envelope'}`,
        );
      else {
        assert.equal(record.ok, false, `${options.label}/${tool} unexpectedly succeeded`);
        if (Array.isArray(expect))
          assert.ok(expect.includes(String(record.code)), `${tool}: expected ${expect}, got ${record.code}`);
      }
      if (
        record.ok &&
        ['ticket_context', 'work_claim'].includes(tool) &&
        (tool !== 'work_claim' || args.include_context !== false)
      ) {
        const maximum =
          args.max_tokens ?? (args.detail === 'full' ? 32768 : args.detail === 'standard' ? 8192 : 4096);
        assert.ok(
          record.reference.canonical_envelope_tokens <= maximum,
          `${tool} exceeded canonical envelope budget`,
        );
      }
      return envelope?.data ?? null;
    },
    async close() {
      await client.close();
      const report = {
        label: options.label,
        actor_id: options.actor,
        profile: options.profile,
        server_info: client.getServerVersion(),
        startup_ms: startupMs,
        catalog_discovery_ms: discoveryMs,
        catalog_operations: catalog.tools.map((tool: any) => tool.name),
        catalog_reference: {
          full_tools_list_result_tokens: tokens(JSON.stringify(catalog)),
          input_catalog_projection_tokens: tokens(
            JSON.stringify(
              catalog.tools.map(({ name, description, inputSchema }: any) => ({
                name,
                description,
                inputSchema,
              })),
            ),
          ),
        },
        calls: calls.length,
        by_tool: summarizeCalls(calls),
        checks,
        wire: {
          client_to_server: summarizeWire(await readFile(incoming)),
          server_to_client: summarizeWire(await readFile(outgoing)),
          ...wireBreakdown(await readFile(incoming), await readFile(outgoing)),
        },
        relay_sha256: hash(relay),
        calls_sha256: hash(await readFile(callPath)),
        stderr_sha256: hash(await readFile(stderr)),
      };
      await writeFile(join(options.directory, 'session.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      return report;
    },
  };
}

export function readExpectations(database: string, projectId: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const project: any = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    assert.ok(project);
    const tickets: any[] = db.prepare('SELECT * FROM tickets WHERE project_id=? ORDER BY key').all(projectId);
    return {
      project,
      tickets: tickets.map((ticket) => ({
        ...ticket,
        labels: JSON.parse(ticket.labels),
        capabilities: JSON.parse(ticket.capabilities),
        criteria: db
          .prepare('SELECT * FROM criteria WHERE project_id=? AND ticket_id=? ORDER BY position,id')
          .all(projectId, ticket.id)
          .map((row) => ({ ...row })),
        links: db
          .prepare('SELECT * FROM links WHERE project_id=? AND (source_id=? OR target_id=?) ORDER BY id')
          .all(projectId, ticket.id, ticket.id),
      })),
    };
  } finally {
    db.close();
  }
}

export async function recoverOmissions(
  session: Awaited<ReturnType<typeof openSession>>,
  context: any,
  stage: string,
) {
  const recovered = [];
  for (const omission of context.omitted ?? []) {
    if (!omission.retrieve_with || !omission.arguments) continue;
    let args = { ...omission.arguments };
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      assert.ok(page < 1000, 'Omission pagination did not terminate.');
      const data = await session.call(omission.retrieve_with, args, stage);
      if (args.checkpoint_id) assert.equal(data.id, args.checkpoint_id);
      if (args.item_id) assert.ok(data.items.some((item: any) => item.id === args.item_id));
      recovered.push({
        section: omission.section,
        required_before: omission.required_before ?? null,
        tool: omission.retrieve_with,
        arguments: args,
        data,
      });
      if (omission.retrieve_with !== 'ticket_history' || args.item_id) break;
      const limit = args.limit ?? 10;
      for (const item of data.items) {
        assert.ok(!seen.has(item.id), 'Duplicate omission item across pages.');
        seen.add(item.id);
      }
      if (data.items.length < limit) break;
      args = { ...args, offset: (args.offset ?? 0) + data.items.length };
    }
  }
  return recovered;
}

async function assessReads(
  runtime: any,
  dataset: string,
  database: string,
  manifest: any,
  specs: any,
  directory: string,
) {
  const expected = readExpectations(database, manifest.project_id);
  const session = await openSession({
    runtime,
    database,
    actor: manifest.actor_ids.operator,
    profile: 'full',
    directory,
    label: `${dataset}-operator`,
  });
  const findings: any[] = [];
  let measured: any;
  try {
    const project = await session.call('project_get', { project_id: manifest.project_id }, 'warm-up');
    assert.equal(project.project.instructions, specs.instructions);
    assert.equal(project.project.policy, expected.project.policy);
    const listed: any[] = [];
    for (let offset = 0; ; offset += 7) {
      const page = await session.call(
        'ticket_list',
        { project_id: manifest.project_id, limit: 7, offset },
        'pagination',
      );
      listed.push(...page.tickets);
      if (page.tickets.length < 7) break;
      assert.ok(offset < 1000, 'Ticket pagination did not terminate.');
    }
    assert.equal(new Set(listed.map((ticket) => ticket.id)).size, expected.tickets.length);
    assert.deepEqual(
      listed.map((ticket) => ticket.id).sort(),
      expected.tickets.map((ticket) => ticket.id).sort(),
    );
    for (const [index, ticket] of expected.tickets.entries()) {
      try {
        const mapping = manifest.tickets.find((item: any) => item.id === ticket.id);
        if (mapping) {
          const spec = specs.tickets.find((item: any) => item.rank === mapping.rank);
          assert.equal(ticket.title, spec.title);
          assert.equal(ticket.description, spec.description);
          assert.deepEqual(
            ticket.criteria.map((item: any) => item.text),
            spec.criteria,
          );
          assert.equal(ticket.status, 'backlog');
          const predecessors = ticket.links
            .filter((link: any) => link.kind === 'blocks' && link.target_id === ticket.id)
            .map((link: any) => manifest.tickets.find((item: any) => item.id === link.source_id)?.rank)
            .sort((a: number, b: number) => a - b);
          assert.deepEqual(
            predecessors,
            [...mapping.depends_on].sort((a: number, b: number) => a - b),
          );
        }
        const input = { project_id: manifest.project_id, ticket_id: ticket.id };
        const detail = await session.call('ticket_get', input, 'detail');
        assert.equal(detail.ticket.description, ticket.description);
        assert.deepEqual(detail.criteria, ticket.criteria);
        const contexts = [];
        for (const detail of ['brief', 'full']) {
          const context = await session.call(
            'ticket_context',
            { ...input, detail, max_tokens: 32768 },
            `context-${detail}`,
          );
          assert.equal(context.ticket.description, ticket.description);
          assert.equal(context.ticket.requirements_revision, ticket.requirements_revision);
          assert.deepEqual(context.criteria, ticket.criteria);
          assert.equal(context.project_instructions.text, expected.project.instructions);
          assert.equal(context.approval_policy, expected.project.policy);
          const recovered = await recoverOmissions(session, context, 'omission-recovery');
          contexts.push({
            detail,
            omissions: context.omitted,
            recovered: recovered.map((item) => ({
              section: item.section,
              tool: item.tool,
              required_before: item.required_before,
            })),
          });
        }
        const searched = await session.call(
          'search',
          { project_id: manifest.project_id, query: ticket.title, kind: 'ticket', limit: 100 },
          'search',
        );
        const hit = searched.results.find((item: any) => item.id === ticket.id);
        assert.ok(hit, `Search did not retrieve ${ticket.key}.`);
        assert.equal(hit.revision, ticket.revision);
        const deep = await session.call(hit.retrieval.tool, hit.retrieval.arguments, 'search-deep-read');
        assert.equal(deep.ticket.description, ticket.description);
        findings.push({
          id: ticket.id,
          key: ticket.key,
          rank: mapping?.rank ?? null,
          success: true,
          criteria: ticket.criteria.length,
          contexts,
        });
      } catch (error) {
        findings.push({
          id: ticket.id,
          key: ticket.key,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((index + 1) % 6 === 0)
        console.log(
          JSON.stringify({
            stage: 'read-progress',
            runtime: runtime.label,
            dataset,
            checked: index + 1,
            total: expected.tickets.length,
            failures: findings.filter((item) => !item.success).length,
          }),
        );
    }
  } catch (error) {
    findings.push({
      scope: 'dataset',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    measured = await session.close();
  }
  return {
    runtime: runtime.label,
    commit: runtime.commit,
    dataset,
    database,
    database_sha256_after_reads: hash(await readFile(database)),
    ticket_count: expected.tickets.length,
    findings,
    session: measured,
  };
}

async function assessDefaultBrief(
  runtime: any,
  dataset: string,
  database: string,
  manifest: any,
  _specs: any,
  directory: string,
) {
  const expected = readExpectations(database, manifest.project_id);
  const session = await openSession({
    runtime,
    database,
    actor: manifest.actor_ids.operator,
    profile: 'full',
    directory,
    label: `${dataset}-default-brief`,
  });
  const findings: any[] = [];
  let measured: any;
  try {
    for (const ticket of expected.tickets) {
      try {
        const context = await session.call(
          'ticket_context',
          { project_id: manifest.project_id, ticket_id: ticket.id },
          'default-brief-4096',
        );
        assert.equal(context.ticket.description, ticket.description);
        assert.deepEqual(context.criteria, ticket.criteria);
        assert.equal(context.project_instructions.text, expected.project.instructions);
        assert.equal(context.approval_policy, expected.project.policy);
        const count = session.calls.at(-1).reference.canonical_envelope_tokens;
        const recovered = await recoverOmissions(session, context, 'default-brief-omission-recovery');
        findings.push({
          id: ticket.id,
          key: ticket.key,
          rank: manifest.tickets.find((item: any) => item.id === ticket.id)?.rank ?? null,
          success: true,
          max_tokens: 4096,
          canonical_envelope_tokens: count,
          recovered_routes: recovered.length,
        });
      } catch (error) {
        findings.push({
          id: ticket.id,
          key: ticket.key,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    measured = await session.close();
  }
  return {
    runtime: runtime.label,
    commit: runtime.commit,
    dataset,
    ticket_count: expected.tickets.length,
    findings,
    session: measured,
  };
}

async function assessCommands(runtime: any, database: string, manifest: any, directory: string) {
  await mkdir(directory, { mode: 0o700 });
  await copyFile(manifest.snapshots.after.path, database, 1);
  const load = (name: string) => import(pathToFileURL(join(runtime.root, 'dist', name)).href);
  const [{ createSqliteAdapters }, { fixture }] = await Promise.all([
    load('adapters/sqlite.js'),
    load('testing/contracts.js'),
  ]);
  const a = createSqliteAdapters(database);
  let fixtureIds: any;
  try {
    await a.storage.migrate();
    const f = await fixture(a);
    fixtureIds = { outsider: f.outsider.id, setup_project: f.project.id };
  } finally {
    await a.search.close();
    await a.storage.close();
  }
  const sessions: Awaited<ReturnType<typeof openSession>>[] = [],
    measured: any[] = [],
    findings: any[] = [];
  const roadmapLifecycle: any[] = [];
  const open = async (label: string, actor: string, profile: string, entry?: string) => {
    const session = await openSession({
      runtime,
      database,
      actor,
      profile,
      label,
      directory: join(directory, label),
      entry,
    });
    sessions.push(session);
    return session;
  };
  let advertised: string[] = [];
  try {
    const operator = await open('operator', manifest.actor_ids.operator, 'full');
    advertised = operator.catalog.tools.map((tool: any) => tool.name);
    const planner = await open('planner', manifest.actor_ids.a, 'planner');
    const worker = await open('worker', manifest.actor_ids.a, 'worker');
    const other = await open('other-worker', manifest.actor_ids.b, 'worker');
    const reviewer = await open('reviewer', manifest.actor_ids.reviewer, 'reviewer');
    const outsider = await open('outsider', fixtureIds.outsider, 'full');
    await operator.call('project_list', {}, 'positive-discovery');
    const empty = await outsider.call('project_list', {}, 'negative-empty-list');
    assert.deepEqual(empty.projects, []);
    const originalDefault = await operator.call(
      'ticket_list',
      { project_id: manifest.project_id, status: 'backlog' },
      'actual30-default-list',
    );
    assert.equal(originalDefault.tickets.length, 10);
    const retained = await worker.call(
      'ticket_context',
      { project_id: manifest.project_id, ticket_id: manifest.tickets[0].id },
      'actual30-retained-context',
    );
    const conditional = await worker.call(
      'ticket_context',
      {
        project_id: manifest.project_id,
        ticket_id: manifest.tickets[0].id,
        if_none_match: retained.fingerprint,
      },
      'actual30-conditional-context',
    );
    assert.equal(conditional.not_modified, true);
    const searched = await worker.call(
      'search',
      { project_id: manifest.project_id, query: retained.ticket.title, kind: 'ticket', limit: 100 },
      'actual30-search',
    );
    const actualHit = searched.results.find((item: any) => item.id === manifest.tickets[0].id);
    assert.ok(actualHit);
    await worker.call(actualHit.retrieval.tool, actualHit.retrieval.arguments, 'actual30-search-deep-read');
    const created = await operator.call(
      'project_create',
      {
        key: 'AS' + randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase(),
        name: 'Isolated command assessment',
        instructions:
          'Assess coordination protocol behavior only. Evidence is synthetic and does not establish implementation completion.',
        policy: 'independent',
        idempotency_key: randomUUID(),
      },
      'fixture-project-create',
    );
    const projectId = created.id;
    const read = (session: typeof operator, tool: string, args: any = {}, stage = 'positive-command') =>
      session.call(tool, { project_id: projectId, ...args }, stage);
    const mutate = (session: typeof operator, tool: string, args: any, stage = 'positive-command') =>
      read(session, tool, { idempotency_key: randomUUID(), ...args }, stage);
    let project = await read(operator, 'project_get');
    await mutate(operator, 'project_update', {
      expected_revision: project.project.revision,
      name: 'Updated isolated command assessment',
    });
    await operator.call(
      'project_update',
      {
        project_id: projectId,
        expected_revision: project.project.revision,
        name: 'Stale edit',
        idempotency_key: randomUUID(),
      },
      'negative-stale-project',
      ['VERSION_CONFLICT'],
    );
    project = await read(operator, 'project_get');
    for (const [actor, role] of [
      [manifest.actor_ids.a, 'contributor'],
      [manifest.actor_ids.b, 'contributor'],
      [manifest.actor_ids.reviewer, 'verifier'],
    ])
      await mutate(operator, 'member_set', { actor_id: actor, role });
    for (const session of [planner, worker, other, reviewer]) await read(session, 'project_get');
    const made = await mutate(planner, 'tickets_create', {
      tickets: [
        {
          title: 'Assessment lifecycle',
          description: 'Synthetic command behavior, not roadmap implementation.',
          criteria: [
            'Owner mutation is fenced.',
            'Current criteria retain exact identities.',
            'Independent review completes only current submission.',
          ],
          status: 'ready',
        },
        {
          title: 'Assessment prerequisite',
          description: 'A removable fixture dependency.',
          criteria: ['Dependency rules are enforced.'],
          status: 'ready',
        },
        {
          title: 'Assessment transition',
          description: 'A fixture for status transitions.',
          criteria: ['Transitions retain revision guards.'],
          status: 'backlog',
        },
      ],
    });
    const [main, prerequisite, transition] = made.tickets;
    for (const item of made.tickets) await read(planner, 'ticket_get', { ticket_id: item.id });
    let detail = await read(planner, 'ticket_get', { ticket_id: main.id });
    await mutate(planner, 'ticket_update', {
      ticket_id: main.id,
      expected_revision: detail.ticket.revision,
      labels: ['assessment'],
    });
    await planner.call(
      'ticket_update',
      {
        project_id: projectId,
        ticket_id: main.id,
        expected_revision: detail.ticket.revision,
        title: 'Stale edit',
        idempotency_key: randomUUID(),
      },
      'negative-stale-ticket',
      ['VERSION_CONFLICT'],
    );
    await read(planner, 'ticket_get', { ticket_id: main.id });
    await mutate(planner, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: main.id,
      kind: 'blocks',
      action: 'add',
    });
    await planner.call(
      'ticket_link',
      {
        project_id: projectId,
        source_id: main.id,
        target_id: prerequisite.id,
        kind: 'blocks',
        action: 'add',
        idempotency_key: randomUUID(),
      },
      'negative-dependency-cycle',
      ['DEPENDENCY_CYCLE'],
    );
    await read(planner, 'ticket_get', { ticket_id: main.id });
    await read(planner, 'ticket_get', { ticket_id: prerequisite.id });
    await mutate(planner, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: main.id,
      kind: 'blocks',
      action: 'remove',
    });
    detail = await read(planner, 'ticket_get', { ticket_id: transition.id });
    const prepared = await mutate(planner, 'ticket_transition', {
      ticket_id: transition.id,
      expected_revision: detail.ticket.revision,
      status: 'ready',
      reason: 'Isolated transition test.',
    });
    await planner.call(
      'ticket_transition',
      {
        project_id: projectId,
        ticket_id: transition.id,
        expected_revision: prepared.revision,
        status: 'ready',
        reason: 'Same state test.',
        idempotency_key: randomUUID(),
      },
      'negative-same-state',
      ['INVALID_TRANSITION'],
    );
    const knowledge = await mutate(planner, 'knowledge_write', {
      title: 'Assessment prior decision',
      body: 'ASSESSMENT_KNOWLEDGE_MARKER: preserve independent role boundaries.',
      kind: 'decision',
    });
    const fullKnowledge = await read(planner, 'knowledge_get', { knowledge_id: knowledge.id });
    assert.ok(fullKnowledge.body.includes('ASSESSMENT_KNOWLEDGE_MARKER'));
    await mutate(planner, 'knowledge_write', {
      knowledge_id: knowledge.id,
      expected_revision: knowledge.revision,
      title: knowledge.title,
      body: fullKnowledge.body + ' Updated once.',
      kind: 'decision',
    });
    await planner.call(
      'knowledge_write',
      {
        project_id: projectId,
        knowledge_id: knowledge.id,
        expected_revision: knowledge.revision,
        title: knowledge.title,
        body: 'Stale edit',
        kind: 'decision',
        idempotency_key: randomUUID(),
      },
      'negative-stale-knowledge',
      ['VERSION_CONFLICT'],
    );
    await read(operator, 'work_next', { limit: 5 });
    let context = await read(worker, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(worker, context, 'worker-recovery');
    const question = await mutate(worker, 'ticket_note', {
      ticket_id: main.id,
      kind: 'question',
      body: 'ASSESSMENT_BLOCKING_QUESTION',
      blocking: true,
    });
    const nonblocking = await mutate(worker, 'ticket_note', {
      ticket_id: main.id,
      kind: 'question',
      body: 'ASSESSMENT_NONBLOCKING_QUESTION',
      blocking: false,
    });
    const historyTool = worker.catalog.tools.find((tool: any) => tool.name === 'ticket_history');
    const questionField = Object.hasOwn(historyTool.inputSchema.properties, 'nonblocking_unanswered')
      ? 'nonblocking_unanswered'
      : 'unanswered_questions';
    const filtered = await read(worker, 'ticket_history', {
      ticket_id: main.id,
      kind: 'notes',
      [questionField]: true,
    });
    assert.ok(filtered.items.some((item: any) => item.id === nonblocking.note.id));
    assert.ok(!filtered.items.some((item: any) => item.id === question.note.id));
    await worker.call(
      'work_claim',
      { project_id: projectId, ticket_id: main.id, idempotency_key: randomUUID() },
      'negative-blocked-claim',
      ['DEPENDENCY_BLOCKED'],
    );
    context = await read(worker, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(worker, context, 'worker-recovery');
    await mutate(worker, 'ticket_note', {
      ticket_id: main.id,
      kind: 'answer',
      answer_to: question.note.id,
      body: 'ASSESSMENT_BLOCKING_QUESTION is answered in this fixture.',
    });
    await worker.call(
      'ticket_note',
      {
        project_id: projectId,
        ticket_id: main.id,
        kind: 'answer',
        answer_to: randomUUID(),
        body: 'Missing question.',
        idempotency_key: randomUUID(),
      },
      'negative-missing-question',
      ['NOT_FOUND'],
    );
    context = await read(worker, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(worker, context, 'worker-recovery');
    let claimed = await mutate(worker, 'work_claim', { ticket_id: main.id });
    await other.call(
      'work_claim',
      { project_id: projectId, ticket_id: main.id, idempotency_key: randomUUID() },
      'negative-second-owner',
      ['NOT_CLAIMABLE'],
    );
    await mutate(worker, 'work_heartbeat', { ticket_id: main.id, claim_token: claimed.claim.token });
    await worker.call(
      'work_heartbeat',
      { project_id: projectId, ticket_id: main.id, claim_token: randomUUID(), idempotency_key: randomUUID() },
      'negative-heartbeat-token',
      ['CLAIM_EXPIRED'],
    );
    detail = await read(planner, 'ticket_get', { ticket_id: main.id });
    await mutate(planner, 'ticket_update', {
      ticket_id: main.id,
      expected_revision: detail.ticket.revision,
      description: detail.ticket.description + ' Requirement revision changed in the fixture.',
    });
    await worker.call(
      'work_heartbeat',
      {
        project_id: projectId,
        ticket_id: main.id,
        claim_token: claimed.claim.token,
        idempotency_key: randomUUID(),
      },
      'negative-invalidated-token',
      ['CLAIM_EXPIRED'],
    );
    context = await read(worker, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(worker, context, 'worker-recovery');
    claimed = await mutate(worker, 'work_claim', { ticket_id: main.id });
    const marker = 'ASSESSMENT_CHECKPOINT_MARKER';
    const checkpoint = await mutate(worker, 'ticket_checkpoint', {
      ticket_id: main.id,
      claim_token: claimed.claim.token,
      progress: marker + ' ' + 'x '.repeat(7000),
      remaining: ['Submit synthetic coordination evidence.'],
      decisions: ['Preserve the observed current requirement identities.'],
      references: ['https://example.test/assessment/checkpoint'],
    });
    const exactCheckpoint = await read(worker, 'checkpoint_get', { checkpoint_id: checkpoint.checkpoint.id });
    assert.ok(exactCheckpoint.body.includes(marker));
    context = await read(worker, 'ticket_context', { ticket_id: main.id });
    assert.ok(
      context.omitted.some(
        (item: any) => item.section === 'latest_checkpoint' && item.required_before === 'execution',
      ),
    );
    const recoveredCheckpoint = await recoverOmissions(worker, context, 'required-execution-recovery');
    assert.ok(recoveredCheckpoint.some((item) => item.data.body?.includes(marker)));
    await mutate(worker, 'work_release', {
      ticket_id: main.id,
      claim_token: claimed.claim.token,
      reason: 'Synthetic handoff; retained checkpoint.',
    });
    context = await read(worker, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(worker, context, 'required-execution-recovery');
    claimed = await mutate(worker, 'work_claim', { ticket_id: main.id });
    await recoverOmissions(worker, claimed.context, 'required-execution-recovery');
    const evidence = claimed.context.criteria.map((criterion: any) => ({
      criterion_id: criterion.id,
      result: 'pass',
      summary: 'ASSESSMENT_EVIDENCE_MARKER ' + 'x '.repeat(1800),
      references: ['https://example.test/assessment/evidence'],
    }));
    await worker.call(
      'ticket_submit',
      {
        project_id: projectId,
        ticket_id: main.id,
        claim_token: claimed.claim.token,
        expected_revision: claimed.ticket.revision,
        summary: 'Incomplete evidence test.',
        evidence: evidence.slice(0, 1),
        idempotency_key: randomUUID(),
      },
      'negative-incomplete-evidence',
      ['EVIDENCE_INCOMPLETE'],
    );
    const submitted = await mutate(worker, 'ticket_submit', {
      ticket_id: main.id,
      claim_token: claimed.claim.token,
      expected_revision: claimed.ticket.revision,
      summary: 'Synthetic coordination evidence only; no roadmap feature completion asserted.',
      evidence,
    });
    assert.equal(submitted.ticket.status, 'in_review');
    const reviewContext = await read(reviewer, 'ticket_context', { ticket_id: main.id });
    assert.ok(
      reviewContext.omitted.some(
        (item: any) => item.section === 'submissions' && item.required_before === 'review',
      ),
    );
    const recoveredEvidence = await recoverOmissions(reviewer, reviewContext, 'required-review-recovery');
    assert.ok(
      recoveredEvidence.some((item) =>
        item.data.items?.some(
          (submission: any) =>
            submission.id === submitted.submission.id &&
            submission.evidence.every((entry: any) => entry.summary.includes('ASSESSMENT_EVIDENCE_MARKER')),
        ),
      ),
    );
    const reviewed = await mutate(reviewer, 'ticket_review', {
      ticket_id: main.id,
      submission_id: submitted.submission.id,
      expected_revision: reviewContext.ticket.revision,
      decision: 'approve',
      feedback: 'ASSESSMENT_REVIEW_MARKER: received exact current criteria and full synthetic evidence.',
    });
    assert.equal(reviewed.ticket.status, 'done');
    const exactReview = await read(reviewer, 'ticket_history', {
      ticket_id: main.id,
      kind: 'reviews',
      item_id: reviewed.review.id,
    });
    assert.ok(exactReview.items[0].feedback.includes('ASSESSMENT_REVIEW_MARKER'));
    const notes: any[] = [];
    for (let offset = 0; ; offset += 2) {
      const page = await read(worker, 'ticket_history', {
        ticket_id: main.id,
        kind: 'notes',
        limit: 2,
        offset,
      });
      notes.push(...page.items);
      if (page.items.length < 2) break;
      assert.ok(offset < 1000);
    }
    assert.equal(notes.length, new Set(notes.map((item) => item.id)).size);
    let cursor = 0;
    const eventIds = new Set<string>();
    for (;;) {
      const page = await read(worker, 'changes_since', { cursor, limit: 3 });
      for (const event of page.events) {
        assert.ok(!eventIds.has(event.id));
        eventIds.add(event.id);
      }
      assert.ok(page.next_cursor >= cursor);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    console.log(
      JSON.stringify({
        stage: 'commands-core',
        runtime: runtime.label,
        positive_operations: new Set(
          sessions.flatMap((session) =>
            session.calls
              .filter((call) => call.ok && !call.stage.startsWith('negative'))
              .map((call) => call.tool),
          ),
        ).size,
        calls: sessions.reduce((sum, session) => sum + session.calls.length, 0),
        remaining: ['GitHub synthetic lane', 'per-operation authorization negatives', 'actual30 workflow'],
      }),
    );
    await planner.call(
      'ticket_github_refresh',
      { project_id: projectId, ticket_id: main.id, pull_request_number: 1, idempotency_key: randomUUID() },
      'negative-unconfigured-github',
      ['GITHUB_NOT_CONFIGURED'],
    );
    const githubEntry = join(directory, 'github-fixture.mjs');
    const githubCode = `import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
const {createSqliteAdapters}=await import(${JSON.stringify(pathToFileURL(join(runtime.root, 'dist/adapters/sqlite.js')).href)});
const {createApplication}=await import(${JSON.stringify(pathToFileURL(join(runtime.root, 'dist/application.js')).href)});
const {createMcpServer}=await import(${JSON.stringify(pathToFileURL(join(runtime.root, 'dist/mcp.js')).href)});
const a=createSqliteAdapters(process.env.SQLITE_PATH);await a.storage.migrate();const sha='a'.repeat(40);
const app=createApplication({...a,github:{repository:'assessment/fixture',required_checks:['verify'],check_app_id:15368,provider:{async inspect(){return {head_sha:sha,observed_head_sha:sha,status:'passed',checks:[{name:'verify',required_app_id:15368,run_id:1,app_id:15368,head_sha:sha,status:'completed',conclusion:'success',url:'https://example.test/fixture-check'}]}}}}});
const server=createMcpServer(app,{actorId:process.env.ACTOR_ID,scopes:new Set(['ticketing:read','ticketing:write'])},'planner');await server.connect(new StdioServerTransport());process.stdin.on('end',async()=>{await server.close();await a.search.close();await a.storage.close()});`;
    await writeFile(githubEntry, githubCode, { flag: 'wx', mode: 0o600 });
    const github = await open('synthetic-github-provider', manifest.actor_ids.a, 'planner', githubEntry);
    await read(github, 'project_get');
    context = await read(github, 'ticket_context', { ticket_id: main.id });
    await recoverOmissions(github, context, 'github-fact-recovery');
    const observed = await mutate(
      github,
      'ticket_github_refresh',
      { ticket_id: main.id, pull_request_number: 1 },
      'synthetic-github-positive',
    );
    const exactGithub = await github.call(
      observed.evidence_ref.tool,
      observed.evidence_ref.arguments,
      'synthetic-github-exact-evidence',
    );
    assert.equal(exactGithub.items[0].head_sha, 'a'.repeat(40));
    assert.equal(exactGithub.items[0].checks.length, 1);
    for (const tool of advertised) {
      if (tool === 'project_list') continue;
      const positive = sessions
        .flatMap((session) => session.calls)
        .find((call) => call.tool === tool && call.ok && !call.stage.startsWith('negative'));
      if (!positive) continue;
      await outsider.call(tool, positive.arguments, 'negative-outsider-authorization', ['FORBIDDEN']);
    }
    console.log(
      JSON.stringify({
        stage: 'commands-coverage',
        runtime: runtime.label,
        positive_operations: advertised.length,
        negative_operations: advertised.length,
        remaining: ['representative actual30 lifecycle'],
      }),
    );
    for (const session of [planner, worker, reviewer])
      await session.call('project_get', { project_id: manifest.project_id }, 'actual30-project-discovery');
    const byRank = new Map<number, any>(manifest.tickets.map((item: any) => [item.rank, item]));
    const closure = (item: any, active = new Set<number>()): any[] => {
      assert.ok(!active.has(item.rank), 'Approved roadmap dependency cycle.');
      const path = new Set([...active, item.rank]);
      const ordered = item.depends_on.flatMap((rank: number) => closure(byRank.get(rank), path));
      return [...new Map([...ordered, item].map((entry: any) => [entry.rank, entry])).values()];
    };
    const targets = manifest.tickets
      .filter((item: any) => item.depends_on.length)
      .sort(
        (left: any, right: any) => closure(left).length - closure(right).length || left.rank - right.rank,
      );
    const representative = targets[0] ?? manifest.tickets[0];
    const targetDetails = await planner.call(
      'ticket_get',
      { project_id: manifest.project_id, ticket_id: representative.id },
      'actual30-ready-setup-read',
    );
    if (targetDetails.ticket.status === 'backlog')
      await planner.call(
        'ticket_transition',
        {
          project_id: manifest.project_id,
          ticket_id: representative.id,
          expected_revision: targetDetails.ticket.revision,
          status: 'ready',
          reason: 'Disposable-clone coordination assessment; no feature implementation asserted.',
          idempotency_key: randomUUID(),
        },
        'actual30-ready-setup',
      );
    let actualContext = await worker.call(
      'ticket_context',
      { project_id: manifest.project_id, ticket_id: representative.id },
      'actual30-before-prerequisite-reconciliation',
    );
    if (representative.depends_on.length)
      await worker.call(
        'work_claim',
        {
          project_id: manifest.project_id,
          ticket_id: representative.id,
          capabilities: actualContext.ticket.capabilities,
          idempotency_key: randomUUID(),
        },
        'negative-actual30-dependency-blocked',
        ['DEPENDENCY_BLOCKED'],
      );
    for (const item of closure(representative)) {
      let actual = await planner.call(
        'ticket_get',
        { project_id: manifest.project_id, ticket_id: item.id },
        'actual30-lifecycle-read',
      );
      if (actual.ticket.status === 'backlog')
        await planner.call(
          'ticket_transition',
          {
            project_id: manifest.project_id,
            ticket_id: item.id,
            expected_revision: actual.ticket.revision,
            status: 'ready',
            reason: 'Isolated prerequisite coordination simulation; no feature implementation asserted.',
            idempotency_key: randomUUID(),
          },
          'actual30-prerequisite-ready-setup',
        );
      actualContext = await worker.call(
        'ticket_context',
        { project_id: manifest.project_id, ticket_id: item.id },
        'actual30-current-worker-context',
      );
      await recoverOmissions(worker, actualContext, 'actual30-worker-required-recovery');
      const actualClaim = await worker.call(
        'work_claim',
        {
          project_id: manifest.project_id,
          ticket_id: item.id,
          capabilities: actualContext.ticket.capabilities,
          idempotency_key: randomUUID(),
        },
        'actual30-claim',
      );
      await recoverOmissions(worker, actualClaim.context, 'actual30-claim-required-recovery');
      await worker.call(
        'ticket_checkpoint',
        {
          project_id: manifest.project_id,
          ticket_id: item.id,
          claim_token: actualClaim.claim.token,
          progress:
            'Synthetic coordination lifecycle assessed on a disposable clone. This records no feature implementation.',
          remaining: [],
          decisions: ['Do not treat this synthetic evidence as roadmap completion.'],
          references: ['https://example.test/assessment/coordination-only'],
          idempotency_key: randomUUID(),
        },
        'actual30-checkpoint',
      );
      actualContext = await worker.call(
        'ticket_context',
        { project_id: manifest.project_id, ticket_id: item.id },
        'actual30-pre-submit-context',
      );
      await recoverOmissions(worker, actualContext, 'actual30-pre-submit-required-recovery');
      const actualSubmission = await worker.call(
        'ticket_submit',
        {
          project_id: manifest.project_id,
          ticket_id: item.id,
          expected_revision: actualContext.ticket.revision,
          claim_token: actualClaim.claim.token,
          summary: 'Disposable coordination simulation only; does not verify roadmap implementation.',
          evidence: actualContext.criteria.map((criterion: any) => ({
            criterion_id: criterion.id,
            result: 'pass',
            summary:
              'Synthetic criterion identity and protocol lifecycle check only; feature remains unimplemented on the live roadmap.',
            references: ['https://example.test/assessment/coordination-only'],
          })),
          idempotency_key: randomUUID(),
        },
        'actual30-submit',
      );
      const reviewActual = await reviewer.call(
        'ticket_context',
        { project_id: manifest.project_id, ticket_id: item.id },
        'actual30-current-reviewer-context',
      );
      await recoverOmissions(reviewer, reviewActual, 'actual30-review-required-recovery');
      const accepted = await reviewer.call(
        'ticket_review',
        {
          project_id: manifest.project_id,
          ticket_id: item.id,
          submission_id: actualSubmission.submission.id,
          expected_revision: reviewActual.ticket.revision,
          decision: 'approve',
          feedback:
            'Coordination protocol simulation approved only on this disposable clone; no roadmap implementation approval.',
          idempotency_key: randomUUID(),
        },
        'actual30-review',
      );
      assert.equal(accepted.ticket.status, 'done');
      roadmapLifecycle.push({
        id: item.id,
        key: item.key,
        rank: item.rank,
        representative: item.id === representative.id,
        original_state: 'backlog',
        final_state_on_clone: 'done',
        dependency_edges_preserved: true,
        evidence_scope: 'Synthetic protocol coordination only; not feature implementation.',
      });
    }
    findings.push({
      success: true,
      scope: 'synthetic-command-fixture',
      project_id: projectId,
      question_filter_field: questionField,
      paged_notes: notes.length,
      paged_events: eventIds.size,
      github_dependency: 'Injected deterministic provider; not external GitHub or production CLI evidence.',
    });
  } catch (error) {
    findings.push({
      success: false,
      scope: 'command-scenario',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const session of sessions.reverse()) measured.push(await session.close());
  }
  const calls = sessions.flatMap((session) => session.calls);
  const coverage = Object.fromEntries(
    advertised.map((tool) => [
      tool,
      {
        positive: calls.filter((call) => call.tool === tool && call.ok && !call.stage.startsWith('negative'))
          .length,
        negative: calls.filter(
          (call) =>
            call.tool === tool &&
            (call.expected_outcome === 'negative' || call.stage === 'negative-empty-list'),
        ).length,
      },
    ]),
  );
  for (const [tool, row] of Object.entries(coverage) as [string, any][])
    if (!row.positive || !row.negative)
      findings.push({
        success: false,
        scope: 'coverage',
        tool,
        missing: !row.positive ? 'positive' : 'negative',
      });
  return {
    runtime: runtime.label,
    commit: runtime.commit,
    package_version: runtime.package_version,
    dataset: 'command-fixtures',
    ticket_count: roadmapLifecycle.length,
    all30_read_coverage_is_separate: true,
    representative_roadmap_lifecycle: roadmapLifecycle,
    synthetic_fixture_ticket_count: 3,
    findings,
    coverage,
    sessions: measured,
    session: {
      calls: calls.length,
      by_tool: summarizeCalls(calls),
      checks: sessions.flatMap((session) => session.checks),
    },
    setup: {
      source: 'Pinned runtime testing fixture helper, excluded from SDK measurements and role delivery.',
      fixture_project: fixtureIds.setup_project,
    },
  };
}

async function appendAttemptLedger(out: string, paths: string[]) {
  const ledger = join(dirname(out), 'roadmap-assessment-attempts.jsonl');
  let existing = '';
  try {
    existing = await readFile(ledger, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const known = new Set(
    existing
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).report_sha256),
  );
  for (const path of paths) {
    const text = await readFile(path, 'utf8'),
      report = JSON.parse(text),
      digest = hash(text);
    if (known.has(digest)) continue;
    const reports = report.reports ?? [];
    appendFileSync(
      ledger,
      JSON.stringify({
        phase: report.phase,
        report: resolve(path),
        report_sha256: digest,
        manifest_sha256: report.manifest_sha256,
        calls: reports.reduce((sum: number, item: any) => sum + item.session.calls, 0),
        failed_checks: reports.reduce(
          (sum: number, item: any) => sum + item.findings.filter((finding: any) => !finding.success).length,
          0,
        ),
        provider_calls: 0,
      }) + '\n',
      { mode: 0o600, flush: true },
    );
    known.add(digest);
  }
  return ledger;
}

async function validateInputs(manifestPath: string) {
  const text = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(text);
  const specText = await readFile(manifest.spec_path, 'utf8');
  assert.equal(hash(specText), manifest.spec_sha256);
  const specs = JSON.parse(specText);
  assert.equal(manifest.tickets.length, 30);
  assert.equal(specs.tickets.length, 30);
  for (const [label, runtime] of Object.entries(manifest.runtimes) as [string, any][]) {
    runtime.label = label;
    runtime.package_version = JSON.parse(await readFile(join(runtime.root, 'package.json'), 'utf8')).version;
    for (const [name, digest] of runtime.files) {
      const path = resolve(runtime.root, name);
      assert.ok(!relative(runtime.root, path).startsWith('..' + sep));
      assert.equal(hash(await readFile(path)), digest, `Pinned runtime file changed: ${label}/${name}`);
    }
    assert.equal(resolve(runtime.cli), resolve(runtime.root, 'dist/cli.js'));
  }
  for (const name of ['before', 'after'])
    assert.equal(hash(await readFile(manifest.snapshots[name].path)), manifest.snapshots[name].sha256);
  return { manifest, specs, manifest_sha256: hash(text) };
}

async function main() {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24.');
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      out: { type: 'string' },
      phase: { type: 'string', default: 'read' },
      'prior-report': { type: 'string', multiple: true },
    },
  });
  assert.ok(values.manifest && values.out);
  const inputs = await validateInputs(resolve(values.manifest!));
  const out = resolve(values.out!);
  assert.ok(['read', 'brief', 'commands'].includes(values.phase!));
  if (values.phase === 'read') await mkdir(out, { mode: 0o700 });
  const reports = [];
  for (const runtime of Object.values(inputs.manifest.runtimes) as any[]) {
    const versionDirectory = join(out, runtime.label);
    if (values.phase === 'read') await mkdir(versionDirectory, { mode: 0o700 });
    if (values.phase === 'commands') {
      const commandDirectory = join(versionDirectory, 'commands-' + randomUUID());
      reports.push(
        await assessCommands(
          runtime,
          join(commandDirectory, 'fixture.sqlite'),
          inputs.manifest,
          commandDirectory,
        ),
      );
      continue;
    }
    for (const dataset of ['before', 'after']) {
      const database = join(versionDirectory, dataset + '.sqlite');
      if (values.phase === 'read') await copyFile(inputs.manifest.snapshots[dataset].path, database, 1);
      reports.push(
        await (values.phase === 'read' ? assessReads : assessDefaultBrief)(
          runtime,
          dataset,
          database,
          inputs.manifest,
          inputs.specs,
          join(versionDirectory, dataset + (values.phase === 'read' ? '-reads' : '-default-brief')),
        ),
      );
    }
  }
  const report = {
    version: 1,
    phase: values.phase,
    observed_at: new Date().toISOString(),
    manifest_sha256: inputs.manifest_sha256,
    script_sha256: hash(await readFile(new URL(import.meta.url))),
    measurements: {
      provider_calls: 0,
      monetary_cost_usd: null,
      tokenizer: 'js-tiktoken/o200k_base ordinary text',
      latency:
        'SDK end-to-end, including relay capture overhead; startup and discovery separate; descriptive percentiles include sample counts.',
      wire: 'Exact original stdio bytes and newline framing. SDK full result includes text/structured duplication; canonical text envelope counted separately. No model comprehension claim.',
    },
    reports,
    source_inputs_reverified_after_run:
      (await validateInputs(resolve(values.manifest!))).manifest_sha256 === inputs.manifest_sha256,
  };
  const reportPath = join(
    out,
    values.phase === 'read'
      ? 'read-report.json'
      : values.phase === 'brief'
        ? 'default-brief-report.json'
        : 'commands-report-' + randomUUID() + '.json',
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await appendAttemptLedger(out, [...(values['prior-report'] ?? []), reportPath]);
  console.log(
    JSON.stringify({
      report: reportPath,
      datasets: reports.map((item) => ({
        runtime: item.runtime,
        dataset: item.dataset,
        tickets: item.ticket_count,
        failures: item.findings.filter((finding: any) => !finding.success).length,
        calls: item.session.calls,
      })),
    }),
  );
  if (reports.some((item) => item.findings.some((finding: any) => !finding.success))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
