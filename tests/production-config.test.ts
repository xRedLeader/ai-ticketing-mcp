import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// @ts-expect-error Operator script is plain Node ESM.
import { checkProductionConfig } from '../scripts/check-production.mjs';

it('checks exact production identities, assigned realm audience, private ports and persistent TLS without echoing values', async () => {
  const env = {
    TICKETING_DOMAIN: 'tickets.acme.org',
    LOGIN_DOMAIN: 'login.acme.org',
    PUBLIC_URL: 'https://tickets.acme.org',
    OAUTH_AUDIENCE: 'https://tickets.acme.org/mcp',
    KEYCLOAK_PUBLIC_URL: 'https://login.acme.org',
    OAUTH_ISSUER: 'https://login.acme.org/realms/ticketing',
    OAUTH_JWKS_URL: 'http://keycloak:8080/realms/ticketing/protocol/openid-connect/certs',
    ALLOWED_ORIGIN_HOSTS: 'tickets.acme.org',
  };
  const realm = JSON.parse(await readFile('deploy/keycloak-realm.json', 'utf8'));
  realm.clientScopes[0].protocolMappers[0].config['included.custom.audience'] = env.OAUTH_AUDIENCE;
  const compose = {
    services: {
      app: { environment: env },
      db: {},
      ollama: {},
      keycloak: { environment: { KC_HOSTNAME: env.KEYCLOAK_PUBLIC_URL }, command: ['start'] },
      proxy: {
        ports: [
          { published: '80', target: 80 },
          { published: '443', target: 443 },
        ],
        volumes: ['/data', '/config'].map((target) => ({ type: 'volume', source: target.slice(1), target })),
      },
    },
  };
  assert.deepEqual(checkProductionConfig(env, compose, realm), []);
  assert.deepEqual(checkProductionConfig(env), []);
  assert.deepEqual(
    checkProductionConfig({ ...env, ALLOWED_ORIGIN_HOSTS: ' tickets.acme.org , console.acme.org ' }),
    [],
  );
  for (const invalid of [undefined, null, false, 0, '', [], 'private-realm-value']) {
    const errors = checkProductionConfig(env, compose, invalid);
    assert.ok(errors.some((message: string) => message.startsWith('Keycloak realm:')));
    assert.equal(errors.join('').includes('private-realm-value'), false);
  }
  for (const change of [
    (realm: any) => (realm.clientScopes = {}),
    (realm: any) => (realm.clients = {}),
    (realm: any) => (realm.clientScopes = [null]),
    (realm: any) => (realm.clients = [null]),
    (realm: any) => (realm.clientScopes[0].protocolMappers = {}),
    (realm: any) => (realm.clientScopes[0].protocolMappers = [null]),
    (realm: any) => (realm.clients[0].defaultClientScopes = {}),
  ]) {
    const invalid = structuredClone(realm);
    change(invalid);
    assert.ok(checkProductionConfig(env, compose, invalid).length > 0);
  }
  for (const clientId of ['ai-ticketing-cli', 'ai-ticketing-agent']) {
    for (const change of [
      (client: any) => delete client.enabled,
      (client: any) => (client.enabled = false),
      (client: any) => (client.enabled = 'true'),
      (client: any) => (client.protocol = 'saml'),
    ]) {
      const invalid = structuredClone(realm);
      change(invalid.clients.find((client: any) => client.clientId === clientId));
      assert.ok(
        checkProductionConfig(env, compose, invalid).some((message: string) =>
          message.startsWith('Keycloak clients:'),
        ),
      );
    }
  }
  for (const [clientId, changes] of [
    [
      'ai-ticketing-cli',
      [
        (client: any) => (client.publicClient = false),
        (client: any) => delete client.standardFlowEnabled,
        (client: any) => (client.standardFlowEnabled = false),
        (client: any) => delete client.attributes['pkce.code.challenge.method'],
        (client: any) => (client.attributes['pkce.code.challenge.method'] = 'plain'),
        (client: any) => delete client.attributes['oauth2.device.authorization.grant.enabled'],
        (client: any) => (client.attributes['oauth2.device.authorization.grant.enabled'] = 'false'),
      ],
    ],
    [
      'ai-ticketing-agent',
      [
        (client: any) => (client.publicClient = true),
        (client: any) => delete client.publicClient,
        (client: any) => delete client.serviceAccountsEnabled,
        (client: any) => (client.serviceAccountsEnabled = false),
      ],
    ],
  ] as const) {
    for (const change of changes) {
      const invalid = structuredClone(realm);
      change(invalid.clients.find((client: any) => client.clientId === clientId));
      assert.ok(
        checkProductionConfig(env, compose, invalid).some((message: string) =>
          message.startsWith(`Keycloak ${clientId}:`),
        ),
      );
    }
  }
  for (const name of ['ticketing:read', 'ticketing:write']) {
    for (const change of [
      (scope: any) => delete scope.protocol,
      (scope: any) => (scope.protocol = 'saml'),
      (scope: any) => delete scope.attributes,
      (scope: any) => delete scope.attributes['include.in.token.scope'],
      (scope: any) => (scope.attributes['include.in.token.scope'] = 'false'),
      (scope: any) => (scope.attributes['include.in.token.scope'] = true),
    ]) {
      const invalid = structuredClone(realm);
      change(invalid.clientScopes.find((scope: any) => scope.name === name));
      assert.ok(
        checkProductionConfig(env, compose, invalid).some(
          (message: string) => message.startsWith('Keycloak scopes:') && message.includes(name),
        ),
      );
    }
    const missing = structuredClone(realm);
    missing.clientScopes = missing.clientScopes.filter((scope: any) => scope.name !== name);
    assert.ok(
      checkProductionConfig(env, compose, missing).some(
        (message: string) => message.startsWith('Keycloak scopes:') && message.includes(name),
      ),
    );
  }
  for (const change of [
    (proxy: any) =>
      proxy.ports.forEach((port: any) => {
        port.protocol = 'udp';
      }),
    (proxy: any) =>
      proxy.ports.forEach((port: any) => {
        port.host_ip = '127.0.0.1';
      }),
    (proxy: any) =>
      proxy.volumes.forEach((volume: any) => {
        delete volume.source;
      }),
    (proxy: any) =>
      proxy.volumes.forEach((volume: any) => {
        volume.read_only = true;
      }),
  ]) {
    const invalid = structuredClone(compose);
    change(invalid.services.proxy);
    assert.ok(
      checkProductionConfig(env, invalid, realm).some((message: string) => message.startsWith('proxy ')),
    );
  }
  for (const [key, value] of Object.entries({
    TICKETING_DOMAIN: 'https://tickets.acme.org/path',
    LOGIN_DOMAIN: env.TICKETING_DOMAIN,
    PUBLIC_URL: env.PUBLIC_URL + '/',
    OAUTH_AUDIENCE: env.OAUTH_AUDIENCE + '?profile=worker',
    KEYCLOAK_PUBLIC_URL: 'http://login.acme.org',
    OAUTH_ISSUER: env.OAUTH_ISSUER + '/',
    ALLOWED_ORIGIN_HOSTS: '*',
    OAUTH_JWKS_URL: 'https://secret-user:private-secret@example.invalid/jwks',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  })) {
    const errors = checkProductionConfig({ ...env, [key]: value }, compose, realm);
    assert.ok(
      errors.some((error: string) => error.includes(key)),
      key,
    );
    assert.equal(errors.join('').includes('private-secret'), false);
  }
  const stale = structuredClone(realm);
  stale.attributes = { frontendUrl: 'http://localhost:8080' };
  assert.ok(checkProductionConfig(env, compose, stale).some((s: string) => s.startsWith('Keycloak issuer:')));
  delete stale.attributes;
  stale.clientScopes[0].protocolMappers[0].config['included.custom.audience'] = 'http://localhost:3000/mcp';
  assert.ok(checkProductionConfig(env, compose, stale).some((s: string) => s.startsWith('Keycloak realm:')));
  stale.clientScopes = realm.clientScopes;
  stale.clients[0].defaultClientScopes = [];
  assert.ok(
    checkProductionConfig(env, compose, stale).some((s: string) => s.startsWith('Keycloak clients:')),
  );
  const exposed = structuredClone(compose) as any;
  exposed.services.app.ports = [{ published: '3000', target: 3000, host_ip: '0.0.0.0' }];
  exposed.services.proxy.volumes = [];
  exposed.services.proxy.ports = [];
  const errors = checkProductionConfig(env, exposed, realm);
  for (const prefix of ['app ports:', 'proxy ports:', 'proxy /data:', 'proxy /config:'])
    assert.ok(
      errors.some((s: string) => s.startsWith(prefix)),
      prefix,
    );
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-production-check-'));
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [resolve('scripts/check-production.mjs'), '--realm-file', 'private-export.json'],
        {
          cwd: directory,
          env: { ...process.env, ...env },
          windowsHide: true,
        },
      ),
      (error: any) =>
        error.code === 1 &&
        /Run --prepare-realm/.test(error.stderr) &&
        /both new and existing/.test(error.stderr),
    );
    const importPath = join(directory, '.local/keycloak-realm.production.json');
    const exportPath = join(directory, 'private-export.json');
    await mkdir(dirname(importPath));
    for (const { imported, exported, args } of [
      { imported: null, exported: realm, args: [] },
      { imported: realm, exported: null, args: ['--realm-file', exportPath] },
      { imported: null, exported: realm, args: ['--realm-file', exportPath] },
    ]) {
      await writeFile(importPath, JSON.stringify(imported));
      await writeFile(exportPath, JSON.stringify(exported));
      await assert.rejects(
        promisify(execFile)(process.execPath, [resolve('scripts/check-production.mjs'), ...args], {
          cwd: directory,
          env: { ...process.env, ...env, KEYCLOAK_ADMIN_PASSWORD: 'private-env-value' },
          windowsHide: true,
        }),
        (error: any) =>
          error.code === 1 &&
          /Keycloak realm: supply a JSON realm object/.test(error.stderr) &&
          !/private-env-value|Cannot render production Compose|passed/.test(error.stderr + error.stdout),
      );
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-production-check-'));
    await rm(directory, { recursive: true, force: true });
  }
});
