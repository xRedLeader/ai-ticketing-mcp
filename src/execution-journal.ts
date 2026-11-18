import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ExecutionProcessIdentity } from './contracts.js';

/** Publish only complete journals, without replacing immutable evidence. */
export function durableExecutionFile(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
export function readExecutionFile(path: string): unknown {
  const fd = openSync(path, 'r');
  try {
    // Journals are operator-owned and bounded; reject a damaged or replaced file before parsing.
    if (fstatSync(fd).size > 262_144) throw new Error('Execution journal exceeds limit.');
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
