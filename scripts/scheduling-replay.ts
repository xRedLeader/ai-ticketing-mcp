import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createSqliteAdapters } from '../src/adapters/sqlite.js';
import { createApplication } from '../src/application.js';
import type { Ticket } from '../src/contracts.js';

const observation = z.strictObject({
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  observed_at: z.iso.datetime(),
  project_id: z.uuid(),
  actor_id: z.uuid(),
  capabilities: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  limit: z.int().min(1).max(25).default(10),
});

/** Compare actual scheduler ordering on the same retained queue, without dispatch. */
export async function replayScheduling(snapshot: string, input: z.input<typeof observation>) {
  const request = observation.parse(input);
  const source = await readFile(snapshot);
  assert.equal(createHash('sha256').update(source).digest('hex'), request.snapshot_sha256);
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'ticketing-scheduling-replay-'));
  assert.equal(dirname(resolve(directory)), root);
  assert.ok(basename(directory).startsWith('ticketing-scheduling-replay-'));
  try {
    const filename = join(directory, 'snapshot.sqlite');
    await writeFile(filename, source, { flag: 'wx', mode: 0o600 });
    const { storage, search } = createSqliteAdapters(filename);
    try {
      const project = await storage.get('projects', request.project_id);
      assert.ok(project, 'Project missing from the recorded queue.');
      const app = createApplication({ storage, search, now: () => new Date(request.observed_at) });
      const query = {
        project_id: request.project_id,
        capabilities: request.capabilities,
        labels: request.labels,
        limit: request.limit,
        mode: 'execution',
      };
      const select = async () => {
        const result = (await app.execute(request.actor_id, 'work_next', query)) as { tickets: Ticket[] };
        return result.tickets.map(({ id, key, requirements_revision }) => ({
          id,
          key,
          requirements_revision,
        }));
      };
      const recorded = project.scheduling_policy ?? 'priority_age';
      const alternative = recorded === 'priority_age' ? 'unblocking' : 'priority_age';
      const baseline = await select();
      await storage.transaction(project.id, (tx) =>
        tx.put('projects', { ...project, scheduling_policy: alternative }),
      );
      const candidate = await select();
      return {
        request,
        policy_activation: 'recommendations_only',
        provider_invocations_added: 0,
        baseline: { policy: recorded, candidates: baseline },
        candidate: { policy: alternative, candidates: candidate },
        first_candidate_changed: (baseline[0]?.id ?? null) !== (candidate[0]?.id ?? null),
        counterfactual_completion: null,
        counterfactual_elapsed_ms: null,
        counterfactual_provider_usage: null,
      };
    } finally {
      await Promise.all([storage.close(), search.close()]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      observation: { type: 'string' },
      out: { type: 'string' },
    },
  });
  assert.ok(
    values.snapshot && values.observation && values.out,
    'Provide --snapshot SQLITE --observation JSON --out NEW_JSON.',
  );
  const result = await replayScheduling(
    values.snapshot,
    JSON.parse(await readFile(values.observation, 'utf8')),
  );
  await writeFile(values.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
