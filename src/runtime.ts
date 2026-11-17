import { PostgresStorage, PostgresSearch } from './adapters/postgres.js';
import { HttpEmbeddings } from './adapters/embeddings.js';
import { createApplication } from './application.js';
import { ensure } from './contracts.js';
export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  ensure(env.DATABASE_URL, 'INVALID_CONFIG', 'DATABASE_URL is required.');
  const storage = new PostgresStorage(env.DATABASE_URL);
  const search = new PostgresSearch(storage.pool);
  const provider = env.EMBEDDING_PROVIDER ?? 'ollama';
  ensure(
    provider === 'ollama' || provider === 'openai',
    'INVALID_CONFIG',
    'EMBEDDING_PROVIDER must be ollama or openai.',
  );
  if (provider === 'openai')
    ensure(
      env.EMBEDDING_URL && env.EMBEDDING_MODEL && env.EMBEDDING_DIMENSIONS,
      'INVALID_CONFIG',
      'Hosted embeddings require EMBEDDING_URL, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS.',
    );
  const embeddings = new HttpEmbeddings({
    provider,
    url: env.EMBEDDING_URL ?? 'http://127.0.0.1:11434',
    model: env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    dimensions: Number(env.EMBEDDING_DIMENSIONS ?? 768),
    apiKey: env.EMBEDDING_API_KEY,
    revision: env.EMBEDDING_REVISION ?? '1',
    spaceId: env.EMBEDDING_SPACE_ID?.trim() || undefined,
    timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS ?? 30000),
  });
  return createApplication({
    storage,
    search,
    embeddings,
    referenceTokenMetrics: env.REFERENCE_TOKEN_METRICS === 'true',
  });
}
