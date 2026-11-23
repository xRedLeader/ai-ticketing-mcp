import { randomUUID } from 'node:crypto';
import { ensure, type Milestone, type Reader, type Ticket, type Transaction } from './contracts.js';
import type { Input } from './schemas.js';

export async function getMilestone(reader: Reader, projectId: string, id: string) {
  const milestone = await reader.get('milestones', id);
  ensure(milestone?.project_id === projectId, 'NOT_FOUND', 'Milestone not found in project.');
  return milestone;
}

export async function milestoneSummary(reader: Reader, milestone: Milestone) {
  ensure(reader.milestoneProgress, 'UNSUPPORTED_MILESTONES', 'Storage does not support milestone progress.');
  const progress = await reader.milestoneProgress(milestone.project_id, milestone.id);
  return {
    ...milestoneReceipt(milestone),
    name: milestone.name,
    status:
      milestone.completed_at && progress.total > 0 && progress.accepted === progress.total
        ? 'completed'
        : 'open',
    progress,
  };
}

export const milestoneReceipt = (milestone: Milestone) => ({
  id: milestone.id,
  project_id: milestone.project_id,
  revision: milestone.revision,
  completed_at: milestone.completed_at,
  completed_by: milestone.completed_by,
});

function version(milestone: Milestone, expected: number) {
  ensure(
    milestone.revision === expected,
    'VERSION_CONFLICT',
    'Read current milestone and reconcile changes.',
    { current_revision: milestone.revision },
  );
}

async function reopen(tx: Transaction, milestone: Milestone, now: string) {
  milestone.revision++;
  milestone.updated_at = now;
  milestone.completed_at = null;
  milestone.completed_by = null;
  await tx.put('milestones', milestone);
}

export async function reopenTicketMilestone(tx: Transaction, ticket: Ticket, now: string) {
  const membership = await tx.get('milestone_memberships', ticket.id);
  if (!membership) return null;
  const milestone = await getMilestone(tx, ticket.project_id, membership.milestone_id);
  if (!milestone.completed_at) return null;
  await reopen(tx, milestone, now);
  return milestone;
}

export async function createMilestone(tx: Transaction, input: Input<'milestone_create'>, now: string) {
  const milestone: Milestone = {
    id: randomUUID(),
    project_id: input.project_id,
    name: input.name,
    outcome: input.outcome,
    exit_criteria: input.exit_criteria,
    revision: 1,
    created_at: now,
    updated_at: now,
    completed_at: null,
    completed_by: null,
  };
  await tx.put('milestones', milestone);
  return milestoneReceipt(milestone);
}

export async function updateMilestone(tx: Transaction, input: Input<'milestone_update'>, now: string) {
  const milestone = await getMilestone(tx, input.project_id, input.milestone_id);
  version(milestone, input.expected_revision);
  for (const key of ['name', 'outcome', 'exit_criteria'] as const)
    if (input[key] !== undefined) (milestone as any)[key] = input[key];
  await reopen(tx, milestone, now);
  return milestoneReceipt(milestone);
}

export async function completeMilestone(
  tx: Transaction,
  input: Input<'milestone_complete'>,
  actorId: string,
  now: string,
) {
  const milestone = await getMilestone(tx, input.project_id, input.milestone_id);
  version(milestone, input.expected_revision);
  const { progress } = await milestoneSummary(tx, milestone);
  ensure(
    progress.total > 0 && progress.accepted === progress.total,
    'MILESTONE_INCOMPLETE',
    'Every member ticket must have accepted current requirements before confirming exit criteria.',
  );
  milestone.revision++;
  milestone.updated_at = now;
  milestone.completed_at = now;
  milestone.completed_by = actorId;
  await tx.put('milestones', milestone);
  return milestoneReceipt(milestone);
}

export async function setTicketMilestone(
  tx: Transaction,
  ticket: Ticket,
  input: Input<'ticket_milestone_set'>,
  now: string,
) {
  const current = await tx.get('milestone_memberships', ticket.id);
  ensure(
    (current?.milestone_id ?? null) === input.expected_milestone_id,
    'VERSION_CONFLICT',
    'Read current ticket milestone and reconcile membership.',
  );
  const next = input.milestone_id ? await getMilestone(tx, ticket.project_id, input.milestone_id) : null;
  if ((current?.milestone_id ?? null) !== input.milestone_id) {
    if (current) await reopen(tx, await getMilestone(tx, ticket.project_id, current.milestone_id), now);
    if (next) {
      await tx.put('milestone_memberships', {
        id: ticket.id,
        project_id: ticket.project_id,
        milestone_id: next.id,
      });
      await reopen(tx, next, now);
    } else await tx.remove('milestone_memberships', ticket.id);
  }
  return { ticket_id: ticket.id, milestone_id: input.milestone_id };
}

export async function listMilestones(reader: Reader, input: Input<'milestone_list'>) {
  const rows = await reader.find('milestones', {
    where: { project_id: input.project_id },
    order: [
      { field: 'created_at', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
    limit: input.limit + 1,
    offset: input.offset,
  });
  return {
    items: await Promise.all(
      rows.slice(0, input.limit).map((milestone) => milestoneSummary(reader, milestone)),
    ),
    has_more: rows.length > input.limit,
    next_offset: input.offset + Math.min(rows.length, input.limit),
  };
}

export async function readMilestone(reader: Reader, input: Input<'milestone_get'>) {
  const milestone = await getMilestone(reader, input.project_id, input.milestone_id);
  const rows = await reader.find('milestone_memberships', {
    where: { project_id: input.project_id, milestone_id: milestone.id },
    order: [{ field: 'id', direction: 'asc' }],
    limit: input.limit + 1,
    offset: input.offset,
  });
  return {
    milestone: { ...milestone, ...(await milestoneSummary(reader, milestone)) },
    members: await Promise.all(
      rows.slice(0, input.limit).map(async (membership) => {
        const ticket = await reader.get('tickets', membership.id);
        ensure(
          ticket?.project_id === input.project_id,
          'INVALID_REFERENCE',
          'Milestone member ticket is missing.',
        );
        const submission = ticket.approved_submission_id
          ? await reader.get('submissions', ticket.approved_submission_id)
          : null;
        return {
          id: ticket.id,
          key: ticket.key,
          title: ticket.title,
          status: ticket.status,
          requirements_revision: ticket.requirements_revision,
          accepted:
            ticket.status === 'done' &&
            submission?.project_id === ticket.project_id &&
            submission.ticket_id === ticket.id &&
            submission.requirements_revision === ticket.requirements_revision,
        };
      }),
    ),
    has_more: rows.length > input.limit,
    next_offset: input.offset + Math.min(rows.length, input.limit),
  };
}
