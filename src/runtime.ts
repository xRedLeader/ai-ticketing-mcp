import { PostgresStorage, PostgresSearch } from './adapters/postgres.js';
import { createSqliteAdapters } from './adapters/sqlite.js';
import { HttpEmbeddings } from './adapters/embeddings.js';
import { createApplication } from './application.js';
import { GitHubClient } from './github.js';
import { SignedWebhook } from './webhook.js';
import { ensure, type StorageAdapter, type SearchAdapter, type EmbeddingProvider } from './contracts.js';
export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  ensure(
    Boolean(env.TICKETING_WEBHOOK_URL) === Boolean(env.TICKETING_WEBHOOK_SECRET),
    'INVALID_CONFIG',
    'Configure both TICKETING_WEBHOOK_URL and TICKETING_WEBHOOK_SECRET.',
  );
  const webhook = env.TICKETING_WEBHOOK_URL
    ? new SignedWebhook(env.TICKETING_WEBHOOK_URL, env.TICKETING_WEBHOOK_SECRET!)
    : undefined;
  const adapter = env.STORAGE_ADAPTER ?? 'postgres';
  ensure(
    adapter === 'postgres' || adapter === 'sqlite',
    'INVALID_CONFIG',
    'STORAGE_ADAPTER must be postgres or sqlite.',
  );
  let storage: StorageAdapter;
  let search: SearchAdapter;
  if (adapter === 'sqlite')
    ({ storage, search } = createSqliteAdapters(env.SQLITE_PATH?.trim() ? env.SQLITE_PATH : undefined));
  else {
    ensure(env.DATABASE_URL, 'INVALID_CONFIG', 'DATABASE_URL is required.');
    const postgres = new PostgresStorage(env.DATABASE_URL);
    storage = postgres;
    search = new PostgresSearch(postgres.pool);
  }
  const provider = env.EMBEDDING_PROVIDER ?? (adapter === 'sqlite' ? 'none' : 'ollama');
  ensure(
    ['none', 'ollama', 'openai'].includes(provider),
    'INVALID_CONFIG',
    'EMBEDDING_PROVIDER must be none, ollama, or openai.',
  );
  let embeddings: EmbeddingProvider | undefined;
  if (provider !== 'none' && search.capabilities?.semantic !== false) {
    if (provider === 'openai')
      ensure(
        env.EMBEDDING_URL && env.EMBEDDING_MODEL && env.EMBEDDING_DIMENSIONS,
        'INVALID_CONFIG',
        'Hosted embeddings require EMBEDDING_URL, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS.',
      );
    embeddings = new HttpEmbeddings({
      provider: provider as 'ollama' | 'openai',
      url: env.EMBEDDING_URL ?? 'http://127.0.0.1:11434',
      model: env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      dimensions: Number(env.EMBEDDING_DIMENSIONS ?? 768),
      apiKey: env.EMBEDDING_API_KEY,
      revision: env.EMBEDDING_REVISION ?? '1',
      spaceId: env.EMBEDDING_SPACE_ID?.trim() || undefined,
      timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS ?? 30000),
      queryTimeoutMs: Number(env.EMBEDDING_QUERY_TIMEOUT_MS ?? 2000),
    });
  }
  return createApplication({
    storage,
    search,
    embeddings,
    webhook,
    referenceTokenMetrics: env.REFERENCE_TOKEN_METRICS === 'true',
    ...(env.TICKETING_GITHUB_REPOSITORY
      ? {
          github: {
            repository: env.TICKETING_GITHUB_REPOSITORY.trim(),
            required_checks: (env.TICKETING_GITHUB_REQUIRED_CHECKS ?? '')
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean),
            check_app_id: Number(env.TICKETING_GITHUB_CHECK_APP_ID),
            provider: new GitHubClient(env.GITHUB_TOKEN),
          },
        }
      : {}),
  });
}
