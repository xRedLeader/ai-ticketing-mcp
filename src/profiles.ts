import { ensure } from './contracts.js';
import { schemas, type Operation } from './schemas.js';

export type McpProfile = 'worker' | 'planner' | 'reviewer' | 'full';

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
  planner: Object.freeze([
    ...shared,
    'tickets_create',
    'ticket_update',
    'ticket_transition',
    'ticket_link',
    'ticket_note',
    'knowledge_write',
    'ticket_github_refresh',
  ] as const),
  reviewer: Object.freeze([...shared, 'ticket_review', 'ticket_note', 'ticket_github_refresh'] as const),
  full: Object.freeze(Object.keys(schemas) as Operation[]),
});

export function parseMcpProfile(value: string | undefined): McpProfile {
  if (value === undefined) return 'worker';
  ensure(
    Object.hasOwn(profileOperations, value),
    'INVALID_INPUT',
    'Profile must be worker, planner, reviewer, or full.',
  );
  return value as McpProfile;
}
