import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import {
  prepareSqliteReload,
  readSqliteMigrations,
  type SqliteMigrations,
} from '../src/hot-reload-sqlite.js';
import { fixture } from '../src/testing/contracts.js';

const initial = 'CREATE TABLE legacy(id TEXT PRIMARY KEY, body TEXT NOT NULL);';
const migration = (name: string, sql: string) => ({ name, bytes: Buffer.from(sql).toString('base64') });
const previous = [migration('001.sql', initial)];
const next = (sql: string) => [...previous, migration('002.sql', sql)];

async function database(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-sqlite-preflight-test-'));
  const filename = join(directory, 'live.sqlite');
  const live = new DatabaseSync(filename);
  live.exec(`PRAGMA journal_mode=WAL; ${initial}
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES('001.sql','old');
    INSERT INTO legacy VALUES('old','preserve me');`);
  t.after(async () => {
    live.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, filename, live };
}

test('captures immutable, sorted, exact migration bytes with bounded UTF-8 input', async (t) => {
  const { directory } = await database(t);
  const entry = join(directory, 'dist', 'cli.js');
  const migrations = join(directory, 'migrations', 'sqlite');
  await mkdir(migrations, { recursive: true });
  await writeFile(join(migrations, '002.sql'), 'second\r\n');
  await writeFile(join(migrations, '001.sql'), 'first\n');
  await writeFile(join(migrations, 'README'), 'ignored');
  const snapshot = await readSqliteMigrations(entry);
  assert.deepEqual(snapshot, [migration('001.sql', 'first\n'), migration('002.sql', 'second\r\n')]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]));
  await writeFile(join(migrations, '001.sql'), 'edited');
  assert.equal(Buffer.from(snapshot[0]!.bytes, 'base64').toString(), 'first\n');
  await writeFile(join(migrations, '003.sql'), Buffer.from([0xff]));
  await assert.rejects(readSqliteMigrations(entry), /UTF-8/);
  await writeFile(join(migrations, '003.sql'), Buffer.alloc(1_048_577));
  await assert.rejects(readSqliteMigrations(entry), /size limit/);
});

test('rejects edited, reordered and inserted migration history', async (t) => {
  const { filename } = await database(t);
  for (const candidate of [
    [migration('001.sql', initial + '\n')],
    [migration('000.sql', initial), ...previous],
    [migration('renamed.sql', initial)],
    [migration('002.sql', initial), ...previous],
  ])
    await assert.rejects(prepareSqliteReload(previous, candidate, filename), /history changed/);
});

test('unchanged history and validated prefix rollback need no probe', async (t) => {
  const { filename, live } = await database(t);
  assert.equal(await prepareSqliteReload(previous, previous, filename), undefined);
  assert.equal(
    live.prepare("SELECT name FROM sqlite_schema WHERE name='_mcp_hot_reload_migrations'").get(),
    undefined,
  );
  const expanded = next('ALTER TABLE legacy ADD COLUMN hint TEXT;');
  const plan = (await prepareSqliteReload(previous, expanded, filename))!;
  await plan.apply();
  await plan.dispose();
  assert.equal(await prepareSqliteReload(expanded, previous, filename), undefined);
  await assert.rejects(
    prepareSqliteReload(next('DROP TABLE legacy;'), previous, filename),
    /controlled upgrade/,
  );
});

test('backs up committed WAL data and leaves pristine scratch and live schemas for candidate startup', async (t) => {
  const { filename, live } = await database(t);
  const candidate = next(`-- semicolon ; DROP TABLE legacy; is a comment
    CREATE /* ; PRAGMA writable_schema=ON; */ TABLE extras(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    ALTER TABLE "legacy" ADD COLUMN "hint" TEXT NULL DEFAULT NULL; -- trailing ;`);
  const probe = (await prepareSqliteReload(previous, candidate, filename))!;
  try {
    assert.equal(dirname(dirname(probe.filename)), dirname(await realpath(filename)));
    if (process.platform !== 'win32') {
      assert.equal((await stat(dirname(probe.filename))).mode & 0o777, 0o700);
      assert.equal((await stat(probe.filename)).mode & 0o777, 0o600);
    }
    const scratch = new DatabaseSync(probe.filename);
    try {
      assert.equal(scratch.prepare('SELECT body FROM legacy WHERE id=?').get('old')!.body, 'preserve me');
      assert.equal(scratch.prepare("SELECT name FROM sqlite_schema WHERE name='extras'").get(), undefined);
      assert.equal(scratch.prepare('PRAGMA table_info(legacy)').all().length, 2);
      assert.equal(scratch.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, 1);
      scratch.exec(Buffer.from(candidate[1]!.bytes, 'base64').toString());
      scratch.prepare('INSERT INTO legacy(id,body) VALUES(?,?)').run('new', 'old writer works');
      assert.equal(scratch.prepare('SELECT hint FROM legacy WHERE id=?').get('old')!.hint, null);
      assert.throws(() => scratch.prepare('INSERT INTO legacy VALUES(?,?)'));
    } finally {
      scratch.close();
    }
    assert.equal(live.prepare('PRAGMA table_info(legacy)').all().length, 2);
    assert.equal(live.prepare('SELECT count(*) n FROM legacy').get()!.n, 1);
    assert.equal(live.prepare("SELECT name FROM sqlite_schema WHERE name='extras'").get(), undefined);
  } finally {
    await probe.dispose();
    await probe.dispose();
  }
  assert.equal(existsSync(dirname(probe.filename)), false);
});

test('fails closed on destructive, dynamic, malformed and ambiguous SQL', async (t) => {
  const { filename, live } = await database(t);
  const rejected = [
    '',
    '-- comment only ;',
    '/* unterminated',
    'CREATE TABLE extras(id TEXT); /* \0 */',
    'CREATE TABLE extras(id TEXT',
    'CREATE TABLE extras(id TEXT);;',
    'CREATE TABLE extras(id TEXT) DROP TABLE legacy;',
    'CREATE TABLE extras AS SELECT * FROM legacy;',
    'CREATE TABLE IF NOT EXISTS legacy(id TEXT);',
    'CREATE TEMP TABLE extras(id TEXT);',
    'CREATE VIRTUAL TABLE extras USING fts5(body);',
    'CREATE TABLE main.extras(id TEXT);',
    'CREATE TABLE extras(id TEXT REFERENCES legacy(id));',
    'CREATE TABLE extras(id TEXT, FOREIGN KEY(id) REFERENCES legacy(id));',
    'CREATE TABLE extras(id TEXT CHECK(length(id)>0));',
    'CREATE TABLE extras(id TEXT GENERATED ALWAYS AS (random()));',
    "CREATE TABLE extras(id TEXT DEFAULT 'a;b');",
    'CREATE TABLE extras(id TEXT) STRICT;',
    'CREATE TABLE extras(id TEXT) WITHOUT ROWID;',
    'CREATE INDEX extra ON legacy(body);',
    'CREATE TRIGGER extra AFTER INSERT ON legacy BEGIN DELETE FROM legacy; END;',
    'CREATE VIEW extra AS SELECT * FROM legacy;',
    'DROP TABLE legacy;',
    'ALTER TABLE legacy RENAME TO renamed;',
    'ALTER TABLE legacy DROP COLUMN body;',
    'ALTER TABLE legacy ADD COLUMN hint TEXT NOT NULL;',
    'ALTER TABLE legacy ADD COLUMN hint TEXT CHECK(hint IS NOT NULL);',
    'ALTER TABLE legacy ADD COLUMN hint TEXT UNIQUE;',
    'ALTER TABLE legacy ADD COLUMN hint INTEGER PRIMARY KEY;',
    'ALTER TABLE legacy ADD COLUMN hint TEXT REFERENCES legacy(id);',
    'ALTER TABLE legacy ADD COLUMN hint TEXT DEFAULT (random());',
    "ALTER TABLE legacy ADD COLUMN hint TEXT DEFAULT 'non-null';",
    'ALTER TABLE legacy ADD COLUMN hint TEXT GENERATED ALWAYS AS (body);',
    'ALTER TABLE main.legacy ADD COLUMN hint TEXT;',
    'ALTER TABLE [legacy] ADD COLUMN hint TEXT;',
    'ALTER TABLE `legacy` ADD COLUMN hint TEXT;',
    'ALTER TABLE "legacy;DROP TABLE legacy" ADD COLUMN hint TEXT;',
    'ALTER TABLE legacy ADD COLUMN hint TEXT; DELETE FROM legacy;',
    'PRAGMA writable_schema=ON;',
    "ATTACH DATABASE 'other.sqlite' AS other;",
    'BEGIN; CREATE TABLE extras(id TEXT); COMMIT;',
    "INSERT INTO legacy VALUES('new','a;b');",
  ];
  for (const sql of rejected)
    await assert.rejects(prepareSqliteReload(previous, next(sql), filename), /controlled upgrade/, sql);
  assert.equal(live.prepare('SELECT body FROM legacy WHERE id=?').get('old')!.body, 'preserve me');
});

test('protects adapter metadata and SQLite internal tables case insensitively', async (t) => {
  const { filename } = await database(t);
  for (const name of [
    'schema_migrations',
    'SCHEMA_MIGRATIONS',
    '"schema_migrations"',
    'sqlite_schema',
    'SQLITE_master',
    'search_documents',
    'search_fts_data',
    '_mcp_hot_reload_migrations',
    '"_MCP_HOT_RELOAD_MIGRATIONS"',
  ]) {
    await assert.rejects(
      prepareSqliteReload(previous, next(`ALTER TABLE ${name} ADD COLUMN hint TEXT;`), filename),
      /controlled upgrade/,
    );
    await assert.rejects(
      prepareSqliteReload(previous, next(`CREATE TABLE ${name}(id TEXT);`), filename),
      /controlled upgrade/,
    );
  }
});

test('SQLite itself rejects invalid new schemas and name collisions without touching live data', async (t) => {
  const { filename, live } = await database(t);
  for (const sql of [
    'CREATE TABLE legacy(id TEXT);',
    'ALTER TABLE missing ADD COLUMN hint TEXT;',
    'CREATE TABLE extra(id TEXT, id TEXT);',
    'ALTER TABLE legacy ADD COLUMN body TEXT;',
  ])
    await assert.rejects(prepareSqliteReload(previous, next(sql), filename));
  assert.equal(live.prepare('PRAGMA table_info(legacy)').all().length, 2);
});

test('rejects applied suffix names whose exact bytes are outside the captured history', async (t) => {
  const { filename, live } = await database(t);
  const sql = 'ALTER TABLE legacy ADD COLUMN hint TEXT;';
  live.exec(sql);
  live.prepare('INSERT INTO schema_migrations VALUES(?,?)').run('002.sql', 'applied');
  await assert.rejects(prepareSqliteReload(previous, next(sql), filename), /unknown or conflicting/);
  assert.equal(await prepareSqliteReload(next(sql), next(sql), filename), undefined);
  assert.equal(live.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, 2);
});

test('old adapter reads, named writes and idempotency receipts survive additive live schema', async (t) => {
  const { filename, live } = await database(t);
  live.prepare('DELETE FROM schema_migrations WHERE name=?').run('001.sql');
  const adapters = createSqliteAdapters(filename);
  try {
    await adapters.storage.migrate();
    const f = await fixture(adapters);
    const ticket = await f.ticket();
    const baseline = await readSqliteMigrations(join(process.cwd(), 'dist', 'cli.js'));
    const sql =
      'ALTER TABLE tickets ADD COLUMN future_field TEXT; CREATE TABLE future_rows(id TEXT PRIMARY KEY);';
    const candidate: SqliteMigrations = [...baseline, migration('007_expand.sql', sql)];
    const probe = (await prepareSqliteReload(baseline, candidate, filename))!;
    await probe.apply();
    await probe.dispose();
    const writer = new DatabaseSync(filename);
    try {
      const key = randomUUID();
      const input = {
        project_id: f.project.id,
        idempotency_key: key,
        tickets: [
          {
            title: 'After expansion',
            description: 'Preserve old writes.',
            status: 'ready',
            criteria: ['Old writes work.'],
          },
        ],
      };
      const first = await f.app.execute(f.worker.id, 'tickets_create', input);
      assert.deepEqual(await f.app.execute(f.worker.id, 'tickets_create', input), first);
      assert.equal((await adapters.storage.get('tickets', ticket.id))!.title, ticket.title);
      assert.equal(
        (
          await adapters.storage.find('receipts', {
            where: { actor_id: f.worker.id, operation: 'tickets_create' },
          })
        ).length,
        2,
      );
      assert.equal(
        writer.prepare('SELECT future_field FROM tickets WHERE id=?').get(ticket.id)!.future_field,
        null,
      );
    } finally {
      writer.close();
    }
  } finally {
    await Promise.all([adapters.storage.close(), adapters.search.close()]);
  }
});

test('applies checksummed expansions atomically and supports repeat apply and reconnect', async (t) => {
  const { filename, live } = await database(t);
  const expanded = next('CREATE TABLE extras(id TEXT PRIMARY KEY); ALTER TABLE legacy ADD COLUMN hint TEXT;');
  const plan = (await prepareSqliteReload(previous, expanded, filename))!;
  try {
    assert.equal(live.prepare('PRAGMA table_info(legacy)').all().length, 2);
    await plan.apply();
    await plan.apply();
    assert.equal(live.prepare('PRAGMA table_info(legacy)').all().length, 3);
    assert.equal(live.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, 2);
    assert.equal(live.prepare('SELECT count(*) n FROM _mcp_hot_reload_migrations').get()!.n, 2);
    assert.equal(await prepareSqliteReload(previous, expanded, filename), undefined);
    assert.equal(await prepareSqliteReload(expanded, expanded, filename), undefined);
  } finally {
    await plan.dispose();
  }
});

test('rejects conflicting filename reuse and branches omitting known expansion files', async (t) => {
  const { filename, live } = await database(t);
  const a = next('CREATE TABLE branch_a(id TEXT);');
  const b = next('CREATE TABLE branch_b(id TEXT);');
  const planA = (await prepareSqliteReload(previous, a, filename))!;
  const planB = (await prepareSqliteReload(previous, b, filename))!;
  try {
    await planA.apply();
    await assert.rejects(planB.apply(), /unknown or conflicting/);
    await assert.rejects(prepareSqliteReload(previous, b, filename), /unknown or conflicting/);
    await assert.rejects(
      prepareSqliteReload(
        previous,
        [...previous, migration('003.sql', 'CREATE TABLE skipped(id TEXT);')],
        filename,
      ),
      /unknown or conflicting/,
    );
    assert.equal(live.prepare("SELECT name FROM sqlite_schema WHERE name='branch_b'").get(), undefined);
    assert.equal(await prepareSqliteReload(previous, previous, filename), undefined);
    const resumed = [...a, migration('003.sql', 'CREATE TABLE resumed(id TEXT);')];
    const plan = (await prepareSqliteReload(previous, resumed, filename))!;
    try {
      await plan.apply();
    } finally {
      await plan.dispose();
    }
    assert.equal(live.prepare('SELECT count(*) n FROM _mcp_hot_reload_migrations').get()!.n, 3);
  } finally {
    await planA.dispose();
    await planB.dispose();
  }
});

test('rolls back all live SQL and metadata after a post-probe conflict, then reconciles', async (t) => {
  const { filename, live } = await database(t);
  const expanded = next('CREATE TABLE extras(id TEXT); CREATE TABLE blocker(id TEXT);');
  const plan = (await prepareSqliteReload(previous, expanded, filename))!;
  try {
    live.exec('CREATE TABLE blocker(id TEXT)');
    await assert.rejects(plan.apply(), /already exists/);
    assert.equal(live.prepare("SELECT name FROM sqlite_schema WHERE name='extras'").get(), undefined);
    assert.equal(
      live.prepare("SELECT name FROM sqlite_schema WHERE name='_mcp_hot_reload_migrations'").get(),
      undefined,
    );
    assert.equal(live.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, 1);
    live.exec('DROP TABLE blocker');
    await plan.apply();
    assert.equal(live.prepare('SELECT count(*) n FROM schema_migrations').get()!.n, 2);
    assert.equal(await prepareSqliteReload(previous, expanded, filename), undefined);
  } finally {
    await plan.dispose();
  }
});

test('rejects missing or external applied history and conflicting baseline checksums', async (t) => {
  const { filename, live } = await database(t);
  const expanded = next('CREATE TABLE extras(id TEXT);');
  const plan = (await prepareSqliteReload(previous, expanded, filename))!;
  try {
    await plan.apply();
  } finally {
    await plan.dispose();
  }
  const edited = [migration('001.sql', initial + '\n')];
  await assert.rejects(prepareSqliteReload(edited, edited, filename), /unknown or conflicting/);
  live.prepare('INSERT INTO schema_migrations VALUES(?,?)').run('003_unknown.sql', 'external');
  await assert.rejects(prepareSqliteReload(previous, previous, filename), /unknown or conflicting/);
  live.prepare('DELETE FROM schema_migrations WHERE name=?').run('003_unknown.sql');
  live.prepare('DELETE FROM schema_migrations WHERE name=?').run('002.sql');
  await assert.rejects(prepareSqliteReload(previous, expanded, filename), /unknown or conflicting/);
});
