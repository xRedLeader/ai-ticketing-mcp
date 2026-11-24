import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createSqliteAdapters } from '../../src/adapters/sqlite.js';
import { fixture, testEmbeddings } from '../../src/testing/contracts.js';
import { createAuthenticator } from '../../src/auth.js';
import { createHttpServer } from '../../src/http.js';
import { createProfileRecorder } from '../../src/profiling.js';

const exec = promisify(execFile);
async function listen(server: Server, host = '0.0.0.0') {
  await new Promise<void>((done) => server.listen(0, host, done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

it(
  'runs real SDK workflows through the production Caddy TLS proxy with explicit test CA trust',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ticketing-https-'));
    const name = `ticketing-https-${randomUUID()}`;
    const dataVolume = `${name}-data`;
    const configVolume = `${name}-config`;
    const adapters = createSqliteAdapters(join(directory, 'fixture.sqlite'));
    const recorder = await createProfileRecorder({ directory: join(directory, 'profiles') });
    const servers: Server[] = [];
    const docker = async (...args: string[]) =>
      (await exec('docker', args, { windowsHide: true, timeout: 60000 })).stdout.trim();
    try {
      await adapters.storage.migrate();
      await adapters.search.configure(testEmbeddings.profile);
      const f = await fixture(adapters, 'self');
      const reservation = createServer();
      const tlsPort = await listen(reservation, '127.0.0.1');
      await close(reservation);
      const base = `https://localhost:${tlsPort}`;
      const issuer = `https://127.0.0.1:${tlsPort}/realms/ticketing`;
      const keys = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'https-fixture', alg: 'RS256' };
      const keyServer = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            req.url?.endsWith('/certs')
              ? { keys: [jwk] }
              : {
                  issuer,
                  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
                  token_endpoint: `${issuer}/protocol/openid-connect/token`,
                  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
                  response_types_supported: ['code'],
                },
          ),
        );
      });
      servers.push(keyServer);
      const keyPort = await listen(keyServer);
      await f.storage.transaction('catalog', (tx) =>
        tx.put('actors', { ...f.worker, issuer, subject: 'https-worker' }),
      );
      const authenticate = await createAuthenticator(f.storage, {
        issuer,
        audience: `${base}/mcp`,
        jwksUrl: `http://127.0.0.1:${keyPort}/certs`,
      });
      const server = createHttpServer(f.app, { publicUrl: base, issuer, authenticate, profiler: recorder });
      servers.push(server);
      const appPort = await listen(server);
      const production = await readFile('deploy/Caddyfile', 'utf8');
      assert.equal(production.split('app:3000').length, 2);
      assert.equal(production.split('keycloak:8080').length, 2);
      // Fixture IP clients omit SNI; a test-only default selects the login certificate, preserving both production site blocks.
      await writeFile(
        join(directory, 'Caddyfile'),
        '{\n  default_sni 127.0.0.1\n}\n' +
          production
            .replace('app:3000', `host.docker.internal:${appPort}`)
            .replace('keycloak:8080', `host.docker.internal:${keyPort}`),
      );
      await docker(
        'run',
        '-d',
        '--name',
        name,
        '--add-host',
        'host.docker.internal:host-gateway',
        '-p',
        `127.0.0.1:${tlsPort}:${tlsPort}`,
        '-p',
        '127.0.0.1::80',
        '-e',
        `TICKETING_DOMAIN=localhost:${tlsPort}`,
        '-e',
        `LOGIN_DOMAIN=https://127.0.0.1:${tlsPort}`,
        '-v',
        `${directory.replaceAll('\\', '/')}/Caddyfile:/etc/caddy/Caddyfile:ro`,
        '-v',
        `${dataVolume}:/data`,
        '-v',
        `${configVolume}:/config`,
        'caddy:2',
      );
      const httpPort = Number((await docker('port', name, '80/tcp')).split(':').at(-1));
      const caFile = join(directory, 'root.crt');
      let copied = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await docker('cp', `${name}:/data/caddy/pki/authorities/local/root.crt`, caFile);
          copied = true;
          break;
        } catch {
          await delay(200);
        }
      }
      assert.ok(copied, 'Caddy did not create its fixture CA. Check Docker and Caddy startup.');
      const caFingerprint = new X509Certificate(await readFile(caFile)).fingerprint256;
      const token = (scope: string, audience = `${base}/mcp`, tokenIssuer = issuer, expiry = '5m') =>
        new SignJWT({ scope })
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(tokenIssuer)
          .setAudience(audience)
          .setSubject('https-worker')
          .setIssuedAt()
          .setExpirationTime(expiry)
          .sign(keys.privateKey);
      const tokens = {
        good: await token('ticketing:read ticketing:write'),
        readOnly: await token('ticketing:read'),
        noRead: await token('ticketing:write'),
        invalid: [
          await token('ticketing:read', 'wrong-audience'),
          await token('ticketing:read', `${base}/mcp`, 'https://wrong.invalid'),
          await token('ticketing:read', `${base}/mcp`, issuer, '-10s'),
        ],
      };
      const configFile = join(directory, 'client.json');
      await writeFile(
        configFile,
        JSON.stringify({
          base,
          direct: `http://127.0.0.1:${appPort}`,
          issuer,
          projectId: f.project.id,
          httpPort,
          tokens,
        }),
        { mode: 0o600 },
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: caFile,
        HTTPS_FIXTURE_CONFIG: configFile,
      };
      assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled.');
      const result = await exec(process.execPath, ['--import', 'tsx', 'tests/https/client.ts'], {
        env,
        windowsHide: true,
        timeout: 30000,
      });
      assert.match(result.stdout, /authorized create\/claim\/submit/);
      await docker('restart', name);
      await docker(
        'cp',
        `${name}:/data/caddy/pki/authorities/local/root.crt`,
        join(directory, 'restarted-root.crt'),
      );
      assert.equal(
        new X509Certificate(await readFile(join(directory, 'restarted-root.crt'))).fingerprint256,
        caFingerprint,
      );
      const smoke = await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const r = await fetch(process.env.HTTPS_SMOKE_URL); if (!r.ok) throw new Error("Restart readiness failed");',
        ],
        { env: { ...env, HTTPS_SMOKE_URL: `${base}/readyz` }, windowsHide: true, timeout: 10000 },
      );
      assert.equal(smoke.stdout, '');
      await recorder.close();
      const capture = (
        await Promise.all(
          (await readdir(recorder.runDirectory))
            .filter((file) => file.endsWith('.jsonl'))
            .map((file) => readFile(join(recorder.runDirectory, file), 'utf8')),
        )
      ).join('');
      for (const secret of [tokens.good, tokens.readOnly, tokens.noRead, ...tokens.invalid])
        assert.equal(capture.includes(secret), false);
      assert.equal(/\bauthorization"?\s*:|\bbearer[ \t]/i.test(capture), false);
      for (const method of ['initialize', 'tools/list', 'tools/call', 'resources/read'])
        assert.ok(capture.includes(method), method);
      const manifest = JSON.parse(await readFile(join(recorder.runDirectory, 'run.json'), 'utf8'));
      assert.equal(manifest.status, 'closed');
      assert.deepEqual(manifest.gaps, []);
      process.stdout.write(
        result.stdout +
          'Verified persistent Caddy CA after restart, closed gap-free profiling, and no Authorization headers or bearer tokens.\n',
      );
    } finally {
      await docker('rm', '-f', name).catch(() => {});
      await docker('volume', 'rm', dataVolume, configVolume).catch(() => {});
      await Promise.all(servers.map(close));
      await recorder.close();
      await adapters.search.close();
      await adapters.storage.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-https-'));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
