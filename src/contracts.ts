/** Stable, backend-neutral contracts. Adapters must pass the exported contract suite. */
export type Status = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type Role = 'reader' | 'contributor' | 'verifier' | 'admin';
export type Policy = 'self' | 'independent' | 'human';
export type SchedulingPolicy = 'priority_age' | 'unblocking';
export interface Actor {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  kind: 'human' | 'agent';
  system_admin: boolean;
}
export interface ExecutionHints {
  model?: string;
  effort?: string;
}
export interface Project {
  id: string;
  key: string;
  name: string;
  instructions: string;
  policy: Policy;
  scheduling_policy?: SchedulingPolicy;
  execution_hints?: ExecutionHints | null;
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
  execution_hints?: ExecutionHints | null;
  github_pull_request?: { repository: string; number: number } | null;
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
export type GitHubCIStatus = 'passed' | 'pending' | 'failed' | 'missing' | 'stale';
export interface GitHubCheck {
  name: string;
  required_app_id: number;
  run_id: number | null;
  app_id: number | null;
  head_sha: string | null;
  status: string;
  conclusion: string | null;
  url: string | null;
}
export interface GitHubObservation {
  head_sha: string;
  observed_head_sha: string;
  status: GitHubCIStatus;
  checks: GitHubCheck[];
}
export interface GitHubConfiguration {
  repository: string;
  required_checks: readonly string[];
  check_app_id: number;
}
export interface GitHubProvider {
  inspect(configuration: GitHubConfiguration, pullRequest: number): Promise<GitHubObservation>;
}
export interface GitHubEvidence extends GitHubObservation {
  id: string;
  project_id: string;
  ticket_id: string;
  actor_id: string;
  repository: string;
  pull_request_number: number;
  requirements_revision: number;
  ticket_revision: number;
  observed_at: string;
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
export interface OutboundDelivery {
  id: string;
  event_id: string;
  project_id: string;
  /** Exact JSON text, reused unchanged across delivery attempts. */
  body: string;
  target_fingerprint: string;
  attempt_count: number;
  next_attempt_at: string;
  locked_until: string | null;
  lock_token: string | null;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
}
export type DeliveryOutcome = { sent_at: string } | { next_attempt_at: string; error_code: string };
export interface DeliveryMetrics {
  webhook_pending: number;
  webhook_failed: number;
  webhook_attempts: number;
}
export interface WebhookTarget {
  readonly fingerprint: string;
  send(delivery: OutboundDelivery): Promise<{ error_code: string } | undefined>;
}
export interface Tables {
  outbound_deliveries: OutboundDelivery;
  github_evidence: GitHubEvidence;
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
    policy?: SchedulingPolicy,
  ): Promise<Ticket[]>;
  get<K extends Table>(table: K, id: string): Promise<Tables[K] | null>;
  find<K extends Table>(table: K, query?: Query<Tables[K]>): Promise<Tables[K][]>;
}
export interface Transaction extends Reader {
  put<K extends Table>(table: K, value: Tables[K]): Promise<void>;
  remove<K extends Table>(table: K, id: string): Promise<void>;
}
export interface StorageAdapter extends Reader {
  /** Absent capabilities support only the legacy priority_age ordering. */
  readonly schedulingPolicies?: readonly SchedulingPolicy[];
  /** One consistent read-only view, independent of project mutation locks. */
  readSnapshot<T>(work: (reader: Reader) => Promise<T>): Promise<T>;
  /** Serializes mutations in a scope, commits atomically, and rolls back on failure. */
  transaction<T>(scope: string, work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Atomically leases durable jobs, including abandoned jobs whose lease expired. */
  leaseJobs(limit: number, leaseMs: number): Promise<Job[]>;
  /** Records success, or schedules a bounded retry; repeatedly failing jobs may stop being leased. */
  finishJob(job: Job, error?: string): Promise<void>;
  /** Optional: deletes idempotency receipts created before the timestamp and returns the count. */
  pruneReceipts?(before: string): Promise<number>;
  /** Atomically leases 1–100 due rows for this target; lease is 1–3,600,000 ms. */
  leaseDeliveries?(targetFingerprint: string, limit: number, leaseMs: number): Promise<OutboundDelivery[]>;
  finishDelivery?(delivery: OutboundDelivery, outcome: DeliveryOutcome): Promise<void>;
  deliveryMetrics?(): Promise<DeliveryMetrics>;
  metrics(): Promise<{
    active_claims: number;
    expired_claims: number;
    review_backlog: number;
    indexing_pending: number;
    indexing_lag_seconds: number;
    indexing_failed?: number;
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
  readonly capabilities?: { semantic: boolean };
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
    profile?: EmbeddingProfile,
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
export function validateGitHubConfiguration(configuration: GitHubConfiguration): void {
  ensure(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(configuration.repository) &&
      !['.', '..'].includes(configuration.repository.split('/')[1]!),
    'INVALID_CONFIG',
    'Configure a trusted owner/repository.',
  );
  ensure(
    Array.isArray(configuration.required_checks) &&
      configuration.required_checks.length >= 1 &&
      configuration.required_checks.length <= 20 &&
      configuration.required_checks.every(
        (name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 200,
      ) &&
      new Set(configuration.required_checks).size === configuration.required_checks.length,
    'INVALID_CONFIG',
    'Configure 1–20 distinct required GitHub check names.',
  );
  ensure(
    Number.isSafeInteger(configuration.check_app_id) && configuration.check_app_id > 0,
    'INVALID_CONFIG',
    'Configure the trusted GitHub check app ID.',
  );
}
