import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UsageBudget,
  type UsageBudgetAdmission,
  type UsageBudgetRun,
  type UsageBudgetSettlement,
} from '../src/usage-budget.js';

const execute = promisify(execFile);
const config: UsageBudgetRun = {
  run_id: 'run',
  project_id: 'project',
  work: [
    { ticket_id: 'one', requirements_revision: 1 },
    { ticket_id: 'two', requirements_revision: 2 },
  ],
  limits: { max_provider_tokens: 1000, max_cost_usd_micros: 1000 },
};
function request(attempt_id: string, extra: Partial<UsageBudgetAdmission> = {}): UsageBudgetAdmission {
  return {
    attempt_id,
    ticket_id: 'one',
    requirements_revision: 1,
    actor_id: 'worker',
    role: 'worker',
    provider: 'fixture',
    model: 'deterministic',
    allowance: { provider_tokens: 300, runtime_ms: 10000, cost_usd_micros: 300 },
    ...extra,
  };
}
const settlement: UsageBudgetSettlement = {
  outcome: 'succeeded',
  usage: {
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_input_tokens: 20,
    output_tokens: 50,
    reasoning_output_tokens: 30,
  },
  usage_source: 'fixture-provider-terminal-event',
  runtime_ms: 100,
  provider_retry_count: 0,
  cost_usd_micros: 100,
  cost_source: 'fixture-invoice',
  reference_tokens: 500,
  estimated_provider_tokens: 250,
  estimated_cost_usd_micros: 200,
};
const acceptance = {
  source: 'authenticated-ticket-get:fixture',
  ticket: {
    id: 'one',
    project_id: 'project',
    requirements_revision: 1,
    status: 'done' as const,
    approved_submission_id: 'submission',
  },
  submission: {
    id: 'submission',
    project_id: 'project',
    ticket_id: 'one',
    actor_id: 'worker',
    requirements_revision: 1,
  },
  review: {
    id: 'review',
    project_id: 'project',
    ticket_id: 'one',
    submission_id: 'submission',
    actor_id: 'reviewer',
    decision: 'approve' as const,
  },
};

async function fixture(run = config) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-usage-budget-'));
  const filename = join(directory, 'ledger.sqlite');
  const ledger = new UsageBudget(filename);
  ledger.createRun(run);
  return {
    directory,
    filename,
    ledger,
    async dispose() {
      ledger.close();
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-usage-budget-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('reports room for zero-cost work at the cost cap', async () => {
  const f = await fixture({ ...config, limits: { ...config.limits, max_cost_usd_micros: 0 } });
  try {
    assert.equal(f.ledger.report('run').status, 'ready');
    assert.equal(
      f.ledger.admit(
        'run',
        request('free', { allowance: { provider_tokens: 300, runtime_ms: 10000, cost_usd_micros: 0 } }),
      ).admitted,
      true,
    );
    assert.equal(f.ledger.report('run').status, 'ready');
    const priced = f.ledger.admit('run', request('priced'));
    assert.equal(priced.admitted, false);
    assert.deepEqual(priced.reasons, ['cost_limit']);
  } finally {
    await f.dispose();
  }
});

it('attributes failures, explicit and provider retries, review usage, costs, and accepted work without subset double counting', async () => {
  const f = await fixture();
  try {
    f.ledger.admit('run', request('failed'));
    f.ledger.settle('run', 'failed', { ...settlement, outcome: 'rejected', provider_retry_count: 2 });
    f.ledger.admit('run', request('retry', { retry_of: 'failed' }));
    f.ledger.settle('run', 'retry', settlement);
    f.ledger.admit('run', request('review', { role: 'reviewer', actor_id: 'reviewer' }));
    f.ledger.settle('run', 'review', settlement);
    f.ledger.admit('run', request('approval', { role: 'approval_review', actor_id: 'approval-reviewer' }));
    f.ledger.settle('run', 'approval', settlement);
    assert.deepEqual(f.ledger.recordAcceptance('run', acceptance), { recorded: true });
    assert.deepEqual(f.ledger.recordAcceptance('run', acceptance), { recorded: false });
    const report = f.ledger.report('run');
    assert.equal(report.totals.rejected, 1);
    assert.equal(report.totals.retries, 1);
    assert.deepEqual(report.totals.provider_usage.total_tokens, { known_total: 600, unknown_invocations: 0 });
    assert.deepEqual(report.totals.provider_usage.cached_input_tokens, {
      known_total: 240,
      unknown_invocations: 0,
    });
    assert.deepEqual(report.totals.provider_usage.reasoning_output_tokens, {
      known_total: 120,
      unknown_invocations: 0,
    });
    assert.equal(report.totals.provider_usage.provider_retry_count.known_total, 2);
    assert.equal(report.by_role.reviewer?.provider_usage.total_tokens.known_total, 150);
    assert.equal(report.by_role.approval_review?.provider_usage.total_tokens.known_total, 150);
    assert.equal(report.totals.billing.cost_usd_micros.known_total, 400);
    assert.equal(report.totals.reference.tokens.known_total, 2000);
    assert.equal(report.totals.estimates.provider_tokens.known_total, 1000);
    assert.equal(report.totals.runtime_ms.known_total, 400);
    assert.equal(report.work[0]?.totals.provider_usage.total_tokens.known_total, 600);
    assert.deepEqual(report.completion, {
      planned: 2,
      independently_accepted: 1,
      unfinished: 1,
      denominator: 'unique independently accepted (ticket_id, requirements_revision)',
      provider_tokens_per_accepted: 600,
    });
  } finally {
    await f.dispose();
  }
});

it('preserves unknown metering and conservative reservations across restart, and blocks further dispatch', async () => {
  const f = await fixture();
  try {
    f.ledger.admit('run', request('failed'));
    f.ledger.settle('run', 'failed', {
      outcome: 'failed',
      runtime_ms: null,
      usage: { input_tokens: 100 },
      usage_source: 'partial-provider-event',
    });
    const reopened = new UsageBudget(f.filename);
    try {
      const report = reopened.report('run');
      assert.equal(report.status, 'needs_attention');
      assert.deepEqual(report.totals.provider_usage.total_tokens, { known_total: 0, unknown_invocations: 1 });
      assert.deepEqual(report.totals.provider_usage.input_tokens, {
        known_total: 100,
        unknown_invocations: 0,
      });
      assert.deepEqual(report.totals.provider_usage.output_tokens, {
        known_total: 0,
        unknown_invocations: 1,
      });
      assert.deepEqual(report.totals.billing.cost_usd_micros, { known_total: 0, unknown_invocations: 1 });
      assert.equal(report.completion.provider_tokens_per_accepted, null);
      assert.deepEqual(report.budget_charged_or_reserved, {
        attempts: 1,
        provider_tokens: 300,
        runtime_ms: 10000,
        cost_usd_micros: 300,
      });
      let invoked = false;
      const denial = await reopened.runInvocation('run', request('blocked'), async () => {
        invoked = true;
        return settlement;
      });
      assert.equal(denial.admitted, false);
      assert.equal(invoked, false);
    } finally {
      reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

it('preserves unknown subsets, hidden retries and billing without inventing costs when monetary enforcement is disabled', async () => {
  const f = await fixture({ ...config, limits: { max_provider_tokens: 1000 } });
  try {
    f.ledger.admit(
      'run',
      request('unknown-cost', {
        allowance: { provider_tokens: 300, runtime_ms: 10000, cost_usd_micros: 300 },
      }),
    );
    f.ledger.settle('run', 'unknown-cost', {
      outcome: 'succeeded',
      usage: { input_tokens: 100, output_tokens: 50 },
      usage_source: 'provider-event',
      runtime_ms: 100,
    });
    const report = f.ledger.report('run');
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.totals.provider_usage.total_tokens, { known_total: 150, unknown_invocations: 0 });
    assert.deepEqual(report.totals.provider_usage.cached_input_tokens, {
      known_total: 0,
      unknown_invocations: 1,
    });
    assert.deepEqual(report.totals.provider_usage.provider_retry_count, {
      known_total: 0,
      unknown_invocations: 1,
    });
    assert.deepEqual(report.totals.billing.cost_usd_micros, { known_total: 0, unknown_invocations: 1 });
  } finally {
    await f.dispose();
  }
});

it('makes config, attempt admission, settlement, and acceptance immutable and replay safe', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.ledger.createRun(config), { created: false });
    assert.throws(() =>
      f.ledger.createRun({ ...config, limits: { ...config.limits, invocation_timeout_ms: 2147483648 } }),
    );
    assert.throws(
      () => f.ledger.createRun({ ...config, limits: { ...config.limits, max_provider_tokens: 2000 } }),
      /immutable/,
    );
    assert.equal(f.ledger.admit('run', request('one')).start_allowed, true);
    assert.equal(f.ledger.admit('run', request('one')).start_allowed, false);
    assert.throws(() => f.ledger.admit('run', request('one', { actor_id: 'different' })), /identity/);
    assert.throws(() => f.ledger.admit('run', request('early-retry', { retry_of: 'one' })), /settled/);
    assert.throws(() => f.ledger.settle('run', 'missing', settlement), /not found/);
    assert.throws(
      () =>
        f.ledger.settle('run', 'one', {
          ...settlement,
          usage: { input_tokens: 10, cached_input_tokens: 11 },
        }),
      /subsets/,
    );
    assert.throws(
      () =>
        f.ledger.settle('run', 'one', {
          ...settlement,
          usage: { input_tokens: 10, cached_input_tokens: 6, cache_write_input_tokens: 5 },
        }),
      /subsets/,
    );
    assert.throws(
      () =>
        f.ledger.settle('run', 'one', {
          ...settlement,
          usage: { output_tokens: 10, reasoning_output_tokens: 11 },
        }),
      /subset/,
    );
    assert.throws(
      () => f.ledger.settle('run', 'one', { ...settlement, cost_source: null }),
      /billing source/,
    );
    assert.throws(
      () => f.ledger.settle('run', 'one', { ...settlement, usage_source: null }),
      /observation source/,
    );
    assert.deepEqual(f.ledger.settle('run', 'one', settlement), { recorded: true });
    assert.deepEqual(f.ledger.settle('run', 'one', settlement), { recorded: false });
    assert.throws(() => f.ledger.settle('run', 'one', { ...settlement, outcome: 'failed' }), /immutable/);
    let invoked = false;
    await f.ledger.runInvocation('run', request('one'), async () => {
      invoked = true;
      return settlement;
    });
    assert.equal(invoked, false);
    assert.throws(
      () =>
        f.ledger.recordAcceptance('run', {
          ...acceptance,
          review: { ...acceptance.review, actor_id: 'worker' },
        }),
      /independent/,
    );
    assert.throws(
      () =>
        f.ledger.recordAcceptance('run', {
          ...acceptance,
          ticket: { ...acceptance.ticket, requirements_revision: 2 },
        }),
      /matching/,
    );
    assert.throws(
      () =>
        f.ledger.recordAcceptance('run', {
          ...acceptance,
          review: { ...acceptance.review, submission_id: 'wrong' },
        }),
      /matching/,
    );
    f.ledger.recordAcceptance('run', acceptance);
    assert.throws(
      () =>
        f.ledger.recordAcceptance('run', {
          ...acceptance,
          review: { ...acceptance.review, id: 'other-review' },
        }),
      /immutable/,
    );
    assert.equal(f.ledger.report('run').totals.invocations, 1);
  } finally {
    await f.dispose();
  }
});

it('keeps a known partial token overrun above the original allowance when the other total is unknown', async () => {
  const f = await fixture();
  try {
    f.ledger.admit('run', request('partial'));
    f.ledger.settle('run', 'partial', {
      outcome: 'failed',
      usage: { input_tokens: 500 },
      usage_source: 'partial-event',
      runtime_ms: null,
    });
    const report = f.ledger.report('run');
    assert.equal(report.budget_charged_or_reserved.provider_tokens, 500);
    assert.deepEqual(report.totals.provider_usage.total_tokens, { known_total: 0, unknown_invocations: 1 });
    assert.equal(report.status, 'needs_attention');
  } finally {
    await f.dispose();
  }
});

it('uses known cache and reasoning subsets as lower bounds without inventing unknown input/output totals', async () => {
  for (const usage of [
    { cached_input_tokens: 500, cache_write_input_tokens: 200, output_tokens: 30 },
    { input_tokens: 30, reasoning_output_tokens: 700 },
  ]) {
    const f = await fixture();
    try {
      f.ledger.admit('run', request('subsets'));
      f.ledger.settle('run', 'subsets', {
        outcome: 'failed',
        usage,
        usage_source: 'partial-event',
        runtime_ms: null,
      });
      const report = f.ledger.report('run');
      assert.equal(report.budget_charged_or_reserved.provider_tokens, 730);
      assert.deepEqual(report.totals.provider_usage.total_tokens, { known_total: 0, unknown_invocations: 1 });
      assert.equal(report.status, 'needs_attention');
    } finally {
      await f.dispose();
    }
  }
});

it('reserves atomically across local processes and never refunds a crashed owner', async () => {
  const f = await fixture({
    ...config,
    limits: { max_attempts: 2, max_provider_tokens: 600, max_runtime_ms: 20000, max_cost_usd_micros: 600 },
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        execute(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `import {UsageBudget} from './src/usage-budget.ts';
       const ledger=new UsageBudget(process.argv[1]);
       try { console.log(JSON.stringify(ledger.admit('run', JSON.parse(process.argv[2])))); } finally { ledger.close(); }`,
            f.filename,
            JSON.stringify(request(`race-${i}`)),
          ],
          { cwd: resolve(import.meta.dirname, '..') },
        ),
      ),
    );
    const admissions = results.map((result) => JSON.parse(result.stdout));
    assert.equal(admissions.filter((result) => result.start_allowed).length, 2);
    assert.ok(
      admissions.filter((result) => !result.admitted).every((result) => result.status === 'needs_attention'),
    );
    const report = f.ledger.report('run');
    assert.equal(report.totals.in_flight, 2);
    assert.deepEqual(report.budget_charged_or_reserved, {
      attempts: 2,
      provider_tokens: 600,
      runtime_ms: 20000,
      cost_usd_micros: 600,
    });
    assert.equal(report.status, 'needs_attention');
    assert.equal(report.completion.unfinished, 2);
  } finally {
    await f.dispose();
  }
});

it('blocks each configured budget and counts an admitted no-dispatch failure as an attempt', async () => {
  for (const limits of [
    { max_provider_tokens: 299 },
    { max_provider_tokens: 1000, max_runtime_ms: 9999 },
    { max_provider_tokens: 1000, max_cost_usd_micros: 299 },
  ]) {
    const f = await fixture({ ...config, limits });
    try {
      assert.equal(f.ledger.admit('run', request('denied')).admitted, false);
      assert.equal(f.ledger.report('run').totals.invocations, 0);
      assert.equal(f.ledger.report('run').status, 'needs_attention');
    } finally {
      await f.dispose();
    }
  }
  const f = await fixture({ ...config, limits: { max_attempts: 1, max_provider_tokens: 1000 } });
  try {
    f.ledger.admit('run', request('worktree-failed'));
    f.ledger.settle('run', 'worktree-failed', {
      outcome: 'failed',
      runtime_ms: 0,
      cost_usd_micros: 0,
      cost_source: 'no-provider-dispatch',
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
      usage_source: 'no-provider-dispatch',
      provider_retry_count: 0,
    });
    const report = f.ledger.report('run');
    assert.deepEqual(report.budget_charged_or_reserved, {
      attempts: 1,
      provider_tokens: 0,
      runtime_ms: 0,
      cost_usd_micros: 0,
    });
    assert.equal(f.ledger.admit('run', request('retry', { retry_of: 'worktree-failed' })).admitted, false);
  } finally {
    await f.dispose();
  }
});

it('blocks on observed overruns and overdue invocations without dropping usage', async () => {
  const f = await fixture();
  try {
    f.ledger.admit('run', request('overrun'));
    f.ledger.settle('run', 'overrun', {
      ...settlement,
      usage: { input_tokens: 400, output_tokens: 200 },
      runtime_ms: 11000,
      cost_usd_micros: 400,
    });
    const report = f.ledger.report('run');
    assert.equal(report.status, 'needs_attention');
    assert.equal(report.reasons.length, 3);
    assert.equal(report.totals.provider_usage.total_tokens.known_total, 600);
    assert.equal(report.budget_charged_or_reserved.provider_tokens, 600);
  } finally {
    await f.dispose();
  }
  const overdue = await fixture();
  try {
    overdue.ledger.admit(
      'run',
      request('overdue', { allowance: { provider_tokens: 10, runtime_ms: 1, cost_usd_micros: 10 } }),
    );
    await new Promise((done) => setTimeout(done, 10));
    assert.ok(overdue.ledger.report('run').reasons.includes('overdue:overdue'));
    assert.equal(overdue.ledger.admit('run', request('blocked')).admitted, false);
    assert.equal(overdue.ledger.report('run').budget_charged_or_reserved.provider_tokens, 10);
  } finally {
    await overdue.dispose();
  }
});

it('dispatches one deterministic callback only after durable admission and retains thrown failures', async () => {
  const f = await fixture();
  try {
    await f.ledger.runInvocation('run', request('callback'), async (signal) => {
      assert.equal(signal.aborted, false);
      const observer = new UsageBudget(f.filename);
      try {
        assert.equal(observer.report('run').totals.in_flight, 1);
      } finally {
        observer.close();
      }
      return settlement;
    });
    await assert.rejects(
      f.ledger.runInvocation('run', request('throws'), async () => {
        throw new Error('fixture failure');
      }),
      /fixture failure/,
    );
    const report = f.ledger.report('run');
    assert.equal(report.totals.succeeded, 1);
    assert.equal(report.totals.failed, 1);
    assert.equal(report.totals.provider_usage.total_tokens.unknown_invocations, 1);
    assert.equal(report.status, 'needs_attention');
  } finally {
    await f.dispose();
  }
});

it('provides a real offline CLI for creating, admitting, settling, accepting and reporting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-usage-budget-'));
  const ledgerPath = join(directory, 'cli.sqlite');
  const inputPath = join(directory, 'input.json');
  const cli = async (command: string, input?: unknown, more: string[] = []) => {
    if (input) await writeFile(inputPath, JSON.stringify(input));
    const result = await execute(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/usage-budget-cli.ts',
        command,
        '--ledger',
        ledgerPath,
        ...more,
        ...(input ? ['--input-file', inputPath] : []),
      ],
      { cwd: resolve(import.meta.dirname, '..') },
    );
    return JSON.parse(result.stdout);
  };
  try {
    assert.deepEqual(await cli('create', config), { created: true });
    assert.equal((await cli('admit', request('cli'), ['--run', 'run'])).start_allowed, true);
    assert.deepEqual(await cli('settle', settlement, ['--run', 'run', '--attempt', 'cli']), {
      recorded: true,
    });
    assert.deepEqual(await cli('accept', acceptance, ['--run', 'run']), { recorded: true });
    const report = await cli('report', undefined, ['--run', 'run']);
    assert.equal(report.completion.independently_accepted, 1);
    assert.equal(report.totals.provider_usage.total_tokens.known_total, 150);
    await assert.rejects(
      cli(
        'admit',
        request('bad', { allowance: { provider_tokens: 0, runtime_ms: 10, cost_usd_micros: null } }),
        ['--run', 'run'],
      ),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        return true;
      },
    );
  } finally {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-usage-budget-'));
    await rm(directory, { recursive: true, force: true });
  }
});
