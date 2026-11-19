import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionProcessIdentity } from './contracts.js';

/** Publish only complete journals, without replacing immutable evidence. */
export function durableExecutionFile(path: string, value: unknown, beforePublish?: () => void) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforePublish?.();
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
export function readExecutionFile(path: string, maxBytes = 262_144): unknown {
  const fd = openSync(path, 'r');
  try {
    // Journals are operator-owned and bounded; reject a damaged or replaced file before parsing.
    if (fstatSync(fd).size > maxBytes) throw new Error('Execution journal exceeds limit.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
/** A PID alone is never an identity. Failure to inspect leaves reconciliation unresolved. */
export function executionProcessIdentity(pid: number): ExecutionProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let marker: string;
    if (process.platform === 'win32') {
      const result = spawnSync(
        `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true },
      );
      if (result.status !== 0) return null;
      marker = result.stdout.trim();
    } else if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      marker = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
    } else return null;
    return marker && marker.length <= 200 ? { pid, start_marker: marker } : null;
  } catch {
    return null;
  }
}

export function windowsExecutionTerminationScript(identity: ExecutionProcessIdentity): string {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d{1,20}$/.test(identity.start_marker))
    throw new Error('Invalid Windows process identity.');
  return `
$ErrorActionPreference='Stop'
$root=Get-Process -Id ${identity.pid}
$null=$root.Handle
if ($root.StartTime.ToUniversalTime().Ticks.ToString() -ne '${identity.start_marker}') { exit 3 }
$owned=@{}; $owned[$root.Id]=$root
$deadline=[DateTime]::UtcNow.AddSeconds(8)
do {
  $found=$false
  $rows=@(Get-CimInstance Win32_Process)
  do {
    $added=$false
    foreach ($row in $rows) {
      if ($owned.ContainsKey([int]$row.ProcessId) -or !$owned.ContainsKey([int]$row.ParentProcessId)) { continue }
      $parent=$owned[[int]$row.ParentProcessId]
      $child=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
      if (!$child -or !$row.CreationDate) { exit 7 }
      $null=$child.Handle
      # CIM creation times have microsecond precision; compare the handle at that same precision.
      if ($child.Id -ne [int]$row.ProcessId -or $child.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff') -cne $row.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff')) { $child.Dispose(); exit 7 }
      if ($child.StartTime -lt $parent.StartTime -or ($parent.HasExited -and $child.StartTime -gt $parent.ExitTime)) { $child.Dispose(); exit 7 }
      $owned[$child.Id]=$child; $added=$true; $found=$true
    }
  } while ($added)
  if ($owned.Count -gt 4096) { exit 4 }
  foreach ($item in @($owned.Values)) { if (!$item.HasExited) { $item.Kill() } }
  foreach ($item in @($owned.Values)) { if (!$item.WaitForExit(1000)) { exit 5 } }
  # Scan again after parents exit, including children created during the first snapshot.
  if ($stable -and !$found) { exit 0 }; $stable=$true
} while ([DateTime]::UtcNow -lt $deadline)
exit 6
`;
}
/** Only an exact owned root can authorize termination; inspection failure never proves exit. */
export async function terminateExecutionProcessTree(identity: ExecutionProcessIdentity): Promise<boolean> {
  if (executionProcessIdentity(identity.pid)?.start_marker !== identity.start_marker) return false;
  if (process.platform === 'win32') {
    if (!/^\d{1,20}$/.test(identity.start_marker)) return false;
    spawnSync(
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-Command', windowsExecutionTerminationScript(identity)],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024, windowsHide: true },
    );
    // Windows has no enforced containment here; captured-handle exit cannot prove no escaped descendant.
    return false;
  }
  if (process.platform !== 'linux') return false;
  const group = () => {
    try {
      return readdirSync('/proc')
        .filter((pid) => /^\d+$/.test(pid))
        .flatMap((pid) => {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return Number(fields[2]) === identity.pid && fields[0] !== 'Z' ? [Number(pid)] : [];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
          }
        });
    } catch {
      return null;
    }
  };
  if (!group()?.includes(identity.pid)) return false;
  if (executionProcessIdentity(identity.pid)?.start_marker !== identity.start_marker) return false;
  try {
    process.kill(-identity.pid, 'SIGKILL');
  } catch {
    return false;
  }
  for (let i = 0; i < 100; i++) {
    const remaining = group();
    if (remaining === null) return false;
    if (!remaining.length) return true;
    await delay(20);
  }
  return false;
}
