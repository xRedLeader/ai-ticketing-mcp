import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import type { Claim } from '../src/contracts.js';

// Run beside model turns; call stop() as soon as your submit, cancel, or release finishes.
export function startClaimMaintenance(client: Client, claim: Claim) {
  let stopped = false;
  let cursor = 0;
  let heartbeat: Record<string, unknown> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const tick = async () => {
    if (stopped) return;
    try {
      heartbeat ??= {
        project_id: claim.project_id,
        ticket_id: claim.ticket_id,
        claim_token: claim.token,
        idempotency_key: randomUUID(),
      };
      const result = await client.callTool({ name: 'work_heartbeat', arguments: heartbeat });
      const acknowledged = result.structuredContent as any;
      if (!acknowledged?.ok) {
        if (
          [
            'CLAIM_EXPIRED',
            'FORBIDDEN',
            'UNAUTHENTICATED',
            'INSUFFICIENT_SCOPE',
            'INVALID_INPUT',
            'IDEMPOTENCY_CONFLICT',
          ].includes(acknowledged?.error?.code)
        )
          stop();
        return;
      }
      if (!(Date.parse(acknowledged.data?.expires_at) > Date.now())) {
        stop();
        return;
      }
      heartbeat = undefined;
      if (stopped) return;
      const changed = await client.callTool({
        name: 'changes_since',
        arguments: { project_id: claim.project_id, cursor },
      });
      if (stopped) return;
      const envelope = changed.structuredContent as any;
      if (envelope?.ok) {
        cursor = envelope.data.next_cursor;
        if (
          envelope.data.events.some(
            (event: any) =>
              event.entity_id === claim.ticket_id &&
              (event.type === 'work.released' ||
                event.type === 'ticket.submitted' ||
                (event.type === 'ticket.transitioned' && ['done', 'cancelled'].includes(event.data.to)) ||
                (event.type === 'work.claimed' && event.actor_id !== claim.actor_id)),
          )
        ) {
          const current = await client.callTool({
            name: 'ticket_get',
            arguments: { project_id: claim.project_id, ticket_id: claim.ticket_id },
          });
          const state = current.structuredContent as any;
          if (
            !state?.ok ||
            !state.data.claim ||
            state.data.claim.token !== claim.token ||
            state.data.claim.expired ||
            ['done', 'cancelled', 'in_review'].includes(state.data.ticket.status)
          )
            stop();
        }
      }
    } catch {
      // Retry the identical unacknowledged heartbeat with its original key.
    } finally {
      if (!stopped) timer = setTimeout(tick, 120_000);
    }
  };
  timer = setTimeout(tick, 120_000);
  return stop;
}
