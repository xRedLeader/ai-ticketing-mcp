import { ensure, type Reader, type ResearchSpike, type Ticket } from './contracts.js';

export async function getSpike(reader: Reader, projectId: string, id: string) {
  const spike = await reader.get('research_spikes', id);
  ensure(spike?.project_id === projectId, 'NOT_FOUND', 'Research spike not found in project.');
  return spike;
}

export function spikeBudget(spike: ResearchSpike, now: string) {
  const deadline = spike.first_claimed_at
    ? new Date(Date.parse(spike.first_claimed_at) + spike.time_budget_ms).toISOString()
    : null;
  return {
    time_budget_ms: spike.time_budget_ms,
    first_claimed_at: spike.first_claimed_at,
    deadline,
    exhausted: deadline !== null && deadline <= now,
  };
}

/** A deadline fences new starts, never observations or result reconciliation. */
export async function researchAdmission(reader: Reader, ticket: Ticket, now: () => string) {
  if (ticket.work_kind !== 'research') return true;
  const spike = await getSpike(reader, ticket.project_id, ticket.id);
  return !spike.completed_at && !spikeBudget(spike, now()).exhausted;
}

export function deliveryOnly(ticket: Ticket) {
  ensure(ticket.work_kind !== 'research', 'RESEARCH_ONLY', 'Use the research lifecycle for this spike.');
}
