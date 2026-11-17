import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpEmbeddings, type EmbeddingConfig } from '../src/adapters/embeddings.js';

it('identifies effective endpoints and explicit shared embedding spaces', () => {
  const config: EmbeddingConfig = {
    provider: 'openai',
    url: 'http://LOCALHOST:80/v1/',
    model: 'test',
    dimensions: 3,
  };
  const id = (overrides: Partial<EmbeddingConfig> = {}) =>
    new HttpEmbeddings({ ...config, ...overrides }).profile.id;
  assert.equal(id(), id({ url: 'http://localhost/v1#unused' }));
  assert.equal(id(), id({ apiKey: 'different-test-key' }));
  for (const overrides of [
    { url: 'http://localhost:1234/v1' },
    { model: 'other' },
    { dimensions: 4 },
    { revision: '2' },
  ])
    assert.notEqual(id(), id(overrides));
  assert.equal(id({ spaceId: 'local-model' }), id({ url: 'http://alias:1234/v1', spaceId: 'local-model' }));
  assert.notEqual(id({ spaceId: 'local-model' }), id({ spaceId: 'different-model' }));
  assert.throws(() => id({ spaceId: ' ' }), { code: 'INVALID_CONFIG' });
});

it('copies and freezes effective configuration and profile before requests', async () => {
  const requests: { path: string; model: string; authorization?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, model: body.model, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config: EmbeddingConfig = {
      provider: 'openai',
      url: `http://127.0.0.1:${(server.address() as any).port}/v1/`,
      model: 'original',
      dimensions: 3,
      apiKey: 'test-original',
    };
    const embeddings = new HttpEmbeddings(config);
    const originalId = embeddings.profile.id;
    Object.assign(config, {
      url: 'http://invalid.example',
      model: 'changed',
      dimensions: 4,
      apiKey: 'test-changed',
      revision: '2',
    });
    await embeddings.embed('ordinary text', 'query');
    assert.deepEqual(requests, [
      { path: '/v1/embeddings', model: 'original', authorization: 'Bearer test-original' },
    ]);
    assert.equal(embeddings.profile.id, originalId);
    assert.ok(Object.isFrozen(embeddings.profile));
    assert.throws(() => {
      embeddings.profile.model = 'changed';
    }, TypeError);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
