import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';
// @ts-expect-error Operator script is plain Node ESM.
import { checkProductionConfig } from '../../scripts/check-production.mjs';

it(
  'imports the public production realm as the pinned non-owner Keycloak user',
  { timeout: 240000 },
  async () => {
    const name = `ticketing-keycloak-${randomUUID()}`;
    const staging = `${name}-prepare`;
    const volume = `${name}-staging`;
    const audience = 'https://tickets.acme.org/mcp';
    const login = 'https://login.acme.org';
    const env = {
      TICKETING_DOMAIN: 'tickets.acme.org',
      LOGIN_DOMAIN: 'login.acme.org',
      PUBLIC_URL: 'https://tickets.acme.org',
      OAUTH_ISSUER: `${login}/realms/ticketing`,
      OAUTH_AUDIENCE: audience,
      OAUTH_JWKS_URL: 'http://keycloak:8080/realms/ticketing/protocol/openid-connect/certs',
      ALLOWED_ORIGIN_HOSTS: 'tickets.acme.org',
      KEYCLOAK_PUBLIC_URL: login,
    };
    const docker = async (...args: string[]) =>
      (await promisify(execFile)('docker', args, { windowsHide: true, timeout: 120000 })).stdout.trim();
    try {
      const { stdout } = await promisify(execFile)(
        'docker',
        [
          'compose',
          '-f',
          'compose.yaml',
          '-f',
          'deploy/compose.production.yaml',
          '--profile',
          'auth',
          'config',
          '--format',
          'json',
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            DB_PASSWORD: 'fixture-only',
            APP_DB_PASSWORD: 'fixture-only',
            KEYCLOAK_DB_PASSWORD: 'fixture-only',
            KEYCLOAK_ADMIN_PASSWORD: 'fixture-only',
            ...env,
          },
        },
      );
      const keycloak = JSON.parse(stdout).services.keycloak;
      assert.equal(keycloak.image, 'quay.io/keycloak/keycloak:26.4.7');
      const mount = keycloak.volumes.find(
        (v: { target: string }) => v.target === '/opt/keycloak/data/import/ticketing.json',
      );
      assert.equal(mount.type, 'bind');
      assert.equal(mount.read_only, true);
      assert.equal(mount.source, resolve('.local/keycloak-realm.production.json'));
      await docker('volume', 'create', volume);
      // Docker-managed Linux storage preserves real UID/mode semantics on Windows hosts too.
      await docker(
        'create',
        '--name',
        staging,
        '--user',
        '0:0',
        '--mount',
        `type=volume,source=${volume},target=/workspace`,
        '--workdir',
        '/workspace',
        'node:24-alpine',
        'node',
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
        import { prepareProductionRealm } from '/prepare.mjs';
        process.umask(0o077);
        await mkdir('deploy');
        const template = JSON.parse(await readFile('/template.json', 'utf8'));
        template.users = [{ username: 'fixture-private-user' }];
        template.clients[1].secret = 'fixture-private-client-secret';
        await writeFile('deploy/keycloak-realm.json', JSON.stringify(template));
        const path = '.local/keycloak-realm.production.json';
        await prepareProductionRealm(path, ${JSON.stringify(audience)});
        assert.equal((await stat(path)).mode & 0o777, 0o644);
        const expected = JSON.parse(await readFile('/template.json', 'utf8'));
        expected.clientScopes[0].protocolMappers[0].config['included.custom.audience'] = ${JSON.stringify(audience)};
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), expected);
        await chmod(path, 0o600);
        await prepareProductionRealm(path, ${JSON.stringify(audience)});
        assert.equal((await stat(path)).mode & 0o777, 0o644);
        const privatePath = '.local/current-realm.json';
        await writeFile(privatePath, 'fixture-private-export', { mode: 0o600 });
        await rm(path);
        await symlink('current-realm.json', path);
        await prepareProductionRealm(path, ${JSON.stringify(audience)});
        assert.equal((await lstat(path)).isFile(), true);
        assert.equal((await stat(path)).uid, 0);
        assert.equal((await stat(path)).mode & 0o777, 0o644);
        assert.equal(await readFile(privatePath, 'utf8'), 'fixture-private-export');
        assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
        assert.deepEqual((await readdir('.local')).sort(), ['current-realm.json', 'keycloak-realm.production.json']);
        console.log('Verified fresh/replaced 0644 imports under umask 077; public allowlist and private export isolation.');
      `,
      );
      await docker('cp', resolve('scripts/check-production.mjs'), `${staging}:/prepare.mjs`);
      await docker('cp', resolve('deploy/keycloak-realm.json'), `${staging}:/template.json`);
      const staged = await docker('start', '-a', staging);
      assert.equal(await docker('inspect', staging, '--format', '{{.State.ExitCode}}'), '0', staged);
      process.stdout.write(staged + '\n');
      const source = `${await docker('volume', 'inspect', volume, '--format', '{{.Mountpoint}}')}/.local/keycloak-realm.production.json`;
      await docker(
        'run',
        '-d',
        '--name',
        name,
        '--memory',
        '1g',
        '-p',
        '127.0.0.1::8080',
        '--mount',
        `type=bind,source=${source},target=${mount.target},readonly`,
        '-e',
        'KC_DB=dev-file',
        '-e',
        `KC_HOSTNAME=${keycloak.environment.KC_HOSTNAME}`,
        '-e',
        'KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin',
        '-e',
        'KC_BOOTSTRAP_ADMIN_PASSWORD=fixture-only',
        keycloak.image,
        ...keycloak.command,
      );
      assert.equal(await docker('image', 'inspect', keycloak.image, '--format', '{{.Config.User}}'), '1000');
      const port = (await docker('port', name, '8080/tcp')).split(':').at(-1);
      let issuer;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}/realms/ticketing/.well-known/openid-configuration`,
            { signal: AbortSignal.timeout(1000) },
          );
          if (response.ok) {
            issuer = (await response.json()).issuer;
            break;
          }
        } catch {}
        if ((await docker('inspect', name, '--format', '{{.State.Running}}')) !== 'true') break;
        await delay(500);
      }
      const logs = await docker('logs', name);
      assert.equal(issuer, `${login}/realms/ticketing`, logs);
      assert.match(logs, /Realm 'ticketing' imported/);
      const base = `http://127.0.0.1:${port}`;
      const token = async (realm: string, parameters: Record<string, string>) => {
        const response = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
          method: 'POST',
          body: new URLSearchParams(parameters),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(typeof body.access_token, 'string');
        return body.access_token as string;
      };
      const adminToken = await token('master', {
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'fixture-admin',
        password: 'fixture-only',
      });
      const admin = async (path: string, init: RequestInit = {}) => {
        const response = await fetch(`${base}/admin/realms/ticketing/${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        assert.ok(response.ok, `Keycloak fixture admin request failed (${response.status})`);
        return response;
      };
      const clients = await (await admin('clients?clientId=ai-ticketing-agent')).json();
      assert.equal(clients.length, 1);
      const credential = await (
        await admin(`clients/${clients[0].id}/client-secret`, { method: 'POST' })
      ).json();
      assert.equal(typeof credential.value, 'string');
      const jwks = createRemoteJWKSet(new URL(`${base}/realms/ticketing/protocol/openid-connect/certs`));
      const verifyScopes = async (expected: string[]) => {
        const accessToken = await token('ticketing', {
          grant_type: 'client_credentials',
          client_id: 'ai-ticketing-agent',
          client_secret: credential.value,
        });
        const { payload } = await jwtVerify(accessToken, jwks, {
          issuer: env.OAUTH_ISSUER,
          audience,
        });
        assert.equal(payload.iss, env.OAUTH_ISSUER);
        assert.equal(payload.aud, audience);
        assert.equal(typeof payload.scope, 'string');
        assert.deepEqual((payload.scope as string).split(' ').sort(), [...expected].sort());
      };
      const realm = JSON.parse(await readFile('deploy/keycloak-realm.json', 'utf8'));
      realm.clientScopes[0].protocolMappers[0].config['included.custom.audience'] = audience;
      assert.deepEqual(checkProductionConfig(env, undefined, realm), []);
      await verifyScopes(['ticketing:read', 'ticketing:write']);
      const scopes = await (await admin('client-scopes')).json();
      for (const name of ['ticketing:read', 'ticketing:write']) {
        const scope = scopes.find((scope: any) => scope.name === name);
        assert.ok(scope);
        scope.attributes['include.in.token.scope'] = 'false';
        await admin(`client-scopes/${scope.id}`, { method: 'PUT', body: JSON.stringify(scope) });
        const invalid = structuredClone(realm);
        invalid.clientScopes.find((scope: any) => scope.name === name).attributes = scope.attributes;
        const errors = checkProductionConfig(env, undefined, invalid);
        assert.equal(errors.length, 1);
        assert.ok(errors[0].startsWith('Keycloak scopes:') && errors[0].includes(name));
        await verifyScopes(['ticketing:read', 'ticketing:write'].filter((scope) => scope !== name));
        scope.attributes['include.in.token.scope'] = 'true';
        await admin(`client-scopes/${scope.id}`, { method: 'PUT', body: JSON.stringify(scope) });
      }
      await verifyScopes(['ticketing:read', 'ticketing:write']);
      process.stdout.write(
        'Verified Keycloak 26.4.7 UID 1000 imports a root-owned 0644 production realm; real default-scope tokens retain exact public issuer/audience while false read/write emission settings omit their scope and fail preflight.\n',
      );
    } finally {
      await docker('rm', '-f', name).catch(() => {});
      await docker('rm', '-f', staging).catch(() => {});
      await docker('volume', 'rm', volume).catch(() => {});
    }
  },
);
