import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SignedWebhook } from '../src/webhook.js';
import { createRuntime } from '../src/runtime.js';
import { hasCode } from '../src/testing/contracts.js';
import type { OutboundDelivery } from '../src/contracts.js';

const secret = 'test-only-signing-key-32-bytes-long';
const row = (target: SignedWebhook): OutboundDelivery => ({
  id: randomUUID(),
  event_id: 'project:1',
  project_id: randomUUID(),
  body: '{ "schema_version": 1, "escaped": "\\u0061" }',
  target_fingerprint: target.fingerprint,
  attempt_count: 1,
  next_attempt_at: new Date().toISOString(),
  locked_until: null,
  lock_token: randomUUID(),
  sent_at: null,
  last_error: null,
  created_at: new Date().toISOString(),
});
async function receiver(work: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(work);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/hooks`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

it('validates fixed destinations and paired configuration without echoing credentials', () => {
  for (const url of [
    'http://localhost/hooks',
    'http://example.test',
    'http://127.1/',
    'http://2130706433/',
    'https://user:password@example.test',
    'https://example.test/#secret',
    'https://example.test/#',
    'file:///tmp/secret',
    'secret',
  ]) {
    assert.throws(() => new SignedWebhook(url, secret), hasCode('INVALID_CONFIG'));
  }
  assert.throws(() => new SignedWebhook('https://example.test', 'short'), hasCode('INVALID_CONFIG'));
  assert.throws(
    () => createRuntime({ TICKETING_WEBHOOK_URL: 'https://example.test' }),
    hasCode('INVALID_CONFIG'),
  );
  assert.throws(() => createRuntime({ TICKETING_WEBHOOK_SECRET: secret }), hasCode('INVALID_CONFIG'));
  const first = new SignedWebhook('HTTPS://EXAMPLE.TEST:443/hooks', secret);
  assert.equal(
    first.fingerprint,
    new SignedWebhook('https://example.test/hooks', 'rotated-test-only-key-at-least-32-bytes').fingerprint,
  );
  assert.doesNotThrow(() => new SignedWebhook('http://[::1]:3000/hooks', secret));
  assert.equal(JSON.stringify(first).includes(secret), false);
});

it('signs exact stored bytes with attempt timestamp and stable delivery ID', async () => {
  const received: { body: string; headers: IncomingMessage['headers'] }[] = [];
  const local = await receiver((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(204).end();
    });
  });
  try {
    const target = new SignedWebhook(local.url, secret);
    const delivery = row(target);
    const clock = mock.method(Date, 'now', () => 1800000000000);
    try {
      assert.equal(await target.send(delivery), undefined);
      clock.mock.mockImplementation(() => 1800000010000);
      assert.equal(await target.send(delivery), undefined);
    } finally {
      clock.mock.restore();
    }
    assert.equal(received.length, 2);
    for (const [index, request] of received.entries()) {
      const timestamp = (1800000000 + index * 10).toString();
      assert.equal(request.body, delivery.body);
      assert.equal(request.headers['x-ticketing-delivery'], delivery.id);
      assert.equal(request.headers['x-ticketing-timestamp'], timestamp);
      assert.equal(
        request.headers['x-ticketing-signature'],
        `sha256=${createHmac('sha256', secret).update(`${timestamp}.${delivery.body}`).digest('hex')}`,
      );
    }
  } finally {
    await local.close();
  }
});

it('refuses target mismatches and redirects, and never reads receiver error bodies', async () => {
  let redirected = 0,
    attempts = 0;
  const destination = await receiver((_req, res) => {
    redirected++;
    res.end();
  });
  const local = await receiver((_req, res) => {
    attempts++;
    res.writeHead(302, { Location: destination.url }).end(secret);
  });
  try {
    const target = new SignedWebhook(local.url, secret),
      delivery = row(target);
    assert.deepEqual(await target.send({ ...delivery, target_fingerprint: '0'.repeat(64) }), {
      error_code: 'TARGET_MISMATCH',
    });
    assert.equal(attempts, 0);
    assert.deepEqual(await target.send(delivery), { error_code: 'HTTP_302' });
    assert.equal(redirected, 0);
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async () =>
        ({
          ok: false,
          status: 503,
          get body() {
            return undefined;
          },
          text() {
            throw new Error('Response body must not be read');
          },
        }) as unknown as Response,
    );
    try {
      assert.deepEqual(await target.send(delivery), { error_code: 'HTTP_503' });
    } finally {
      fetchMock.mock.restore();
    }
  } finally {
    await local.close();
    await destination.close();
  }
});

it(
  'classifies network failures without retaining messages and bounds stalled receivers to five seconds',
  { timeout: 10000 },
  async () => {
    const target = new SignedWebhook('https://example.test/hooks', secret);
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error(`private ${secret}`);
    });
    try {
      assert.deepEqual(await target.send(row(target)), { error_code: 'NETWORK_ERROR' });
    } finally {
      fetchMock.mock.restore();
    }
    const local = await receiver(() => {});
    try {
      const stalled = new SignedWebhook(local.url, secret);
      const started = performance.now();
      assert.deepEqual(await stalled.send(row(stalled)), { error_code: 'TIMEOUT' });
      assert.ok(performance.now() - started < 8000);
    } finally {
      await local.close();
    }
  },
);
