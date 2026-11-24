import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { captureReviewBenchmarkPair, scoreReviewDecision } from './review-benchmark.mjs';

const endpoint = 'https://api.openai.com/v1/responses';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const jsonFile = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const known = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export function reviewUsage(input, output, cached, reasoning) {
  const inputTokens = known(input),
    outputTokens = known(output);
  const cachedTokens = known(cached),
    reasoningTokens = known(reasoning);
  return {
    input: inputTokens,
    output: outputTokens,
    cached_input: cachedTokens,
    reasoning_output: reasoningTokens,
    total: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
  };
}

async function responses(requestBody, directory, mode) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: {
      authorization: 'Bearer ' + process.env.REVIEW_OPENAI_API_KEY,
      'content-type': 'application/json',
    },
    body: requestBody,
  });
  const raw = await response.text();
  await writeFile(join(directory, mode + '.response.json'), raw, { flag: 'wx', mode: 0o600 });
  const data = JSON.parse(raw);
  const usage = reviewUsage(
    data.usage?.input_tokens,
    data.usage?.output_tokens,
    data.usage?.input_tokens_details?.cached_tokens,
    data.usage?.output_tokens_details?.reasoning_tokens,
  );
  const content = data.output?.flatMap((item) => (item.type === 'message' ? item.content : [])) ?? [];
  const ok =
    response.ok && data.status === 'completed' && content.length === 1 && content[0].type === 'output_text';
  return {
    usage,
    model_observed: data.model ?? null,
    decision: ok ? decisionJSON(content[0].text) : null,
    error: ok ? null : 'Response status ' + response.status + ' / ' + (data.status ?? 'unknown'),
  };
}

function decisionJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function codex(request, directory, mode, binary, effort) {
  const cwd = await mkdtemp(join(tmpdir(), 'review-benchmark-'));
  const args = [
    '--no-daemon',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--strict-config',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    cwd,
    '-m',
    request.model,
    '-c',
    'model_reasoning_effort=' + JSON.stringify(effort),
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '--disable',
    'plugins',
    '--disable',
    'apps',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--disable',
    'multi_agent',
    '--output-schema',
    join(directory, 'schema.json'),
    '-',
  ];
  const path = join(directory, mode + '.jsonl');
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    err = createWriteStream(join(directory, mode + '.stderr'), { flags: 'wx', mode: 0o600 });
  try {
    const child = spawn(binary, args, {
      cwd,
      windowsHide: true,
      timeout: 180_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(request.instructions + '\n\n' + request.input);
    const [code] = await Promise.all([done, pipeline(child.stdout, out), pipeline(child.stderr, err)]);
    const events = (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const terminal = events.filter((e) => ['turn.completed', 'turn.failed'].includes(e.type));
    const u = terminal.length === 1 ? terminal[0].usage : undefined;
    const usage = reviewUsage(
      u?.input_tokens,
      u?.output_tokens,
      u?.cached_input_tokens,
      u?.reasoning_output_tokens,
    );
    const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
    const diagnostics = events.filter((e) => e.type === 'error' || e.item?.type === 'error').length;
    const ok =
      code === 0 &&
      terminal.length === 1 &&
      terminal[0].type === 'turn.completed' &&
      diagnostics === 0 &&
      items.every((item) => ['agent_message', 'reasoning', 'plan'].includes(item.type)) &&
      events
        .filter((e) => e.type === 'item.started')
        .every((e) => ['agent_message', 'reasoning', 'plan'].includes(e.item.type));
    return {
      usage,
      model_observed: null,
      decision: ok ? decisionJSON(items.findLast((item) => item.type === 'agent_message')?.text) : null,
      error: ok ? null : 'Incomplete Codex turn, client diagnostics, or unexpected tool invocation.',
    };
  } finally {
    out.destroy();
    err.destroy();
    await rmdir(cwd).catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      scenario: { type: 'string', default: 'pass' },
      model: { type: 'string' },
      client: { type: 'string', default: 'responses' },
      'codex-bin': { type: 'string' },
      effort: { type: 'string', default: 'high' },
    },
  });
  assert.match(values.run ?? '', /^[a-zA-Z0-9_-]{1,80}$/, 'Supply a new --run name.');
  assert(['responses', 'codex'].includes(values.client), 'Unknown client.');
  const useCodex = values.client === 'codex';
  if (useCodex)
    assert(
      isAbsolute(values['codex-bin'] ?? '') && values.model,
      'Codex requires --codex-bin ABSOLUTE_PATH and --model.',
    );
  else assert(process.env.REVIEW_OPENAI_API_KEY, 'Set REVIEW_OPENAI_API_KEY for the Responses API.');
  const pair = await captureReviewBenchmarkPair(values.scenario, { model: values.model ?? 'gpt-5-mini' });
  const { full, compact } = pair.packets;
  const { input: fullInput, ...fixed } = full.request;
  const { input: compactInput, ...other } = compact.request;
  assert.deepEqual(fixed, other);
  assert.deepEqual(fixed.tools, []);
  assert.equal(fixed.store, false);
  assert.equal(typeof fullInput, 'string');
  assert.equal(typeof compactInput, 'string');
  assert(
    fullInput !== compactInput && Buffer.byteLength(compactInput) < Buffer.byteLength(fullInput),
    'This fixture selects the full fallback. Use its offline equivalence check; there is no distinct compact input to measure.',
  );
  const root = fileURLToPath(new URL('../.local/review-benchmarks/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = join(root, values.run);
  await mkdir(directory, { mode: 0o700 });
  await jsonFile(join(directory, 'schema.json'), fixed.text.format.schema);
  const modes = ['full', 'compact'];
  await jsonFile(join(directory, 'design.json'), {
    scenario: values.scenario,
    client: values.client,
    model: fixed.model,
    effort: useCodex ? values.effort : null,
    expected: pair.expected,
    request_sha256: Object.fromEntries(modes.map((m) => [m, hash(pair.packets[m].requestBody)])),
  });
  for (const mode of modes)
    await writeFile(join(directory, mode + '.request.json'), pair.packets[mode].requestBody, {
      flag: 'wx',
      mode: 0o600,
    });
  const arms = await Promise.all(
    modes.map(async (mode) => {
      const start = Date.now(),
        packet = pair.packets[mode];
      let observation;
      try {
        observation = useCodex
          ? await codex(packet.request, directory, mode, values['codex-bin'], values.effort)
          : await responses(packet.requestBody, directory, mode);
      } catch (e) {
        observation = { usage: reviewUsage(), decision: null, error: e.message };
      }
      const arm = { mode, elapsed_ms: Date.now() - start, ...observation };
      await jsonFile(join(directory, mode + '.observation.json'), arm);
      return arm;
    }),
  );
  const report = compareLiveReviews(arms, pair.expected, values.client);
  Object.assign(report, {
    scenario: values.scenario,
    client: values.client,
    requested_model: fixed.model,
    approval_review_usage: null,
    provider_internal_retries: null,
  });
  await jsonFile(join(directory, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

export function compareLiveReviews(arms, expected, client = 'responses') {
  assert.deepEqual(
    arms.map((a) => a.mode),
    ['full', 'compact'],
  );
  const [full, compact] = arms;
  const measured = arms.every(
    (a) =>
      a.usage.total !== null &&
      (a.usage.cached_input === null || a.usage.cached_input <= a.usage.input) &&
      (a.usage.reasoning_output === null || a.usage.reasoning_output <= a.usage.output),
  );
  const quality = arms.map((a) =>
    a.error || !a.decision
      ? { pass: false, errors: [a.error ?? 'Missing decision.'] }
      : scoreReviewDecision(a.decision, expected),
  );
  const saved = measured ? full.usage.total - compact.usage.total : null;
  const inputSaved = measured ? full.usage.input - compact.usage.input : null;
  const sameObservedModel =
    typeof full.model_observed === 'string' &&
    full.model_observed.length > 0 &&
    full.model_observed === compact.model_observed;
  const passed =
    quality.every((v) => v.pass) &&
    (client === 'codex' || sameObservedModel) &&
    saved !== null &&
    saved > 0 &&
    inputSaved > 0;
  return {
    arms,
    quality,
    reported_tokens_saved: saved,
    reported_input_tokens_saved: inputSaved,
    same_observed_model: sameObservedModel,
    native_responses_gate_passed: client === 'responses' && passed,
    passed,
    billed_cost: null,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
