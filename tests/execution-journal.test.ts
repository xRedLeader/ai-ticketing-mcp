import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import {
  durableExecutionFile,
  readExecutionFile,
  windowsExecutionTerminationScript,
} from '../src/execution-journal.js';

it('publishes a complete immutable journal after repeated crashes during staging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-journal-'));
  try {
    const path = join(directory, 'never-started.json');
    const javascript = new URL('../src/execution-journal.js', import.meta.url);
    const module = (
      existsSync(javascript) ? javascript : new URL('../src/execution-journal.ts', import.meta.url)
    ).href;
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

it('checks the deadline after syncing bytes and before publishing an immutable journal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ticketing-journal-deadline-'));
  try {
    const path = join(directory, 'result.json');
    assert.throws(
      () =>
        durableExecutionFile(path, { status: 'passed' }, () => {
          throw new Error('TIMEOUT');
        }),
      /TIMEOUT/,
    );
    assert.equal(existsSync(path), false);
    durableExecutionFile(path, { status: 'failed', error_code: 'TIMEOUT' });
    assert.deepEqual(readExecutionFile(path), { status: 'failed', error_code: 'TIMEOUT' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it(
  'Windows binds descendant handles to the exact snapshot before terminating any mocked process',
  { skip: process.platform !== 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'ticketing-process-snapshot-'));
    try {
      const killed = join(directory, 'killed.txt');
      const rootTicks = (621355968000000000n + BigInt(Date.UTC(2026, 0, 1)) * 10000n).toString();
      for (const scenario of ['matching', 'replacement', 'missing_creation', 'missing_process']) {
        writeFileSync(killed, '');
        const mocks = `
$script:killed='${killed.replaceAll("'", "''")}'
function New-FakeProcess($id, $start) {
  $item=[PSCustomObject]@{Id=$id;Handle=0;StartTime=$start;HasExited=$false;ExitTime=$start.AddSeconds(5)}
  $item | Add-Member ScriptMethod Kill { [IO.File]::AppendAllText($script:killed, $this.Id.ToString()+[Environment]::NewLine); $this.HasExited=$true }
  $item | Add-Member ScriptMethod WaitForExit { param($timeout) return $this.HasExited }
  $item | Add-Member ScriptMethod Dispose {}
  return $item
}
$start=[DateTime]::Parse('2026-01-01T00:00:00Z').ToUniversalTime()
$script:root=New-FakeProcess 101 $start
$script:child=New-FakeProcess 202 $start.AddSeconds(${scenario === 'replacement' ? 2 : 1})
function Get-Process {
  [CmdletBinding()]param([int]$Id)
  if ($Id -eq 101) { return $script:root }
  if ($Id -eq 202) { ${scenario === 'missing_process' ? 'return $null' : 'return $script:child'} }
  throw 'Unexpected process lookup'
}
function Get-CimInstance {
  param($ClassName)
  return [PSCustomObject]@{ProcessId=202;ParentProcessId=101;CreationDate=${scenario === 'missing_creation' ? '$null' : '$start.AddSeconds(1)'}}
}
`;
        const result = spawnSync(
          `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            mocks + windowsExecutionTerminationScript({ pid: 101, start_marker: rootTicks }),
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        );
        assert.equal(result.status, scenario === 'matching' ? 0 : 7, `${scenario}: ${result.stderr}`);
        assert.deepEqual(
          readFileSync(killed, 'utf8').trim().split(/\r?\n/).filter(Boolean).sort(),
          scenario === 'matching' ? ['101', '202'] : [],
          scenario,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
