import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Application } from '../src/application.js';
import { createHttpServer } from '../src/http.js';
import { createAuthenticator } from '../src/auth.js';
import type { StorageAdapter } from '../src/contracts.js';

it('returns a bad request when URL parsing fails and still serves health checks', async (t) => {
  const server = createHttpServer({} as Application, {
    publicUrl: 'https://tickets.acme.org',
    issuer: 'https://login.acme.org/realms/ticketing',
    authenticate: async () => {
      assert.fail('Health requests must not authenticate.');
    },
  });
  const parse = URL.parse.bind(URL);
  const mock = t.mock.method(URL, 'parse', (input: string, base?: string | URL) =>
    input === '/healthz?fixture=invalid' ? null : parse(input, base),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/healthz`;
  try {
    assert.equal((await fetch(`${url}?fixture=invalid`)).status, 400);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    mock.mock.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects cleartext remote OAuth trust roots before loading keys', async (t) => {
  const storage = {} as StorageAdapter;
  const issuer = 'https://login.acme.org/realms/ticketing';
  const audience = 'https://tickets.acme.org/mcp';
  const config = { issuer, audience };
  const jwksUrl = 'http://keys.invalid/certs';
  const request = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'error');
    return Response.json({ issuer, jwks_uri: jwksUrl });
  });
  await assert.rejects(createAuthenticator(storage, { ...config, issuer: 'http://login.acme.org' }), {
    code: 'INVALID_CONFIG',
  });
  await assert.rejects(createAuthenticator(storage, { ...config, jwksUrl, allowLocalKeycloakJwks: true }), {
    code: 'INVALID_CONFIG',
  });
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(createAuthenticator(storage, config), { code: 'INVALID_CONFIG' });
  assert.equal(request.mock.callCount(), 1);
  await createAuthenticator(storage, {
    issuer: 'http://127.0.0.1:8080/realm',
    audience,
    jwksUrl: 'http://127.0.0.1:8080/certs',
  });
});

it('preserves allowed and denied HTTP origin hostnames when the allowlist contains spaces', async () => {
  for (const allowedOrigins of [
    ['tickets.acme.org', 'console.acme.org'],
    [' tickets.acme.org ', ' console.acme.org '],
  ]) {
    const server = createHttpServer({} as Application, {
      publicUrl: 'https://tickets.acme.org',
      issuer: 'https://login.acme.org/realms/ticketing',
      allowedOrigins,
      authenticate: async () => {
        throw new Error('Health requests do not require authentication.');
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const [origin, status] of [
        ['https://tickets.acme.org', 200],
        ['https://console.acme.org:8443', 200],
        ['https://console.acme.org.evil.invalid', 403],
        ['https://untrusted.acme.org', 403],
        ['null', 403],
      ] as const) {
        const response = await fetch(`${base}/healthz`, {
          headers: { Origin: origin },
        });
        assert.equal(response.status, status, origin);
        await response.arrayBuffer();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
