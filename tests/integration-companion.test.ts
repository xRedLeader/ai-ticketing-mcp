import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IntegrationCompanion, type IntegrationRequest } from '../examples/integration-companion.js';
import { createWorktree, type WorktreeRecord } from '../examples/worktree-isolation.js';
import { ExecutionRecipeRegistry } from '../src/execution-recipes.js';
import type { DependencyJoin } from '../src/contracts.js';
import { hasCode } from '../src/testing/contracts.js';
import { executionProcessIdentity } from '../src/execution-journal.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DomainError } from '../src/contracts.js';

function fixture(conflict = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ticketing-integration-')));
  const repository = join(directory, 'repository'),
    workspace = join(directory, 'owned');
  mkdirSync(repository);
  mkdirSync(workspace);
  const gitExecutable = realpathSync(
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0]!,
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(gitExecutable, ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
      ),
    }).trim();
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Integration Fixture');
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, 'a.txt'), 'base-a\n');
  writeFileSync(join(repository, 'b.txt'), 'base-b\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'test: integration base');
  const base = git(repository, 'rev-parse', 'HEAD');
  const project = randomUUID(),
    actor = randomUUID(),
    ticket = randomUUID();
  const sources: IntegrationRequest['sources'] = [0, 1].map((index) => {
    const identity = {
      repository,
      workspaceRoot: workspace,
      runId: `source-${index}`,
      attemptId: randomUUID(),
      baseCommit: base,
    };
    const record = createWorktree(identity);
    writeFileSync(
      join(record.worktreePath, conflict || index === 0 ? 'a.txt' : 'b.txt'),
      `accepted-${index}\n`,
    );
    git(record.worktreePath, 'add', '.');
    git(record.worktreePath, 'commit', '-m', 'test: accepted source');
    writeFileSync(join(record.artifactPath, 'evidence.txt'), `source ${index} evidence\n`);
    return {
      ticket_id: randomUUID(),
      requirements_revision: 1,
      submission_id: randomUUID(),
      commit: git(record.worktreePath, 'rev-parse', 'HEAD'),
      worktree: identity,
    };
  });
  let snapshot: DependencyJoin = {
    ticket_id: ticket,
    requirements_revision: 1,
    ready: true,
    branches: sources.map((source) => ({
      ticket_id: source.ticket_id,
      relationship: 'dependency',
      requirements_revision: 1,
      state: 'accepted',
      submission_id: source.submission_id,
      evidence: [
        {
          criterion_id: randomUUID(),
          result: 'pass',
          summary: 'Accepted exact source mapping.',
          references: [source.commit],
        },
      ],
      retryable: false,
    })),
    identity: 'initial',
  };
  snapshot.identity = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const request = { operation_id: randomUUID(), ticket_id: ticket, sources };
  const calls = join(directory, 'verification-calls.txt'),
    started = join(directory, 'verification-started.txt');
  const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'verified\\n');fs.writeFileSync(${JSON.stringify(started)},'started');if(fs.readFileSync('a.txt','utf8')!=='accepted-0\\n'||fs.readFileSync('b.txt','utf8')!=='accepted-1\\n')process.exitCode=2;`;
  const configuration = (record: WorktreeRecord, commit: string, body = script) => ({
    workspace_roots: [directory],
    recipes: [
      {
        id: 'git',
        project_ids: [project],
        executable: gitExecutable,
        argv: [],
        cwd: record.worktreePath,
        env: {},
        timeout_ms: 5000,
      },
      {
        id: 'check',
        project_ids: [project],
        executable: process.execPath,
        argv: ['-e', body],
        cwd: record.worktreePath,
        env: {},
        timeout_ms: 5000,
      },
    ],
    pipelines: [
      {
        id: 'integration-checks',
        project_ids: [project],
        source: { recipe_id: 'git', commit },
        steps: [{ id: 'check', recipe_id: 'check', needs: [], on_failure: 'stop', toolchain_files: [] }],
        timeout_ms: 10_000,
      },
    ],
  });
  const pipeline = (record: WorktreeRecord, commit: string, body = script) => {
    const registry = new ExecutionRecipeRegistry(configuration(record, commit, body));
    const metadata = registry.metadata().find((item) => item.id === 'integration-checks')!;
    const pinned = registry.get(metadata.id, metadata.fingerprint, project);
    assert.ok('kind' in pinned);
    return pinned;
  };
  const options = {
    application: {
      async getDependencyJoin() {
        return structuredClone(snapshot);
      },
    },
    actor_id: actor,
    project_id: project,
    repository,
    workspace_root: workspace,
    target_ref: 'refs/heads/main',
    git_executable: gitExecutable,
    pipeline,
  };
  return {
    directory,
    repository,
    workspace,
    gitExecutable,
    git,
    base,
    project,
    actor,
    ticket,
    request,
    calls,
    started,
    script,
    configuration,
    pipeline,
    options,
    setSnapshot(value: DependencyJoin) {
      snapshot = value;
    },
    getSnapshot() {
      return structuredClone(snapshot);
    },
    companion: (body = script, root = workspace) =>
      new IntegrationCompanion({
        ...options,
        workspace_root: root,
        pipeline: (record, commit) => pipeline(record, commit, body),
      }),
    dispose() {
      assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('ticketing-integration-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function until(test: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    assert.ok(Date.now() < deadline, 'Fixture observation timed out.');
    await delay(20);
  }
}

it('prepares exact accepted sources with actual pinned verification and retry-safe local review metadata', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repository, 'user-only.txt'), 'preserve user work\n');
    const companion = f.companion();
    const receipt = await companion.prepare(f.request);
    assert.equal(receipt.state, 'ready_for_review');
    assert.equal(f.git(f.repository, 'rev-parse', 'refs/heads/main'), f.base);
    assert.equal(f.git(receipt.worktree!.worktreePath, 'show', 'HEAD:a.txt'), 'accepted-0');
    assert.equal(f.git(receipt.worktree!.worktreePath, 'show', 'HEAD:b.txt'), 'accepted-1');
    assert.deepEqual(await companion.prepare(f.request), receipt);
    assert.equal(readFileSync(f.calls, 'utf8'), 'verified\n');
    assert.equal(readFileSync(join(f.repository, 'user-only.txt'), 'utf8'), 'preserve user work\n');
    assert.ok(receipt.verification_sha256);
    for (const source of f.request.sources) {
      assert.equal(f.git(source.worktree.repository, 'rev-parse', source.commit), source.commit);
      const records = readdirSync(join(f.workspace, 'artifacts'))
        .map((name) => join(f.workspace, 'artifacts', name, 'evidence.txt'))
        .filter(existsSync);
      assert.equal(records.length, 2);
    }
    await assert.rejects(
      companion.prepare({
        ...f.request,
        sources: [{ ...f.request.sources[0]!, submission_id: randomUUID() }, f.request.sources[1]!],
      }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    f.dispose();
  }
});

it('retains attributable conflicts, source commits and evidence without moving the target', async () => {
  const f = fixture(true);
  try {
    const receipt = await f.companion().prepare(f.request);
    assert.equal(receipt.state, 'conflict');
    assert.deepEqual(receipt.conflict?.paths, ['a.txt']);
    assert.ok(receipt.conflict?.submission_id);
    assert.ok(existsSync(receipt.conflict!.artifact_path));
    assert.equal(f.git(f.repository, 'rev-parse', 'refs/heads/main'), f.base);
    assert.equal(existsSync(f.calls), false);
    assert.deepEqual(await f.companion().prepare(f.request), receipt);
    assert.equal(readdirSync(join(f.workspace, 'worktrees')).length, 2);
  } finally {
    f.dispose();
  }
});

it('requires a new verified attempt when the target advances during verification', async () => {
  const f = fixture();
  try {
    const slow = f.companion(`${f.script}setTimeout(()=>{},500);`);
    const preparing = slow.prepare(f.request);
    await until(() => existsSync(f.started));
    const advanced = f.request.sources[0]!.commit;
    f.git(f.repository, 'update-ref', 'refs/heads/main', advanced, f.base);
    const stale = await preparing;
    assert.equal(stale.state, 'revalidation_required');
    assert.equal(stale.code, 'TARGET_CHANGED');
    assert.equal(f.git(f.repository, 'rev-parse', 'refs/heads/main'), advanced);
    const ready = await f.companion().prepare({ ...f.request, operation_id: randomUUID() });
    assert.equal(ready.state, 'ready_for_review');
    assert.equal(ready.target_commit, advanced);
    assert.equal(readFileSync(f.calls, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    f.dispose();
  }
});

it('never returns stale ready evidence after accepted source, join or verification changes', async () => {
  for (const change of ['source', 'join', 'verification']) {
    const f = fixture();
    try {
      const companion = f.companion();
      const ready = await companion.prepare(f.request);
      assert.equal(ready.state, 'ready_for_review');
      if (change === 'source') {
        const sourceRecord = readdirSync(join(f.workspace, 'worktrees'))
          .map((name) => join(f.workspace, 'worktrees', name))
          .find((path) => f.git(path, 'rev-parse', 'HEAD') === f.request.sources[0]!.commit)!;
        writeFileSync(join(sourceRecord, 'extra.txt'), 'new branch work\n');
        f.git(sourceRecord, 'add', '.');
        f.git(sourceRecord, 'commit', '-m', 'test: changed source');
      } else if (change === 'join') f.setSnapshot({ ...f.getSnapshot(), identity: 'changed-accepted-proof' });
      else writeFileSync(join(ready.worktree!.worktreePath, 'a.txt'), 'modified after checks\n');
      const stale = await companion.prepare(f.request);
      assert.equal(stale.state, 'revalidation_required');
      assert.equal(
        stale.code,
        change === 'source' ? 'SOURCE_CHANGED' : change === 'join' ? 'JOIN_CHANGED' : 'SOURCE_CHANGED',
      );
      assert.equal(readFileSync(f.calls, 'utf8'), 'verified\n');
    } finally {
      f.dispose();
    }
  }
});

it('serializes different operation IDs and workspace roots on the same canonical target', async () => {
  const f = fixture();
  try {
    const slow = f.companion(`${f.script}setTimeout(()=>{},500);`);
    const running = slow.prepare(f.request);
    await until(() => existsSync(f.started));
    assert.equal((await slow.prepare(f.request)).code, 'NATIVE_UNRESOLVED');
    const otherRoot = join(f.directory, 'other-owned');
    mkdirSync(otherRoot);
    const other = f.companion(f.script, otherRoot);
    const otherRequest = { ...f.request, operation_id: randomUUID() };
    assert.equal((await other.prepare(otherRequest)).state, 'busy');
    assert.equal(readFileSync(f.calls, 'utf8'), 'verified\n');
    assert.equal((await running).state, 'ready_for_review');
    assert.equal((await other.prepare(otherRequest)).state, 'ready_for_review');
    assert.equal(f.git(f.repository, 'rev-parse', 'refs/heads/main'), f.base);
  } finally {
    f.dispose();
  }
});

it('retains the interlock across native host crash until explicit independent termination proof', async () => {
  const f = fixture();
  try {
    const done = join(f.directory, 'native-done.txt'),
      pidFile = join(f.directory, 'native-pid.txt');
    const crashBody = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(done)},'native command reached its final operation');process.kill(process.ppid);process.exit(0);`;
    const workerPath = join(f.directory, 'integration-worker.mjs');
    const modulePath = new URL('../examples/integration-companion.ts', import.meta.url).href;
    const registryPath = new URL('../src/execution-recipes.ts', import.meta.url).href;
    const snapshot = f.getSnapshot();
    const configTemplate = f.configuration(
      { worktreePath: 'REPLACE' } as WorktreeRecord,
      '0'.repeat(40),
      crashBody,
    );
    writeFileSync(
      workerPath,
      `import {IntegrationCompanion} from ${JSON.stringify(modulePath)};import {ExecutionRecipeRegistry} from ${JSON.stringify(registryPath)};const config=${JSON.stringify(configTemplate)};const options=${JSON.stringify({ actor_id: f.actor, project_id: f.project, repository: f.repository, workspace_root: f.workspace, target_ref: 'refs/heads/main', git_executable: f.gitExecutable })};const companion=new IntegrationCompanion({...options,application:{async getDependencyJoin(){return ${JSON.stringify(snapshot)}}},pipeline(record,commit){for(const command of config.recipes)command.cwd=record.worktreePath;config.pipelines[0].source.commit=commit;const registry=new ExecutionRecipeRegistry(config);const metadata=registry.metadata().find(x=>x.id==='integration-checks');return registry.get(metadata.id,metadata.fingerprint,options.project_id)}});await companion.prepare(${JSON.stringify(f.request)});`,
    );
    const worker = spawn(process.execPath, ['--import', 'tsx', workerPath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    await once(worker, 'exit');
    assert.ok(existsSync(pidFile), errors);
    await until(
      () => existsSync(done) && executionProcessIdentity(Number(readFileSync(pidFile, 'utf8'))) === null,
    );
    const companion = f.companion();
    assert.equal((await companion.prepare(f.request)).state, 'needs_attention');
    await assert.rejects(
      companion.reconcile(f.request, { source: 'fixture-independent-observer', stopped: () => false }),
      hasCode('NATIVE_UNRESOLVED'),
    );
    const abandoned = await companion.reconcile(f.request, {
      source: 'fixture-independent-observer',
      stopped: () =>
        existsSync(done) && executionProcessIdentity(Number(readFileSync(pidFile, 'utf8'))) === null,
    });
    assert.equal(abandoned.state, 'abandoned');
    assert.deepEqual(
      await companion.reconcile(f.request, { source: 'fixture-independent-observer', stopped: () => false }),
      abandoned,
    );
    assert.equal((await companion.prepare(f.request)).state, 'abandoned');
    assert.equal(
      (await companion.prepare({ ...f.request, operation_id: randomUUID() })).state,
      'ready_for_review',
    );
    assert.equal(f.git(f.repository, 'rev-parse', 'refs/heads/main'), f.base);
  } finally {
    f.dispose();
  }
});

it('grants only one release owner when cleanup paths race and preserves the replacement target lock', () => {
  const f = fixture();
  const originalUnlink = fs.unlinkSync;
  try {
    const companion = f.companion() as unknown as {
      release(path: string, owner: { operation: string; acquisition: string }, journal: string): void;
    };
    const lock = join(f.directory, 'race-lock.json'),
      journal = join(f.directory, 'race-journal');
    mkdirSync(journal);
    const owner = { operation: 'same-operation', acquisition: randomUUID() };
    const replacement = { ...owner, acquisition: randomUUID() };
    writeFileSync(lock, JSON.stringify(owner));
    let deletions = 0;
    fs.unlinkSync = (path) => {
      if (path !== lock) return originalUnlink(path);
      deletions++;
      if (deletions === 1) {
        // A second cleanup runs after the first owner's lock check, before its native unlink.
        companion.release(lock, owner, journal);
        if (!existsSync(lock)) writeFileSync(lock, JSON.stringify(replacement));
      }
      originalUnlink(path);
    };
    syncBuiltinESMExports();
    companion.release(lock, owner, journal);
    assert.equal(deletions, 1);
    writeFileSync(lock, JSON.stringify(replacement));
    companion.release(lock, owner, journal);
    assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), replacement);
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    f.dispose();
  }
});

it('releases a retry acquisition when the original finishes before the lock is acquired', async () => {
  const f = fixture();
  const originalExists = fs.existsSync;
  try {
    const companion = f.companion();
    const completed = await companion.prepare(f.request);
    assert.equal(completed.state, 'ready_for_review');
    const resultPath = join(completed.journal_path, 'result.json');
    let missed = false;
    fs.existsSync = (path) => {
      if (!missed && path === resultPath) {
        missed = true;
        return false;
      }
      return originalExists(path);
    };
    syncBuiltinESMExports();
    assert.deepEqual(await companion.prepare(f.request), completed);
    assert.ok(missed);
    assert.equal(readFileSync(f.calls, 'utf8'), 'verified\n');
    assert.equal(
      (await companion.prepare({ ...f.request, operation_id: randomUUID() })).state,
      'ready_for_review',
    );
  } finally {
    fs.existsSync = originalExists;
    syncBuiltinESMExports();
    f.dispose();
  }
});

it('keeps large accepted joins readable on retry without copying their evidence into the intent', async () => {
  const f = fixture();
  try {
    const snapshot = f.getSnapshot();
    for (const branch of snapshot.branches)
      branch.evidence = Array.from({ length: 50 }, () => ({
        criterion_id: randomUUID(),
        result: 'pass',
        summary: 'a'.repeat(4000),
        references: Array.from(
          { length: 20 },
          (_, index) => `https://example.test/${index}/${'b'.repeat(1950)}`,
        ),
      }));
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024);
    f.setSnapshot(snapshot);
    const receipt = await f.companion().prepare(f.request);
    assert.equal(receipt.state, 'ready_for_review');
    const intent = JSON.parse(readFileSync(join(receipt.journal_path, 'intent.json'), 'utf8'));
    assert.equal(intent.join_identity, snapshot.identity);
    assert.equal(intent.join, undefined);
    assert.deepEqual(await f.companion().prepare(f.request), receipt);
  } finally {
    f.dispose();
  }
});

it(
  'terminates the local verification group and its descendants on Linux timeout',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const f = fixture();
    try {
      const marker = join(f.directory, 'child-started.txt');
      const late = join(f.directory, 'child-still-running.txt');
      const descendant = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 2200);`;
      const body = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });`;
      const companion = new IntegrationCompanion({
        ...f.options,
        pipeline(record, commit) {
          const config = f.configuration(record, commit, body);
          config.recipes[1]!.timeout_ms = 1000;
          const registry = new ExecutionRecipeRegistry(config);
          const metadata = registry.metadata().find((item) => item.id === 'integration-checks')!;
          const recipe = registry.get(metadata.id, metadata.fingerprint, f.project);
          assert.ok('kind' in recipe);
          return recipe;
        },
      });
      const result = await companion.prepare(f.request);
      await delay(2300);
      assert.ok(existsSync(marker));
      assert.equal(existsSync(late), false);
      assert.equal(result.state, 'failed');
      assert.equal(result.code, 'TIMEOUT');
      assert.equal(result.cleanup_verified, true);
      assert.equal(
        (await f.companion().prepare({ ...f.request, operation_id: randomUUID() })).state,
        'ready_for_review',
      );
    } finally {
      f.dispose();
    }
  },
);

it('retains an interrupted release grant until explicit recovery and authorizes historical result access', async () => {
  const f = fixture();
  const originalUnlink = fs.unlinkSync;
  let interrupted = false;
  try {
    fs.unlinkSync = (path) => {
      if (!interrupted && /[\\/]targets[\\/][a-f0-9]{64}\.json$/.test(String(path))) {
        interrupted = true;
        throw new Error('Fixture stopped the release owner.');
      }
      originalUnlink(path);
    };
    syncBuiltinESMExports();
    const companion = f.companion();
    await assert.rejects(companion.prepare(f.request), /Fixture stopped the release owner/);
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    assert.equal((await companion.prepare(f.request)).state, 'ready_for_review');
    const next = { ...f.request, operation_id: randomUUID() };
    assert.equal((await companion.prepare(next)).state, 'busy');
    const otherActor = new IntegrationCompanion({ ...f.options, actor_id: randomUUID() });
    await assert.rejects(otherActor.prepare(f.request), hasCode('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(
      otherActor.reconcile(f.request, { source: 'other-actor', stopped: () => true }),
      hasCode('IDEMPOTENCY_CONFLICT'),
    );
    const revoked = new IntegrationCompanion({
      ...f.options,
      application: {
        async getDependencyJoin() {
          throw new DomainError('FORBIDDEN', 'Revoked fixture actor.');
        },
      },
    });
    await assert.rejects(revoked.prepare(f.request), hasCode('FORBIDDEN'));
    await assert.rejects(
      revoked.reconcile(f.request, { source: 'revoked-actor', stopped: () => true }),
      hasCode('FORBIDDEN'),
    );
    assert.equal(
      (
        await companion.reconcile(f.request, {
          source: 'fixture-observed-release-owner-returned',
          stopped: () => true,
        })
      ).state,
      'abandoned',
    );
    assert.equal((await companion.prepare(next)).state, 'ready_for_review');
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    f.dispose();
  }
});
