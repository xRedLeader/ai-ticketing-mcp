import { z } from 'zod';
import {
  DomainError,
  ensure,
  validateGitHubConfiguration,
  type GitHubConfiguration,
  type GitHubObservation,
  type GitHubProvider,
  type GitHubCheck,
} from './contracts.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const pullRequest = z.object({
  number: z.int().positive(),
  head: z.object({ sha }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const checkRun = z.object({
  id: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().max(255),
  head_sha: sha,
  app: z.object({ id: z.int().positive() }),
  status: z.string().max(40),
  conclusion: z.string().max(80).nullable(),
  html_url: z.url().max(2048),
});
const checkPage = z.object({ total_count: z.int().nonnegative(), check_runs: z.array(checkRun).max(100) });

export class GitHubClient implements GitHubProvider {
  constructor(
    private readonly token?: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async json(path: string, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ai-ticketing-mcp',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        redirect: 'error',
        signal,
      });
    } catch {
      throw new DomainError('GITHUB_UNAVAILABLE', 'GitHub evidence could not be retrieved.');
    }
    ensure(response.ok, 'GITHUB_UNAVAILABLE', 'GitHub evidence could not be retrieved.', {
      status: response.status,
    });
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new DomainError('GITHUB_UNAVAILABLE', 'GitHub evidence could not be retrieved.');
    }
    ensure(
      Buffer.byteLength(text) <= 4 * 1024 * 1024,
      'GITHUB_RESPONSE_TOO_LARGE',
      'GitHub returned too much evidence.',
    );
    try {
      return JSON.parse(text);
    } catch {
      throw new DomainError('GITHUB_INVALID_RESPONSE', 'GitHub returned invalid evidence.');
    }
  }

  async inspect(configuration: GitHubConfiguration, number: number): Promise<GitHubObservation> {
    validateGitHubConfiguration(configuration);
    const signal = AbortSignal.timeout(15000);
    ensure(Number.isSafeInteger(number) && number > 0, 'INVALID_INPUT', 'A pull request number is required.');
    const repository = configuration.repository;
    const path = `/repos/${repository}/pulls/${number}`;
    const parsePullRequest = (value: unknown) => {
      const result = pullRequest.safeParse(value);
      ensure(
        result.success &&
          result.data.number === number &&
          result.data.base.repo.full_name.toLowerCase() === repository.toLowerCase(),
        'GITHUB_INVALID_RESPONSE',
        'GitHub returned evidence for a different pull request or repository.',
      );
      return result.data.head.sha.toLowerCase();
    };
    const head = parsePullRequest(await this.json(path, signal));
    const checks: GitHubCheck[] = [];
    for (const name of configuration.required_checks) {
      const runs: z.infer<typeof checkRun>[] = [];
      for (let page = 1; page <= 10; page++) {
        const value = checkPage.safeParse(
          await this.json(
            `/repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100&page=${page}`,
            signal,
          ),
        );
        ensure(value.success, 'GITHUB_INVALID_RESPONSE', 'GitHub returned invalid check runs.');
        runs.push(...value.data.check_runs);
        ensure(
          value.data.check_runs.length > 0 || runs.length >= value.data.total_count,
          'GITHUB_INCOMPLETE_EVIDENCE',
          'GitHub check pagination was incomplete. Retry the same refresh request.',
        );
        if (runs.length >= value.data.total_count) break;
        ensure(page < 10, 'GITHUB_EVIDENCE_LIMIT', 'Too many check runs to verify completely.');
      }
      const run = runs
        .filter(
          (item) =>
            item.name === name &&
            item.app.id === configuration.check_app_id &&
            item.head_sha.toLowerCase() === head,
        )
        .sort((a, b) => b.id - a.id)[0];
      checks.push(
        run
          ? {
              name,
              required_app_id: configuration.check_app_id,
              run_id: run.id,
              app_id: run.app.id,
              head_sha: run.head_sha.toLowerCase(),
              status: run.status,
              conclusion: run.conclusion,
              url: run.html_url,
            }
          : {
              name,
              required_app_id: configuration.check_app_id,
              run_id: null,
              app_id: null,
              head_sha: null,
              status: 'missing',
              conclusion: null,
              url: null,
            },
      );
    }
    const observed = parsePullRequest(await this.json(path, signal));
    const status =
      observed !== head
        ? 'stale'
        : checks.some((check) => check.status === 'missing')
          ? 'missing'
          : checks.some((check) => check.status !== 'completed')
            ? 'pending'
            : checks.some((check) => check.conclusion !== 'success')
              ? 'failed'
              : 'passed';
    return { head_sha: head, observed_head_sha: observed, status, checks };
  }
}
