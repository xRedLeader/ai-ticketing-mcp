import type { MilestoneProgress } from '../contracts.js';

const statuses = ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled'] as const;

export function milestoneProgressSql(project: string, milestone: string) {
  return `SELECT count(*) AS total,
    coalesce(sum(CASE WHEN t.status='done' AND s.requirements_revision=t.requirements_revision THEN 1 ELSE 0 END),0) AS accepted,
    ${statuses.map((status) => `coalesce(sum(CASE WHEN t.status='${status}' THEN 1 ELSE 0 END),0) AS ${status}`).join(',')}
    FROM milestone_memberships m JOIN tickets t ON t.id=m.id AND t.project_id=m.project_id
    LEFT JOIN submissions s ON s.id=t.approved_submission_id AND s.ticket_id=t.id AND s.project_id=t.project_id
    WHERE m.project_id=${project} AND m.milestone_id=${milestone}`;
}

export function milestoneProgress(row: Record<string, unknown>): MilestoneProgress {
  return {
    total: Number(row.total),
    accepted: Number(row.accepted),
    status_counts: Object.fromEntries(
      statuses.map((status) => [status, Number(row[status])]),
    ) as MilestoneProgress['status_counts'],
  };
}
