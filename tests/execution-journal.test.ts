import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { durableExecutionFile, readExecutionFile } from '../src/execution-journal.js';

it('publishes a complete immutable journal after repeated crashes during staging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-journal-'));
  try {
    const path = join(directory, 'never-started.json');
    const module = new URL('../src/execution-journal.ts', import.meta.url).href;
    for (let i = 0; i < 2; i++) {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          '--input-type=module',
          '-e',
          `const {durableExecutionFile} = await import(${JSON.stringify(module)});
         durableExecutionFile(${JSON.stringify(path)}, {toJSON() {process.exit(93)}});`,
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      assert.equal(child.status, 93, child.stderr);
      assert.equal(existsSync(path), false);
    }
    assert.equal(readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 2);
    const proof = { run_id: 'run', spawned: false };
    durableExecutionFile(path, proof);
    assert.deepEqual(readExecutionFile(path), proof);
    assert.throws(() => durableExecutionFile(path, { spawned: true }), { code: 'EEXIST' });
    assert.deepEqual(readExecutionFile(path), proof);
    assert.equal(readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
