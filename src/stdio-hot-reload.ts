#!/usr/bin/env node
import { specTypeSchemas } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { serializeSuccessEnvelope } from './envelope.js';
import { parseMcpProfile } from './profiles.js';

type Message = Parameters<StdioServerTransport['send']>[0];
type Request = Extract<Message, { method: string; id: string | number }>;
type Reply = Extract<Message, { result: unknown } | { error: unknown }>;
type Bootstrap =
  { message: Request; hash?: string; catalog?: Reply } | { message: Message; notification: true };
type Backend = { entry: string; transport: StdioClientTransport };

const discovery = new Set([
  'server/discover',
  'initialize',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
]);
const stateless = new Set(['ping', 'tools/call', 'prompts/get', 'resources/read']);
const log = (event: string, detail: Record<string, unknown> = {}) => {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
};

function fingerprint(reply: Reply): string {
  if ('error' in reply)
    return createHash('sha256')
      .update(serializeSuccessEnvelope({ error: reply.error }))
      .digest('hex');
  const result = reply.result;
  // Version identifies the deployed build; capabilities, instructions and discovery remain stable.
  const info = result.serverInfo;
  const value =
    info && typeof info === 'object' && 'version' in info
      ? { ...result, serverInfo: { ...info, version: undefined } }
      : result;
  return createHash('sha256')
    .update(serializeSuccessEnvelope({ result: value }))
    .digest('hex');
}

function toolCatalog(reply: Reply) {
  if ('error' in reply || !Array.isArray(reply.result.tools))
    throw new Error('Candidate tool catalog is incomplete.');
  const { tools, ...metadata } = reply.result;
  const definitions = new Map<string, string>();
  for (const tool of tools) {
    const parsed = specTypeSchemas.Tool['~standard'].validate(tool);
    if (parsed.issues || definitions.has(parsed.value.name))
      throw new Error('Candidate tool catalog has invalid or duplicate definitions.');
    definitions.set(parsed.value.name, serializeSuccessEnvelope(tool));
  }
  return { definitions, metadata: serializeSuccessEnvelope(metadata), paginated: 'nextCursor' in metadata };
}

function addsTools(frame: Exclude<Bootstrap, { notification: true }>, reply: Reply) {
  if (!frame.catalog) throw new Error('Connected client discovery changed.');
  const before = toolCatalog(frame.catalog);
  const after = toolCatalog(reply);
  // A single page cannot establish that the complete existing catalog is preserved.
  if (frame.message.params?.cursor !== undefined || before.paginated || after.paginated)
    throw new Error('Paginated tool catalog changed; reconnect the client.');
  if (before.metadata !== after.metadata) throw new Error('Connected client discovery changed.');
  for (const [name, definition] of before.definitions) {
    if (after.definitions.get(name) !== definition) throw new Error('Existing tool removed or changed.');
  }
  return after.definitions.size > before.definitions.size;
}

async function sqliteMigrations(entry: string) {
  const directory = join(dirname(entry), '..', 'migrations', 'sqlite');
  const migrations = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!migrations.length) throw new Error('No SQLite migrations found for the selected build.');
  return serializeSuccessEnvelope(
    await Promise.all(migrations.map(async (name) => [name, await readFile(join(directory, name), 'utf8')])),
  );
}

async function validateEntry(path: string) {
  if (!isAbsolute(path) || !path.endsWith('.js') || /[\r\n\0]/.test(path))
    throw new Error('Provide the absolute path to a built server CLI (.js).');
  const entry = await realpath(path);
  if (!(await stat(entry)).isFile()) throw new Error('The selected CLI must be a file.');
  return entry;
}

async function selectEntry(pointer: string, path: string) {
  const entry = await validateEntry(path);
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${entry}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, pointer);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ selected: entry })}\n`);
}

async function relay(pointer: string, profile: string) {
  const front = new StdioServerTransport();
  const pending = new Map<Request['id'], Bootstrap | null>();
  const bootstrap: Bootstrap[] = [];
  let pinned = false;
  let stopping = false;
  let attempted: string | undefined;
  let deployed: string | undefined;
  let active: Backend | undefined;
  let candidate: Backend | undefined;
  let messages = Promise.resolve();
  let toolsListChanged = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([active?.transport.close(), candidate?.transport.close(), front.close()]);
  };
  const send = (message: Message) => front.send(message).catch(() => void stop());
  const fail = (id: Request['id'], message: string) =>
    send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

  function remember(frame: Bootstrap) {
    // Only replay the fixed discovery surface. Bound memory even if a client repeatedly probes.
    if (bootstrap.length >= 64 || Buffer.byteLength(JSON.stringify(frame.message)) > 16_384) {
      pinned = true;
      return;
    }
    bootstrap.push(frame);
  }

  function attach(backend: Backend) {
    backend.transport.onerror = () => log('mcp_relay_backend_error', { pid: backend.transport.pid });
    backend.transport.onclose = () => {
      if (active !== backend || stopping) return;
      log('mcp_relay_backend_disconnected');
      active = undefined;
      attempted = undefined;
      for (const [id, frame] of pending) {
        if (frame && 'hash' in frame && !frame.hash) pinned = true;
        void fail(
          id,
          'The MCP backend disconnected. The outcome is unknown. Retry mutations with their original idempotency keys.',
        );
      }
      pending.clear();
      if (pinned) void stop();
    };
    backend.transport.onmessage = (message) => {
      if (active !== backend || stopping) return;
      if ('method' in message && 'id' in message) pinned = true;
      if (!('method' in message) && message.id !== undefined) {
        const frame = pending.get(message.id);
        if (frame && !('notification' in frame)) {
          frame.hash = fingerprint(message);
          if (frame.message.method === 'tools/list') {
            const cached = bootstrap.find(
              (cached) => !('notification' in cached) && cached.hash === frame.hash && cached.catalog,
            );
            frame.catalog = cached && !('notification' in cached) ? cached.catalog : message;
          }
          if (
            (frame.message.method === 'initialize' || frame.message.method === 'server/discover') &&
            'result' in message
          ) {
            const capabilities = message.result.capabilities;
            toolsListChanged = Boolean(
              capabilities &&
              typeof capabilities === 'object' &&
              'tools' in capabilities &&
              capabilities.tools &&
              typeof capabilities.tools === 'object' &&
              'listChanged' in capabilities.tools &&
              capabilities.tools.listChanged === true,
            );
          }
        }
        pending.delete(message.id);
      }
      void send(message);
    };
  }

  async function open(entry: string, replay: readonly Bootstrap[]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'stdio', '--profile', profile],
      env: Object.fromEntries(
        Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
      ),
    });
    const backend = { entry, transport };
    candidate = backend;
    let reply: ((message: Reply) => void) | undefined;
    let expected: Request['id'] | undefined;
    let rejectProbe!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectProbe = reject;
    });
    const timer = setTimeout(() => rejectProbe(new Error('Probe deadline exceeded.')), 5_000);
    transport.onerror = rejectProbe;
    transport.onclose = () => rejectProbe(new Error('Candidate disconnected.'));
    transport.onmessage = (message) => {
      if ('method' in message) {
        if ('id' in message) rejectProbe(new Error('Candidate requires a client interaction.'));
      } else if (message.id === expected) reply?.(message);
    };
    try {
      await Promise.race([aborted, transport.start()]);
      const catalogs = new Map<Exclude<Bootstrap, { notification: true }>, Reply>();
      const catalogReplies = new Map<string, Reply>();
      let catalogChanged = false;
      for (const frame of replay) {
        if ('notification' in frame) {
          await Promise.race([aborted, transport.send(frame.message)]);
          continue;
        }
        expected = frame.message.id;
        const response = new Promise<Reply>((resolve) => {
          reply = resolve;
        });
        const result = await Promise.race([aborted, transport.send(frame.message).then(() => response)]);
        const hash = fingerprint(result);
        if (hash !== frame.hash) {
          if (frame.message.method !== 'tools/list' || !toolsListChanged)
            throw new Error('Connected client discovery changed.');
          catalogChanged = addsTools(frame, result) || catalogChanged;
        }
        if (frame.message.method === 'tools/list') {
          const catalog = catalogReplies.get(hash) ?? result;
          catalogReplies.set(hash, catalog);
          catalogs.set(frame, catalog);
        }
      }
      if (catalogChanged) {
        const definitions = new Set(
          [...catalogs.values()].map((reply) =>
            serializeSuccessEnvelope(Object.fromEntries(toolCatalog(reply).definitions)),
          ),
        );
        if (definitions.size !== 1) throw new Error('Candidate tool catalog changed during discovery.');
      }
      if (stopping) throw new Error('Client closed.');
      const previous = active;
      active = backend;
      deployed = entry;
      attach(backend);
      for (const [frame, reply] of catalogs) {
        frame.hash = fingerprint(reply);
        frame.catalog = reply;
      }
      log(previous ? 'mcp_relay_switched' : 'mcp_relay_ready', { entry, pid: transport.pid });
      if (previous) void previous.transport.close().catch(() => log('mcp_relay_close_error'));
      if (catalogChanged) await send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch (error) {
      void transport.close().catch(() => {});
      throw error;
    } finally {
      candidate = undefined;
      clearTimeout(timer);
    }
  }

  async function reload() {
    if (pending.size || pinned || stopping) return;
    try {
      const selected = (await readFile(pointer, 'utf8')).trim();
      if (selected === attempted) return;
      attempted = selected;
      const entry = await validateEntry(selected);
      // The SQLite stdio CLI migrates during startup. Never let a rejected probe change the live schema.
      if (deployed && deployed !== entry && process.env.STORAGE_ADAPTER === 'sqlite') {
        const [current, replacement] = await Promise.all([
          sqliteMigrations(deployed),
          sqliteMigrations(entry),
        ]);
        if (current !== replacement)
          throw new Error('SQLite migrations changed; a controlled upgrade is required.');
      }
      if (active?.entry !== entry) await open(entry, bootstrap);
    } catch (error) {
      log('mcp_relay_rejected', {
        retained: Boolean(active),
        reason: error instanceof Error ? error.message : 'Unknown error.',
      });
    }
  }

  async function forward(message: Message) {
    if (stopping) return;
    if ('method' in message && 'id' in message) {
      if (pending.has(message.id)) return;
      await reload();
      if (stopping) return;
      if (!active) return fail(message.id, 'The MCP backend is unavailable. Check the selected build.');
      if (discovery.has(message.method)) {
        const frame = { message, hash: undefined };
        remember(frame);
        pending.set(message.id, frame);
      } else {
        if (!stateless.has(message.method)) pinned = true;
        pending.set(message.id, null);
      }
    } else if ('method' in message) {
      if (message.method === 'notifications/initialized') remember({ message, notification: true });
      else if (message.method !== 'notifications/cancelled') pinned = true;
    }
    try {
      await active?.transport.send(message);
    } catch {
      if ('method' in message && 'id' in message && pending.delete(message.id)) {
        pinned = true;
        await fail(
          message.id,
          'MCP delivery failed. The outcome is unknown. Retry mutations with their original idempotency keys.',
        );
      }
    }
  }

  front.onmessage = (message) => {
    messages = messages
      .then(() => forward(message))
      .catch(() => {
        log('mcp_relay_error');
        void stop();
      });
  };
  front.onclose = () => void stop();
  front.onerror = () => log('mcp_relay_client_error');
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  await front.start();
}

async function main() {
  process.stderr.on('error', () => {});
  const { values } = parseArgs({
    options: { pointer: { type: 'string' }, profile: { type: 'string' }, select: { type: 'string' } },
  });
  if (!values.pointer || !isAbsolute(values.pointer))
    throw new Error(
      'Usage: node dist/stdio-hot-reload.js --pointer ABSOLUTE_PATH [--profile NAME | --select ABSOLUTE_CLI]',
    );
  if (values.select !== undefined) await selectEntry(values.pointer, values.select);
  else await relay(values.pointer, parseMcpProfile(values.profile));
}

void main().catch((error: unknown) => {
  log('mcp_relay_config_error', {
    message: error instanceof Error ? error.message : 'Invalid configuration.',
  });
  process.exitCode = 1;
});
