import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import { startClaimMaintenance } from '../examples/claim-maintenance.js';

const claim = {
  id: 'ticket',
  project_id: 'project',
  ticket_id: 'ticket',
  actor_id: 'worker',
  token: 'token',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

it('stops on an expired successful heartbeat replay instead of treating it as renewal', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = {
    async callTool() {
      calls++;
      return {
        structuredContent: {
          ok: true,
          data: { ...claim, expires_at: new Date(Date.now() - 1).toISOString() },
        },
      };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.equal(calls, 1);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('does not start another request after stop while a change poll is pending', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const client = {
    async callTool(request: any) {
      calls.push(request.name);
      if (request.name === 'changes_since') return pending;
      return { structuredContent: { ok: true, data: claim } };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    stop();
    finish({
      structuredContent: {
        ok: true,
        data: { next_cursor: 1, events: [{ entity_id: claim.ticket_id, type: 'work.released' }] },
      },
    });
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(calls, ['work_heartbeat', 'changes_since']);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('stops scheduled work immediately when the caller finishes or cancels', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = {
    async callTool() {
      calls++;
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    stop();
    mock.timers.tick(240_000);
    await flush();
    assert.equal(calls, 0);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('checks current ownership before treating historical completion events as terminal', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let heartbeats = 0;
  const client = {
    async callTool(request: any) {
      if (request.name === 'work_heartbeat') heartbeats++;
      return {
        structuredContent: {
          ok: true,
          data:
            request.name === 'changes_since'
              ? { next_cursor: 3, events: [{ entity_id: 'ticket', type: 'ticket.submitted' }] }
              : request.name === 'ticket_get'
                ? { ticket: { status: 'in_progress' }, claim: { token: claim.token, expired: false } }
                : claim,
        },
      };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.equal(heartbeats, 2);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('retries structured transient errors with the same key', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const heartbeats: any[] = [];
  const client = {
    async callTool(request: any) {
      if (request.name === 'work_heartbeat') heartbeats.push(structuredClone(request));
      return {
        structuredContent: {
          ok: false,
          error: { code: heartbeats.length === 1 ? 'INTERNAL_ERROR' : 'CLAIM_EXPIRED' },
        },
      };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(heartbeats[0], heartbeats[1]);
    mock.timers.tick(120_000);
    await flush();
    assert.equal(heartbeats.length, 2);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('retries an unacknowledged heartbeat unchanged and stops after release', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const requests: any[] = [];
  const client = {
    async callTool(request: any) {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error('response lost');
      return {
        structuredContent: {
          ok: true,
          data:
            request.name === 'changes_since'
              ? { next_cursor: 7, events: [{ entity_id: 'ticket', type: 'work.released' }] }
              : request.name === 'ticket_get'
                ? { ticket: { status: 'ready' }, claim: null }
                : claim,
        },
      };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[2].name, 'changes_since');
    mock.timers.tick(120_000);
    await flush();
    assert.equal(requests.length, 4);
  } finally {
    stop();
    mock.timers.reset();
  }
});

it('uses a fresh key for each acknowledged heartbeat and stops on lost ownership', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const keys: string[] = [];
  const client = {
    async callTool(request: any) {
      if (request.name === 'work_heartbeat') keys.push(request.arguments.idempotency_key);
      return {
        structuredContent:
          request.name === 'changes_since'
            ? { ok: true, data: { next_cursor: 1, events: [] } }
            : keys.length > 1
              ? { ok: false, error: { code: 'CLAIM_EXPIRED' } }
              : { ok: true, data: claim },
      };
    },
  } as unknown as Client;
  const stop = startClaimMaintenance(client, claim);
  try {
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    mock.timers.tick(120_000);
    await flush();
    assert.equal(keys.length, 2);
  } finally {
    stop();
    mock.timers.reset();
  }
});
