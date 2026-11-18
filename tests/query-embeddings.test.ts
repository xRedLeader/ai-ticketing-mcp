import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CachedEmbeddings } from '../src/query-embeddings.js';
import type { EmbeddingProvider } from '../src/contracts.js';

const profile = { id: '0123456789abcdef', model: 'query-test', dimensions: 3 };

it('coalesces exact queries, isolates callers, and passes document calls through', async () => {
  let calls = 0;
  let resolve!: (vector: number[]) => void;
  const pending = new Promise<number[]>((done) => {
    resolve = done;
  });
  const provider: EmbeddingProvider = {
    profile,
    async embed() {
      calls++;
      return pending;
    },
  };
  const cache = new CachedEmbeddings(provider);
  const first = cache.embed('query', 'query');
  const second = cache.embed('query', 'query');
  assert.equal(calls, 1);
  const original = [1, 2, 3];
  resolve(original);
  const [a, b] = await Promise.all([first, second]);
  a[0] = 99;
  original[1] = 99;
  assert.deepEqual(b, [1, 2, 3]);
  assert.deepEqual(await cache.embed('query', 'query'), [1, 2, 3]);
  await cache.embed('query ', 'query');
  await cache.embed('query', 'document');
  await cache.embed('query', 'document');
  assert.equal(calls, 4);
  assert.equal(cache.metrics.query_embedding_reuses, 2);
  assert.equal(cache.metrics.embedding_calls, 4);
  assert.ok(Object.isFrozen(cache.profile));
});

it('expires successful vectors ten minutes after completion and evicts resolved LRU entries', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let resolve!: (vector: number[]) => void;
  const initial = new Promise<number[]>((done) => {
    resolve = done;
  });
  const cache = new CachedEmbeddings({
    profile,
    async embed() {
      calls++;
      return calls === 1 ? initial : [1, 2, 3];
    },
  });
  const pending = cache.embed('first', 'query');
  now += 600_000;
  resolve([1, 2, 3]);
  await pending;
  now += 599_999;
  await cache.embed('first', 'query');
  assert.equal(calls, 1);
  now++;
  await cache.embed('first', 'query');
  assert.equal(calls, 2);
  for (let i = 0; i < 255; i++) await cache.embed(`query-${i}`, 'query');
  await cache.embed('first', 'query');
  await cache.embed('overflow', 'query');
  const before = calls;
  await cache.embed('first', 'query');
  assert.equal(calls, before);
  await cache.embed('query-0', 'query');
  assert.equal(calls, before + 1);
});

it('reclaims an expired recent entry before a live LRU entry without evicting pending work', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  let resolve!: (vector: number[]) => void;
  const pending = new Promise<number[]>((done) => {
    resolve = done;
  });
  const cache = new CachedEmbeddings({
    profile,
    async embed(text) {
      calls.push(text);
      return text === 'pending' ? pending : [1, 2, 3];
    },
  });
  const first = cache.embed('pending', 'query');
  await cache.embed('expired', 'query');
  now++;
  for (let i = 0; i < 254; i++) await cache.embed(`live-${i}`, 'query');
  await cache.embed('expired', 'query');
  now = 601_000;
  await cache.embed('overflow', 'query');
  const joined = cache.embed('pending', 'query');
  resolve([1, 2, 3]);
  await Promise.all([first, joined]);
  assert.equal(calls.filter((text) => text === 'pending').length, 1);
  await cache.embed('live-0', 'query');
  assert.equal(calls.filter((text) => text === 'live-0').length, 1);
  await cache.embed('expired', 'query');
  assert.equal(calls.filter((text) => text === 'expired').length, 2);
});

it('bounds pending entries, keeps matching work coalesced, and retries rejected work', async () => {
  let calls = 0;
  let resolve!: (vector: number[]) => void;
  const pending = new Promise<number[]>((done) => {
    resolve = done;
  });
  const cache = new CachedEmbeddings({
    profile,
    async embed() {
      calls++;
      return pending;
    },
  });
  const requests = Array.from({ length: 256 }, (_, i) => cache.embed(`pending-${i}`, 'query'));
  requests.push(cache.embed('pending-0', 'query'));
  await assert.rejects(cache.embed('overflow', 'query'), { code: 'EMBEDDING_UNAVAILABLE' });
  assert.equal(calls, 256);
  assert.equal(cache.metrics.query_embedding_saturations, 1);
  resolve([1, 2, 3]);
  const results = await Promise.all(requests);
  results[0]![0] = 99;
  assert.equal(results.at(-1)![0], 1);
  await cache.embed('overflow', 'query');
  assert.equal(calls, 257);

  let attempts = 0;
  const retrying = new CachedEmbeddings({
    profile,
    async embed() {
      if (++attempts === 1) throw new Error('offline');
      return [1, 2, 3];
    },
  });
  const failed = [retrying.embed('same', 'query'), retrying.embed('same', 'query')];
  for (const result of await Promise.allSettled(failed)) assert.equal(result.status, 'rejected');
  assert.deepEqual(await retrying.embed('same', 'query'), [1, 2, 3]);
  assert.equal(attempts, 2);
  assert.equal(retrying.metrics.embedding_failures, 1);
});

it('separates immutable embedding profiles', async () => {
  const mutable = { ...profile };
  const first = new CachedEmbeddings({
    profile: mutable,
    async embed() {
      return [1, 0, 0];
    },
  });
  mutable.id = 'fedcba9876543210';
  mutable.model = 'changed';
  const second = new CachedEmbeddings({
    profile: mutable,
    async embed() {
      return [0, 1, 0];
    },
  });
  assert.equal(first.profile.id, profile.id);
  assert.deepEqual(await first.embed('same', 'query'), [1, 0, 0]);
  assert.deepEqual(await second.embed('same', 'query'), [0, 1, 0]);
});
