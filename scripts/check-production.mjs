import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Messages deliberately contain field names and remedies, never supplied values or subprocess output.
export function checkProductionConfig(env, compose, realm) {
  const errors = [];
  const fail = (condition, message) => {
    if (!condition) errors.push(message);
  };
  fail(
    env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    'NODE_TLS_REJECT_UNAUTHORIZED: unset this value to keep TLS verification enabled.',
  );
  const domain = (value) =>
    typeof value === 'string' &&
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(value) &&
    !/(?:^|\.)(?:localhost|example|invalid|test)$|\.example\.(?:com|net|org)$/i.test(value);
  fail(
    domain(env.TICKETING_DOMAIN),
    'TICKETING_DOMAIN: set an operator-owned DNS hostname, without scheme, port or path.',
  );
  fail(
    domain(env.LOGIN_DOMAIN) && env.LOGIN_DOMAIN !== env.TICKETING_DOMAIN,
    'LOGIN_DOMAIN: set a separate operator-owned DNS hostname.',
  );
  fail(
    env.PUBLIC_URL === `https://${env.TICKETING_DOMAIN}`,
    'PUBLIC_URL: use exactly https://TICKETING_DOMAIN (no trailing slash).',
  );
  fail(
    env.OAUTH_AUDIENCE === `${env.PUBLIC_URL}/mcp`,
    'OAUTH_AUDIENCE: use exactly PUBLIC_URL/mcp, without a profile query.',
  );
  fail(
    env.KEYCLOAK_PUBLIC_URL === `https://${env.LOGIN_DOMAIN}`,
    'KEYCLOAK_PUBLIC_URL: use exactly https://LOGIN_DOMAIN.',
  );
  fail(
    env.OAUTH_ISSUER === `${env.KEYCLOAK_PUBLIC_URL}/realms/ticketing`,
    'OAUTH_ISSUER: use the exact public /realms/ticketing issuer, including case.',
  );
  const origins = (env.ALLOWED_ORIGIN_HOSTS ?? '').split(',').map((s) => s.trim());
  fail(
    origins.includes(env.TICKETING_DOMAIN) && origins.every(domain),
    'ALLOWED_ORIGIN_HOSTS: use explicit trusted DNS hostnames including TICKETING_DOMAIN; no wildcard, URL or port.',
  );
  fail(
    env.OAUTH_JWKS_URL === 'http://keycloak:8080/realms/ticketing/protocol/openid-connect/certs',
    'OAUTH_JWKS_URL: use the private bundled Keycloak JWKS endpoint for this deployment.',
  );
  if (realm) {
    const scope = realm.clientScopes?.find((s) => s.name === 'ticketing:read');
    const mapper = scope?.protocolMappers?.find(
      (m) =>
        m.protocolMapper === 'oidc-audience-mapper' &&
        m.config?.['included.custom.audience'] === env.OAUTH_AUDIENCE &&
        m.config?.['access.token.claim'] === 'true',
    );
    fail(
      realm.realm === 'ticketing' && mapper,
      'Keycloak realm: update ticketing:read > ticketing-audience to the exact OAUTH_AUDIENCE with access-token claim enabled, then export the current realm again.',
    );
    fail(
      realm.clients?.filter((c) => ['ai-ticketing-cli', 'ai-ticketing-agent'].includes(c.clientId)).length ===
        2 &&
        realm.clients
          .filter((c) => ['ai-ticketing-cli', 'ai-ticketing-agent'].includes(c.clientId))
          .every((c) =>
            ['ticketing:read', 'ticketing:write'].every((scope) => c.defaultClientScopes?.includes(scope)),
          ),
      'Keycloak clients: assign ticketing:read and ticketing:write default scopes to both bundled clients.',
    );
  }
  if (compose) {
    const services = compose.services ?? {};
    for (const name of ['app', 'db', 'keycloak', 'ollama'])
      fail(
        (services[name]?.ports ?? []).every((p) => ['127.0.0.1', '::1'].includes(p.host_ip)),
        `${name} ports: remove host publication or bind it only to loopback.`,
      );
    const proxy = services.proxy;
    fail(
      [80, 443].every((port) =>
        proxy?.ports?.some(
          (p) =>
            Number(p.published) === port &&
            p.target === port &&
            (!p.protocol || p.protocol === 'tcp') &&
            (!p.host_ip || ['0.0.0.0', '::'].includes(p.host_ip)),
        ),
      ),
      'proxy ports: publish TCP 80 and 443; allow them through the host firewall and NAT.',
    );
    for (const target of ['/data', '/config'])
      fail(
        proxy?.volumes?.some((v) => v.type === 'volume' && v.source && !v.read_only && v.target === target),
        `proxy ${target}: mount a persistent named volume; never use down -v during renewal or restart.`,
      );
    const expected = {
      PUBLIC_URL: env.PUBLIC_URL,
      OAUTH_ISSUER: env.OAUTH_ISSUER,
      OAUTH_AUDIENCE: env.OAUTH_AUDIENCE,
      ALLOWED_ORIGIN_HOSTS: env.ALLOWED_ORIGIN_HOSTS,
      OAUTH_JWKS_URL: env.OAUTH_JWKS_URL,
    };
    fail(
      Object.entries(expected).every(([key, value]) => services.app?.environment?.[key] === value),
      'app environment: render the production Compose override with the same environment file.',
    );
    fail(
      services.keycloak?.environment?.KC_HOSTNAME === env.KEYCLOAK_PUBLIC_URL &&
        services.keycloak?.command?.[0] === 'start',
      'keycloak: use the production command and public KC_HOSTNAME.',
    );
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg, i) =>
        !['--prepare-realm', '--live', '--realm-file'].includes(arg) && args[i - 1] !== '--realm-file',
    ) ||
    (args.includes('--realm-file') && !args[args.indexOf('--realm-file') + 1])
  )
    throw new Error(
      'Usage: node --env-file=.env scripts/check-production.mjs [--prepare-realm] [--realm-file PRIVATE_EXPORT.json] [--live]',
    );
  let errors = checkProductionConfig(process.env);
  if (errors.length) {
    process.stderr.write(errors.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  const importPath = resolve('.local/keycloak-realm.production.json');
  if (args.includes('--prepare-realm')) {
    const realm = JSON.parse(await readFile('deploy/keycloak-realm.json', 'utf8'));
    const mapper = realm.clientScopes
      ?.find((scope) => scope.name === 'ticketing:read')
      ?.protocolMappers?.find(
        (mapper) => mapper.name === 'ticketing-audience' && mapper.protocolMapper === 'oidc-audience-mapper',
      );
    if (!mapper?.config)
      throw new Error(
        'Realm template: restore the ticketing:read audience mapper before preparing the production import.',
      );
    mapper.config['included.custom.audience'] = process.env.OAUTH_AUDIENCE;
    await mkdir(dirname(importPath), { recursive: true });
    await writeFile(importPath, JSON.stringify(realm, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(
      'Prepared private production realm import. Existing Keycloak realms are not overwritten by startup import.\n',
    );
  }
  let realm, compose, importRealm;
  try {
    importRealm = JSON.parse(await readFile(importPath, 'utf8'));
    realm = JSON.parse(
      await readFile(
        args.includes('--realm-file') ? args[args.indexOf('--realm-file') + 1] : importPath,
        'utf8',
      ),
    );
  } catch {
    throw new Error(
      'Cannot read realm JSON. Run --prepare-realm for a new installation; use --realm-file with a private current export for an existing realm.',
    );
  }
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
        '--profile',
        'local-ai',
        'config',
        '--format',
        'json',
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    compose = JSON.parse(stdout);
  } catch {
    throw new Error(
      'Cannot render production Compose. Check Docker Compose >=2.24.4 and required private .env passwords locally; do not publish rendered config.',
    );
  }
  errors = checkProductionConfig(process.env, compose, importRealm);
  if (args.includes('--realm-file')) errors.push(...checkProductionConfig(process.env, undefined, realm));
  if (errors.length) {
    process.stderr.write(errors.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Production config and ${args.includes('--realm-file') ? 'supplied realm export' : 'new-install import only'} passed. No secret values printed.\n`,
  );
  if (args.includes('--live')) {
    for (const host of [process.env.TICKETING_DOMAIN, process.env.LOGIN_DOMAIN]) {
      try {
        const addresses = await lookup(host, { all: true });
        if (!addresses.length) throw new Error();
        const redirect = await fetch(`http://${host}/healthz`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
        if (
          ![301, 308].includes(redirect.status) ||
          redirect.headers.get('location') !== `https://${host}/healthz`
        )
          throw new Error();
      } catch {
        throw new Error(
          'DNS/port 80 check failed. Correct all A/AAAA records and public TCP 80 routing; test from outside the deployment network.',
        );
      }
    }
    try {
      const protectedResource = await fetch(
        `${process.env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`,
        { signal: AbortSignal.timeout(10000) },
      );
      const resource = await protectedResource.json();
      const discovery = await fetch(`${process.env.OAUTH_ISSUER}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10000),
      });
      const issuer = await discovery.json();
      if (
        !protectedResource.ok ||
        !discovery.ok ||
        resource.resource !== process.env.OAUTH_AUDIENCE ||
        resource.authorization_servers?.[0] !== process.env.OAUTH_ISSUER ||
        issuer.issuer !== process.env.OAUTH_ISSUER
      )
        throw new Error();
      const ready = await fetch(`${process.env.PUBLIC_URL}/readyz`, { signal: AbortSignal.timeout(10000) });
      if (!ready.ok) throw new Error();
    } catch {
      throw new Error(
        'TLS/port 443/discovery/readiness check failed. Check Caddy issuance logs, certificate hostname/trust/expiry, public TCP 443, issuer and backend health.',
      );
    }
    process.stdout.write(
      'Live DNS, HTTP redirects, verified HTTPS, exact discovery and readiness passed from this host. Repeat externally; this does not prove future renewal.\n',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
