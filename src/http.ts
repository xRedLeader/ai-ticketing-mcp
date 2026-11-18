import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  hostHeaderValidation,
  originValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { DomainError, ensure } from './contracts.js';
import { createMcpServer, type Principal } from './mcp.js';
import type { Application } from './application.js';
import { parseMcpProfile } from './profiles.js';
import type { ProfileRecorder } from './profiling.js';

export interface HttpConfig {
  publicUrl: string;
  issuer: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  profiler?: ProfileRecorder;
  authenticate: (authorization: string | undefined) => Promise<Principal>;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= 4 * 1024 * 1024, 'REQUEST_TOO_LARGE', 'Request body exceeds 4 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_INPUT', 'Request body must be JSON.');
  }
}
export function createHttpServer(app: Application, config: HttpConfig) {
  const url = new URL(config.publicUrl);
  ensure(
    url.pathname === '/' && !url.search && !url.hash,
    'INVALID_CONFIG',
    'PUBLIC_URL must be an origin, without a path, query, or fragment.',
  );
  ensure(
    url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'INVALID_CONFIG',
    'Public remote deployments require HTTPS.',
  );
  const resource = new URL('/mcp', url).href;
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', url).href;
  const validateHost = hostHeaderValidation([url.hostname, 'localhost', '127.0.0.1', '[::1]']);
  const validateOrigin = originValidation(config.allowedOrigins ?? [url.hostname]);
  let active = 0;
  const server = createServer(async (req, res) => {
    const start = performance.now();
    const requestUrl = new URL(req.url ?? '/', url);
    const path = requestUrl.pathname;
    res.on('finish', () =>
      process.stderr.write(
        JSON.stringify({
          level: 'info',
          event: 'http',
          method: req.method,
          path: [
            '/mcp',
            '/healthz',
            '/readyz',
            '/metrics',
            '/.well-known/oauth-protected-resource',
            '/.well-known/oauth-protected-resource/mcp',
          ].includes(path)
            ? path
            : 'unknown',
          status: res.statusCode,
          duration_ms: Math.round(performance.now() - start),
        }) + '\n',
      ),
    );
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (active >= 128) {
      json(res, 503, { error: 'SERVER_BUSY' });
      return;
    }
    active++;
    try {
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }
      if (req.method === 'GET' && path === '/readyz') {
        try {
          await Promise.all([app.storage.health(), app.searchAdapter.health()]);
          json(res, 200, { status: 'ready' });
        } catch {
          json(res, 503, { status: 'not_ready' });
        }
        return;
      }
      if (
        req.method === 'GET' &&
        ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)
      ) {
        json(res, 200, {
          resource,
          authorization_servers: [config.issuer],
          scopes_supported: ['ticketing:read', 'ticketing:write'],
          bearer_methods_supported: ['header'],
          resource_name: 'AI Ticketing MCP',
        });
        return;
      }
      if (!['/mcp', '/metrics'].includes(path)) {
        json(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const principal = await config.authenticate(req.headers.authorization);
      if (path === '/metrics') {
        ensure(req.method === 'GET', 'INVALID_INPUT', 'Metrics require GET.');
        ensure(
          (await app.actor(principal.actorId)).system_admin,
          'FORBIDDEN',
          'Metrics require system administrator access.',
        );
        const metrics = {
          ...app.metrics,
          ...app.embeddings?.metrics,
          ...config.profiler?.metrics,
          ...(await app.storage.metrics()),
          ...(await app.storage.deliveryMetrics?.()),
        };
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(
          Object.entries(metrics)
            .map(([key, value]) => `ai_ticketing_${key} ${value}`)
            .join('\n') + '\n',
        );
        return;
      }
      const profiles = requestUrl.searchParams.getAll('profile');
      ensure(profiles.length <= 1, 'INVALID_INPUT', 'Specify profile only once.');
      const profile = parseMcpProfile(profiles[0]);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        json(res, 405, {
          error: 'METHOD_NOT_ALLOWED',
          message: 'Use POST and changes_since for durable event polling.',
        });
        return;
      }
      ensure(
        req.headers['content-type']?.split(';')[0]?.trim() === 'application/json',
        'INVALID_INPUT',
        'Content-Type must be application/json.',
      );
      const parsed = await body(req);
      const mcp = createMcpServer(app, principal, profile);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once('close', () => {
        void mcp.close();
      });
      await mcp.connect(
        config.profiler?.wrapTransport(transport, {
          transport: 'http',
          profile,
          actorId: principal.actorId,
        }) ?? transport,
      );
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const safe =
        error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Request failed.');
      const status =
        safe.code === 'UNAUTHENTICATED'
          ? 401
          : safe.code === 'INSUFFICIENT_SCOPE' || safe.code === 'FORBIDDEN'
            ? 403
            : safe.code === 'REQUEST_TOO_LARGE'
              ? 413
              : safe.code === 'INVALID_INPUT'
                ? 400
                : 500;
      if (status === 401 || safe.code === 'INSUFFICIENT_SCOPE')
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadataUrl}", scope="ticketing:read ticketing:write", error="${status === 401 ? 'invalid_token' : 'insufficient_scope'}"`,
        );
      json(res, status, { error: safe.code, message: safe.message });
    } finally {
      active--;
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}
