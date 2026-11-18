import { mkdir, open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

export interface ProfileOptions {
  directory: string;
  maxFileBytes?: number;
  maxFiles?: number;
  maxQueueBytes?: number;
}
export interface ProfileLimits {
  max_file_bytes: number;
  max_files: number;
  max_queue_bytes: number;
}
export interface ProfileConnection {
  transport: 'stdio' | 'http';
  profile: string;
  actorId?: string;
}
interface RecordBase {
  v: 1;
  seq: number;
  at_ms: number;
  monotonic_ms: number;
  connection_id: string;
}
export interface ProfileMessage extends RecordBase {
  type: 'message';
  transport: ProfileConnection['transport'];
  profile: string;
  actor_id?: string;
  direction: 'incoming' | 'outgoing';
  payload: string;
}
export interface ProfileSendResult extends RecordBase {
  type: 'send_result';
  message_seq: number;
  outcome: 'sent' | 'failed';
}
export type ProfileRecord = ProfileMessage | ProfileSendResult;
export interface ProfileGap {
  from_seq: number;
  to_seq: number;
  count: number;
  reason: 'queue_full' | 'oversize' | 'serialization_error' | 'io_error' | 'closed';
}
export interface ProfileSegment {
  file: string;
  first_seq: number;
  last_seq: number;
  records: number;
  bytes: number;
}
export interface ProfileRun {
  v: 1;
  run_id: string;
  started_at: string;
  ended_at?: string;
  status: 'open' | 'closed' | 'error';
  limits: ProfileLimits;
  counters: Record<string, number>;
  last_sequence: number;
  gaps: ProfileGap[];
  gap_ranges_omitted: number;
  segments: ProfileSegment[];
  error_codes?: string[];
}
export interface ProfileRecorder {
  readonly runDirectory: string;
  readonly metrics: Record<string, number>;
  wrapTransport(transport: Transport, connection: ProfileConnection): Transport;
  close(): Promise<void>;
}

const defaults: ProfileLimits = {
  max_file_bytes: 8 * 1024 * 1024,
  max_files: 8,
  max_queue_bytes: 16 * 1024 * 1024,
};
type Queued = { bytes: Buffer; seq: number; message: boolean };
class Recorder implements ProfileRecorder {
  readonly runDirectory: string;
  readonly metrics = {
    profile_records_seen: 0,
    profile_records_written: 0,
    profile_records_dropped: 0,
    profile_records_evicted: 0,
    profile_messages_seen: 0,
    profile_messages_written: 0,
    profile_bytes_written: 0,
    profile_bytes_evicted: 0,
    profile_segments_evicted: 0,
    profile_queue_bytes: 0,
    profile_peak_queue_bytes: 0,
    profile_capture_errors: 0,
  };
  private readonly run: Omit<ProfileRun, 'counters'>;
  private readonly errors = new Set<string>();
  private queue: (Queued | undefined)[] = [];
  private head = 0;
  private handle?: FileHandle;
  private segmentNumber = 0;
  private writing?: Promise<void>;
  private closing?: Promise<void>;
  private ended = false;
  private disabled = false;
  private dirty = false;

  constructor(options: ProfileOptions) {
    const id = randomUUID();
    this.runDirectory = join(resolve(options.directory), `run-${Date.now()}-${process.pid}-${id}`);
    this.run = {
      v: 1,
      run_id: id,
      started_at: new Date().toISOString(),
      status: 'open',
      limits: {
        max_file_bytes: options.maxFileBytes ?? defaults.max_file_bytes,
        max_files: options.maxFiles ?? defaults.max_files,
        max_queue_bytes: options.maxQueueBytes ?? defaults.max_queue_bytes,
      },
      last_sequence: 0,
      gaps: [],
      gap_ranges_omitted: 0,
      segments: [],
    };
  }
  async initialize() {
    try {
      if (!Object.values(this.run.limits).every((value) => Number.isSafeInteger(value) && value > 0))
        throw new Error('INVALID_LIMITS');
      await mkdir(dirname(this.runDirectory), { recursive: true, mode: 0o700 });
      await mkdir(this.runDirectory, { mode: 0o700 });
      await this.manifest();
    } catch {
      this.fail('INITIALIZATION_FAILED');
      this.disabled = true;
    }
  }
  private fail(code: string) {
    this.metrics.profile_capture_errors++;
    const first = !this.errors.has(code);
    this.errors.add(code);
    this.run.status = 'error';
    this.dirty = true;
    if (first) {
      try {
        // Bypass Writable error events so even a broken diagnostic sink stays fail-open.
        fs.write(2, JSON.stringify({ level: 'warn', event: 'profiling_error', code }) + '\n', () => {});
      } catch {
        /* Diagnostics must not change transport behavior. */
      }
    }
  }
  private gap(seq: number, reason: ProfileGap['reason']) {
    this.metrics.profile_records_dropped++;
    const last = this.run.gaps.at(-1);
    if (last?.reason === reason && last.to_seq + 1 === seq) {
      last.to_seq = seq;
      last.count++;
    } else {
      this.run.gaps.push({ from_seq: seq, to_seq: seq, count: 1, reason });
      if (this.run.gaps.length > 256) {
        this.run.gaps.shift();
        this.run.gap_ranges_omitted++;
      }
    }
    this.dirty = true;
  }
  private record(connectionId: string, message: boolean, fields: () => object): number {
    const seq = ++this.run.last_sequence;
    this.metrics.profile_records_seen++;
    if (message) this.metrics.profile_messages_seen++;
    try {
      if (this.ended || this.disabled) {
        this.gap(seq, this.ended ? 'closed' : 'io_error');
        if (this.ended) this.fail('CAPTURE_AFTER_CLOSE');
      } else {
        const bytes = Buffer.from(
          JSON.stringify({
            v: 1,
            seq,
            at_ms: Date.now(),
            monotonic_ms: performance.now(),
            connection_id: connectionId,
            ...fields(),
          }) + '\n',
        );
        if (bytes.length > this.run.limits.max_file_bytes) this.gap(seq, 'oversize');
        else if (this.metrics.profile_queue_bytes + bytes.length > this.run.limits.max_queue_bytes)
          this.gap(seq, 'queue_full');
        else {
          this.queue.push({ bytes, seq, message });
          this.metrics.profile_queue_bytes += bytes.length;
          this.metrics.profile_peak_queue_bytes = Math.max(
            this.metrics.profile_peak_queue_bytes,
            this.metrics.profile_queue_bytes,
          );
          this.dirty = true;
        }
      }
    } catch {
      this.gap(seq, 'serialization_error');
      this.fail('SERIALIZATION_FAILED');
    }
    this.schedule();
    return seq;
  }
  private schedule() {
    if (this.writing || this.disabled) return;
    this.writing = this.drain()
      .catch(() => {
        this.fail('WRITE_FAILED');
        this.disabled = true;
      })
      .finally(() => {
        this.writing = undefined;
        if (!this.disabled && (this.head < this.queue.length || this.dirty)) this.schedule();
      });
  }
  private async manifest() {
    this.dirty = false;
    const data: ProfileRun = {
      ...this.run,
      counters: { ...this.metrics },
      ...(this.errors.size ? { error_codes: [...this.errors] } : {}),
    };
    const path = join(this.runDirectory, 'run.json');
    await writeFile(path + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(path + '.tmp', path);
  }
  private async nextSegment(seq: number) {
    await this.handle?.close();
    this.handle = undefined;
    if (this.run.segments.length === this.run.limits.max_files) {
      const evicted = this.run.segments[0]!;
      await unlink(join(this.runDirectory, evicted.file));
      this.run.segments.shift();
      this.metrics.profile_records_evicted += evicted.records;
      this.metrics.profile_bytes_evicted += evicted.bytes;
      this.metrics.profile_segments_evicted++;
    }
    const file = `events-${String(++this.segmentNumber).padStart(6, '0')}.jsonl`;
    this.handle = await open(join(this.runDirectory, file), 'wx', 0o600);
    this.run.segments.push({ file, first_seq: seq, last_seq: seq, records: 0, bytes: 0 });
  }
  private async drain() {
    let active: Queued | undefined;
    try {
      while (this.head < this.queue.length) {
        const item = (active = this.queue[this.head]!);
        try {
          const current = this.run.segments.at(-1);
          if (!current || current.bytes + item.bytes.length > this.run.limits.max_file_bytes)
            await this.nextSegment(item.seq);
          let offset = 0;
          while (offset < item.bytes.length) {
            const { bytesWritten } = await this.handle!.write(item.bytes, offset);
            if (!bytesWritten) throw new Error('WRITE_FAILED');
            offset += bytesWritten;
          }
          const segment = this.run.segments.at(-1)!;
          segment.bytes += item.bytes.length;
          segment.last_seq = item.seq;
          segment.records++;
          this.metrics.profile_records_written++;
          if (item.message) this.metrics.profile_messages_written++;
          this.metrics.profile_bytes_written += item.bytes.length;
        } finally {
          this.metrics.profile_queue_bytes -= item.bytes.length;
          this.queue[this.head] = undefined;
          this.head++;
        }
        active = undefined;
        if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
      }
      this.queue = [];
      this.head = 0;
      await this.manifest();
    } catch {
      this.fail('WRITE_FAILED');
      this.disabled = true;
      // The partially written record and queued tail are incomplete even if a prefix reached disk.
      if (active) this.gap(active.seq, 'io_error');
      for (; this.head < this.queue.length; this.head++) this.gap(this.queue[this.head]!.seq, 'io_error');
      this.queue = [];
      this.head = 0;
      this.metrics.profile_queue_bytes = 0;
      await this.handle?.close().catch(() => {});
      this.handle = undefined;
      await this.manifest().catch(() => {
        this.fail('MANIFEST_FAILED');
      });
    }
  }
  wrapTransport(transport: Transport, info: ProfileConnection): Transport {
    const id = randomUUID();
    const capture = (direction: ProfileMessage['direction'], message: JSONRPCMessage) =>
      this.record(id, true, () => ({
        type: 'message',
        transport: info.transport,
        profile: info.profile,
        ...(info.actorId ? { actor_id: info.actorId } : {}),
        direction,
        payload: JSON.stringify(message),
      }));
    const originalMessage = transport.onmessage,
      originalClose = transport.onclose,
      originalError = transport.onerror;
    const wrapped: Transport = {
      start: () => transport.start(),
      send: async (message, options) => {
        const messageSeq = capture('outgoing', message);
        try {
          await transport.send(message, options);
          this.record(id, false, () => ({ type: 'send_result', message_seq: messageSeq, outcome: 'sent' }));
        } catch (error) {
          this.record(id, false, () => ({ type: 'send_result', message_seq: messageSeq, outcome: 'failed' }));
          throw error;
        }
      },
      close: () => transport.close(),
      get sessionId() {
        return transport.sessionId;
      },
      set sessionId(value) {
        transport.sessionId = value;
      },
      get hasPerRequestStream() {
        return transport.hasPerRequestStream;
      },
    };
    if (transport.setProtocolVersion)
      wrapped.setProtocolVersion = transport.setProtocolVersion.bind(transport);
    if (transport.setSupportedProtocolVersions)
      wrapped.setSupportedProtocolVersions = transport.setSupportedProtocolVersions.bind(transport);
    transport.onmessage = (message, extra) => {
      capture('incoming', message);
      originalMessage?.call(transport, message, extra);
      wrapped.onmessage?.(message, extra);
    };
    transport.onclose = () => {
      originalClose?.call(transport);
      wrapped.onclose?.();
    };
    transport.onerror = (error) => {
      this.fail('TRANSPORT_ERROR');
      this.schedule();
      originalError?.call(transport, error);
      wrapped.onerror?.(error);
    };
    return wrapped;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.ended = true;
      this.schedule();
      while (this.writing) await this.writing;
      await this.handle?.close().catch(() => {
        this.fail('CLOSE_FAILED');
      });
      this.handle = undefined;
      this.run.ended_at = new Date().toISOString();
      if (this.run.status !== 'error') this.run.status = 'closed';
      await this.manifest().catch(() => {
        this.fail('MANIFEST_FAILED');
      });
    })().catch(() => {
      this.fail('CLOSE_FAILED');
    }));
  }
}
export async function createProfileRecorder(options: ProfileOptions): Promise<ProfileRecorder> {
  const recorder = new Recorder(options);
  await recorder.initialize();
  return recorder;
}
