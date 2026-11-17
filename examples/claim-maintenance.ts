import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import type { Claim } from '../src/contracts.js';

// Run beside model turns; call stop() as soon as your submit, cancel, or release finishes.
export function startClaimMaintenance(client: Client, claim: Claim) {
  let stopped = false;
  let cursor = 0;
  let heartbeat: Record<string, unknown> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const stop = () => {
    stopped = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(pollTimer);
  };
  const failed = (envelope: any) => {
    if (envelope?.ok) return false;
    if (
      [
        'CLAIM_EXPIRED',
        'FORBIDDEN',
        'UNAUTHENTICATED',
        'INSUFFICIENT_SCOPE',
        'INVALID_INPUT',
        'IDEMPOTENCY_CONFLICT',
      ].includes(envelope?.error?.code)
    )
      stop();
    return true;
  };
  const poll = async () => {
    if (stopped) return;
    let delay = 120_000;
    try {
      const changed = await client.callTool({
        name: 'changes_since',
        arguments: { project_id: claim.project_id, cursor, limit: 100 },
      });
      if (stopped) return;
      const envelope = changed.structuredContent as any;
      if (failed(envelope)) return;
      const next = envelope.data.next_cursor;
      if (!Number.isSafeInteger(next) || next < cursor || (envelope.data.has_more && next === cursor)) return;
      if (
        envelope.data.events.some(
          (event: any) =>
            event.entity_id === claim.ticket_id &&
            (event.type === 'work.released' ||
              event.type === 'ticket.submitted' ||
              event.type === 'ticket.invalidated' ||
              event.type === 'work.claimed' ||
              (event.type === 'ticket.transitioned' && ['done', 'cancelled'].includes(event.data?.to))),
        )
      ) {
        const current = await client.callTool({
          name: 'ticket_get',
          arguments: { project_id: claim.project_id, ticket_id: claim.ticket_id },
        });
        if (stopped) return;
        const state = current.structuredContent as any;
        if (failed(state)) return;
        if (
          !state.data.claim ||
          state.data.claim.token !== claim.token ||
          state.data.claim.expired ||
          ['done', 'cancelled', 'in_review'].includes(state.data.ticket.status)
        )
          stop();
      }
      cursor = next;
      // Yield after each page so a large backlog cannot monopolize the heartbeat timer.
      delay = envelope.data.has_more ? 0 : 120_000;
    } catch {
      // Keep the cursor until the page and any ownership check succeed.
    } finally {
      if (!stopped) pollTimer = setTimeout(poll, delay);
    }
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
      if (stopped) return;
      const acknowledged = result.structuredContent as any;
      if (failed(acknowledged)) return;
      if (!(Date.parse(acknowledged.data?.expires_at) > Date.now())) {
        stop();
        return;
      }
      heartbeat = undefined;
      if (!polling) {
        polling = true;
        void poll();
      }
    } catch {
      // Retry the identical unacknowledged heartbeat with its original key.
    } finally {
      if (!stopped) heartbeatTimer = setTimeout(tick, 120_000);
    }
  };
  heartbeatTimer = setTimeout(tick, 120_000);
  return stop;
}
