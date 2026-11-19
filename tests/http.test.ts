import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Application } from '../src/application.js';
import { createHttpServer } from '../src/http.js';

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
