import { DomainError, type EmbeddingProfile, type EmbeddingProvider } from './contracts.js';

const CAPACITY = 256;
const TTL_MS = 600_000;
type Entry = { value: Promise<number[]>; expires?: number };

export class CachedEmbeddings implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  readonly metrics = {
    embedding_calls: 0,
    query_embedding_reuses: 0,
    embedding_failures: 0,
    query_embedding_saturations: 0,
  };
  private readonly queries = new Map<string, Entry>();

  constructor(private readonly provider: EmbeddingProvider) {
    this.profile = Object.freeze({ ...provider.profile });
  }

  private async invoke(text: string, purpose: 'query' | 'document') {
    this.metrics.embedding_calls++;
    try {
      return await this.provider.embed(text, purpose);
    } catch (error) {
      this.metrics.embedding_failures++;
      throw error;
    }
  }

  async embed(text: string, purpose: 'query' | 'document'): Promise<number[]> {
    if (purpose === 'document') return (await this.invoke(text, purpose)).slice();
    const key = JSON.stringify([this.profile.id, this.profile.model, this.profile.dimensions, text]);
    const cached = this.queries.get(key);
    if (cached && (cached.expires === undefined || cached.expires > Date.now())) {
      this.queries.delete(key);
      this.queries.set(key, cached);
      this.metrics.query_embedding_reuses++;
      return (await cached.value).slice();
    }
    if (cached) this.queries.delete(key);
    if (this.queries.size === CAPACITY) {
      const oldestResolved = [...this.queries].find(([, entry]) => entry.expires !== undefined);
      if (oldestResolved) this.queries.delete(oldestResolved[0]);
      else {
        this.metrics.query_embedding_saturations++;
        throw new DomainError('EMBEDDING_UNAVAILABLE', 'Semantic query embeddings are busy. Retry later.');
      }
    }
    const entry: Entry = {
      value: this.invoke(text, purpose).then(
        (vector) => {
          if (this.queries.get(key) === entry) entry.expires = Date.now() + TTL_MS;
          return vector.slice();
        },
        (error) => {
          if (this.queries.get(key) === entry) this.queries.delete(key);
          throw error;
        },
      ),
    };
    this.queries.set(key, entry);
    return (await entry.value).slice();
  }
}
