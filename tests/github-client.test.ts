import { it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github.js';

const configuration = {
  repository: 'xRedLeader/ai-ticketing-mcp',
  required_checks: ['verify'],
  check_app_id: 15368,
};
const head = 'a'.repeat(40),
  changed = 'b'.repeat(40);
const pr = (sha = head) => ({
  number: 1,
  head: { sha },
  base: { repo: { full_name: configuration.repository } },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 100,
  name: 'verify',
  head_sha: head,
  app: { id: 15368 },
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/xRedLeader/ai-ticketing-mcp/actions/runs/100',
  ...overrides,
});
function client(runs: ReturnType<typeof run>[], finalHead = head) {
  let reads = 0;
  const requests: string[] = [];
  const provider = new GitHubClient('test-only', (async (input, options) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.body, undefined);
    return new Response(
      JSON.stringify(
        url.pathname.includes('/check-runs')
          ? { total_count: runs.length, check_runs: runs }
          : pr(++reads === 1 ? head : finalHead),
      ),
      { status: 200 },
    );
  }) as typeof fetch);
  return { provider, requests };
}

it('binds successful checks to the exact repository, PR, app, and head without external writes', async () => {
  const f = client([run()]);
  const result = await f.provider.inspect(configuration, 1);
  assert.equal(result.status, 'passed');
  assert.equal(result.head_sha, head);
  assert.equal(result.checks[0]!.app_id, 15368);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[1]!.includes(`/commits/${head}/`));
});

it('does not infer success from missing, incomplete, failed, wrong-origin, or superseded runs', async () => {
  for (const [runs, expected] of [
    [[], 'missing'],
    [[run({ status: 'in_progress', conclusion: null })], 'pending'],
    [[run({ conclusion: 'failure' })], 'failed'],
    [[run({ app: { id: 7 } })], 'missing'],
    [[run({ head_sha: changed })], 'missing'],
    [[run(), run({ id: 101, conclusion: 'cancelled' })], 'failed'],
  ] as const)
    assert.equal((await client([...runs]).provider.inspect(configuration, 1)).status, expected);
  assert.equal((await client([run()], changed).provider.inspect(configuration, 1)).status, 'stale');
});

it('paginates all check runs and selects the latest matching trusted run', async () => {
  let pages = 0;
  const provider = new GitHubClient(undefined, (async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.includes('/check-runs')) return new Response(JSON.stringify(pr()));
    pages++;
    const runs =
      pages === 1
        ? Array.from({ length: 100 }, (_, index) => run({ id: index + 1, app: { id: 99 } }))
        : [run({ id: 200 })];
    return new Response(JSON.stringify({ total_count: 101, check_runs: runs }));
  }) as typeof fetch);
  const result = await provider.inspect(configuration, 1);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0]!.run_id, 200);
  assert.equal(pages, 2);
});

it('fails closed for invalid configuration, repository mismatches, and remote failures', async () => {
  await assert.rejects(client([]).provider.inspect({ ...configuration, required_checks: [] }, 1), {
    code: 'INVALID_CONFIG',
  });
  await assert.rejects(client([]).provider.inspect({ ...configuration, repository: '../other' }, 1), {
    code: 'INVALID_CONFIG',
  });
  const other = new GitHubClient(
    undefined,
    (async () =>
      new Response(
        JSON.stringify({ ...pr(), base: { repo: { full_name: 'other/repository' } } }),
      )) as typeof fetch,
  );
  await assert.rejects(other.inspect(configuration, 1), { code: 'GITHUB_INVALID_RESPONSE' });
  const unavailable = new GitHubClient(
    undefined,
    (async () => new Response('{}', { status: 503 })) as typeof fetch,
  );
  await assert.rejects(unavailable.inspect(configuration, 1), { code: 'GITHUB_UNAVAILABLE' });
});

it('refuses an incomplete advertised page instead of accepting earlier success', async () => {
  let page = 0;
  const provider = new GitHubClient(undefined, (async (input) => {
    if (!String(input).includes('/check-runs')) return new Response(JSON.stringify(pr()));
    page++;
    return new Response(
      JSON.stringify({
        total_count: 101,
        check_runs: page === 1 ? Array.from({ length: 100 }, (_, index) => run({ id: index + 1 })) : [],
      }),
    );
  }) as typeof fetch);
  await assert.rejects(provider.inspect(configuration, 1), { code: 'GITHUB_INCOMPLETE_EVIDENCE' });
});
