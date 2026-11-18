import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DomainError,
  ensure,
  type StorageAdapter,
  type Reader,
  type Transaction,
  type Table,
  type Tables,
  type Query,
  type Job,
  type OutboundDelivery,
  type DeliveryOutcome,
  type SearchAdapter,
  type SearchDocument,
  type SearchHit,
  type EmbeddingProfile,
  type Note,
  type SchedulingPolicy,
} from '../contracts.js';

const columns: Record<Table, string[]> = {
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
  actors: ['id', 'issuer', 'subject', 'name', 'kind', 'system_admin'],
  projects: [
    'id',
    'key',
    'name',
    'instructions',
    'policy',
    'execution_hints',
    'revision',
    'ticket_seq',
    'event_seq',
    'created_at',
    'scheduling_policy',
  ],
  members: ['id', 'project_id', 'actor_id', 'role'],
  tickets: [
    'id',
    'project_id',
    'key',
    'title',
    'description',
    'execution_hints',
    'github_pull_request',
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
};
const jsonColumns = new Set([
  'metadata',
  'evidence',
  'data',
  'result',
  'requirements_snapshot',
  'execution_hints',
  'github_pull_request',
  'checks',
]);
type Executor = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
function decode(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(
        ([key, value]) =>
          !['execution_hints', 'github_pull_request', 'scheduling_policy'].includes(key) || value !== null,
      )
      .map(([key, value]) => [
        key,
        value instanceof Date
          ? value.toISOString()
          : key === 'seq' || key === 'event_seq'
            ? Number(value)
            : value,
      ]),
  );
}
function translate(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '23505') throw new DomainError('CONFLICT', 'A record with this identifier already exists.');
  if (code === '23503' || code === '23514')
    throw new DomainError('INVALID_REFERENCE', 'A reference or database invariant is invalid.');
  throw error;
}
function repository(db: Executor): Transaction {
  const field = (table: Table, key: string) => {
    ensure(columns[table]?.includes(key), 'INVALID_QUERY', 'Unknown storage field.');
    return `"${key}"`;
  };
  return {
    async unansweredQuestions(projectId, ticketId, blocking, limit, offset) {
      ensure(
        Number.isInteger(limit) && limit >= 1 && limit <= 10001 && Number.isInteger(offset) && offset >= 0,
        'INVALID_QUERY',
        'Question page limit must be 1–10001 and offset must be nonnegative.',
      );
      const result = await db.query(
        `SELECT q.* FROM notes q WHERE q.project_id=$1 AND q.ticket_id=$2 AND q.kind='question' AND q.blocking=$3 AND NOT EXISTS(SELECT 1 FROM notes a WHERE a.project_id=q.project_id AND a.ticket_id=q.ticket_id AND a.answer_to=q.id AND a.kind='answer') ORDER BY q.created_at,q.id LIMIT $4 OFFSET $5`,
        [projectId, ticketId, blocking, limit, offset],
      );
      return result.rows.map(decode) as unknown as Note[];
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
      ensure(
        Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 10001 &&
          Number.isSafeInteger(offset) &&
          offset >= 0,
        'INVALID_QUERY',
        'Work page limit must be 1–10001 and offset must be nonnegative.',
      );
      ensure(['priority_age', 'unblocking'].includes(policy), 'INVALID_QUERY', 'Unknown scheduling policy.');
      const order =
        policy === 'unblocking'
          ? `t.priority,CASE WHEN t.created_at<=($5::timestamptz-interval '24 hours') THEN 0 ELSE 1 END,CASE WHEN t.created_at<=($5::timestamptz-interval '24 hours') THEN 0 ELSE (SELECT count(*) FROM links outgoing JOIN tickets dependent ON dependent.id=outgoing.target_id AND dependent.project_id=t.project_id WHERE outgoing.project_id=t.project_id AND outgoing.source_id=t.id AND outgoing.kind='blocks' AND dependent.status NOT IN ('done','cancelled')) END DESC,t.created_at,t.id`
          : 't.priority,t.created_at,t.id';
      const result = await db.query(
        `SELECT t.* FROM tickets t WHERE t.project_id=$1 AND t.status IN ('ready','in_progress') AND (t.assignee_id IS NULL OR t.assignee_id=$2) AND t.capabilities <@ $3::text[] AND t.labels @> $4::text[] AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.expires_at>$5) AND NOT EXISTS(SELECT 1 FROM links l JOIN tickets prerequisite ON prerequisite.id=l.source_id WHERE l.target_id=t.id AND l.kind='blocks' AND prerequisite.status<>'done') AND NOT EXISTS(SELECT 1 FROM notes q WHERE q.ticket_id=t.id AND q.kind='question' AND q.blocking AND NOT EXISTS(SELECT 1 FROM notes a WHERE a.answer_to=q.id AND a.kind='answer')) ORDER BY ${order} LIMIT $6 OFFSET $7`,
        [projectId, actorId, capabilities, labels, now, limit, offset],
      );
      return result.rows.map(decode) as unknown as Tables['tickets'][];
    },
    async get<K extends Table>(table: K, id: string) {
      const rows = await this.find(table, { where: { id } as Query<Tables[K]>['where'], limit: 1 });
      return rows[0] ?? null;
    },
    async find<K extends Table>(table: K, query: Query<Tables[K]> = {}) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      const values: unknown[] = [];
      const conditions = Object.entries(query.where ?? {}).map(([key, value]) => {
        const name = field(table, key);
        if (value === null) return `${name} IS NULL`;
        if (typeof value === 'object' && value && !Array.isArray(value)) {
          if ('in' in value) {
            values.push(value.in);
            return `${name} = ANY($${values.length})`;
          }
          if ('gt' in value) {
            values.push(value.gt);
            return `${name} > $${values.length}`;
          }
        }
        values.push(value);
        return `${name} = $${values.length}`;
      });
      const order = query.order
        ?.map((item) => `${field(table, String(item.field))} ${item.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(',');
      const limit = query.limit ?? 1000;
      ensure(
        Number.isInteger(limit) && limit >= 1 && limit <= 10001,
        'INVALID_QUERY',
        'Storage page limit must be 1–10001.',
      );
      ensure(
        Number.isInteger(query.offset ?? 0) && (query.offset ?? 0) >= 0,
        'INVALID_QUERY',
        'Invalid offset.',
      );
      values.push(limit, query.offset ?? 0);
      const result = await db.query(
        `SELECT * FROM "${table}"${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}${order ? ` ORDER BY ${order}` : ''} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return result.rows.map(decode) as unknown as Tables[K][];
    },
    async put<K extends Table>(table: K, value: Tables[K]) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      const keys = columns[table]!;
      const record = value as unknown as Record<string, unknown>;
      const values = keys.map((key) => (jsonColumns.has(key) ? JSON.stringify(record[key]) : record[key]));
      const names = keys.map((key) => field(table, key));
      const conflict =
        table === 'github_evidence' || table === 'outbound_deliveries'
          ? ''
          : ` ON CONFLICT(id) DO UPDATE SET ${names
              .filter((name) => name !== '"id"')
              .map((name) => `${name}=EXCLUDED.${name}`)
              .join(',')}`;
      await db.query(
        `INSERT INTO "${table}" (${names.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})${conflict}`,
        values,
      );
    },
    async remove(table, id) {
      ensure(Object.hasOwn(columns, table), 'INVALID_QUERY', 'Unknown storage table.');
      ensure(table !== 'github_evidence', 'IMMUTABLE_EVIDENCE', 'GitHub evidence snapshots are immutable.');
      ensure(table !== 'outbound_deliveries', 'IMMUTABLE_DELIVERY', 'Outbound deliveries are immutable.');
      await db.query(`DELETE FROM "${table}" WHERE id=$1`, [id]);
    },
  };
}

export class PostgresStorage implements StorageAdapter {
  readonly schedulingPolicies = Object.freeze(['priority_age', 'unblocking'] as const);
  readonly pool: pg.Pool;
  private reader: Transaction;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 20,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    this.reader = repository(this.pool);
  }
  get<K extends Table>(table: K, id: string) {
    return this.reader.get(table, id);
  }
  find<K extends Table>(table: K, query?: Query<Tables[K]>) {
    return this.reader.find(table, query);
  }
  unansweredQuestions(projectId: string, ticketId: string, blocking: boolean, limit: number, offset: number) {
    return this.reader.unansweredQuestions(projectId, ticketId, blocking, limit, offset);
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
    return this.reader.workCandidates(projectId, actorId, capabilities, labels, now, limit, offset, policy);
  }
  async transaction<T>(scope: string, work: (tx: Transaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A project lock orders writes and event cursors by commit, including graph mutations.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
      const result = await work(repository(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      return translate(error);
    } finally {
      client.release();
    }
  }
  async readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { get, find, unansweredQuestions, workCandidates } = repository(client);
      const result = await work({ get, find, unansweredQuestions, workCandidates });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      return translate(error);
    } finally {
      client.release();
    }
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(71402911)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
      for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
        if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
        await client.query('BEGIN');
        try {
          await client.query(await readFile(`${directory}/${name}`, 'utf8'));
          await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(71402911)');
      client.release();
    }
  }
  async leaseJobs(limit: number, leaseMs: number): Promise<Job[]> {
    const result = await this.pool.query(
      `UPDATE jobs SET locked_until=now()+($2 * interval '1 millisecond'), lock_token=$3 WHERE id IN (SELECT id FROM jobs WHERE available_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING *`,
      [limit, leaseMs, randomUUID()],
    );
    return result.rows.map(decode) as unknown as Job[];
  }
  async finishJob(job: Job, error?: string) {
    if (!error) {
      await this.pool.query('DELETE FROM jobs WHERE id=$1 AND lock_token=$2 AND revision=$3', [
        job.id,
        job.lock_token,
        job.revision,
      ]);
      return;
    }
    await this.pool.query(
      `UPDATE jobs SET attempts=attempts+1, available_at=now()+($4 * interval '1 second'), locked_until=NULL,lock_token=NULL,last_error=$5 WHERE id=$1 AND lock_token=$2 AND revision=$3`,
      [
        job.id,
        job.lock_token,
        job.revision,
        Math.min(3600, 2 ** Math.min(job.attempts + 1, 12)),
        error.slice(0, 500),
      ],
    );
  }
  async health() {
    await this.pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  }
  async leaseDeliveries(
    targetFingerprint: string,
    limit: number,
    leaseMs: number,
  ): Promise<OutboundDelivery[]> {
    ensure(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_INPUT',
      'Delivery batch must be 1–100.',
    );
    ensure(
      Number.isInteger(leaseMs) && leaseMs >= 1 && leaseMs <= 3600000,
      'INVALID_INPUT',
      'Invalid delivery lease.',
    );
    const result = await this.pool.query(
      `UPDATE outbound_deliveries SET locked_until=now()+($3 * interval '1 millisecond'), lock_token=gen_random_uuid(), attempt_count=least(attempt_count::bigint+1,2147483647)::integer WHERE id IN (SELECT id FROM outbound_deliveries WHERE target_fingerprint=$1 AND sent_at IS NULL AND next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<=now()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $2) RETURNING *`,
      [targetFingerprint, limit, leaseMs],
    );
    return result.rows.map(decode) as unknown as OutboundDelivery[];
  }
  async finishDelivery(delivery: OutboundDelivery, outcome: DeliveryOutcome): Promise<void> {
    if (!delivery.lock_token) return;
    if ('sent_at' in outcome) {
      await this.pool.query(
        'UPDATE outbound_deliveries SET sent_at=$3,locked_until=NULL,lock_token=NULL,last_error=NULL WHERE id=$1 AND lock_token=$2 AND sent_at IS NULL',
        [delivery.id, delivery.lock_token, outcome.sent_at],
      );
    } else {
      ensure(
        /^[A-Z][A-Z0-9_]{0,79}$/.test(outcome.error_code),
        'INVALID_INPUT',
        'Delivery errors must be safe codes.',
      );
      await this.pool.query(
        'UPDATE outbound_deliveries SET next_attempt_at=$3,last_error=$4,locked_until=NULL,lock_token=NULL WHERE id=$1 AND lock_token=$2 AND sent_at IS NULL',
        [delivery.id, delivery.lock_token, outcome.next_attempt_at, outcome.error_code],
      );
    }
  }
  async deliveryMetrics() {
    const result = await this.pool.query(
      `SELECT count(*) FILTER(WHERE sent_at IS NULL)::float webhook_pending,count(*) FILTER(WHERE sent_at IS NULL AND last_error IS NOT NULL)::float webhook_failed,least(coalesce(sum(attempt_count),0),9007199254740991)::float webhook_attempts FROM outbound_deliveries`,
    );
    return result.rows[0] as { webhook_pending: number; webhook_failed: number; webhook_attempts: number };
  }
  async metrics() {
    const result = await this.pool.query(
      `SELECT (SELECT count(*)::integer FROM claims WHERE expires_at>now()) active_claims,(SELECT count(*)::integer FROM claims WHERE expires_at<=now()) expired_claims,(SELECT count(*)::integer FROM tickets WHERE status='in_review') review_backlog,(SELECT count(*)::integer FROM jobs) indexing_pending,(SELECT coalesce(greatest(0,extract(epoch FROM now()-min(available_at))),0)::float FROM jobs) indexing_lag_seconds`,
    );
    return result.rows[0];
  }
  async close() {
    await this.pool.end();
  }
}

function vectorLiteral(vector: number[], profile: EmbeddingProfile) {
  ensure(
    vector.length === profile.dimensions && vector.every(Number.isFinite),
    'INVALID_EMBEDDING',
    'Embedding dimensions or values are invalid.',
  );
  ensure(
    vector.some((value) => value !== 0),
    'INVALID_EMBEDDING',
    'An embedding cannot be a zero vector.',
  );
  return `[${vector.join(',')}]`;
}
export class PostgresSearch implements SearchAdapter {
  private coverageCache = new Map<
    string,
    { expires: number; value: Promise<{ documents: number; embedded: number; observed_at: string }> }
  >();
  private invalidateCoverage(projectId: string) {
    for (const key of this.coverageCache.keys())
      if (key.startsWith(`${projectId}:`)) this.coverageCache.delete(key);
  }

  constructor(private pool: pg.Pool) {}
  async configure(profile: EmbeddingProfile) {
    ensure(
      /^[a-f0-9]{16,64}$/.test(profile.id) &&
        Number.isInteger(profile.dimensions) &&
        profile.dimensions >= 1 &&
        profile.dimensions <= 2000,
      'INVALID_PROFILE',
      'Profile ID must be a hex digest; dimensions must be 1–2000.',
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout=0');
      await client.query("SET LOCAL maintenance_work_mem='256MB'");
      await client.query(
        'INSERT INTO search_profiles(id,model,dimensions) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [profile.id, profile.model, profile.dimensions],
      );
      const existing = (await client.query('SELECT * FROM search_profiles WHERE id=$1', [profile.id]))
        .rows[0];
      ensure(
        existing.model === profile.model && existing.dimensions === profile.dimensions,
        'INVALID_PROFILE',
        'An existing embedding profile cannot change.',
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "vectors_${profile.id}" ON search_vectors USING hnsw ((embedding::vector(${profile.dimensions})) vector_cosine_ops) WHERE profile_id='${profile.id}'`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async indexText(document: SearchDocument) {
    await this.pool.query(
      `INSERT INTO search_documents(id,project_id,kind,revision,title,text,archived) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,title=EXCLUDED.title,text=EXCLUDED.text,archived=EXCLUDED.archived WHERE search_documents.revision<=EXCLUDED.revision`,
      [
        document.id,
        document.project_id,
        document.kind,
        document.revision,
        document.title,
        document.text,
        document.archived,
      ],
    );
    this.invalidateCoverage(document.project_id);
  }
  async indexVector(
    document: SearchDocument,
    profile: EmbeddingProfile,
    vector: number[],
    inputHash?: string,
  ) {
    const literal = vectorLiteral(vector, profile);
    await this.pool.query(
      `INSERT INTO search_vectors(document_id,profile_id,revision,embedding,input_hash) SELECT id,$2,$3,$4::vector,$5 FROM search_documents WHERE id=$1 AND revision=$3 AND NOT archived ON CONFLICT(document_id,profile_id) DO UPDATE SET revision=EXCLUDED.revision,embedding=EXCLUDED.embedding,input_hash=EXCLUDED.input_hash WHERE search_vectors.revision<=EXCLUDED.revision`,
      [document.id, profile.id, document.revision, literal, inputHash ?? null],
    );
    this.invalidateCoverage(document.project_id);
  }
  async reuseVector(
    document: SearchDocument,
    profile: EmbeddingProfile,
    inputHash: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE search_vectors v SET revision=$3 FROM search_documents d WHERE d.id=$1 AND d.id=v.document_id AND d.revision=$3 AND NOT d.archived AND v.profile_id=$2 AND v.input_hash=$4 AND v.revision<=$3`,
      [document.id, profile.id, document.revision, inputHash],
    );
    this.invalidateCoverage(document.project_id);
    return result.rowCount === 1;
  }
  async search(
    projectId: string,
    query: string,
    limit: number,
    semantic?: { profile: EmbeddingProfile; vector: number[] },
  ): Promise<SearchHit[]> {
    const textResults = await this.pool.query(
      `SELECT id,kind,revision FROM search_documents WHERE project_id=$1 AND NOT archived AND search @@ websearch_to_tsquery('english',$2) ORDER BY ts_rank_cd(search,websearch_to_tsquery('english',$2)) DESC,id LIMIT $3`,
      [projectId, query, limit * 3],
    );
    let vectorRows: { id: string; kind: SearchDocument['kind']; revision: number }[] = [];
    if (semantic) {
      const p = semantic.profile;
      vectorLiteral(semantic.vector, p);
      ensure(
        /^[a-f0-9]{16,64}$/.test(p.id) &&
          Number.isInteger(p.dimensions) &&
          p.dimensions >= 1 &&
          p.dimensions <= 2000,
        'INVALID_PROFILE',
        'Invalid vector profile.',
      );
      const result = await this.pool.query(
        `SELECT d.id,d.kind,d.revision FROM search_vectors v JOIN search_documents d ON d.id=v.document_id AND d.revision=v.revision WHERE d.project_id=$1 AND NOT d.archived AND v.profile_id='${p.id}' ORDER BY v.embedding::vector(${p.dimensions}) <=> $2::vector(${p.dimensions}),d.id LIMIT $3`,
        [projectId, vectorLiteral(semantic.vector, p), limit * 3],
      );
      vectorRows = result.rows;
    }
    const merged = new Map<string, SearchHit>();
    for (const rows of [textResults.rows, vectorRows])
      rows.forEach((row, i) => {
        const previous = merged.get(row.id);
        merged.set(row.id, {
          id: row.id,
          kind: row.kind,
          revision: row.revision,
          score: (previous?.score ?? 0) + 1 / (60 + i + 1),
        });
      });
    return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }
  async coverage(projectId: string, profile?: EmbeddingProfile) {
    // shortcut: coverage is a five-second snapshot; use durable counters if exact live counts become necessary.
    const key = `${projectId}:${profile?.id ?? 'lexical'}`;
    const cached = this.coverageCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.pool
      .query(
        profile
          ? `SELECT count(*)::integer documents,count(v.document_id)::integer embedded FROM search_documents d LEFT JOIN search_vectors v ON v.document_id=d.id AND v.revision=d.revision AND v.profile_id=$2 WHERE d.project_id=$1 AND NOT d.archived`
          : 'SELECT count(*)::integer documents,0::integer embedded FROM search_documents WHERE project_id=$1 AND NOT archived',
        profile ? [projectId, profile.id] : [projectId],
      )
      .then((result) => ({ ...result.rows[0], observed_at: new Date().toISOString() }))
      .catch((error) => {
        if (this.coverageCache.get(key)?.value === value) this.coverageCache.delete(key);
        throw error;
      });
    this.coverageCache.set(key, { expires: Date.now() + 5000, value });
    if (this.coverageCache.size > 1000) this.coverageCache.delete(this.coverageCache.keys().next().value!);
    return value;
  }
  async health() {
    await this.pool.query('SELECT 1 FROM search_documents LIMIT 1');
  }
  async close() {
    /* The storage adapter owns the shared pool. */
  }
}
