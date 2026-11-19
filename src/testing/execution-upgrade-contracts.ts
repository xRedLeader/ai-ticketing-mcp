import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createApplication } from '../application.js';
import { fixture, type ContractAdapters } from './contracts.js';
import type { Table } from '../contracts.js';

/** Seed the historical claim shape without requiring the current adapter's optional columns. */
export async function seedLegacyExecutionClaim(
  sql: (text: string) => Promise<unknown>,
  projectId: string,
  ticketId: string,
  actorId: string,
  now: Date,
) {
  await assert.rejects(
    sql('SELECT execution FROM claims LIMIT 0'),
    (error: any) => error.code === '42703' || /no such column: execution/.test(error.message),
  );
  const claim = {
    id: ticketId,
    project_id: projectId,
    ticket_id: ticketId,
    actor_id: actorId,
    token: randomUUID(),
    expires_at: new Date(now.getTime() + 600000).toISOString(),
  };
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  await sql(
    `INSERT INTO claims(id,project_id,ticket_id,actor_id,token,expires_at) VALUES(${Object.values(claim).map(literal).join(',')})`,
  );
  await sql(`UPDATE tickets SET status='in_progress',revision=revision+1 WHERE id=${literal(ticketId)}`);
  return { claim };
}

export function registerExecutionUpgradeContractTests(
  name: string,
  dialect: 'sqlite' | 'postgres',
  factory: () => Promise<ContractAdapters & { sql: (text: string) => Promise<void> }>,
) {
  for (const history of ['main', 'accepted'] as const)
    it(`${name} upgrades the ${history}-first migration history without replaying existing full filenames`, async () => {
      const adapters = await factory();
      try {
        const directory = new URL(
          dialect === 'sqlite' ? '../../migrations/sqlite/' : '../../migrations/',
          import.meta.url,
        );
        await adapters.sql(
          `CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at ${dialect === 'postgres' ? 'timestamptz NOT NULL DEFAULT now()' : 'TEXT NOT NULL'})`,
        );
        const files = (await readdir(directory))
          .filter(
            (file) =>
              file.endsWith('.sql') &&
              !file.includes('execution_recovery') &&
              !file.includes('memory_validity') &&
              !file.includes('execution_control') &&
              !file.includes('durable_wakes') &&
              !file.includes('client_capabilities') &&
              (history === 'main'
                ? !file.includes('project_memory') && !file.includes('execution_runs')
                : !file.includes('review_fixes')),
          )
          .sort();
        for (const file of files) {
          await adapters.sql(await readFile(new URL(file, directory), 'utf8'));
          await adapters.sql(`INSERT INTO schema_migrations VALUES('${file}','2026-11-01T00:00:00.000Z')`);
        }
        const f = await fixture(adapters),
          ticket = await f.ticket(),
          claim = await seedLegacyExecutionClaim(
            adapters.sql,
            f.project.id,
            ticket.id,
            f.worker.id,
            f.clock.now,
          );
        await f.call(f.worker.id, 'ticket_checkpoint', {
          ticket_id: ticket.id,
          claim_token: claim.claim.token,
          progress: 'Preserve exact existing progress.',
        });
        const tables: Table[] = ['actors', 'projects', 'members', 'tickets', 'claims', 'notes', 'receipts'];
        if (history === 'accepted') {
          const app = createApplication({
            storage: f.storage,
            search: f.search,
            executionRecipes: [{ id: 'existing', fingerprint: 'a'.repeat(64), project_ids: [f.project.id] }],
          });
          await app.execute(f.worker.id, 'run_submit', {
            project_id: f.project.id,
            ticket_id: ticket.id,
            claim_token: claim.claim.token,
            idempotency_key: randomUUID(),
            recipe_id: 'existing',
            checkpoint: { progress: 'Existing registered run.' },
            completion_condition: { kind: 'exit_code', exit_code: 0 },
          });
          tables.push('execution_jobs', 'continuations', 'knowledge', 'knowledge_revisions');
        }
        const snapshot = async () => {
          const result: Record<string, unknown> = {};
          for (const table of tables)
            result[table] = await f.storage.find(table, { order: [{ field: 'id', direction: 'asc' }] });
          return result;
        };
        const before = await snapshot();
        await f.storage.migrate();
        await f.storage.migrate();
        await adapters.sql('SELECT execution FROM claims LIMIT 0');
        assert.deepEqual(await snapshot(), before);
        assert.equal((await f.storage.get('execution_controllers', 'execution'))?.owner_id, 'unclaimed');
        assert.deepEqual(await f.storage.find('execution_attempts'), []);
      } finally {
        await adapters.dispose?.();
      }
    });
}
