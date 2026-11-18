#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { write } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRuntime } from './runtime.js';
import { createAuthenticator } from './auth.js';
import { createHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { DomainError, ensure, type Actor } from './contracts.js';
import type { Operation } from './schemas.js';
import { parseMcpProfile } from './profiles.js';
import type { ProfileRecorder } from './profiling.js';

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
    sqlite: { type: 'string' },
    operation: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
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
async function capture(env: NodeJS.ProcessEnv) {
  const enabled = env.MCP_PROFILE_CAPTURE ?? 'true';
  ensure(['true', 'false'].includes(enabled), 'INVALID_CONFIG', 'MCP_PROFILE_CAPTURE must be true or false.');
  if (enabled === 'false') return undefined;
  const { createProfileRecorder } = await import('./profiling.js');
  const number = (key: string) => {
    if (env[key] === undefined) return undefined;
    const value = Number(env[key]);
    ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_CONFIG', `${key} must be a positive integer.`);
    return value;
  };
  const directory = env.MCP_PROFILE_DIRECTORY ?? '.local/token-profiles';
  ensure(directory.trim().length > 0, 'INVALID_CONFIG', 'MCP_PROFILE_DIRECTORY requires a directory.');
  const recorder = await createProfileRecorder({
    directory,
    maxFileBytes: number('MCP_PROFILE_MAX_FILE_BYTES'),
    maxFiles: number('MCP_PROFILE_MAX_FILES'),
    maxQueueBytes: number('MCP_PROFILE_MAX_QUEUE_BYTES'),
  });
  try {
    write(
      2,
      JSON.stringify({ event: 'mcp_profile_capture', directory: recorder.runDirectory, raw_payloads: true }) +
        '\n',
      () => {},
    );
  } catch {}
  return recorder;
}
async function main() {
  if (command === 'help') {
    process.stdout.write(
      `ai-ticketing commands:\n  migrate                 Apply migrations and prepare the configured search profile\n  actor --issuer --subject --name --kind [--admin]   Register an identity (trusted operator)\n  call --actor ID --operation NAME --input-file FILE   Execute as a trusted local operator\n  call --url URL --token-env ACCESS_TOKEN --operation NAME --input-file FILE   Authenticated remote call\n  serve                   Serve authenticated HTTP MCP\n  stdio [--profile NAME]  Local MCP; worker (default), planner, reviewer, full (actor required outside SQLite)\n  worker [--once]          Process durable indexing and configured webhook deliveries\n  reindex --actor ID --project ID   Rebuild project search indexes\n  inspect --actor ID --project ID   Inspect project and queue metrics\n  profile-report --input DIR --output FILE   Analyze captured MCP traffic offline\n\nUse --sqlite PATH for local storage; SQLite stdio initializes its agent and indexing automatically.\nUse --input JSON instead of --input-file for short inputs. Secrets belong in environment variables.\nMCP capture is on by default; set MCP_PROFILE_CAPTURE=false to opt out. Raw payloads stay local without model-visible output.\n`,
    );
    return;
  }
  if (command === 'profile-report') {
    ensure(
      values.input && values.output,
      'INVALID_INPUT',
      'profile-report requires --input DIR and --output FILE.',
    );
    const { analyzeProfile } = await import('./profile-report.js');
    const report = await analyzeProfile(values.input);
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    print({ report: values.output, complete: report.complete });
    if (!report.complete) process.exitCode = 2;
    return;
  }
  if (command === 'call' && values.url) {
    const token = process.env[values['token-env'] ?? 'ACCESS_TOKEN'];
    ensure(
      token && values.operation,
      'INVALID_CONFIG',
      'Set the token environment variable and --operation.',
    );
    const client = new Client({ name: 'ai-ticketing-cli', version: '2.0.0' });
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
  ensure(
    values.sqlite === undefined || values.sqlite.trim().length > 0,
    'INVALID_INPUT',
    '--sqlite requires a file path.',
  );
  const runtimeEnv =
    values.sqlite === undefined
      ? process.env
      : { ...process.env, STORAGE_ADAPTER: 'sqlite', SQLITE_PATH: values.sqlite };
  const app = createRuntime(runtimeEnv);
  let profiler: ProfileRecorder | undefined;
  let keepAlive = false;
  try {
    if (command === 'stdio' || command === 'serve') profiler = await capture(runtimeEnv);
    if (command === 'migrate') {
      await app.storage.migrate();
      if (app.embeddings && app.searchAdapter.capabilities?.semantic !== false)
        await app.searchAdapter.configure(app.embeddings.profile);
      print({ migrated: true, embedding_profile: app.embeddings?.profile ?? null });
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
    let actorId = values.actor ?? process.env.ACTOR_ID;
    if (command === 'call') {
      ensure(actorId && values.operation, 'INVALID_INPUT', 'call requires --actor and --operation.');
      print(await app.execute(actorId, values.operation as Operation, await input()));
      return;
    }
    if (command === 'reindex') {
      ensure(actorId && values.project, 'INVALID_INPUT', 'reindex requires --actor and --project.');
      if (app.embeddings && app.searchAdapter.capabilities?.semantic !== false)
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
        metrics: { ...(await app.storage.metrics()), ...(await app.storage.deliveryMetrics?.()) },
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
      const retention = runtimeEnv.RECEIPT_RETENTION_DAYS?.trim();
      const retentionMs = retention ? Number(retention) * 86_400_000 : undefined;
      ensure(
        retentionMs === undefined ||
          (retentionMs >= 86_400_000 && Number.isFinite(new Date(Date.now() - retentionMs).getTime())),
        'INVALID_CONFIG',
        'RECEIPT_RETENTION_DAYS must be at least 1 and give a valid date.',
      );
      let pruneAt = 0;
      const index = async () => {
        const now = Date.now();
        if (retentionMs !== undefined && app.storage.pruneReceipts && now >= pruneAt) {
          await app.storage.pruneReceipts(new Date(now - retentionMs).toISOString());
          pruneAt = now + 3_600_000;
        }
        return app.indexOnce(10);
      };
      const run = async (work: () => Promise<number>) => {
        try {
          do {
            const count = await work();
            if (values.once) break;
            if (!count) await new Promise((resolve) => setTimeout(resolve, 1000));
          } while (!stopped);
        } finally {
          stopped = true;
        }
      };
      const results = await Promise.allSettled([run(index), run(() => app.deliverOnce())]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return;
    }
    if (command === 'stdio') {
      if (runtimeEnv.STORAGE_ADAPTER === 'sqlite') {
        await app.storage.migrate();
        if (!actorId)
          actorId = await app.storage.transaction('catalog', async (tx) => {
            const previous = (
              await tx.find('actors', { where: { issuer: 'local-stdio', subject: 'local-mcp' }, limit: 1 })
            )[0];
            if (previous) {
              ensure(
                previous.kind === 'agent',
                'INVALID_CONFIG',
                'The default local MCP identity must be an agent.',
              );
              return previous.id;
            }
            const actor: Actor = {
              id: randomUUID(),
              issuer: 'local-stdio',
              subject: 'local-mcp',
              name: 'Local MCP agent',
              kind: 'agent',
              system_admin: true,
            };
            await tx.put('actors', actor);
            return actor.id;
          });
      }
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
      const transport = new StdioServerTransport();
      await server.connect(
        profiler?.wrapTransport(transport, {
          transport: 'stdio',
          profile: parseMcpProfile(values.profile),
          actorId,
        }) ?? transport,
      );
      keepAlive = true;
      let closing = false;
      let indexing: Promise<unknown> | undefined;
      let delivering: Promise<unknown> | undefined;
      const index = () => {
        if (closing || indexing) return;
        indexing = app
          .indexOnce(100)
          .catch((error) => {
            process.stderr.write(
              JSON.stringify({
                level: 'warn',
                event: 'indexing_failed',
                code: error instanceof DomainError ? error.code : 'FAILED',
              }) + '\n',
            );
          })
          .finally(() => {
            indexing = undefined;
          });
      };
      const indexTimer = runtimeEnv.STORAGE_ADAPTER === 'sqlite' ? setInterval(index, 1000) : undefined;
      indexTimer?.unref();
      if (indexTimer) index();
      const deliver = () => {
        if (closing || delivering) return;
        delivering = app
          .deliverOnce()
          .catch(() => {
            process.stderr.write(
              JSON.stringify({ level: 'warn', event: 'webhook_delivery_failed', code: 'FAILED' }) + '\n',
            );
          })
          .finally(() => {
            delivering = undefined;
          });
      };
      const deliveryTimer = runtimeEnv.TICKETING_WEBHOOK_URL ? setInterval(deliver, 1000) : undefined;
      deliveryTimer?.unref();
      if (deliveryTimer) deliver();
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        clearInterval(indexTimer);
        clearInterval(deliveryTimer);
        await server.close();
        await Promise.all([indexing, delivering]);
        await profiler?.close();
        await app.searchAdapter.close();
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
        profiler,
      });
      await new Promise<void>((resolve) =>
        server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', resolve),
      );
      keepAlive = true;
      process.stderr.write(JSON.stringify({ level: 'info', event: 'listening', url: publicUrl }) + '\n');
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        server.close(() => {
          void (async () => {
            await profiler?.close();
            await app.searchAdapter.close();
            await app.storage.close();
          })();
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
      await profiler?.close();
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
          : command === 'profile-report'
            ? 'Profile report failed. Check the capture directory and use a new writable output file.'
            : 'Command failed. Check database availability and configuration.',
    }) + '\n',
  );
  if (process.env.DEBUG === '1') process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
