import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      (error: any) => error.code === 1 && /Run --prepare-realm/.test(error.stderr),
    );
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ticketing-production-check-'));
    await rm(directory, { recursive: true, force: true });
  }
});
