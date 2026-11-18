import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../src/stdio-hot-reload.ts', import.meta.url));
const exec = promisify(execFile);
const work = { name: 'work', description: 'Do work', inputSchema: { type: 'object' } };
const added = { name: 'added', description: 'New tool', inputSchema: { type: 'object' } };

async function fixture(t: TestContext, env: Record<string, string> = {}, modern = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-stdio-reload-'));
  const pointer = join(directory, 'active');
  const journal = join(directory, 'started');
  const updates: (string[] | Error)[] = [];
  const client = new Client(
    { name: 'reload-test', version: '1' },
    modern
      ? { versionNegotiation: { mode: 'auto' } }
      : {
          listChanged: {
            tools: {
              debounceMs: 0,
              onChanged: (error, tools) => {
                updates.push(error ?? tools!.map((tool) => tool.name));
              },
            },
          },
        },
  );
  if (modern)
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      updates.push(
        (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((tool) => tool.name),
      );
    });
  let diagnostics = '';
  const relay = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entry, '--pointer', pointer],
    stderr: 'pipe',
    env,
  });
  relay.stderr?.on('data', (chunk) => {
    diagnostics += chunk.toString();
  });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });

  const build = async (
    version: string,
    options: {
      tools?: Record<string, unknown>[];
      listChanged?: boolean;
      migration?: string;
      instructions?: string;
      prompts?: Record<string, unknown>[];
      replies?: Record<string, unknown>[];
      metadata?: Record<string, unknown>;
    } = {},
  ) => {
    const folder = join(directory, version);
    const migrations = join(folder, 'migrations', 'sqlite');
    await mkdir(migrations, { recursive: true });
    await writeFile(join(migrations, '001.sql'), options.migration ?? 'SELECT 1;');
    await mkdir(join(folder, 'dist'));
    const path = join(folder, 'dist', 'cli.js');
    // Each invocation writes one journal entry; waiting and crashing are test-only controls.
    await writeFile(
      path,
      `const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const version = ${JSON.stringify(version)};
const journal = ${JSON.stringify(journal)};
const modern = ${modern};
const options = ${JSON.stringify(options)};
const capabilities = {tools: options.listChanged ? {listChanged:true} : {}, prompts:{}};
const replies = options.replies ?? [{tools:options.tools ?? ${JSON.stringify([work])},...options.metadata}];
let lists = 0;
function send(body) {
  if(modern && body.result) body.result = {resultType:'complete',_meta:{},ttlMs:0,cacheScope:'private',...body.result};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',...body})+'\\n');
}
createInterface({input:process.stdin}).on('line', line=>{
  const {id,method,params}=JSON.parse(line);
  if(id===undefined) return;
  if(method==='server/discover') return modern
    ? send({id,result:{supportedVersions:['2026-07-28'],capabilities,instructions:options.instructions}})
    : send({id,error:{code:-32601,message:'Method not found'}});
  if(method==='initialize') return send({id,result:{protocolVersion:params.protocolVersion,capabilities,serverInfo:{name:'fixture',version},instructions:options.instructions}});
  if(method==='tools/list') return send({id,result:replies[Math.min(lists++,replies.length-1)]});
  if(method==='prompts/list') return send({id,result:{prompts:options.prompts ?? []}});
  if(method==='tools/call') {
    appendFileSync(journal,version+':'+params.arguments.label+'\\n');
    if(params.arguments.crash) return process.exit(1);
    setTimeout(()=>send({id,result:{content:[{type:'text',text:version}]}}),params.arguments.delay??0);
  }
});`,
    );
    return path;
  };
  const select = (path: string) =>
    exec(process.execPath, ['--import', 'tsx', entry, '--pointer', pointer, '--select', path]);
  const call = async (label: string, fields: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name: 'work', arguments: { label, ...fields } });
    const content = response.content?.[0];
    assert(content?.type === 'text');
    return content.text;
  };
  const events = () => readFile(journal, 'utf8');
  const connect = async (path: string) => {
    await select(path);
    await client.connect(relay);
    // Modern stdio negotiation probes a sibling process; advertise on this connection too.
    if (modern) await client.discover();
    assert.equal((await client.listTools()).tools[0]?.name, 'work');
  };
  const refreshed = async (count: number) => {
    for (let i = 0; i < 150 && updates.length < count; i++) await delay(10);
    assert.equal(updates.length, count);
    return updates;
  };
  return { build, call, connect, select, events, client, updates, refreshed, diagnostics: () => diagnostics };
}

test('switches a connected client at idle, rejects a changed catalog, and can roll back', async (t) => {
  const f = await fixture(t);
  const [first, second, incompatible] = await Promise.all([
    f.build('first'),
    f.build('second'),
    f.build('changed', { tools: [{ ...work, description: 'Changed catalog' }] }),
  ]);
  await f.connect(first);
  assert.equal(await f.call('before'), 'first');
  await f.select(second);
  assert.equal(await f.call('after'), 'second');
  await f.select(incompatible);
  assert.equal(await f.call('retained'), 'second');
  await f.select(first);
  assert.equal(await f.call('rollback'), 'first');
  assert.equal(await f.events(), 'first:before\nsecond:after\nsecond:retained\nfirst:rollback\n');
  assert.match(f.diagnostics(), /mcp_relay_rejected/);
});

test('keeps the old backend while a call is outstanding and never repeats it', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.build('first'), f.build('second')]);
  await f.connect(first);
  const slow = f.call('in-flight', { delay: 1_200 });
  for (let i = 0; i < 150; i++) {
    if ((await f.events().catch(() => '')).includes('first:in-flight')) break;
    await delay(10);
  }
  assert.match(await f.events(), /first:in-flight/);
  await f.select(second);
  assert.equal(await f.call('while-busy'), 'first');
  assert.equal(await slow, 'first');
  assert.equal(await f.call('after-drain'), 'second');
  assert.equal(await f.events(), 'first:in-flight\nfirst:while-busy\nsecond:after-drain\n');
});

test('recovers a disconnected backend without replaying the interrupted call', async (t) => {
  const f = await fixture(t);
  await f.connect(await f.build('first'));
  await assert.rejects(f.call('crash', { crash: true }), /outcome is unknown/);
  assert.equal(await f.call('after-crash'), 'first');
  assert.equal(await f.events(), 'first:crash\nfirst:after-crash\n');
});

test('rejects changed SQLite migrations before spawning the candidate', async (t) => {
  const f = await fixture(t, { STORAGE_ADAPTER: 'sqlite' });
  const [first, incompatible] = await Promise.all([
    f.build('first'),
    f.build('schema-changed', { migration: 'SELECT 2;' }),
  ]);
  await f.connect(first);
  await f.select(incompatible);
  assert.equal(await f.call('unchanged'), 'first');
  assert.match(f.diagnostics(), /SQLite migrations changed/);
  assert.doesNotMatch(f.diagnostics(), /mcp_relay_switched/);
});

for (const modern of [false, true]) {
  test(`refreshes added tools on the same ${modern ? 'modern' : 'legacy'} SDK connection and advances the baseline`, async (t) => {
    const f = await fixture(t, {}, modern);
    const first = await f.build('first', { listChanged: true });
    const second = await f.build('second', { listChanged: true, tools: [work, added] });
    const thirdTool = { ...added, name: 'third' };
    const third = await f.build('third', { listChanged: true, tools: [work, added, thirdTool] });
    await f.connect(first);
    await f.select(second);
    assert.equal(await f.call('added'), 'second');
    assert.deepEqual(await f.refreshed(1), [['work', 'added']]);
    const result = await f.client.callTool({ name: 'added', arguments: { label: 'new-tool' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'second' }]);
    await f.select(second);
    assert.equal(await f.call('repeat'), 'second');
    await f.select(first);
    assert.equal(await f.call('cannot-remove-added'), 'second');
    assert.equal(f.updates.length, 1);
    await f.select(third);
    assert.equal(await f.call('added-again'), 'third');
    assert.deepEqual(await f.refreshed(2), [
      ['work', 'added'],
      ['work', 'added', 'third'],
    ]);
    await assert.rejects(f.call('crash', { crash: true }), /outcome is unknown/);
    assert.equal(await f.call('recover'), 'third');
    assert.equal(f.updates.length, 2);

    // A separate connection discovers the selected catalog without a synthetic notification.
    await f.client.close();
    await f.connect(third);
    assert.deepEqual(
      (await f.client.listTools()).tools.map((tool) => tool.name),
      ['work', 'added', 'third'],
    );
    assert.equal(f.updates.length, 2);
  });
}

test('rejects additions when the connected session did not advertise listChanged', async (t) => {
  const f = await fixture(t);
  await f.connect(await f.build('first'));
  await f.select(await f.build('second', { tools: [work, added] }));
  assert.equal(await f.call('unchanged'), 'first');
  assert.deepEqual(f.updates, []);
  assert.match(f.diagnostics(), /mcp_relay_rejected/);
});

test('rejects changed definitions, removed tools, duplicate names and non-tool discovery changes', async (t) => {
  const f = await fixture(t);
  await f.connect(await f.build('first', { listChanged: true }));
  await f.client.listPrompts();
  const candidates = [
    { tools: [{ ...work, inputSchema: { type: 'object', required: ['new'] } }, added] },
    { tools: [{ ...work, outputSchema: { type: 'object' } }, added] },
    { tools: [{ ...work, annotations: { destructiveHint: true } }, added] },
    { tools: [added] },
    { tools: [work, added, added] },
    { tools: [work, { name: 'added' }] },
    { tools: [work, { ...added, inputSchema: { type: 'string' } }] },
    { tools: [work, added], instructions: 'Changed instructions' },
    { tools: [work, added], prompts: [{ name: 'new-prompt' }] },
    { tools: [work, added], metadata: { nextCursor: 'new-page' } },
    { tools: [work, added], metadata: { _meta: { changed: true } } },
    { replies: [{}] },
  ];
  for (const [index, options] of candidates.entries()) {
    await f.select(await f.build(`rejected-${index}`, { listChanged: true, ...options }));
    assert.equal(await f.call(`candidate-${index}`), 'first');
  }
  assert.deepEqual(f.updates, []);
  // Failed probes must not change cached discovery or suppress the next valid addition.
  await f.select(await f.build('accepted', { listChanged: true, tools: [work, added] }));
  assert.equal(await f.call('valid'), 'accepted');
  assert.deepEqual(await f.refreshed(1), [['work', 'added']]);
});

test('rejects a candidate whose repeated discovery responses have a catalog gap', async (t) => {
  const f = await fixture(t);
  await f.connect(await f.build('first', { listChanged: true }));
  await f.client.listTools(undefined, { cacheMode: 'refresh' });
  await f.select(
    await f.build('gap', { listChanged: true, replies: [{ tools: [work, added] }, { tools: [work] }] }),
  );
  assert.equal(await f.call('unchanged'), 'first');
  assert.deepEqual(f.updates, []);
  assert.match(f.diagnostics(), /Candidate tool catalog changed during discovery/);
});

test('waits for in-flight calls before accepting and notifying about added tools', async (t) => {
  const f = await fixture(t);
  await f.connect(await f.build('first', { listChanged: true }));
  const slow = f.call('in-flight', { delay: 1_200 });
  for (let i = 0; i < 150; i++) {
    if ((await f.events().catch(() => '')).includes('first:in-flight')) break;
    await delay(10);
  }
  assert.match(await f.events(), /first:in-flight/);
  await f.select(await f.build('second', { listChanged: true, tools: [work, added] }));
  assert.equal(await f.call('while-busy'), 'first');
  assert.deepEqual(f.updates, []);
  assert.equal(await slow, 'first');
  assert.equal(await f.call('after-drain'), 'second');
  assert.deepEqual(await f.refreshed(1), [['work', 'added']]);
  assert.equal(await f.events(), 'first:in-flight\nfirst:while-busy\nsecond:after-drain\n');
});
