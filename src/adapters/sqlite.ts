import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, realpathSync, existsSync, openSync, closeSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DomainError,
  ensure,
  type StorageAdapter,
  type SearchAdapter,
  type Reader,
  type Transaction,
  type Table,
  type Tables,
  type Query,
  type Note,
  type Job,
  type OutboundDelivery,
  type SearchDocument,
  type SearchHit,
  type EmbeddingProfile,
  type SchedulingPolicy,
} from '../contracts.js';

const columns: Record<Table, string[]> = {
  actors: ['id', 'issuer', 'subject', 'name', 'kind', 'system_admin'],
  projects: [
    'id',
    'key',
    'name',
    'instructions',
    'policy',
    'revision',
    'ticket_seq',
    'event_seq',
    'created_at',
    'execution_hints',
    'scheduling_policy',
  ],
  members: ['id', 'project_id', 'actor_id', 'role'],
  tickets: [
    'id',
    'project_id',
    'key',
    'title',
    'description',
    'status',
    'priority',
    'labels',
    'capabilities',
    'assignee_id',
    'parent_id',
    'revision',
    'requirements_revision',
    'created_by',
    'approved_submission_id',
    'created_at',
    'updated_at',
    'execution_hints',
    'github_pull_request',
  ],
  criteria: ['id', 'project_id', 'ticket_id', 'text', 'position'],
  links: ['id', 'project_id', 'source_id', 'target_id', 'kind'],
  notes: [
    'id',
    'project_id',
    'ticket_id',
    'actor_id',
    'kind',
    'body',
    'blocking',
    'answer_to',
    'metadata',
    'ticket_revision',
    'created_at',
  ],
  claims: ['id', 'project_id', 'ticket_id', 'actor_id', 'token', 'expires_at'],
  submissions: [
    'id',
    'project_id',
    'ticket_id',
    'actor_id',
    'requirements_revision',
    'evidence',
    'summary',
    'requirements_snapshot',
    'ticket_revision',
    'created_at',
  ],
  reviews: [
    'id',
    'project_id',
    'ticket_id',
    'submission_id',
    'actor_id',
    'decision',
    'feedback',
    'ticket_revision',
    'created_at',
  ],
  knowledge: ['id', 'project_id', 'title', 'body', 'kind', 'revision', 'archived', 'actor_id', 'updated_at'],
  events: ['id', 'project_id', 'seq', 'actor_id', 'type', 'entity_id', 'data', 'created_at'],
  receipts: ['id', 'project_id', 'actor_id', 'operation', 'input_hash', 'result', 'created_at'],
  jobs: [
    'id',
    'project_id',
    'entity_id',
    'kind',
    'revision',
    'attempts',
    'available_at',
    'locked_until',
    'lock_token',
    'last_error',
  ],
  outbound_deliveries: [
    'id',
    'event_id',
    'project_id',
    'body',
    'target_fingerprint',
    'attempt_count',
    'next_attempt_at',
    'locked_until',
    'lock_token',
    'sent_at',
    'last_error',
    'created_at',
  ],
  github_evidence: [
    'id',
    'project_id',
    'ticket_id',
    'actor_id',
    'repository',
    'pull_request_number',
    'head_sha',
    'observed_head_sha',
    'status',
    'requirements_revision',
    'ticket_revision',
    'checks',
    'observed_at',
  ],
};
const json = new Set([
  'labels',
  'capabilities',
  'metadata',
  'evidence',
  'requirements_snapshot',
  'execution_hints',
  'github_pull_request',
  'checks',
  'data',
  'result',
]);
const booleans = new Set(['system_admin', 'blocking', 'archived']);
function encode(key: string, value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (json.has(key))
    return value === null &&
      (key === 'execution_hints' || key === 'requirements_snapshot' || key === 'github_pull_request')
      ? null
      : JSON.stringify(value);
  if (value === null) return null;
  if (booleans.has(key)) return value ? 1 : 0;
  return value as SQLInputValue;
}
function decode(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]) =>
      (key === 'execution_hints' || key === 'github_pull_request' || key === 'scheduling_policy') &&
      value === null
        ? []
        : [
            [
              key,
              json.has(key) && typeof value === 'string'
                ? JSON.parse(value)
                : booleans.has(key)
                  ? value === 1
                  : value,
            ],
          ],
    ),
  );
}
function page(limit: number, offset: number) {
  ensure(
    Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 10001 &&
      Number.isSafeInteger(offset) &&
      offset >= 0,
    'INVALID_QUERY',
    'Page limit must be 1–10001 and offset must be nonnegative.',
  );
}
function translate(error: unknown): never {
  const code = (error as { errcode?: number }).errcode;
  if (code === 1555 || code === 2067)
    throw new DomainError('CONFLICT', 'A record with this identifier already exists.');
  if (code === 787 || code === 275 || code === 1299)
    throw new DomainError('INVALID_REFERENCE', 'A reference or database invariant is invalid.');
  throw error;
}
function repository(db: DatabaseSync): Transaction {
  const field = (table: Table, key: string) => {
    ensure(columns[table]?.includes(key), 'INVALID_QUERY', 'Unknown storage field.');
    return `"${key}"`;
  };
  return {
    async get<K extends Table>(table: K, id: string) {
      return (await this.find(table, { where: { id } as Query<Tables[K]>['where'], limit: 1 }))[0] ?? null;
    },
    async find<K extends Table>(table: K, query: Query<Tables[K]> = {}) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      const values: SQLInputValue[] = [];
      const conditions = Object.entries(query.where ?? {}).map(([key, value]) => {
        const name = field(table, key);
        if (value === null) return `${name} IS NULL`;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if ('in' in value) {
            const items = value.in as unknown[];
            if (!items.length) return '0';
            values.push(...items.map((item) => encode(key, item)));
            return `${name} IN (${items.map(() => '?').join(',')})`;
          }
          if ('gt' in value) {
            values.push(encode(key, value.gt));
            return `${name}>?`;
          }
        }
        values.push(encode(key, value));
        return `${name}=?`;
      });
      const order = query.order
        ?.map((item) => `${field(table, String(item.field))} ${item.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(',');
      page(query.limit ?? 1000, query.offset ?? 0);
      return db
        .prepare(
          `SELECT * FROM "${table}"${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}${order ? ` ORDER BY ${order}` : ''} LIMIT ? OFFSET ?`,
        )
        .all(...values, query.limit ?? 1000, query.offset ?? 0)
        .map(decode) as unknown as Tables[K][];
    },
    async unansweredQuestions(projectId, ticketId, blocking, limit, offset) {
      page(limit, offset);
      return db
        .prepare(
          `SELECT q.* FROM notes q WHERE q.project_id=? AND q.ticket_id=? AND q.kind='question' AND q.blocking=? AND NOT EXISTS(SELECT 1 FROM notes a WHERE a.project_id=q.project_id AND a.ticket_id=q.ticket_id AND a.kind='answer' AND a.answer_to=q.id) ORDER BY q.created_at,q.id LIMIT ? OFFSET ?`,
        )
        .all(projectId, ticketId, Number(blocking), limit, offset)
        .map(decode) as unknown as Note[];
    },
    async workCandidates(
      projectId,
      actorId,
      capabilities,
      labels,
      now,
      limit,
      offset,
      policy = 'priority_age',
    ) {
      page(limit, offset);
      ensure(['priority_age', 'unblocking'].includes(policy), 'INVALID_QUERY', 'Unknown scheduling policy.');
      const cutoff =
        policy === 'unblocking' ? new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString() : null;
      const order =
        policy === 'unblocking'
          ? `t.priority,CASE WHEN t.created_at<=? THEN 0 ELSE 1 END,CASE WHEN t.created_at<=? THEN 0 ELSE (SELECT count(*) FROM links outgoing JOIN tickets dependent ON dependent.id=outgoing.target_id AND dependent.project_id=t.project_id WHERE outgoing.project_id=t.project_id AND outgoing.source_id=t.id AND outgoing.kind='blocks' AND dependent.status NOT IN ('done','cancelled')) END DESC,t.created_at,t.id`
          : 't.priority,t.created_at,t.id';
      return db
        .prepare(
          `SELECT t.* FROM tickets t WHERE t.project_id=? AND t.status IN ('ready','in_progress') AND (t.assignee_id IS NULL OR t.assignee_id=?) AND NOT EXISTS(SELECT 1 FROM json_each(t.capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM json_each(?) l WHERE l.value NOT IN (SELECT value FROM json_each(t.labels))) AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.expires_at>?) AND NOT EXISTS(SELECT 1 FROM links l JOIN tickets p ON p.id=l.source_id WHERE l.project_id=t.project_id AND l.target_id=t.id AND l.kind='blocks' AND p.status<>'done') AND NOT EXISTS(SELECT 1 FROM notes q WHERE q.project_id=t.project_id AND q.ticket_id=t.id AND q.kind='question' AND q.blocking=1 AND NOT EXISTS(SELECT 1 FROM notes a WHERE a.project_id=q.project_id AND a.ticket_id=q.ticket_id AND a.answer_to=q.id AND a.kind='answer')) ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(
          projectId,
          actorId,
          JSON.stringify(capabilities),
          JSON.stringify(labels),
          now,
          ...(cutoff === null ? [] : [cutoff, cutoff]),
          limit,
          offset,
        )
        .map(decode) as unknown as Tables['tickets'][];
    },
    async put<K extends Table>(table: K, value: Tables[K]) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      const keys = columns[table];
      const record = value as unknown as Record<string, unknown>;
      ensure(
        typeof record.id === 'string' && record.id.length > 0,
        'INVALID_REFERENCE',
        'A record ID is required.',
      );
      const conflict =
        table === 'github_evidence' || table === 'outbound_deliveries'
          ? ''
          : ` ON CONFLICT(id) DO UPDATE SET ${keys
              .filter((key) => key !== 'id')
              .map((key) => `${field(table, key)}=excluded.${field(table, key)}`)
              .join(',')}`;
      db.prepare(
        `INSERT INTO "${table}" (${keys.map((key) => field(table, key)).join(',')}) VALUES (${keys.map(() => '?').join(',')})${conflict}`,
      ).run(...keys.map((key) => encode(key, record[key])));
    },
    async remove(table, id) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      ensure(table !== 'github_evidence', 'IMMUTABLE_EVIDENCE', 'GitHub evidence records are immutable.');
      ensure(
        table !== 'outbound_deliveries',
        'IMMUTABLE_DELIVERY',
        'Outbound delivery records are immutable.',
      );
      db.prepare(`DELETE FROM "${table}" WHERE id=?`).run(id);
    },
  };
}

type Shared = { path: string; key: string; writer: DatabaseSync; tail: Promise<void>; users: number };
const sharedFiles = new Map<string, Shared>();
const activeWriter = new AsyncLocalStorage<{ shared: Shared; active: boolean }>();
function acquire(filename: string): Shared {
  ensure(
    filename.trim().length > 0 && filename !== ':memory:',
    'INVALID_CONFIG',
    'SQLite requires a nonempty persistent file path for isolated readers.',
  );
  const absolute = resolve(filename);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const path = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const existing = sharedFiles.get(key);
  if (existing) return existing;
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;');
  } catch (error) {
    writer.close();
    throw error;
  }
  const shared = { path, key, writer, tail: Promise.resolve(), users: 0 };
  sharedFiles.set(key, shared);
  return shared;
}
function write<T>(shared: Shared, work: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const current = activeWriter.getStore();
  ensure(
    current?.shared !== shared || !current.active,
    'NESTED_TRANSACTION',
    'Use the supplied transaction for writes; index documents after the transaction commits.',
  );
  const context = { shared, active: true };
  const task = shared.tail
    .then(() =>
      activeWriter.run(context, async () => {
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            shared.writer.exec('BEGIN IMMEDIATE');
            break;
          } catch (error) {
            if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
            await delay(10);
          }
        }
        try {
          const result = await work(shared.writer);
          shared.writer.exec('COMMIT');
          return result;
        } catch (error) {
          shared.writer.exec('ROLLBACK');
          return translate(error);
        }
      }),
    )
    .finally(() => {
      context.active = false;
    });
  shared.tail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
class Handle {
  readonly db: DatabaseSync;
  private closed = false;
  private closing?: Promise<void>;
  readonly snapshots = new Set<Promise<unknown>>();
  constructor(readonly shared: Shared) {
    shared.users++;
    this.db = new DatabaseSync(shared.path, { readOnly: true });
  }
  open() {
    ensure(!this.closed, 'STORAGE_CLOSED', 'SQLite adapter is closed.');
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.snapshots]);
      await this.shared.tail;
      this.db.close();
      if (--this.shared.users === 0) {
        this.shared.writer.close();
        sharedFiles.delete(this.shared.key);
      }
    })());
  }
}
class SqliteStorage extends Handle implements StorageAdapter {
  readonly schedulingPolicies = Object.freeze(['priority_age', 'unblocking'] as const);
  get<K extends Table>(table: K, id: string) {
    this.open();
    return repository(this.db).get(table, id);
  }
  find<K extends Table>(table: K, query?: Query<Tables[K]>) {
    this.open();
    return repository(this.db).find(table, query);
  }
  unansweredQuestions(projectId: string, ticketId: string, blocking: boolean, limit: number, offset: number) {
    this.open();
    return repository(this.db).unansweredQuestions(projectId, ticketId, blocking, limit, offset);
  }
  workCandidates(
    projectId: string,
    actorId: string,
    capabilities: string[],
    labels: string[],
    now: string,
    limit: number,
    offset: number,
    policy: SchedulingPolicy = 'priority_age',
  ) {
    this.open();
    return repository(this.db).workCandidates(
      projectId,
      actorId,
      capabilities,
      labels,
      now,
      limit,
      offset,
      policy,
    );
  }
  transaction<T>(_scope: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.open();
    return write(this.shared, (db) => work(repository(db)));
  }
  readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T> {
    this.open();
    const reading = (async () => {
      const db = new DatabaseSync(this.shared.path, { readOnly: true });
      try {
        db.exec('BEGIN');
        db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
        const { get, find, unansweredQuestions, workCandidates } = repository(db);
        const result = await work({ get, find, unansweredQuestions, workCandidates });
        db.exec('COMMIT');
        return result;
      } finally {
        db.close();
      }
    })();
    this.snapshots.add(reading);
    void reading.then(
      () => this.snapshots.delete(reading),
      () => this.snapshots.delete(reading),
    );
    return reading;
  }
  async migrate() {
    this.open();
    await write(this.shared, async (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
      const directory = fileURLToPath(new URL('../../migrations/sqlite/', import.meta.url));
      for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) continue;
        db.exec(await readFile(join(directory, name), 'utf8'));
        db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(name, new Date().toISOString());
      }
    });
  }
  async leaseJobs(limit: number, leaseMs: number): Promise<Job[]> {
    this.open();
    page(limit, 0);
    ensure(
      Number.isSafeInteger(leaseMs) && leaseMs > 0,
      'INVALID_QUERY',
      'Job lease duration must be positive.',
    );
    return write(this.shared, async (db) => {
      const now = new Date().toISOString();
      const until = new Date(Date.now() + leaseMs).toISOString();
      const token = randomUUID();
      const jobs = db
        .prepare(
          'SELECT * FROM jobs WHERE available_at<=? AND (locked_until IS NULL OR locked_until<?) ORDER BY available_at,id LIMIT ?',
        )
        .all(now, now, limit)
        .map(decode) as unknown as Job[];
      const update = db.prepare('UPDATE jobs SET locked_until=?,lock_token=? WHERE id=?');
      for (const job of jobs) {
        update.run(until, token, job.id);
        job.locked_until = until;
        job.lock_token = token;
      }
      return jobs;
    });
  }
  async finishJob(job: Job, error?: string) {
    this.open();
    await write(this.shared, async (db) => {
      if (error === undefined)
        db.prepare('DELETE FROM jobs WHERE id=? AND lock_token=? AND revision=?').run(
          job.id,
          job.lock_token,
          job.revision,
        );
      else
        db.prepare(
          'UPDATE jobs SET attempts=attempts+1,available_at=?,locked_until=NULL,lock_token=NULL,last_error=? WHERE id=? AND lock_token=? AND revision=?',
        ).run(
          new Date(Date.now() + Math.min(3600, 2 ** Math.min(job.attempts + 1, 12)) * 1000).toISOString(),
          error.slice(0, 500),
          job.id,
          job.lock_token,
          job.revision,
        );
    });
  }
  async leaseDeliveries(
    targetFingerprint: string,
    limit: number,
    leaseMs: number,
  ): Promise<OutboundDelivery[]> {
    this.open();
    ensure(
      Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100 &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 1 &&
        leaseMs <= 3_600_000,
      'INVALID_INPUT',
      'Delivery leases require a limit of 1–100 and duration of 1–3600000 milliseconds.',
    );
    return write(this.shared, async (db) => {
      const now = new Date().toISOString();
      const until = new Date(Date.now() + leaseMs).toISOString();
      const deliveries = db
        .prepare(
          'SELECT * FROM outbound_deliveries WHERE target_fingerprint=? AND sent_at IS NULL AND next_attempt_at<=? AND (locked_until IS NULL OR locked_until<=?) ORDER BY next_attempt_at,id LIMIT ?',
        )
        .all(targetFingerprint, now, now, limit)
        .map(decode) as unknown as OutboundDelivery[];
      const update = db.prepare(
        'UPDATE outbound_deliveries SET locked_until=?,lock_token=?,attempt_count=MIN(attempt_count+1,2147483647) WHERE id=?',
      );
      for (const delivery of deliveries) {
        delivery.locked_until = until;
        delivery.lock_token = randomUUID();
        update.run(until, delivery.lock_token, delivery.id);
        delivery.attempt_count = Math.min(delivery.attempt_count + 1, 2147483647);
      }
      return deliveries;
    });
  }
  async finishDelivery(
    delivery: OutboundDelivery,
    outcome: { sent_at: string } | { next_attempt_at: string; error_code: string },
  ) {
    this.open();
    if (!delivery.lock_token) return;
    if ('error_code' in outcome)
      ensure(
        /^[A-Z][A-Z0-9_]{0,79}$/.test(outcome.error_code),
        'INVALID_QUERY',
        'Delivery failures require a code without response content.',
      );
    await write(this.shared, async (db) => {
      if ('sent_at' in outcome)
        db.prepare(
          'UPDATE outbound_deliveries SET sent_at=?,locked_until=NULL,lock_token=NULL,last_error=NULL WHERE id=? AND lock_token=? AND sent_at IS NULL',
        ).run(outcome.sent_at, delivery.id, delivery.lock_token);
      else
        db.prepare(
          'UPDATE outbound_deliveries SET next_attempt_at=?,last_error=?,locked_until=NULL,lock_token=NULL WHERE id=? AND lock_token=? AND sent_at IS NULL',
        ).run(outcome.next_attempt_at, outcome.error_code, delivery.id, delivery.lock_token);
    });
  }
  async deliveryMetrics() {
    this.open();
    const row = this.db
      .prepare(
        'SELECT count(*) FILTER(WHERE sent_at IS NULL) webhook_pending,count(*) FILTER(WHERE sent_at IS NULL AND last_error IS NOT NULL) webhook_failed,total(attempt_count) webhook_attempts FROM outbound_deliveries',
      )
      .get()!;
    return {
      webhook_pending: Number(row.webhook_pending),
      webhook_failed: Number(row.webhook_failed),
      webhook_attempts: Math.min(Number.MAX_SAFE_INTEGER, Number(row.webhook_attempts)),
    };
  }
  async metrics() {
    this.open();
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM claims WHERE expires_at>?) active_claims,(SELECT count(*) FROM claims WHERE expires_at<=?) expired_claims,(SELECT count(*) FROM tickets WHERE status='in_review') review_backlog,(SELECT count(*) FROM jobs) indexing_pending,(SELECT coalesce(max(0,(julianday(?) - julianday(min(available_at)))*86400),0) FROM jobs) indexing_lag_seconds`,
      )
      .get(now, now, now)!;
    return row as unknown as Awaited<ReturnType<StorageAdapter['metrics']>>;
  }
  async health() {
    this.open();
    this.db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get();
  }
}
class SqliteSearch extends Handle implements SearchAdapter {
  readonly capabilities = Object.freeze({ semantic: false });
  async configure(_profile: EmbeddingProfile) {
    this.open();
  }
  async indexText(document: SearchDocument) {
    this.open();
    ensure(
      typeof document.id === 'string' && document.id.length > 0,
      'INVALID_REFERENCE',
      'A document ID is required.',
    );
    await write(this.shared, async (db) => {
      db.prepare(
        'INSERT INTO search_documents(id,project_id,kind,revision,title,text,archived) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,title=excluded.title,text=excluded.text,archived=excluded.archived WHERE search_documents.revision<=excluded.revision',
      ).run(
        document.id,
        document.project_id,
        document.kind,
        document.revision,
        document.title,
        document.text,
        Number(document.archived),
      );
    });
  }
  async indexVector(
    _document: SearchDocument,
    _profile: EmbeddingProfile,
    _vector: number[],
    _inputHash?: string,
  ): Promise<void> {
    throw new DomainError('UNSUPPORTED_SEARCH', 'SQLite provides full-text search only.');
  }
  async search(projectId: string, query: string, limit: number): Promise<SearchHit[]> {
    this.open();
    page(limit, 0);
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const match = words.map((word) => `"${word}"`).join(' AND ');
    return this.db
      .prepare(
        'SELECT d.id,d.kind,d.revision,-bm25(search_fts,2.0,1.0) score FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid WHERE search_fts MATCH ? AND d.project_id=? AND d.archived=0 ORDER BY bm25(search_fts,2.0,1.0),d.id LIMIT ?',
      )
      .all(match, projectId, limit) as unknown as SearchHit[];
  }
  async coverage(projectId: string, _profile?: EmbeddingProfile) {
    this.open();
    const row = this.db
      .prepare('SELECT count(*) documents FROM search_documents WHERE project_id=? AND archived=0')
      .get(projectId)!;
    return { documents: Number(row.documents), embedded: 0, observed_at: new Date().toISOString() };
  }
  async health() {
    this.open();
    this.db.prepare('SELECT 1 FROM search_documents LIMIT 1').get();
  }
}

export function createSqliteAdapters(filename = '.local/ticketing.sqlite'): {
  storage: StorageAdapter;
  search: SearchAdapter;
} {
  const shared = acquire(filename);
  return { storage: new SqliteStorage(shared), search: new SqliteSearch(shared) };
}
