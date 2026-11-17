import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../src/contracts.js';

export function contextFixture() {
  const now = new Date('2026-11-17T12:00:00Z');
  const actor = {
    id: randomUUID(),
    name: 'Worker',
    issuer: 'test',
    subject: 'worker',
    kind: 'agent',
    system_admin: false,
  };
  const project = {
    id: randomUUID(),
    key: 'PACK',
    name: 'Packing',
    instructions: 'Preserve all current requirements.',
    policy: 'independent',
    revision: 1,
    ticket_seq: 1,
    event_seq: 40,
    created_at: now.toISOString(),
  };
  const member = {
    id: `${project.id}:${actor.id}`,
    project_id: project.id,
    actor_id: actor.id,
    role: 'contributor',
  };
  const ticket = {
    id: randomUUID(),
    project_id: project.id,
    key: 'PACK-1',
    title: 'Large history',
    description:
      'mandatory-snapshot-marker ' +
      'Preserve the current acceptance criteria and verify the owner access boundary. '.repeat(160),
    status: 'ready',
    priority: 3,
    labels: [],
    capabilities: [],
    assignee_id: null,
    parent_id: null,
    revision: 40,
    requirements_revision: 1,
    created_by: actor.id,
    approved_submission_id: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const criterion = {
    id: randomUUID(),
    project_id: project.id,
    ticket_id: ticket.id,
    position: 0,
    text: 'Reject unauthorized access and preserve authorized access.',
  };
  const note = {
    id: randomUUID(),
    project_id: project.id,
    ticket_id: ticket.id,
    actor_id: actor.id,
    kind: 'checkpoint',
    body: 'Record completed verification before resuming work. '.repeat(30),
    blocking: false,
    answer_to: null,
    metadata: { decisions: ['Keep the authorization boundary.'] },
    ticket_revision: 39,
    created_at: now.toISOString(),
  };
  const reviews = Array.from({ length: 11 }, (_, index) => ({
    id: randomUUID(),
    project_id: project.id,
    ticket_id: ticket.id,
    submission_id: randomUUID(),
    actor_id: actor.id,
    decision: 'approve',
    feedback: 'Review the current evidence and verify each criterion independently. '.repeat(30),
    ticket_revision: 38 - index,
    created_at: now.toISOString(),
  }));
  const submissions = Array.from({ length: 11 }, (_, index) => ({
    id: randomUUID(),
    project_id: project.id,
    ticket_id: ticket.id,
    actor_id: actor.id,
    requirements_revision: 1,
    ticket_revision: 38 - index,
    evidence: [
      {
        criterion_id: criterion.id,
        result: 'pass',
        summary: 'The owner receives the response and an outsider receives access denied. '.repeat(30),
        references: ['https://example.test/evidence'],
      },
    ],
    summary: 'Verified the current criterion.',
    requirements_snapshot: {
      title: ticket.title,
      description: ticket.description,
      criteria: [{ criterion_id: criterion.id, text: criterion.text }],
    },
    created_at: now.toISOString(),
  }));
  const tables: Record<string, any[]> = {
    actors: [actor],
    projects: [project],
    members: [member],
    tickets: [ticket],
    criteria: [criterion],
    links: [],
    claims: [],
    notes: [note],
    reviews,
    submissions,
  };
  const state = { reading: false, mutating: false, snapshot_ms: 0, mutation_ms: 0 };
  const reader = {
    async get(table: string, id: string) {
      return tables[table]?.find((row) => row.id === id) ?? null;
    },
    async find(table: string, query: any = {}) {
      const rows = (tables[table] ?? []).filter((row) =>
        Object.entries(query.where ?? {}).every(([key, value]: [string, any]) =>
          value && typeof value === 'object' && 'in' in value
            ? value.in.includes(row[key])
            : row[key] === value,
        ),
      );
      for (const order of [...(query.order ?? [])].reverse())
        rows.sort(
          (a, b) =>
            String(a[order.field]).localeCompare(String(b[order.field]), undefined, { numeric: true }) *
            (order.direction === 'asc' ? 1 : -1),
        );
      return rows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 1000));
    },
    async unansweredQuestions(
      _project: string,
      _ticket: string,
      blocking: boolean,
      limit: number,
      offset: number,
    ) {
      return tables
        .notes!.filter((row) => row.kind === 'question' && row.blocking === blocking)
        .slice(offset, offset + limit);
    },
    async workCandidates() {
      return [];
    },
  };
  const storage = {
    ...reader,
    async readSnapshot(work: any) {
      state.reading = true;
      const start = performance.now();
      try {
        return await work(reader);
      } finally {
        state.snapshot_ms += performance.now() - start;
        state.reading = false;
      }
    },
    async transaction(_scope: string, work: any) {
      state.mutating = true;
      const start = performance.now();
      try {
        return await work(reader);
      } finally {
        state.mutation_ms += performance.now() - start;
        state.mutating = false;
      }
    },
  } as unknown as StorageAdapter;
  return { actor, project, ticket, tables, storage, state, now };
}
