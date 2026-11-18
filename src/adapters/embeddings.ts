import { createHash } from 'node:crypto';
import { ensure, DomainError, type EmbeddingProfile, type EmbeddingProvider } from '../contracts.js';

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  url: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  timeoutMs?: number;
  /** Interactive searches fall back to full text quickly instead of waiting for document-sized timeouts. */
  queryTimeoutMs?: number;
  revision?: string;
  spaceId?: string;
}
// shortcut: mean pooling loses passage precision; add chunk retrieval when relevance evaluations require it.
export class HttpEmbeddings implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  private readonly config: Readonly<EmbeddingConfig>;
  constructor(config: EmbeddingConfig) {
    const url = new URL(config.url);
    ensure(
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
      'INVALID_CONFIG',
      'Embedding URL must be HTTP(S) without embedded credentials.',
    );
    ensure(
      Number.isInteger(config.dimensions) && config.dimensions >= 1 && config.dimensions <= 2000,
      'INVALID_CONFIG',
      'Embedding dimensions must be 1–2000.',
    );
    ensure(
      config.spaceId === undefined || config.spaceId.trim().length > 0,
      'INVALID_CONFIG',
      'Embedding space ID cannot be empty.',
    );
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.hash = '';
    this.config = Object.freeze({
      ...config,
      url: url.href,
      timeoutMs: config.timeoutMs ?? 30000,
      revision: config.revision ?? '1',
      spaceId: config.spaceId?.trim(),
    });
    const endpoint = new URL(url);
    endpoint.pathname =
      endpoint.pathname.replace(/\/$/, '') + (config.provider === 'ollama' ? '/api/embed' : '/embeddings');
    this.profile = Object.freeze({
      id: createHash('sha256')
        .update(
          JSON.stringify([
            config.provider,
            this.config.spaceId === undefined ? ['endpoint', endpoint.href] : ['space', this.config.spaceId],
            this.config.revision,
            config.model,
            config.dimensions,
            'chunks-6000-mean-v1',
          ]),
        )
        .digest('hex')
        .slice(0, 24),
      model: config.model,
      dimensions: config.dimensions,
    });
  }
  async embed(text: string, purpose: 'query' | 'document') {
    const chunks = text.match(/[\s\S]{1,6000}/gu) ?? [''];
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 8) {
      const inputs = chunks
        .slice(offset, offset + 8)
        .map((chunk) =>
          this.config.model.startsWith('nomic-embed-text')
            ? `${purpose === 'query' ? 'search_query' : 'search_document'}: ${chunk}`
            : chunk,
        );
      const url = new URL(this.config.url);
      url.pathname =
        url.pathname.replace(/\/$/, '') + (this.config.provider === 'ollama' ? '/api/embed' : '/embeddings');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(
          this.config.provider === 'ollama'
            ? { model: this.config.model, input: inputs, truncate: false }
            : {
                model: this.config.model,
                input: inputs,
                dimensions: this.config.dimensions,
                encoding_format: 'float',
              },
        ),
        signal: AbortSignal.timeout(
          purpose === 'query' ? (this.config.queryTimeoutMs ?? 2000) : (this.config.timeoutMs ?? 30000),
        ),
      });
      if (!response.ok)
        throw new DomainError(
          'EMBEDDING_UNAVAILABLE',
          `Embedding provider returned HTTP ${response.status}.`,
        );
      const result = (await response.json()) as {
        embeddings?: number[][];
        data?: { index: number; embedding: number[] }[];
      };
      const batch =
        this.config.provider === 'ollama'
          ? result.embeddings
          : result.data?.sort((a, b) => a.index - b.index).map((item) => item.embedding);
      ensure(
        batch &&
          batch.length === inputs.length &&
          batch.every(
            (vector) =>
              Array.isArray(vector) &&
              vector.length === this.profile.dimensions &&
              vector.every(Number.isFinite),
          ),
        'INVALID_EMBEDDING',
        'Provider returned invalid embeddings.',
      );
      vectors.push(...batch);
    }
    const mean = Array.from(
      { length: this.profile.dimensions },
      (_, i) => vectors.reduce((sum, vector) => sum + vector[i]!, 0) / vectors.length,
    );
    const norm = Math.hypot(...mean);
    ensure(norm > 0, 'INVALID_EMBEDDING', 'Provider returned a zero vector.');
    return mean.map((value) => value / norm);
  }
}
