import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ensure,
  type Project,
  type Transaction,
  type WakeDecision,
  type WakeRegistration,
} from './contracts.js';

const eventType = z.enum([
  'ticket.updated',
  'ticket.invalidated',
  'ticket.transitioned',
  'ticket.note_added',
  'ticket.linked',
  'ticket.reviewed',
  'ticket.submitted',
  'work.released',
  'run.submitted',
  'run.settled',
]);
const registrationInput = z.strictObject({
  ticket_id: z.uuid(),
  condition: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('events'),
      types: z
        .array(eventType)
        .min(1)
        .max(10)
        .transform((types) => [...new Set(types)].sort()),
    }),
    z.strictObject({ kind: z.literal('continuation'), continuation_id: z.uuid() }),
  ]),
  deadline: z.iso.datetime().nullable().default(null),
  expected_revision: z.int().positive().optional(),
});
const evaluationInput = z.strictObject({
  after: z.uuid().optional(),
  limit: z.int().min(1).max(100).default(100),
  event_limit: z.int().min(1).max(100).default(100),
});
const ticketId = z.uuid();
function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  ensure(result.success, 'INVALID_INPUT', 'Invalid durable wake input.');
  return result.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export async function wakeRegistration(tx: Transaction, projectId: string, raw: unknown) {
  const id = parse(ticketId, raw);
  const row = await tx.get('wake_conditions', id);
  ensure(row?.project_id === projectId, 'NOT_FOUND', 'Wake condition not found.');
  return row;
}
export async function registerWake(
  tx: Transaction,
  project: Project,
  actorId: string,
  raw: unknown,
  now: string,
) {
  const input = parse(registrationInput, raw);
  const ticket = await tx.get('tickets', input.ticket_id);
  ensure(ticket?.project_id === project.id, 'NOT_FOUND', 'Ticket not found.');
  if (input.condition.kind === 'continuation') {
    const continuation = await tx.get('continuations', input.condition.continuation_id);
    ensure(
      continuation?.project_id === project.id && continuation.ticket_id === ticket.id,
      'INVALID_REFERENCE',
      'Wake continuation must belong to this ticket.',
    );
  }
  const previous = await tx.get('wake_conditions', ticket.id);
  const deadline = input.deadline ? new Date(input.deadline).toISOString() : null;
  if (previous) {
    if (input.expected_revision === undefined) {
      ensure(
        fingerprint([previous.condition, previous.deadline]) === fingerprint([input.condition, deadline]),
        'VERSION_CONFLICT',
        'Rearming requires expected_revision.',
      );
      return previous;
    }
    ensure(
      input.expected_revision === previous.revision,
      'VERSION_CONFLICT',
      'Wake condition revision changed.',
    );
    ensure(
      !previous.active && !previous.pending.length && previous.cursor === project.event_seq,
      'WAKE_PENDING',
      'Drain and finish existing wake decisions before rearming.',
    );
    ensure(
      !previous.deadline || previous.deadline_fired || Date.parse(previous.deadline) > Date.parse(now),
      'WAKE_PENDING',
      'Evaluate the missed deadline before rearming.',
    );
    if (previous.condition.kind === 'continuation' && !previous.observed.continuation) {
      const continuation = await tx.get('continuations', previous.condition.continuation_id);
      ensure(
        continuation?.status === 'pending',
        'WAKE_PENDING',
        'Evaluate the settled continuation before rearming.',
      );
    }
  } else ensure(input.expected_revision === undefined, 'VERSION_CONFLICT', 'Wake condition does not exist.');
  const row: WakeRegistration = {
    id: ticket.id,
    project_id: project.id,
    ticket_id: ticket.id,
    actor_id: actorId,
    condition: input.condition,
    deadline,
    cursor: project.event_seq,
    revision: (previous?.revision ?? 0) + 1,
    generation: previous?.generation ?? 0,
    observed: {},
    deadline_fired: false,
    pending: [],
    active: null,
    finished_token: previous?.finished_token ?? null,
    updated_at: now,
  };
  await tx.put('wake_conditions', row);
  return row;
}

export async function evaluateWakes(tx: Transaction, project: Project, raw: unknown, now: string) {
  const input = parse(evaluationInput, raw);
  const page = await tx.find('wake_conditions', {
    where: { project_id: project.id, ...(input.after ? { id: { gt: input.after } } : {}) },
    order: [{ field: 'id', direction: 'asc' }],
    limit: input.limit + 1,
  });
  let changed = 0,
    events = 0;
  for (const original of page.slice(0, input.limit)) {
    const row = {
      ...original,
      observed: { ...original.observed },
      pending: structuredClone(original.pending),
    };
    const batch = await tx.find('events', {
      where: { project_id: project.id, seq: { gt: row.cursor } },
      order: [{ field: 'seq', direction: 'asc' }],
      limit: input.event_limit,
    });
    for (const event of batch) {
      ensure(event.seq === row.cursor + 1, 'EVENT_GAP', 'Durable event gap; wake cursor was not advanced.');
      row.cursor = event.seq;
      events++;
      if (
        row.condition.kind !== 'events' ||
        event.entity_id !== row.ticket_id ||
        !row.condition.types.includes(event.type)
      )
        continue;
      const observed = fingerprint(event.data);
      if (row.observed[event.type] === observed) continue;
      row.observed[event.type] = observed;
      const reason = row.pending.find((item) => item.kind === 'event' && item.code === event.type);
      if (reason?.kind === 'event') {
        reason.last_seq = event.seq;
        reason.count++;
      } else
        row.pending.push({
          kind: 'event',
          code: event.type,
          first_seq: event.seq,
          last_seq: event.seq,
          count: 1,
        });
    }
    ensure(
      batch.length === input.event_limit || row.cursor === project.event_seq,
      'EVENT_GAP',
      'Durable event gap; wake cursor was not advanced.',
    );
    if (row.condition.kind === 'continuation') {
      const continuation = await tx.get('continuations', row.condition.continuation_id);
      ensure(
        continuation?.project_id === project.id && continuation.ticket_id === row.ticket_id,
        'INVALID_REFERENCE',
        'Registered continuation is unavailable.',
      );
      if (continuation.status !== 'pending' && !row.observed.continuation) {
        const code =
          continuation.status === 'satisfied'
            ? 'CONTINUATION_SATISFIED'
            : continuation.failure_reason && /^[A-Z][A-Z0-9_]{0,99}$/.test(continuation.failure_reason)
              ? continuation.failure_reason
              : 'CONTINUATION_FAILED';
        row.pending.push({
          kind: 'continuation',
          continuation_id: continuation.id,
          run_id: continuation.run_id,
          status: continuation.status,
          code,
        });
        row.observed.continuation = continuation.status;
      }
    }
    if (row.deadline && !row.deadline_fired && Date.parse(row.deadline) <= Date.parse(now)) {
      row.pending.push({ kind: 'deadline', at: row.deadline });
      row.deadline_fired = true;
    }
    if (fingerprint(row) !== fingerprint(original)) {
      row.revision++;
      row.updated_at = now;
      await tx.put('wake_conditions', row);
      changed++;
    }
  }
  return {
    evaluated: Math.min(page.length, input.limit),
    changed,
    events,
    next_cursor: page.slice(0, input.limit).at(-1)?.id ?? null,
    has_more: page.length > input.limit,
  };
}

export async function claimWake(
  tx: Transaction,
  project: Project,
  raw: unknown,
  now: string,
): Promise<WakeDecision | null> {
  const input = parse(
    z.strictObject({ ticket_id: ticketId, expected_generation: z.int().nonnegative() }),
    raw,
  );
  const row = await wakeRegistration(tx, project.id, input.ticket_id);
  ensure(input.expected_generation === row.generation, 'VERSION_CONFLICT', 'Wake generation changed.');
  if (row.active || !row.pending.length || row.cursor !== project.event_seq) return null;
  ensure(row.generation < 2147483647, 'CONFLICT', 'Wake generation exhausted.');
  const active: WakeDecision = {
    generation: row.generation + 1,
    token: randomUUID(),
    reasons: row.pending,
    through_cursor: row.cursor,
    created_at: now,
  };
  await tx.put('wake_conditions', {
    ...row,
    generation: active.generation,
    active,
    pending: [],
    revision: row.revision + 1,
    updated_at: now,
  });
  return active;
}
export async function finishWake(tx: Transaction, projectId: string, raw: unknown, now: string) {
  const input = parse(
    z.strictObject({ ticket_id: ticketId, generation: z.int().positive(), token: z.uuid() }),
    raw,
  );
  const row = await wakeRegistration(tx, projectId, input.ticket_id);
  if (!row.active)
    return {
      completed: row.generation === input.generation && row.finished_token === input.token,
      changed: false,
      ticket_id: row.ticket_id,
      generation: input.generation,
    };
  if (row.active.generation !== input.generation || row.active.token !== input.token)
    return { completed: false, changed: false, ticket_id: row.ticket_id, generation: input.generation };
  await tx.put('wake_conditions', {
    ...row,
    active: null,
    finished_token: input.token,
    revision: row.revision + 1,
    updated_at: now,
  });
  return { completed: true, changed: true, ticket_id: row.ticket_id, generation: input.generation };
}
