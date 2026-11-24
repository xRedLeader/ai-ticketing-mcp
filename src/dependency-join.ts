import { createHash } from 'node:crypto';
import { ensure, type DependencyBranch, type DependencyJoin, type Reader, type Ticket } from './contracts.js';

export async function dependencyJoin(
  reader: Reader,
  ticket: Ticket,
  executionRuns = false,
  branchDispatches = false,
): Promise<DependencyJoin> {
  const [links, children] = await Promise.all([
    reader.find('links', {
      where: { project_id: ticket.project_id, target_id: ticket.id, kind: 'blocks' },
      limit: 10001,
    }),
    reader.find('tickets', { where: { project_id: ticket.project_id, parent_id: ticket.id }, limit: 10001 }),
  ]);
  ensure(links.length + children.length <= 10000, 'GRAPH_LIMIT', 'Join exceeds 10,000 branches.');
  const dependencies = links.length
    ? await reader.find('tickets', {
        where: { project_id: ticket.project_id, id: { in: links.map((link) => link.source_id) } },
        limit: 10001,
      })
    : [];
  ensure(
    dependencies.length === new Set(links.map((link) => link.source_id)).size,
    'INVALID_REFERENCE',
    'Join prerequisite is missing.',
  );
  const branches: DependencyBranch[] = [];
  const required = [
    ...dependencies.map((branch) => ({ branch, relationship: 'dependency' as const })),
    ...children.map((branch) => ({ branch, relationship: 'child' as const })),
  ].sort((a, b) => a.branch.id.localeCompare(b.branch.id) || a.relationship.localeCompare(b.relationship));
  for (const { branch, relationship } of required) {
    const submission = branch.approved_submission_id
      ? await reader.get('submissions', branch.approved_submission_id)
      : null;
    const accepted =
      branch.status === 'done' &&
      submission?.project_id === ticket.project_id &&
      submission.ticket_id === branch.id &&
      submission.requirements_revision === branch.requirements_revision;
    let state: DependencyBranch['state'] = accepted
      ? 'accepted'
      : branch.status === 'cancelled'
        ? 'cancelled'
        : branch.status === 'done'
          ? 'superseded'
          : 'pending';
    if (state === 'pending') {
      const managed = branchDispatches ? await reader.get('branch_dispatches', branch.id) : null;
      const run = executionRuns
        ? (
            await reader.find('execution_jobs', {
              where: {
                project_id: ticket.project_id,
                ticket_id: branch.id,
                requirements_revision: branch.requirements_revision,
              },
              order: [
                { field: 'created_at', direction: 'desc' },
                { field: 'id', direction: 'desc' },
              ],
              limit: 1,
            })
          )[0]
        : null;
      const latest = (
        await reader.find('submissions', {
          where: {
            project_id: ticket.project_id,
            ticket_id: branch.id,
            requirements_revision: branch.requirements_revision,
          },
          order: [{ field: 'ticket_revision', direction: 'desc' }],
          limit: 1,
        })
      )[0];
      const review = latest
        ? (
            await reader.find('reviews', {
              where: { project_id: ticket.project_id, ticket_id: branch.id, submission_id: latest.id },
              order: [{ field: 'ticket_revision', direction: 'desc' }],
              limit: 1,
            })
          )[0]
        : null;
      if (run?.status === 'failed' || review?.decision === 'request_changes') state = 'failed';
      if (
        managed?.requirements_revision === branch.requirements_revision &&
        managed.dispatch.state === 'completed'
      ) {
        if (managed.dispatch.code === 'failed' || managed.dispatch.code === 'rejected') state = 'failed';
        if (managed.dispatch.code === 'cancelled') state = 'cancelled';
      }
    }
    branches.push({
      ticket_id: branch.id,
      relationship,
      requirements_revision: branch.requirements_revision,
      state,
      submission_id: accepted ? submission.id : null,
      evidence: accepted ? submission.evidence : [],
      retryable: ['failed', 'cancelled'].includes(state) && ['ready', 'in_progress'].includes(branch.status),
    });
  }
  const proof = { ticket_id: ticket.id, requirements_revision: ticket.requirements_revision, branches };
  return {
    ...proof,
    identity: createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
    ready: branches.every((branch) => branch.state === 'accepted'),
  };
}
