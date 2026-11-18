import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { open, readdir, mkdtemp, chmod, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// Base64 keeps the captured bytes immutable, including encoding and line endings.
export type SqliteMigrations = readonly Readonly<{ name: string; bytes: string }>[];
const manifestTable = '_mcp_hot_reload_migrations';
const manifestSql = `CREATE TABLE "${manifestTable}"(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)`;
const checksum = (migration: SqliteMigrations[number]) =>
  createHash('sha256').update(Buffer.from(migration.bytes, 'base64')).digest('hex');

export async function readSqliteMigrations(entry: string): Promise<SqliteMigrations> {
  const directory = join(dirname(entry), '..', 'migrations', 'sqlite');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length || names.length > 1024) throw new Error('Invalid SQLite migration count.');
  const migrations = [];
  let total = 0;
  for (const name of names) {
    const file = await open(join(directory, name), 'r');
    try {
      if (!(await file.stat()).isFile()) throw new Error(`SQLite migration is not a file: ${name}`);
      const bytes = Buffer.alloc(1_048_577);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      total += length;
      if (length > 1_048_576 || total > 16_777_216)
        throw new Error('SQLite migrations exceed the hot reload size limit.');
      const content = bytes.subarray(0, length);
      if (!isUtf8(content)) throw new Error(`SQLite migration is not UTF-8: ${name}`);
      migrations.push(Object.freeze({ name, bytes: content.toString('base64') }));
    } finally {
      await file.close();
    }
  }
  return Object.freeze(migrations);
}

function expansionSql(migration: SqliteMigrations[number]): string {
  const sql = Buffer.from(migration.bytes, 'base64').toString('utf8');
  const tokens: string[] = [];
  for (const [token] of sql.matchAll(
    /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9]*|[(),;]|\S/g,
  )) {
    if (/^\s|^--|^\/\*/.test(token)) continue;
    tokens.push(token);
  }
  let position = 0;
  const invalid = (): never => {
    throw new Error(`SQLite migration requires a controlled upgrade: ${migration.name}`);
  };
  const take = (expected: string) => {
    if (tokens[position]?.toUpperCase() !== expected) return false;
    position++;
    return true;
  };
  const expect = (expected: string) => {
    if (!take(expected)) invalid();
  };
  const identifier = () => {
    const token = tokens[position++] ?? '';
    const name = token.startsWith('"') ? token.slice(1, -1) : token;
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) invalid();
    return name;
  };
  const table = () => {
    const name = identifier().toLowerCase();
    if (
      name === 'schema_migrations' ||
      name === manifestTable ||
      name.startsWith('sqlite_') ||
      name.startsWith('search_')
    )
      invalid();
  };
  const column = (nullable: boolean) => {
    identifier();
    if (!/^(TEXT|INTEGER|REAL|BLOB|NUMERIC)$/i.test(tokens[position++] ?? '')) invalid();
    if (nullable) {
      take('NULL');
      if (take('DEFAULT')) expect('NULL');
      return;
    }
    while (position < tokens.length && tokens[position] !== ',' && tokens[position] !== ')') {
      if (take('PRIMARY')) expect('KEY');
      else if (take('NOT')) expect('NULL');
      else if (take('DEFAULT')) expect('NULL');
      else if (!take('NULL') && !take('UNIQUE')) invalid();
    }
  };
  if (!tokens.length || sql.includes('\0')) invalid();
  while (position < tokens.length) {
    if (take('CREATE')) {
      expect('TABLE');
      table();
      expect('(');
      column(false);
      while (take(',')) column(false);
      expect(')');
    } else if (take('ALTER')) {
      expect('TABLE');
      table();
      expect('ADD');
      take('COLUMN');
      column(true);
    } else invalid();
    if (position < tokens.length) expect(';');
  }
  return sql;
}

function appliedHistory(db: DatabaseSync, previous: SqliteMigrations, next: SqliteMigrations) {
  const reject = (): never => {
    throw new Error(
      'SQLite applied migration history is unknown or conflicting; controlled upgrade required.',
    );
  };
  const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
  const metadata = db.prepare('SELECT sql FROM sqlite_schema WHERE name=? COLLATE NOCASE').get(manifestTable);
  if (metadata && metadata.sql !== manifestSql) reject();
  const history = metadata
    ? db.prepare(`SELECT name,sha256 FROM "${manifestTable}" ORDER BY name`).all()
    : previous.map((migration) => ({ name: migration.name, sha256: checksum(migration) }));
  if (
    history.some(
      (row) =>
        typeof row.name !== 'string' || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256),
    )
  )
    reject();
  if (applied.length !== history.length || applied.some((row, index) => row.name !== history[index]!.name))
    reject();
  const matches = (migrations: SqliteMigrations) => {
    for (let index = 0; index < Math.min(migrations.length, history.length); index++)
      if (
        migrations[index]!.name !== history[index]!.name ||
        checksum(migrations[index]!) !== history[index]!.sha256
      )
        reject();
  };
  if (previous.length > history.length) reject();
  matches(previous);
  matches(next);
  return { history, recorded: Boolean(metadata) };
}

function applyExpansion(db: DatabaseSync, previous: SqliteMigrations, next: SqliteMigrations) {
  const { history, recorded } = appliedHistory(db, previous, next);
  if (next.length <= history.length) return;
  if (!recorded) {
    db.exec(manifestSql);
    for (const row of history)
      db.prepare(`INSERT INTO "${manifestTable}"(name,sha256) VALUES(?,?)`).run(row.name!, row.sha256!);
  }
  for (const migration of next.slice(history.length)) {
    db.exec(expansionSql(migration));
    db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)').run(
      migration.name,
      new Date().toISOString(),
    );
    db.prepare(`INSERT INTO "${manifestTable}"(name,sha256) VALUES(?,?)`).run(
      migration.name,
      checksum(migration),
    );
  }
}

async function applyLive(filename: string, previous: SqliteMigrations, next: SqliteMigrations) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
    try {
      applyExpansion(db, previous, next);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Preflight is read only on live storage; call apply only after accepting the shadow candidate. */
export async function prepareSqliteReload(
  previous: SqliteMigrations,
  next: SqliteMigrations,
  filename: string,
): Promise<{ filename: string; apply(): Promise<void>; dispose(): Promise<void> } | undefined> {
  for (let index = 0; index < Math.min(previous.length, next.length); index++) {
    if (previous[index]!.name !== next[index]!.name || previous[index]!.bytes !== next[index]!.bytes)
      throw new Error('SQLite migration history changed; controlled upgrade required.');
  }
  const suffix = (next.length > previous.length ? next : previous).slice(
    Math.min(previous.length, next.length),
  );
  suffix.forEach(expansionSql);

  const liveFilename = await realpath(filename);
  let directory: string | undefined;
  let scratch: string;
  const dispose = () => (directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve());
  try {
    const source = new DatabaseSync(liveFilename, { readOnly: true });
    try {
      source.exec('BEGIN');
      const { history } = appliedHistory(source, previous, next);
      if (next.length <= history.length) return;
      // On Windows the copy inherits permissions from the operator's database directory.
      directory = await mkdtemp(join(dirname(liveFilename), '.ticketing-sqlite-reload-'));
      scratch = join(directory, 'probe.sqlite');
      await backup(source, scratch);
    } finally {
      source.close();
    }
    await chmod(scratch, 0o600);
    const probe = new DatabaseSync(scratch);
    try {
      probe.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      try {
        applyExpansion(probe, previous, next);
      } finally {
        probe.exec('ROLLBACK');
      }
    } finally {
      probe.close();
    }
    return { filename: scratch, apply: () => applyLive(liveFilename, previous, next), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
