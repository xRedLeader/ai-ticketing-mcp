import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, copyFile, readdir, mkdtemp, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { countReferenceTokens } from '../src/tokens.js';
import {
  parseCodexInvocation,
  validateRole,
  aggregateUsage,
  codexArguments,
  createMaintenanceLedger,
  parsePartialMaintenanceLedger,
  type ExpectedWorkflow,
} from './real-client-observation.js';

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24.');
const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    workflow: { type: 'string', default: 'all' },
    resume: { type: 'boolean' },
    'retry-failed': { type: 'boolean' },
    runtime: { type: 'string' },
    revision: { type: 'string' },
    model: { type: 'string' },
    'reviewer-model': { type: 'string' },
    effort: { type: 'string' },
    'codex-bin': { type: 'string' },
    'timeout-seconds': { type: 'string', default: '600' },
  },
});
assert.match(values.run ?? '', /^[a-zA-Z0-9_-]+$/, '--run requires a simple unique run name.');
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repo, '.local', 'real-client-runs', values.run!);
const manifestPath = join(root, 'report.json');
const contractText = await readFile(join(repo, 'scripts/fixtures/protocol-workflows.json'), 'utf8');
const contract = JSON.parse(contractText);
const contractHash = createHash('sha256').update(contractText).digest('hex');
assert.ok(
  values.workflow === 'all' || contract.workflows.some((item: any) => item.id === values.workflow),
  'Unknown workflow.',
);
const timeout = Number(values['timeout-seconds']) * 1000;
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const measurementSourceHashes = Object.fromEntries(
  await Promise.all(
    ['real-client-benchmark.ts', 'real-client-observation.ts'].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(join(repo, 'scripts', name)))
        .digest('hex'),
    ]),
  ),
);
let manifest: any;
async function recoverMaintenance(directory: string) {
  try {
    return JSON.parse(await readFile(join(directory, 'maintenance-result.json'), 'utf8'));
  } catch {
    let ledger = '';
    try {
      ledger = await readFile(join(directory, 'maintenance.jsonl'), 'utf8');
    } catch {}
    return parsePartialMaintenanceLedger(ledger);
  }
}
async function recover(directory: string, role: string, failure: string) {
  let stdout = '';
  try {
    stdout = await readFile(join(directory, `${role}.jsonl`), 'utf8');
  } catch {}
  const observation = parseCodexInvocation(stdout, null);
  return {
    consumer: 'model',
    role,
    ...observation,
    success: false,
    interrupted: true,
    errors: [...observation.errors, failure],
    ...(role === 'worker' ? { maintenance: await recoverMaintenance(directory) } : {}),
  };
}
async function save() {
  manifest.usage = aggregateUsage(
    manifest.workflows.flatMap((workflow: any) =>
      workflow.attempts.flatMap((attempt: any) => attempt.invocations ?? []),
    ),
  );
  manifest.failed_attempts = manifest.workflows.reduce(
    (sum: number, workflow: any) =>
      sum + workflow.attempts.filter((attempt: any) => attempt.status === 'failed').length,
    0,
  );
  manifest.completed_workflows = manifest.workflows.filter((workflow: any) =>
    workflow.attempts.some((attempt: any) => attempt.status === 'completed'),
  ).length;
  manifest.retry_attempts = manifest.workflows.reduce(
    (sum: number, workflow: any) => sum + Math.max(0, workflow.attempts.length - 1),
    0,
  );
  const temporary = join(root, `report-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, manifestPath);
}
async function digestTree(directory: string) {
  const hashes: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), relative + '/');
      else
        hashes[relative] = createHash('sha256')
          .update(await readFile(join(path, entry.name)))
          .digest('hex');
    }
  }
  await visit(directory, '');
  return hashes;
}
if (values.resume) {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.scenario_contract_sha256, contractHash, 'The frozen semantic contract changed.');
  for (const [flag, key] of [
    ['model', 'worker'],
    ['reviewer-model', 'reviewer'],
  ] as const)
    if (values[flag])
      assert.equal(values[flag], manifest.models[key], 'Do not change models within one report.');
  if (values.effort) assert.equal(values.effort, manifest.effort);
  assert.deepEqual(
    await digestTree(join(root, 'runtime')),
    manifest.runtime_hashes,
    'The pinned runtime changed.',
  );
  for (const workflow of manifest.workflows)
    for (let i = 0; i < workflow.attempts.length; i++) {
      const attempt = workflow.attempts[i];
      if (attempt.status !== 'running') continue;
      try {
        workflow.attempts[i] = JSON.parse(
          await readFile(join(attempt.artifact_directory, 'attempt.json'), 'utf8'),
        );
        continue;
      } catch {}
      attempt.status = 'failed';
      attempt.failure =
        'Interrupted driver invocation; partial client artifacts and reported usage retained.';
      for (const role of ['worker', 'reviewer']) {
        if (attempt.invocations.some((item: any) => item.role === role)) continue;
        try {
          await readFile(join(attempt.artifact_directory, `${role}.jsonl`));
          attempt.invocations.push(await recover(attempt.artifact_directory, role, attempt.failure));
        } catch {}
      }
      await writeFile(
        join(attempt.artifact_directory, 'attempt.json'),
        JSON.stringify(attempt, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    }
  await save();
} else {
  assert.ok(values.runtime && values.revision, 'A new report requires --runtime PATH and --revision COMMIT.');
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const source = resolve(values.runtime!);
  assert.notEqual(source, repo, 'Use a recorded stable build, not the moving working tree.');
  const runtime = join(root, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  for (const item of ['dist', 'migrations', 'package.json', 'package-lock.json'])
    await cp(join(source, item), join(runtime, item), { recursive: true, errorOnExist: true, force: false });
  await copyFile(join(repo, 'scripts/real-client-server.mjs'), join(root, 'server.mjs'));
  const revision = execFileSync('git', ['rev-parse', values.revision!], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const codex =
    values['codex-bin'] ?? process.env.CODEX_BIN ?? (process.platform === 'win32' ? 'codex.exe' : 'codex');
  manifest = {
    version: 1,
    created_at: new Date().toISOString(),
    client: 'Codex CLI',
    client_version: execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim(),
    codex_binary: codex,
    runtime_revision: revision,
    runtime_hashes: await digestTree(runtime),
    fixture_server_sha256: createHash('sha256')
      .update(await readFile(join(root, 'server.mjs')))
      .digest('hex'),
    scenario_contract_sha256: contractHash,
    models: { worker: values.model ?? 'gpt-6.1-sol', reviewer: values['reviewer-model'] ?? 'gpt-6-astra' },
    effort: values.effort ?? 'xhigh',
    monetary_cost: { status: 'unavailable', usd: null },
    measurement: {
      provider_usage:
        'Last cumulative turn.completed usage once per Codex invocation; absent fields remain unknown.',
      reference_counts:
        'Observed MCP requests/full results/canonical envelopes, without metadata normalization; model catalog discovery is not emitted by this client and stays unknown. These are not billed tokens.',
      maintenance:
        'Two virtual heartbeat/change intervals through an observed SDK sidecar outside model turns; no real two-minute wait. Sidecar responses never establish model delivery.',
      presentation:
        'Codex tool_output_token_limit=32768; plugins/headroom and shell tools disabled. JSONL result logs do not expose exact post-rendering model input, so action/evidence fact acknowledgements are checked separately.',
      approvals:
        'Per-invocation on-request approval routes through auto_review with a read-only sandbox. No tool preapproval or machine policy changes. Approval-review usage is not separately exposed by this CLI and remains unknown.',
      runtime:
        'Production code and migrations copied together from the explicit stable build; hashes verified on resume.',
      evidence:
        'Synthetic coordination evidence; no claim of implementation-quality or external URL verification.',
    },
    workflows: contract.workflows.map((workflow: any) => ({ id: workflow.id, attempts: [] })),
  };
  await save();
}
assert.equal(
  createHash('sha256')
    .update(await readFile(join(root, 'server.mjs')))
    .digest('hex'),
  manifest.fixture_server_sha256,
);
const runtimeRoot = join(root, 'runtime');
const load = (name: string) => import(pathToFileURL(join(runtimeRoot, 'dist', name)).href);
const [{ createSqliteAdapters }, { fixture }] = await Promise.all([
  load('adapters/sqlite.js'),
  load('testing/contracts.js'),
]);

async function seed(directory: string, workflow: any) {
  const database = join(directory, 'fixture.sqlite');
  const a = createSqliteAdapters(database);
  await a.storage.migrate();
  const f = await fixture(a, workflow.policy);
  const project = await a.storage.get('projects', f.project.id);
  await f.app.execute(f.admin.id, 'project_update', {
    project_id: project.id,
    expected_revision: project.revision,
    name: contract.project.name,
    instructions: contract.project.instructions,
    idempotency_key: randomUUID(),
  });
  await a.storage.transaction('catalog', async (tx: any) => {
    await tx.put('actors', { ...f.reviewer, kind: 'agent' });
  });
  const description =
    workflow.description === 'long'
      ? contract.project.long_description_paragraph.repeat(contract.project.long_description_repetitions)
      : contract.project.description;
  const created = await f.ticket({
    title: contract.project.title,
    description,
    criteria: [contract.project.criterion],
    priority: 1,
  });
  const ticket = await a.storage.get('tickets', created.id);
  let prerequisiteId: string | undefined;
  if (workflow.blocking) {
    const prerequisite = await f.ticket({
      title: 'Prerequisite access boundary',
      priority: 5,
      assignee_id: f.admin.id,
    });
    prerequisiteId = prerequisite.id;
    await f.call(f.worker.id, 'ticket_link', {
      source_id: prerequisite.id,
      target_id: ticket.id,
      kind: 'blocks',
      action: 'add',
    });
    await f.call(f.worker.id, 'ticket_note', {
      ticket_id: ticket.id,
      kind: 'question',
      body: 'Confirm that the prerequisite access boundary is ready.',
      blocking: true,
    });
  }
  await a.storage.transaction(project.id, async (tx: any) => {
    for (let i = 0; i < workflow.history_comments; i++)
      await tx.put('notes', {
        id: randomUUID(),
        project_id: project.id,
        ticket_id: ticket.id,
        actor_id: f.worker.id,
        kind: 'comment',
        body: `Historical observation ${i + 1}: ${contract.project.description}`,
        blocking: false,
        answer_to: null,
        metadata: {},
        ticket_revision: 1,
        created_at: f.clock.now.toISOString(),
      });
    if (workflow.resume_checkpoint)
      await tx.put('notes', {
        id: randomUUID(),
        project_id: project.id,
        ticket_id: ticket.id,
        actor_id: f.worker.id,
        kind: 'checkpoint',
        body: contract.project.checkpoint_progress,
        blocking: false,
        answer_to: null,
        metadata: {
          remaining: contract.project.checkpoint_remaining,
          decisions: contract.project.checkpoint_decisions,
          references: [],
        },
        ticket_revision: 1,
        created_at: f.clock.now.toISOString(),
      });
  });
  await f.app.indexOnce(10000);
  return {
    a,
    config: {
      version: 1,
      database,
      runtimeRoot,
      adminId: f.admin.id,
      projectId: project.id,
      projectName: contract.project.name,
      ticketId: ticket.id,
      prerequisiteId,
      clock: f.clock.now.toISOString(),
      workflow,
    },
    expected: {
      workflow,
      project,
      ticket,
      description: ticket.description,
      workerId: f.worker.id,
      reviewerId: f.reviewer.id,
      prerequisiteId,
      contract,
    } as ExpectedWorkflow,
  };
}
function prompt(role: 'worker' | 'reviewer', workflow: any) {
  const common = `This is a synthetic coordination benchmark. Use ONLY the ai-ticketing MCP tools. Do not use filesystem, shell, plugins, web, or other servers. Discover the project named ${JSON.stringify(contract.project.name)} through MCP. Never infer requirements, IDs, decisions, permissions, or submission evidence from this prompt. Read them from actual MCP responses. Follow every required omission reference. Use fresh idempotency keys for logical mutations, retaining a key only for an identical retry. Do not edit repository code. `;
  if (role === 'reviewer')
    return (
      common +
      'Find the in-review ticket. Read complete current requirements, instructions, policy, blockers, dependencies, and the exact latest submission evidence through MCP before reviewing. Independently check internal consistency and criterion coverage of this synthetic prepared evidence; approve if all current criteria have passing evidence and a reference. In review feedback quote every actual criterion ID and every submitted evidence reference you checked. Do not claim or resubmit the ticket. Finish only after a successful ticket_review.'
    );
  return (
    common +
    `Read complete current requirements, project instructions/policy, blockers/dependencies and prior checkpoint decisions before progress. ${workflow.blocking ? 'Initially a prerequisite and blocking question prevent claims: observe the rejected claim, read both blockers, and answer the actual blocking question. The external fixture then completes the prerequisite; claim again. ' : ''}Claim work atomically. A separate observed SDK sidecar handles two virtual heartbeat/change intervals outside model turns; do not call routine maintenance tools or wait real minutes. ${workflow.change ? 'After the first claim, deliberately attempt one checkpoint using that initial token. The fixture coordinates the first background interval and a requirement change before processing it; observe CLAIM_EXPIRED. Then reconcile changes, reload current requirements, and reclaim with a fresh key; the sidecar handles the second interval with the new token. ' : ''}Persist one successful checkpoint. In its progress quote the last sentence of the current description and the first sentence of the project instructions; include approval_policy=POLICY. Copy all prior checkpoint decisions verbatim into its decisions array when resuming. Submit passing evidence for every CURRENT received criterion using the latest returned revision. Use the synthetic prepared evidence reference https://example.test/access-check-evidence and summarize authorized-owner and rejected-outsider outcomes; do not fetch the URL. ${workflow.review ? 'Stop at in_review for a separate reviewer.' : 'Stop only when the self-policy submission returns done.'} Report the final ticket key/status and any failures concisely.`
  );
}

async function maintenance(directory: string, seeded: any) {
  const statePath = join(directory, 'maintenance-state.json');
  let completed = 0;
  let requested = 0;
  let cursor = 0;
  let failure: string | null = null;
  let queue = Promise.resolve();
  let clock = Date.parse(seeded.config.clock);
  const calls: any[] = [];
  const wire: any[] = [];
  const ledger = createMaintenanceLedger(join(directory, 'maintenance.jsonl'));
  const record = (kind: 'wire' | 'call', value: any) => {
    ledger(kind, value);
    (kind === 'wire' ? wire : calls).push(value);
  };
  const tokens = new Set<string>();
  const update = async () => {
    const temporary = statePath + '.tmp';
    await writeFile(
      temporary,
      JSON.stringify({
        completed_intervals: completed,
        status: failure ? 'failed' : 'running',
        clock: new Date(clock).toISOString(),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, statePath);
  };
  await update();
  const configPath = join(directory, 'maintenance-fixture.json');
  await writeFile(
    configPath,
    JSON.stringify({
      ...seeded.config,
      role: 'worker',
      channel: 'maintenance',
      actorId: seeded.expected.workerId,
      maintenanceState: statePath,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      MCP_BENCH_FIXTURE: configPath,
      ACTOR_ID: seeded.expected.workerId,
      STORAGE_ADAPTER: 'sqlite',
      SQLITE_PATH: seeded.config.database,
      EMBEDDING_PROVIDER: 'none',
    }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  const raw = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'server.mjs')],
    cwd: repo,
    env,
    stderr: 'pipe',
  });
  const transport = new Proxy(raw, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'send')
        return async (message: any, ...rest: any[]) => {
          record('wire', { consumer: 'maintenance', direction: 'outgoing', message });
          return value.call(target, message, ...rest);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(
        target,
        key,
        key === 'onmessage'
          ? (message: any, ...rest: any[]) => {
              record('wire', { consumer: 'maintenance', direction: 'incoming', message });
              return value?.(message, ...rest);
            }
          : value,
        target,
      );
    },
  });
  const client = new Client({ name: 'observed-maintenance', version: '1.0.0' });
  await client.connect(transport);
  const discovery = await client.listTools();
  record('call', {
    consumer: 'maintenance',
    role: 'worker',
    operation: 'tools/list',
    request: {},
    result: discovery,
  });
  async function call(tool: string, args: any) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      let result: any,
        error: string | null = null;
      try {
        result = await client.callTool({ name: tool, arguments: args });
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
      record('call', {
        consumer: 'maintenance',
        role: 'worker',
        operation: tool,
        request: { name: tool, arguments: args },
        result,
        error,
        virtual_clock: new Date(clock).toISOString(),
        elapsed_ms: Math.round(performance.now() - started),
      });
      if (result?.structuredContent?.ok) return result.structuredContent.data;
      const code = result?.structuredContent?.error?.code;
      if (attempt === 0 && (error || code === 'INTERNAL_ERROR')) continue;
      throw new Error(`Maintenance ${tool} failed: ${code ?? error ?? 'invalid response'}`);
    }
  }
  const interval = async (token: string) => {
    clock += 120_000;
    await update();
    await call('work_heartbeat', {
      project_id: seeded.config.projectId,
      ticket_id: seeded.config.ticketId,
      claim_token: token,
      idempotency_key: randomUUID(),
    });
    let more = true;
    while (more) {
      const changes = await call('changes_since', {
        project_id: seeded.config.projectId,
        cursor,
        limit: 100,
      });
      if (
        changes.events.some(
          (event: any) =>
            event.entity_id === seeded.config.ticketId &&
            ['work.claimed', 'work.released', 'ticket.submitted', 'ticket.invalidated'].includes(event.type),
        )
      ) {
        const current = await call('ticket_get', {
          project_id: seeded.config.projectId,
          ticket_id: seeded.config.ticketId,
        });
        if (
          (!current.claim || current.claim.token !== token || current.claim.expired) &&
          !(seeded.expected.workflow.change && completed === 0)
        )
          throw new Error('Maintenance observed lost ownership.');
      }
      assert.ok(
        Number.isSafeInteger(changes.next_cursor) &&
          changes.next_cursor >= cursor &&
          (!changes.has_more || changes.next_cursor > cursor),
        'Nonadvancing maintenance cursor.',
      );
      cursor = changes.next_cursor;
      more = changes.has_more;
    }
    completed++;
    await update();
  };
  return {
    statePath,
    observe(event: any) {
      if (
        event.type !== 'item.completed' ||
        event.item?.type !== 'mcp_tool_call' ||
        event.item.tool !== 'work_claim'
      )
        return;
      const result = event.item.result;
      let envelope = result?.structured_content ?? result?.structuredContent;
      if (!envelope)
        try {
          envelope = JSON.parse(result.content.find((block: any) => block.type === 'text').text);
        } catch {}
      const token = envelope?.ok ? envelope.data?.claim?.token : undefined;
      if (!token || tokens.has(token) || requested >= 2) return;
      tokens.add(token);
      const count = seeded.expected.workflow.change ? 1 : 2;
      requested += count;
      queue = queue
        .then(async () => {
          for (let i = 0; i < count; i++) await interval(token);
        })
        .catch(async (error) => {
          failure = error.message;
          await update();
        });
    },
    async finish() {
      await queue;
      if (completed !== 2 && !failure)
        failure = 'The model did not trigger both virtual maintenance intervals.';
      try {
        await client.close();
      } catch (error) {
        failure ??= `Maintenance close failed: ${String(error)}`;
      }
      const report = {
        consumer: 'maintenance',
        role: 'worker',
        success: failure === null,
        evidence_complete: true,
        completed_intervals: completed,
        failure,
        calls,
        wire,
        reference: {
          request_tokens: calls.reduce(
            (sum, item) => sum + countReferenceTokens(JSON.stringify(item.request)),
            0,
          ),
          sdk_result_tokens: calls.reduce(
            (sum, item) => sum + (item.result ? countReferenceTokens(JSON.stringify(item.result)) : 0),
            0,
          ),
          catalog_tokens: countReferenceTokens(
            JSON.stringify(
              discovery.tools.map(({ name, description, inputSchema }: any) => ({
                name,
                description,
                inputSchema,
              })),
            ),
          ),
          wire_outgoing_tokens: wire
            .filter((item) => item.direction === 'outgoing')
            .reduce((sum, item) => sum + countReferenceTokens(JSON.stringify(item.message)), 0),
          wire_incoming_tokens: wire
            .filter((item) => item.direction === 'incoming')
            .reduce((sum, item) => sum + countReferenceTokens(JSON.stringify(item.message)), 0),
        },
        rpc_round_trips: wire.filter(
          (item) => item.direction === 'outgoing' && item.message.method && 'id' in item.message,
        ).length,
      };
      await writeFile(join(directory, 'maintenance-result.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      return report;
    },
  };
}
async function invoke(role: 'worker' | 'reviewer', workflow: any, directory: string, seeded: any) {
  const actor = role === 'worker' ? seeded.expected.workerId : seeded.expected.reviewerId;
  const sidecar = role === 'worker' ? await maintenance(directory, seeded) : undefined;
  const configPath = join(directory, `${role}-fixture.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      ...seeded.config,
      role,
      channel: 'model',
      actorId: actor,
      maintenanceState: join(directory, 'maintenance-state.json'),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const cwd = await mkdtemp(join(tmpdir(), 'ticketing-model-client-'));
  const args = codexArguments({
    model: manifest.models[role],
    effort: manifest.effort,
    cwd,
    node: process.execPath,
    server: join(root, 'server.mjs'),
    config: configPath,
    database: seeded.config.database,
    actor,
  });
  await writeFile(
    join(directory, `${role}-request.json`),
    JSON.stringify(
      {
        requested_model: manifest.models[role],
        reasoning_effort: manifest.effort,
        arguments: args,
        prompt: prompt(role, workflow),
        cwd,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  const stdoutPath = join(directory, `${role}.jsonl`),
    stderrPath = join(directory, `${role}.stderr`);
  const out = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 }),
    err = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const environment = { ...process.env };
  for (const key of ['ACTOR_ID', 'SQLITE_PATH', 'STORAGE_ADAPTER', 'EMBEDDING_PROVIDER'])
    delete environment[key];
  const started = performance.now();
  let timedOut = false;
  let spawnError: string | null = null;
  let exitCode: number | null = null;
  const child = spawn(manifest.codex_binary, args, {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      try {
        sidecar?.observe(JSON.parse(line));
      } catch {}
    }
  });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt(role, workflow));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  try {
    await new Promise<void>((done) => {
      child.once('error', (error) => {
        spawnError = error.message;
        done();
      });
      child.once('close', (code) => {
        exitCode = code;
        done();
      });
    });
  } finally {
    clearTimeout(timer);
    if (!out.writableEnded) out.end();
    if (!err.writableEnded) err.end();
    await Promise.all([
      out.closed ? Promise.resolve() : once(out, 'close'),
      err.closed ? Promise.resolve() : once(err, 'close'),
    ]);
  }
  const observation = parseCodexInvocation(await readFile(stdoutPath, 'utf8'), exitCode);
  if (spawnError) observation.errors.push(spawnError);
  if (timedOut) observation.errors.push('Codex invocation timed out.');
  let validation: any = { success: false, errors: [...observation.errors] };
  try {
    validation = validateRole(observation, role, seeded.expected);
  } catch (error) {
    validation.errors.push(`Post-client validation failed: ${String(error)}`);
  }
  let maintained: any;
  try {
    maintained = await sidecar?.finish();
    if (maintained && !maintained.success) {
      validation.success = false;
      validation.errors.push(maintained.failure!);
    }
  } catch (error) {
    validation.success = false;
    validation.errors.push(`Maintenance finalization failed: ${String(error)}`);
    maintained = await recoverMaintenance(directory);
  }
  const report = {
    consumer: 'model',
    role,
    model_requested: manifest.models[role],
    model_reported: null,
    reasoning_effort: manifest.effort,
    elapsed_ms: Math.round(performance.now() - started),
    exit_code: exitCode,
    timed_out: timedOut,
    ...observation,
    ...validation,
    maintenance: maintained,
  };
  await writeFile(join(directory, `${role}-result.json`), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return report;
}
const selected = manifest.workflows.filter(
  (item: any) => values.workflow === 'all' || item.id === values.workflow,
);
for (const item of selected) {
  if (item.attempts.some((attempt: any) => attempt.status === 'completed')) {
    console.log(JSON.stringify({ workflow: item.id, status: 'already_completed_not_rerun' }));
    continue;
  }
  if (item.attempts.length && !values['retry-failed']) {
    console.log(
      JSON.stringify({
        workflow: item.id,
        status: 'previous_failure_retained',
        retry: 'Use --retry-failed explicitly.',
      }),
    );
    continue;
  }
  const workflow = contract.workflows.find((entry: any) => entry.id === item.id);
  const id = randomUUID();
  const directory = join(root, `${item.id}-${id}`);
  await mkdir(directory, { mode: 0o700 });
  const attempt: any = {
    id,
    started_at: new Date().toISOString(),
    status: 'running',
    invocations: [],
    artifact_directory: directory,
    measurement_source_sha256: measurementSourceHashes,
    approval_configuration: {
      approval_policy: 'on-request',
      approvals_reviewer: 'auto_review',
      sandbox: 'read-only',
    },
  };
  item.attempts.push(attempt);
  await save();
  let seeded: any;
  try {
    seeded = await seed(directory, workflow);
    const worker = await invoke('worker', workflow, directory, seeded);
    attempt.invocations.push(worker);
    if (!worker.success)
      throw new Error('Worker invocation did not satisfy observed-response completion checks.');
    if (workflow.review) {
      assert.equal((await seeded.a.storage.get('tickets', seeded.expected.ticket.id)).status, 'in_review');
      const reviewer = await invoke('reviewer', workflow, directory, seeded);
      attempt.invocations.push(reviewer);
      if (!reviewer.success)
        throw new Error('Reviewer invocation did not satisfy observed-response completion checks.');
    }
    assert.equal(
      (await seeded.a.storage.get('tickets', seeded.expected.ticket.id)).status,
      'done',
      'Authoritative final ticket did not complete.',
    );
    attempt.status = 'completed';
  } catch (error) {
    attempt.status = 'failed';
    attempt.failure = error instanceof Error ? error.message : String(error);
    for (const role of ['worker', 'reviewer']) {
      if (attempt.invocations.some((item: any) => item.role === role)) continue;
      try {
        await readFile(join(directory, `${role}.jsonl`));
        attempt.invocations.push(await recover(directory, role, attempt.failure));
      } catch {}
    }
  } finally {
    await seeded?.a.search.close();
    await seeded?.a.storage.close();
    attempt.finished_at = new Date().toISOString();
    await writeFile(join(directory, 'attempt.json'), JSON.stringify(attempt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await save();
  }
  console.log(
    JSON.stringify({
      workflow: item.id,
      status: attempt.status,
      failure: attempt.failure,
      usage: aggregateUsage(attempt.invocations),
      report: manifestPath,
    }),
  );
}
console.log(
  JSON.stringify({
    report: manifestPath,
    completed_workflows: manifest.completed_workflows,
    failed_attempts: manifest.failed_attempts,
    retry_attempts: manifest.retry_attempts,
    usage: manifest.usage,
    monetary_cost: manifest.monetary_cost,
  }),
);
if (selected.some((item: any) => !item.attempts.some((attempt: any) => attempt.status === 'completed')))
  process.exitCode = 1;
