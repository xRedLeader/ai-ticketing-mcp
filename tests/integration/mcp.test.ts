import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { setup } from './helpers.js';
import { createHttpServer } from '../../src/http.js';
import { createAuthenticator } from '../../src/auth.js';
import { randomUUID } from 'node:crypto';
import { profileOperations, type McpProfile } from '../../src/profiles.js';

it('serves authenticated SDK HTTP clients, resources, prompts, scopes, and discovery', async () => {
  const f = await setup();
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'test';
  jwk.alg = 'RS256';
  const keyServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => keyServer.listen(0, '127.0.0.1', resolve));
  const keyPort = (keyServer.address() as any).port;
  const issuer = `http://127.0.0.1:${keyPort}`;
  const audience = 'http://127.0.0.1/mcp';
  await f.storage.transaction('catalog', async (tx) => {
    await tx.put('actors', { ...f.worker, issuer, subject: 'oauth-worker' });
  });
  const authenticate = await createAuthenticator(f.storage, { issuer, audience, jwksUrl: `${issuer}/jwks` });
  const server = createHttpServer(f.app, { publicUrl: 'http://127.0.0.1', issuer, authenticate });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = async (scope = 'ticketing:read ticketing:write', aud = audience, expiry = '5m') =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setSubject('oauth-worker')
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(keys.privateKey);
  const client = new Client({ name: 'integration', version: '1.0.0' });
  try {
    const unauthorized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata/);
    const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    assert.equal(metadata.resource, audience);
    for (const invalidToken of [
      await token('ticketing:read', 'wrong-audience'),
      await token('ticketing:read', audience, '-10s'),
    ]) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${invalidToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401);
    }
    const missingScope = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token('unrelated')}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingScope.status, 403);
    const badOrigin = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp?profile=full`), {
        requestInit: { headers: { Authorization: `Bearer ${await token()}` } },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 26);
    assert.ok(tools.tools.some((tool) => tool.name === 'ticket_context'));
    assert.ok(tools.tools.every((tool) => tool.inputSchema && tool.outputSchema));
    const created = await client.callTool({
      name: 'tickets_create',
      arguments: {
        project_id: f.project.id,
        idempotency_key: randomUUID(),
        tickets: [
          {
            title: 'SDK task',
            description: 'Exercise the protocol',
            criteria: ['MCP responds'],
            status: 'ready',
          },
        ],
      },
    });
    assert.equal((created.structuredContent as any).ok, true);
    const ticket = (created.structuredContent as any).data.tickets[0];
    const resource = await client.readResource({ uri: `ticketing://ticket/${f.project.id}/${ticket.id}` });
    assert.ok(resource.contents.length);
    assert.ok((await client.listPrompts()).prompts.some((prompt) => prompt.name === 'execution'));
    const reader = new Client({ name: 'read-only', version: '1.0.0' });
    try {
      await reader.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${await token('ticketing:read')}` } },
        }),
      );
      const denied = await reader.callTool({
        name: 'work_claim',
        arguments: { project_id: f.project.id, ticket_id: ticket.id, idempotency_key: randomUUID() },
      });
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as any).error.code, 'INSUFFICIENT_SCOPE');
    } finally {
      await reader.close();
    }
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    keyServer.closeAllConnections();
    await new Promise<void>((resolve) => keyServer.close(() => resolve()));
    await f.dispose();
  }
});

it('serves local stdio clients without writing non-protocol data to stdout', async () => {
  const f = await setup();
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  try {
    for (const profile of [undefined, 'worker', 'planner', 'reviewer', 'full'] as const) {
      const client = new Client({ name: 'stdio-integration', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/cli.ts', 'stdio', ...(profile ? ['--profile', profile] : [])],
        env: { ...env, DATABASE_URL: process.env.TEST_DATABASE_URL!, ACTOR_ID: f.worker.id },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      try {
        await client.connect(transport);
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
          [...profileOperations[(profile ?? 'worker') as McpProfile]].sort(),
        );
        const result = await client.callTool({ name: 'project_list', arguments: {} });
        assert.equal((result.structuredContent as any).ok, true);
        assert.ok(
          (result.structuredContent as any).data.projects.some((project: any) => project.id === f.project.id),
        );
      } catch (error) {
        throw new Error(`stdio ${profile ?? 'default'} failed: ${stderr}`, { cause: error });
      } finally {
        await client.close();
      }
    }
  } finally {
    await f.dispose();
  }
});
