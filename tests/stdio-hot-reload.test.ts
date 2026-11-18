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

async function fixture(t: TestContext, env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-stdio-reload-'));
  const pointer = join(directory, 'active');
  const journal = join(directory, 'started');
  const client = new Client({ name: 'reload-test', version: '1' });
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

  const build = async (version: string, changedCatalog = false, migration = 'SELECT 1;') => {
    const folder = join(directory, version);
    const migrations = join(folder, 'migrations', 'sqlite');
    await mkdir(migrations, { recursive: true });
    await writeFile(join(migrations, '001.sql'), migration);
    await mkdir(join(folder, 'dist'));
    const path = join(folder, 'dist', 'cli.js');
    // The fixture intentionally speaks the legacy handshake after the modern probe.
    // Each invocation writes one journal entry; waiting and crashing are test-only controls.
    await writeFile(
      path,
      `const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const version = ${JSON.stringify(version)};
const journal = ${JSON.stringify(journal)};
function send(body) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',...body})+'\\n'); }
createInterface({input:process.stdin}).on('line', line=>{
  const {id,method,params}=JSON.parse(line);
  if(id===undefined) return;
  if(method==='server/discover') return send({id,error:{code:-32601,message:'Method not found'}});
  if(method==='initialize') return send({id,result:{protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version}}});
  if(method==='tools/list') return send({id,result:{tools:[{name:'work',description:${JSON.stringify(changedCatalog ? 'Changed catalog' : 'Do work')},inputSchema:{type:'object'}}]}});
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
    assert.equal((await client.listTools()).tools[0]?.name, 'work');
  };
  return { build, call, connect, select, events, diagnostics: () => diagnostics };
}

test('switches a connected client at idle, rejects a changed catalog, and can roll back', async (t) => {
  const f = await fixture(t);
  const [first, second, incompatible] = await Promise.all([
    f.build('first'),
    f.build('second'),
    f.build('changed', true),
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
    f.build('schema-changed', false, 'SELECT 2;'),
  ]);
  await f.connect(first);
  await f.select(incompatible);
  assert.equal(await f.call('unchanged'), 'first');
  assert.match(f.diagnostics(), /SQLite migrations changed/);
  assert.doesNotMatch(f.diagnostics(), /mcp_relay_switched/);
});
