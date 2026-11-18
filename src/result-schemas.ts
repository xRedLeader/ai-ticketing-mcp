import { z } from 'zod';
import type { Operation } from './schemas.js';
const id = z.string(),
  timestamp = z.string(),
  json = z.json();
const executionHints = z
  .object({ model: z.string().min(1).max(128).optional(), effort: z.string().min(1).max(32).optional() })
  .strict();
const githubBinding = z.object({ repository: z.string(), number: z.number().int().positive() });
export const githubEvidenceSchema = z.object({
  id,
  project_id: id,
  ticket_id: id,
  actor_id: id,
  repository: z.string(),
  pull_request_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  observed_head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(['passed', 'pending', 'failed', 'missing', 'stale']),
  requirements_revision: z.number().int().positive(),
  ticket_revision: z.number().int().positive(),
  checks: z.array(
    z.object({
      name: z.string(),
      required_app_id: z.number().int().positive(),
      run_id: z.number().int().positive().nullable(),
      app_id: z.number().int().positive().nullable(),
      head_sha: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
      status: z.string(),
      conclusion: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
  observed_at: timestamp,
  stale: z.boolean(),
});
const project = z.object({
  id,
  key: z.string(),
  name: z.string(),
  instructions: z.string(),
  policy: z.enum(['self', 'independent', 'human']),
  scheduling_policy: z.enum(['priority_age', 'unblocking']).optional(),
  execution_hints: executionHints.optional(),
  revision: z.number(),
  ticket_seq: z.number(),
  event_seq: z.number(),
  created_at: timestamp,
});
const ticket = z.object({
  id,
  project_id: id,
  key: z.string(),
  title: z.string(),
  description: z.string(),
  execution_hints: executionHints.optional(),
  github_pull_request: githubBinding.optional(),
  status: z.enum(['backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled']),
  priority: z.number(),
  labels: z.array(z.string()),
  capabilities: z.array(z.string()),
  assignee_id: id.nullable(),
  parent_id: id.nullable(),
  revision: z.number(),
  requirements_revision: z.number(),
  created_by: id,
  approved_submission_id: id.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
const criterion = z.object({ id, project_id: id, ticket_id: id, text: z.string(), position: z.number() });
const link = z.object({
  id,
  project_id: id,
  source_id: id,
  target_id: id,
  kind: z.enum(['blocks', 'related']),
});
const note = z.object({
  id,
  project_id: id,
  ticket_id: id,
  actor_id: id,
  kind: z.enum(['comment', 'checkpoint', 'question', 'answer']),
  body: z.string(),
  blocking: z.boolean(),
  answer_to: id.nullable(),
  metadata: z.record(z.string(), json),
  ticket_revision: z.number(),
  created_at: timestamp,
});
const claim = z.object({ id, project_id: id, ticket_id: id, actor_id: id, token: id, expires_at: timestamp });
const evidence = z.object({
  criterion_id: id,
  result: z.enum(['pass', 'fail']),
  summary: z.string(),
  references: z.array(z.string()),
});
const submission = z.object({
  requirements_snapshot: z
    .object({
      title: z.string(),
      description: z.string(),
      criteria: z.array(z.object({ criterion_id: z.string(), text: z.string() })),
    })
    .nullable(),
  id,
  project_id: id,
  ticket_id: id,
  actor_id: id,
  requirements_revision: z.number(),
  ticket_revision: z.number(),
  evidence: z.array(evidence),
  summary: z.string(),
  created_at: timestamp,
});
const review = z.object({
  id,
  project_id: id,
  ticket_id: id,
  submission_id: id,
  actor_id: id,
  decision: z.enum(['approve', 'request_changes']),
  feedback: z.string(),
  ticket_revision: z.number(),
  created_at: timestamp,
});
const knowledge = z.object({
  id,
  project_id: id,
  title: z.string(),
  body: z.string(),
  kind: z.enum(['policy', 'decision', 'runbook', 'architecture', 'note']),
  revision: z.number(),
  archived: z.boolean(),
  actor_id: id,
  updated_at: timestamp,
});
const member = z.object({
  id,
  project_id: id,
  actor_id: id,
  role: z.enum(['reader', 'contributor', 'verifier', 'admin']),
});
const blocker = z.object({ code: z.string(), reference: id, message: z.string() });
const visibleClaim = z
  .object({ actor_id: id, expires_at: timestamp, expired: z.boolean(), token: id.optional() })
  .nullable();
const projectSummary = project.omit({
  execution_hints: true,
  instructions: true,
  ticket_seq: true,
  event_seq: true,
  created_at: true,
});
const ticketSummary = ticket.omit({
  github_pull_request: true,
  execution_hints: true,
  description: true,
  created_by: true,
  created_at: true,
  updated_at: true,
});
const ticketReceipt = ticket.pick({
  id: true,
  project_id: true,
  key: true,
  status: true,
  revision: true,
  requirements_revision: true,
});
const noteReceipt = note.pick({
  id: true,
  project_id: true,
  ticket_id: true,
  kind: true,
  ticket_revision: true,
  created_at: true,
});
const retrieval = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
const omission = z.object({
  section: z.string(),
  retrieve_with: z.string(),
  arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  revision: z.number().optional(),
  required_before: z.enum(['execution', 'review']).optional(),
});
const context = z.discriminatedUnion('not_modified', [
  z.object({ fingerprint: z.string(), not_modified: z.literal(true) }),
  z.object({
    fingerprint: z.string(),
    not_modified: z.literal(false),
    ticket,
    criteria: z.array(criterion),
    project_instructions: z.object({ text: z.string(), authority: z.string() }),
    effective_execution_hints: executionHints.optional(),
    github_evidence: githubEvidenceSchema.optional(),
    approval_policy: z.enum(['self', 'independent', 'human']),
    blockers: z.array(blocker),
    completion_blockers: z.array(blocker),
    dependencies: z.array(link.extend({ ticket: ticketSummary.nullable() })),
    claim: visibleClaim,
    untrusted_content_notice: z.string(),
    omitted: z.array(omission),
    latest_checkpoint: note.nullable().optional(),
    open_questions: z.array(note).optional(),
    reviews: z.array(review).optional(),
    submissions: z.array(submission.omit({ requirements_snapshot: true })).optional(),
  }),
]);
const search = z.object({
  results: z.array(
    z.object({
      id,
      kind: z.enum(['ticket', 'knowledge', 'checkpoint']),
      title: z.string(),
      revision: z.number(),
      excerpt: z.string(),
      score: z.number(),
      resource_uri: z.string(),
      retrieval,
      untrusted_content: z.boolean(),
    }),
  ),
  degraded: z.string().nullable(),
  coverage: z.object({ documents: z.number(), embedded: z.number(), observed_at: z.string() }),
  index_consistency: z.literal('eventual'),
});
export const resultSchemas: Record<Operation, z.ZodType> = {
  ticket_github_refresh: z.object({
    ticket: ticketReceipt,
    github_evidence: githubEvidenceSchema.pick({
      id: true,
      status: true,
      head_sha: true,
      observed_head_sha: true,
      observed_at: true,
      requirements_revision: true,
      ticket_revision: true,
      stale: true,
    }),
    evidence_ref: retrieval,
  }),
  project_list: z.object({ projects: z.array(projectSummary) }),
  project_get: z.object({
    project,
    members: z.array(member.extend({ name: z.string(), kind: z.enum(['human', 'agent']) })),
  }),
  project_create: projectSummary,
  project_update: projectSummary,
  member_set: member.extend({ role: z.enum(['reader', 'contributor', 'verifier', 'admin', 'none']) }),
  tickets_create: z.object({ tickets: z.array(ticketReceipt) }),
  ticket_list: z.object({ tickets: z.array(ticketSummary) }),
  ticket_update: ticketReceipt,
  ticket_transition: ticketReceipt,
  ticket_get: z.object({
    ticket,
    effective_execution_hints: executionHints.optional(),
    github_evidence: githubEvidenceSchema.optional(),
    criteria: z.array(criterion),
    links: z.array(link),
    claim: visibleClaim,
    blockers: z.array(blocker),
  }),
  ticket_history: z.object({ items: z.array(z.union([note, submission, review, githubEvidenceSchema])) }),
  ticket_link: z.object({
    source_id: id,
    target_id: id,
    kind: z.enum(['blocks', 'related']),
    action: z.enum(['add', 'remove']),
  }),
  work_next: z.object({ tickets: z.array(ticketSummary) }),
  work_claim: z.object({
    ticket: ticketReceipt,
    claim,
    context: context.optional(),
    context_omitted: z.enum(['requested', 'legacy_receipt']).optional(),
    context_ref: retrieval.optional(),
  }),
  work_heartbeat: claim,
  work_release: ticketReceipt,
  ticket_checkpoint: z.object({ ticket: ticketReceipt, checkpoint: noteReceipt }),
  ticket_note: z.object({ ticket: ticketReceipt, note: noteReceipt }),
  ticket_submit: z.object({
    ticket: ticketReceipt,
    submission: submission.pick({
      id: true,
      project_id: true,
      ticket_id: true,
      requirements_revision: true,
      ticket_revision: true,
      created_at: true,
    }),
  }),
  ticket_review: z.object({
    ticket: ticketReceipt,
    review: review.pick({
      id: true,
      project_id: true,
      ticket_id: true,
      submission_id: true,
      decision: true,
      ticket_revision: true,
      created_at: true,
    }),
  }),
  ticket_context: context,
  search,
  knowledge_get: knowledge,
  knowledge_write: knowledge.omit({ body: true }),
  checkpoint_get: note,
  changes_since: z.object({
    events: z.array(
      z.object({
        id,
        project_id: id,
        seq: z.number(),
        actor_id: id,
        type: z.string(),
        entity_id: z.string(),
        data: z.record(z.string(), json),
        created_at: timestamp,
      }),
    ),
    next_cursor: z.number(),
    has_more: z.boolean(),
  }),
};
export function toolOutputSchema(operation: Operation) {
  return z.object({
    ok: z.boolean(),
    data: resultSchemas[operation].nullable(),
    error: z
      .object({ code: z.string(), message: z.string(), details: z.record(z.string(), json) })
      .nullable(),
  });
}
