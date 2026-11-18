import { createRemoteJWKSet, jwtVerify } from 'jose';
import { DomainError, ensure, type StorageAdapter } from './contracts.js';
import type { Principal } from './mcp.js';

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
}
export async function createAuthenticator(storage: StorageAdapter, config: AuthConfig) {
  const issuer = new URL(config.issuer);
  ensure(['http:', 'https:'].includes(issuer.protocol), 'INVALID_CONFIG', 'OAuth issuer must use HTTP(S).');
  let jwksUrl = config.jwksUrl;
  if (!jwksUrl) {
    const response = await fetch(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10000),
    });
    ensure(response.ok, 'AUTH_UNAVAILABLE', 'Cannot load OAuth discovery.');
    const metadata = (await response.json()) as { issuer: string; jwks_uri: string };
    ensure(
      metadata.issuer === config.issuer,
      'INVALID_CONFIG',
      'Discovery issuer does not match configured issuer.',
    );
    jwksUrl = metadata.jwks_uri;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30000 });
  return async (authorization: string | undefined): Promise<Principal> => {
    ensure(
      authorization && authorization.startsWith('Bearer ') && authorization.length <= 16384,
      'UNAUTHENTICATED',
      'Supply a valid OAuth bearer token.',
    );
    let payload;
    try {
      payload = (
        await jwtVerify(authorization.slice(7), jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['RS256', 'PS256', 'ES256'],
          requiredClaims: ['exp', 'iat', 'sub'],
          clockTolerance: 5,
        })
      ).payload;
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Bearer token is expired or invalid for this resource.');
    }
    const actor = (
      await storage.find('actors', { where: { issuer: config.issuer, subject: payload.sub! }, limit: 1 })
    )[0];
    ensure(
      actor,
      'UNAUTHENTICATED',
      'This identity is not registered. Ask an operator to map its issuer and subject.',
    );
    // Issuers may use a space-delimited scope or an scp string or array.
    const raw = payload.scope ?? payload.scp;
    const scopes = new Set(
      typeof raw === 'string'
        ? raw.split(' ')
        : Array.isArray(raw)
          ? raw.filter((s): s is string => typeof s === 'string')
          : [],
    );
    ensure(scopes.has('ticketing:read'), 'INSUFFICIENT_SCOPE', 'ticketing:read scope is required.');
    return { actorId: actor.id, scopes };
  };
}
