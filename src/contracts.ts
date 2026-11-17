/** Stable, backend-neutral contracts. Adapters must pass the exported contract suite. */
export type Status = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type Role = 'reader' | 'contributor' | 'verifier' | 'admin';
export type Policy = 'self' | 'independent' | 'human';
export interface Actor {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  kind: 'human' | 'agent';
  system_admin: boolean;
}
export interface Project {
  id: string;
  key: string;
  name: string;
  instructions: string;
  policy: Policy;
  revision: number;
  ticket_seq: number;
  event_seq: number;
  created_at: string;
}
export interface Member {
  id: string;
  project_id: string;
  actor_id: string;
  role: Role;
}
export interface Ticket {
  id: string;
  project_id: string;
  key: string;
  title: string;
  description: string;
  status: Status;
  priority: number;
  labels: string[];
  capabilities: string[];
  assignee_id: string | null;
  parent_id: string | null;
  revision: number;
  requirements_revision: number;
  created_by: string;
  approved_submission_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface Criterion {
  id: string;
  project_id: string;
  ticket_id: string;
  text: string;
  position: number;
}
export interface Link {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  kind: 'blocks' | 'related';
}
export interface Note {
  id: string;
  project_id: string;
  ticket_id: string;
  actor_id: string;
  kind: 'comment' | 'checkpoint' | 'question' | 'answer';
  body: string;
  blocking: boolean;
  answer_to: string | null;
  metadata: Record<string, unknown>;
  ticket_revision: number;
  created_at: string;
}
export interface Claim {
  id: string;
  project_id: string;
  ticket_id: string;
  actor_id: string;
  token: string;
  expires_at: string;
}
export interface Evidence {
  criterion_id: string;
  result: 'pass' | 'fail';
  summary: string;
  references: string[];
}
export interface Submission {
  requirements_snapshot: {
    title: string;
    description: string;
    criteria: { criterion_id: string; text: string }[];
  } | null;
  id: string;
  project_id: string;
  ticket_id: string;
  actor_id: string;
  requirements_revision: number;
  ticket_revision: number;
  evidence: Evidence[];
  summary: string;
  created_at: string;
}
export interface Review {
  id: string;
  project_id: string;
  ticket_id: string;
  submission_id: string;
  actor_id: string;
  decision: 'approve' | 'request_changes';
  feedback: string;
  ticket_revision: number;
  created_at: string;
}
export interface Knowledge {
  id: string;
  project_id: string;
  title: string;
  body: string;
  kind: 'policy' | 'decision' | 'runbook' | 'architecture' | 'note';
  revision: number;
  archived: boolean;
  actor_id: string;
  updated_at: string;
}
export interface Event {
  id: string;
  project_id: string;
  seq: number;
  actor_id: string;
  type: string;
  entity_id: string;
  data: Record<string, unknown>;
  created_at: string;
}
export interface Receipt {
  id: string;
  project_id: string | null;
  actor_id: string;
  operation: string;
  input_hash: string;
  result: unknown;
  created_at: string;
}
export interface Job {
  id: string;
  project_id: string;
  entity_id: string;
  kind: 'ticket' | 'knowledge' | 'checkpoint';
  revision: number;
  attempts: number;
  available_at: string;
  locked_until: string | null;
  lock_token: string | null;
  last_error: string | null;
}
export interface Tables {
  actors: Actor;
  projects: Project;
  members: Member;
  tickets: Ticket;
  criteria: Criterion;
  links: Link;
  notes: Note;
  claims: Claim;
  submissions: Submission;
  reviews: Review;
  knowledge: Knowledge;
  events: Event;
  receipts: Receipt;
  jobs: Job;
}
export type Table = keyof Tables;
export type Filter<T> = Partial<{ [K in keyof T]: T[K] | { in: T[K][] } | { gt: T[K] } }>;
export interface Query<T> {
  where?: Filter<T>;
  order?: { field: keyof T; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}
export interface Reader {
  unansweredQuestions(
    projectId: string,
    ticketId: string,
    blocking: boolean,
    limit: number,
    offset: number,
  ): Promise<Note[]>;
  /** Ordered candidates; shared domain logic rechecks eligibility inside the transaction. */
  workCandidates(
    projectId: string,
    actorId: string,
    capabilities: string[],
    labels: string[],
    now: string,
    limit: number,
    offset: number,
  ): Promise<Ticket[]>;
  get<K extends Table>(table: K, id: string): Promise<Tables[K] | null>;
  find<K extends Table>(table: K, query?: Query<Tables[K]>): Promise<Tables[K][]>;
}
export interface Transaction extends Reader {
  put<K extends Table>(table: K, value: Tables[K]): Promise<void>;
  remove<K extends Table>(table: K, id: string): Promise<void>;
}
export interface StorageAdapter extends Reader {
  /** One consistent read-only view, independent of project mutation locks. */
  readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T>;
  /** Serializes mutations in a scope, commits atomically, and rolls back on failure. */
  transaction<T>(scope: string, work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Atomically leases durable jobs, including abandoned jobs whose lease expired. */
  leaseJobs(limit: number, leaseMs: number): Promise<Job[]>;
  finishJob(job: Job, error?: string): Promise<void>;
  metrics(): Promise<{
    active_claims: number;
    expired_claims: number;
    review_backlog: number;
    indexing_pending: number;
    indexing_lag_seconds: number;
  }>;
  migrate(): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export interface SearchDocument {
  ticket_id?: string;
  id: string;
  project_id: string;
  kind: 'ticket' | 'knowledge' | 'checkpoint';
  revision: number;
  title: string;
  text: string;
  archived: boolean;
}
export interface SearchHit {
  id: string;
  kind: SearchDocument['kind'];
  revision: number;
  score: number;
}
export interface EmbeddingProfile {
  id: string;
  model: string;
  dimensions: number;
}
export interface SearchAdapter {
  configure(profile: EmbeddingProfile): Promise<void>;
  indexText(document: SearchDocument): Promise<void>;
  indexVector(
    document: SearchDocument,
    profile: EmbeddingProfile,
    vector: number[],
    inputHash?: string,
  ): Promise<void>;
  reuseVector?(document: SearchDocument, profile: EmbeddingProfile, inputHash: string): Promise<boolean>;
  search(
    projectId: string,
    query: string,
    limit: number,
    semantic?: { profile: EmbeddingProfile; vector: number[] },
  ): Promise<SearchHit[]>;
  coverage(
    projectId: string,
    profile: EmbeddingProfile,
  ): Promise<{ documents: number; embedded: number; observed_at: string }>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  embed(text: string, purpose: 'query' | 'document'): Promise<number[]>;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
