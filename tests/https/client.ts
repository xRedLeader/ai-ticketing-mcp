import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/client';

const config = JSON.parse(await readFile(process.env.HTTPS_FIXTURE_CONFIG!, 'utf8'));
const { base, direct, issuer, projectId, tokens, httpPort } = config;
const ca = await readFile(process.env.NODE_EXTRA_CA_CERTS!, 'utf8');
async function tlsFailure(options: Parameters<typeof get>[1]) {
  return new Promise<string>((resolve, reject) => {
    const req = get(`${base}/healthz`, options, (res) => {
      res.resume();
      reject(new Error('Invalid TLS unexpectedly accepted.'));
    });
    req.once('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
  });
}
assert.ok(
  [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ].includes(await tlsFailure({ ca: [...rootCertificates] })),
);
assert.equal(
  await tlsFailure({ ca, checkServerIdentity: (_host, cert) => checkServerIdentity('wrong.invalid', cert) }),
  'ERR_TLS_CERT_ALTNAME_INVALID',
);
const redirect = await fetch(`http://localhost:${httpPort}/mcp?profile=worker`, { redirect: 'manual' });
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get('location'), `${base}/mcp?profile=worker`);
const unauthenticated = await fetch(`${base}/mcp`, { method: 'POST' });
assert.equal(unauthenticated.status, 401);
const challenge = extractWWWAuthenticateParams(unauthenticated);
assert.equal(challenge.resourceMetadataUrl?.href, `${base}/.well-known/oauth-protected-resource/mcp`);
const metadata = await discoverOAuthProtectedResourceMetadata(new URL(`${base}/mcp`));
assert.equal(metadata.resource, `${base}/mcp`);
assert.deepEqual(metadata.authorization_servers, [issuer]);
const authorizationServer = await discoverAuthorizationServerMetadata(issuer);
assert.equal(authorizationServer?.issuer, issuer);
for (const token of tokens.invalid) {
  const denied = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(denied.status, 401);
}
assert.equal(
  (await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.noRead}` } }))
    .status,
  403,
);
assert.equal((await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
assert.equal((await fetch(`${base}/healthz`, { headers: { Origin: base } })).status, 200);
const clients: Client[] = [];
async function connect(url: string, token = tokens.good) {
  const client = new Client({ name: 'https-regression', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp?profile=full`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
try {
  const secure = await connect(base);
  const plain = await connect(direct);
  const reader = await connect(base, tokens.readOnly);
  assert.deepEqual(await secure.listTools(), await plain.listTools());
  for (const client of [plain, secure]) {
    const response = await client.callTool({ name: 'project_get', arguments: { project_id: projectId } });
    assert.equal((response.structuredContent as any).ok, true);
    config.results ??= [];
    config.results.push(response);
  }
  assert.deepEqual(config.results[0], config.results[1]);
  assert.deepEqual(
    await secure.readResource({ uri: 'ticketing://guide' }),
    await plain.readResource({ uri: 'ticketing://guide' }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await secure.callTool({
      name,
      arguments: { project_id: projectId, idempotency_key: randomUUID(), ...args },
    });
    const envelope = response.structuredContent as any;
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    assert.deepEqual(JSON.parse((response.content[0] as any).text), envelope);
    return envelope.data;
  };
  const created = await call('tickets_create', {
    tickets: [
      {
        title: 'TLS workflow',
        description: 'Authorized SDK workflow through Caddy.',
        criteria: ['Verified HTTPS MCP'],
        status: 'ready',
      },
    ],
  });
  const ticketId = created.tickets[0].id;
  const denied = await reader.callTool({
    name: 'work_claim',
    arguments: { project_id: projectId, ticket_id: ticketId, idempotency_key: randomUUID() },
  });
  assert.equal((denied.structuredContent as any).error.code, 'INSUFFICIENT_SCOPE');
  const claimed = await call('work_claim', { ticket_id: ticketId });
  const current = await secure.callTool({
    name: 'ticket_get',
    arguments: { project_id: projectId, ticket_id: ticketId },
  });
  const state = (current.structuredContent as any).data;
  await call('ticket_submit', {
    ticket_id: ticketId,
    claim_token: claimed.claim.token,
    expected_revision: state.ticket.revision,
    summary: 'TLS verified.',
    evidence: state.criteria.map((criterion: any) => ({
      criterion_id: criterion.id,
      result: 'pass',
      summary: 'HTTPS SDK workflow passed.',
      references: ['tests/https/caddy.test.ts'],
    })),
  });
  const final = await secure.callTool({
    name: 'ticket_get',
    arguments: { project_id: projectId, ticket_id: ticketId },
  });
  assert.equal((final.structuredContent as any).data.ticket.status, 'done');
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
process.stdout.write(
  'Verified TLS trust/hostname failures, redirect, SDK discovery, auth/scopes/origins, payload parity and authorized create/claim/submit.\n',
);
