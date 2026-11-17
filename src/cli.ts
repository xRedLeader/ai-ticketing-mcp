#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntime } from './runtime.js';
import { createAuthenticator } from './auth.js';
import { createHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { DomainError, ensure, type Actor } from './contracts.js';
import type { Operation } from './schemas.js';
import { parseMcpProfile } from './profiles.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    actor: { type: 'string' },
    issuer: { type: 'string' },
    subject: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    admin: { type: 'boolean' },
    project: { type: 'string' },
    profile: { type: 'string' },
    operation: { type: 'string' },
    input: { type: 'string' },
    'input-file': { type: 'string' },
    url: { type: 'string' },
    'token-env': { type: 'string' },
    once: { type: 'boolean' },
  },
});
const command = positionals[0] ?? 'help';
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
async function input() {
  return JSON.parse(
    values['input-file'] ? await readFile(values['input-file'], 'utf8') : (values.input ?? '{}'),
  );
}
async function main() {
  if (command === 'help') {
    process.stdout.write(
      `ai-ticketing commands:\n  migrate                 Apply migrations and prepare the configured search profile\n  actor --issuer --subject --name --kind [--admin]   Register an identity (trusted operator)\n  call --actor ID --operation NAME --input-file FILE   Execute as a trusted local operator\n  call --url URL --token-env ACCESS_TOKEN --operation NAME --input-file FILE   Authenticated remote call\n  serve                   Serve authenticated HTTP MCP\n  stdio [--profile NAME]  Local MCP; worker (default), planner, reviewer, full (requires ACTOR_ID)\n  worker [--once]          Process durable indexing jobs\n  reindex --actor ID --project ID   Rebuild project search indexes\n  inspect --actor ID --project ID   Inspect project and queue metrics\n\nUse --input JSON instead of --input-file for short inputs. Secrets belong in environment variables.\n`,
    );
    return;
  }
  if (command === 'call' && values.url) {
    const token = process.env[values['token-env'] ?? 'ACCESS_TOKEN'];
    ensure(
      token && values.operation,
      'INVALID_CONFIG',
      'Set the token environment variable and --operation.',
    );
    const client = new Client({ name: 'ai-ticketing-cli', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(values.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const result = await client.callTool({ name: values.operation, arguments: await input() });
      print(result.structuredContent ?? result);
      if (result.isError) process.exitCode = 1;
    } finally {
      await client.close();
    }
    return;
  }
  const app = createRuntime();
  let keepAlive = false;
  try {
    if (command === 'migrate') {
      await app.storage.migrate();
      await app.searchAdapter.configure(app.embeddings.profile);
      print({ migrated: true, embedding_profile: app.embeddings.profile });
      return;
    }
    if (command === 'actor') {
      ensure(
        values.subject && values.name && ['human', 'agent'].includes(values.kind ?? ''),
        'INVALID_INPUT',
        'actor requires --subject, --name, and --kind human|agent.',
      );
      const issuer = values.issuer ?? 'local';
      const result = await app.storage.transaction('catalog', async (tx) => {
        const previous = (
          await tx.find('actors', { where: { issuer, subject: values.subject! }, limit: 1 })
        )[0];
        const actor: Actor = {
          id: previous?.id ?? randomUUID(),
          issuer,
          subject: values.subject!,
          name: values.name!,
          kind: values.kind as Actor['kind'],
          system_admin: values.admin ?? previous?.system_admin ?? false,
        };
        await tx.put('actors', actor);
        return actor;
      });
      print(result);
      return;
    }
    const actorId = values.actor ?? process.env.ACTOR_ID;
    if (command === 'call') {
      ensure(actorId && values.operation, 'INVALID_INPUT', 'call requires --actor and --operation.');
      print(await app.execute(actorId, values.operation as Operation, await input()));
      return;
    }
    if (command === 'reindex') {
      ensure(actorId && values.project, 'INVALID_INPUT', 'reindex requires --actor and --project.');
      await app.searchAdapter.configure(app.embeddings.profile);
      print(await app.rebuild(actorId, values.project));
      return;
    }
    if (command === 'inspect') {
      ensure(actorId && values.project, 'INVALID_INPUT', 'inspect requires --actor and --project.');
      ensure(
        (await app.actor(actorId)).system_admin,
        'FORBIDDEN',
        'Inspection metrics require system administrator access.',
      );
      print({
        project: await app.execute(actorId, 'project_get', { project_id: values.project }),
        metrics: await app.storage.metrics(),
      });
      return;
    }
    if (command === 'worker') {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      do {
        const count = await app.indexOnce(10);
        if (values.once) break;
        if (!count) await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (!stopped);
      return;
    }
    if (command === 'stdio') {
      ensure(actorId, 'INVALID_CONFIG', 'ACTOR_ID is required for trusted local stdio.');
      await app.actor(actorId);
      const server = createMcpServer(
        app,
        {
          actorId,
          scopes: new Set(['ticketing:read', 'ticketing:write']),
        },
        parseMcpProfile(values.profile),
      );
      await server.connect(new StdioServerTransport());
      keepAlive = true;
      const shutdown = async () => {
        await server.close();
        await app.storage.close();
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      process.stdin.once('end', () => void shutdown());
      return;
    }
    if (command === 'serve') {
      ensure(
        process.env.OAUTH_ISSUER && process.env.PUBLIC_URL,
        'INVALID_CONFIG',
        'HTTP mode requires OAUTH_ISSUER and PUBLIC_URL.',
      );
      const publicUrl = process.env.PUBLIC_URL;
      const audience = process.env.OAUTH_AUDIENCE ?? new URL('/mcp', publicUrl).href;
      const authenticate = await createAuthenticator(app.storage, {
        issuer: process.env.OAUTH_ISSUER,
        audience,
        jwksUrl: process.env.OAUTH_JWKS_URL,
      });
      const server = createHttpServer(app, {
        publicUrl,
        issuer: process.env.OAUTH_ISSUER,
        authenticate,
        allowedOrigins: process.env.ALLOWED_ORIGIN_HOSTS?.split(','),
      });
      await new Promise<void>((resolve) =>
        server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', resolve),
      );
      keepAlive = true;
      process.stderr.write(JSON.stringify({ level: 'info', event: 'listening', url: publicUrl }) + '\n');
      const shutdown = () => {
        server.close(() => {
          void app.storage.close();
        });
        setTimeout(() => server.closeAllConnections(), 10000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return;
    }
    throw new DomainError('INVALID_INPUT', `Unknown command: ${command}`);
  } finally {
    if (!keepAlive) {
      await app.searchAdapter.close();
      await app.storage.close();
    }
  }
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      code: error instanceof DomainError ? error.code : 'FAILED',
      message:
        error instanceof DomainError
          ? error.message
          : 'Command failed. Check database availability and configuration.',
    }) + '\n',
  );
  if (process.env.DEBUG === '1') process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
