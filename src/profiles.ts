import { ensure } from './contracts.js';
import { schemas, type Operation } from './schemas.js';

export type McpProfile = 'worker' | 'executor' | 'planner' | 'researcher' | 'reviewer' | 'full';

const shared = [
  'project_list',
  'project_get',
  'ticket_list',
  'ticket_context',
  'ticket_get',
  'ticket_history',
  'search',
  'knowledge_get',
  'checkpoint_get',
  'changes_since',
] as const;

export const profileOperations: Readonly<Record<McpProfile, readonly Operation[]>> = Object.freeze({
  worker: Object.freeze([
    ...shared,
    'work_claim',
    'work_heartbeat',
    'work_release',
    'ticket_checkpoint',
    'ticket_note',
    'ticket_submit',
  ] as const),
  executor: Object.freeze([
    'project_list',
    'project_get',
    'ticket_list',
    'ticket_context',
    'ticket_get',
    'ticket_history',
    'checkpoint_get',
    'work_claim',
    'work_release',
    'ticket_note',
    'ticket_submit',
    'run_submit',
    'run_wait',
    'run_get',
    'run_cancel',
    'artifact_read',
  ] as const),
  planner: Object.freeze([
    ...shared,
    'idea_create',
    'idea_list',
    'idea_get',
    'idea_triage',
    'milestone_list',
    'milestone_get',
    'milestone_create',
    'milestone_update',
    'milestone_complete',
    'ticket_milestone_set',
    'spike_schedule',
    'spike_list',
    'spike_get',
    'tickets_create',
    'ticket_update',
    'ticket_transition',
    'ticket_link',
    'ticket_note',
    'knowledge_write',
    'ticket_github_refresh',
  ] as const),
  reviewer: Object.freeze([
    ...shared,
    'ticket_review',
    'ticket_note',
    'ticket_github_refresh',
    'artifact_read',
  ] as const),
  researcher: Object.freeze([
    'project_list',
    'project_get',
    'idea_get',
    'spike_list',
    'spike_get',
    'spike_claim',
    'spike_complete',
    'ticket_context',
    'ticket_get',
    'ticket_history',
    'checkpoint_get',
    'work_heartbeat',
    'work_release',
    'ticket_checkpoint',
    'ticket_note',
    'run_submit',
    'run_get',
    'run_wait',
    'artifact_read',
  ] as const),
  full: Object.freeze(Object.keys(schemas) as Operation[]),
});

export function parseMcpProfile(value: string | undefined): McpProfile {
  if (value === undefined) return 'worker';
  ensure(
    Object.hasOwn(profileOperations, value),
    'INVALID_INPUT',
    'Profile must be worker, executor, planner, researcher, reviewer, or full.',
  );
  return value as McpProfile;
}
