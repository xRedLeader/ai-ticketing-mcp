import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/server';
import {
  createProfileRecorder,
  type ProfileOptions,
  type ProfileRecorder,
  type ProfileRecord,
  type ProfileRun,
} from '../src/profiling.js';

const ping = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'ping' });
function transport(): Transport {
  return {
    async start() {},
    async send() {},
    async close() {
      this.onclose?.();
    },
  };
}
async function files(recorder: ProfileRecorder) {
  const run: ProfileRun = JSON.parse(await readFile(join(recorder.runDirectory, 'run.json'), 'utf8'));
  const records: ProfileRecord[] = [];
  let raw = '';
  for (const segment of run.segments) {
    const text = await readFile(join(recorder.runDirectory, segment.file), 'utf8');
    raw += text;
    records.push(
      ...text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  return { run, records, raw };
}
async function withRecorder(
  work: (recorder: ProfileRecorder, directory: string) => Promise<void>,
  options: Omit<ProfileOptions, 'directory'> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'ticketing-profiling-test-'));
  const recorder = await createProfileRecorder({ directory, ...options });
  try {
    await work(recorder, directory);
  } finally {
    await recorder.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('ticketing-profiling-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

it('captures immutable parsed snapshots and send outcomes without transport auth metadata', async () => {
  await withRecorder(async (recorder) => {
    const original = transport();
    let release!: () => void,
      sentMessage: JSONRPCMessage | undefined,
      sentOptions: TransportSendOptions | undefined;
    original.send = async (message, options) => {
      sentMessage = message;
      sentOptions = options;
      await new Promise<void>((done) => {
        release = done;
      });
    };
    const wrapped = recorder.wrapTransport(original, {
      transport: 'http',
      profile: 'worker',
      actorId: 'fixture-actor',
    });
    const extra: MessageExtraInfo = {
      request: new Request('http://127.0.0.1/mcp', {
        headers: { Authorization: 'Bearer inbound-header-secret' },
      }),
      authInfo: { token: 'inbound-auth-secret', clientId: 'fixture', scopes: ['ticketing:read'] },
    };
    let receivedExtra: MessageExtraInfo | undefined;
    wrapped.onmessage = (_message, value) => {
      receivedExtra = value;
    };
    original.onmessage!(ping(1), extra);
    const outgoing: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { claim_token: 'raw-fixture-claim', marker: 'original' },
    };
    const options = { headers: { Authorization: 'Bearer outbound-header-secret' } };
    const sending = wrapped.send(outgoing, options);
    outgoing.result.marker = 'changed-after-send';
    release();
    await sending;
    assert.strictEqual(sentMessage, outgoing);
    assert.strictEqual(sentOptions, options);
    assert.strictEqual(receivedExtra, extra);
    await recorder.close();
    const captured = await files(recorder);
    assert.equal(captured.run.status, 'closed');
    assert.equal(captured.records.length, 3);
    const messages = captured.records.filter((row) => row.type === 'message');
    assert.equal(messages[0]!.direction, 'incoming');
    assert.equal(messages[1]!.direction, 'outgoing');
    assert.equal(JSON.parse(messages[1]!.payload).result.marker, 'original');
    assert.ok(captured.raw.includes('raw-fixture-claim'));
    for (const secret of ['inbound-header-secret', 'inbound-auth-secret', 'outbound-header-secret'])
      assert.equal(captured.raw.includes(secret), false);
    assert.equal(captured.records[2]!.type, 'send_result');
    assert.deepEqual(
      captured.records.map((row) => row.seq),
      [1, 2, 3],
    );
    assert.equal(new Set(captured.records.map((row) => row.connection_id)).size, 1);
    assert.ok(captured.records.every((row) => row.at_ms > 0 && row.monotonic_ms >= 0));
  });
});

it('preserves transport callbacks, receiver binding, protocol setters and lifecycle outcomes', async () => {
  await withRecorder(async (recorder) => {
    const original = transport();
    const order: string[] = [];
    const failure = new Error('start sentinel');
    original.start = async function () {
      assert.strictEqual(this, original);
      throw failure;
    };
    original.sessionId = 'before';
    Object.defineProperty(original, 'hasPerRequestStream', { value: true });
    original.setProtocolVersion = function (version) {
      assert.strictEqual(this, original);
      order.push(version);
    };
    original.setSupportedProtocolVersions = function (versions) {
      assert.strictEqual(this, original);
      order.push(...versions);
    };
    original.onmessage = function (this: Transport) {
      assert.strictEqual(this, original);
      order.push('original-message');
    };
    original.onclose = function (this: Transport) {
      assert.strictEqual(this, original);
      order.push('original-close');
    };
    const wrapped = recorder.wrapTransport(original, { transport: 'stdio', profile: 'full' });
    wrapped.onmessage = function (this: Transport) {
      assert.strictEqual(this, wrapped);
      order.push('wrapped-message');
    };
    wrapped.onclose = function (this: Transport) {
      assert.strictEqual(this, wrapped);
      order.push('wrapped-close');
    };
    await assert.rejects(wrapped.start(), (error) => error === failure);
    wrapped.setProtocolVersion!('version');
    wrapped.setSupportedProtocolVersions!(['supported']);
    original.sessionId = 'after';
    assert.equal(wrapped.sessionId, 'after');
    wrapped.sessionId = 'assigned';
    assert.equal(original.sessionId, 'assigned');
    assert.equal(wrapped.hasPerRequestStream, true);
    original.onmessage!(ping(1));
    await wrapped.close();
    assert.deepEqual(order, [
      'version',
      'supported',
      'original-message',
      'wrapped-message',
      'original-close',
      'wrapped-close',
    ]);
  });
});

it('records rejected sends while preserving the original error and keeping connections separate', async () => {
  await withRecorder(async (recorder) => {
    const original = transport(),
      failure = new Error('send sentinel');
    original.send = async () => {
      throw failure;
    };
    const first = recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
    await assert.rejects(first.send(ping(1)), (error) => error === failure);
    const second = recorder.wrapTransport(transport(), { transport: 'http', profile: 'reviewer' });
    await second.send({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid input' } });
    await recorder.close();
    const { records } = await files(recorder);
    assert.deepEqual(
      records.filter((row) => row.type === 'send_result').map((row) => row.outcome),
      ['failed', 'sent'],
    );
    assert.equal(new Set(records.map((row) => row.connection_id)).size, 2);
    for (const outcome of records.filter((row) => row.type === 'send_result'))
      assert.ok(
        records.some(
          (row) => row.seq === outcome.message_seq && row.type === 'message' && row.direction === 'outgoing',
        ),
      );
  });
});

it('bounds queue admission and drops oversized records whole with explicit tail gaps', async () => {
  await withRecorder(
    async (recorder) => {
      const original = transport(),
        wrapped = recorder.wrapTransport(original, { transport: 'stdio', profile: 'full' });
      await wrapped.send(ping(1));
      await recorder.close();
      const { run, records } = await files(recorder);
      assert.equal(records.length, 0);
      assert.equal(run.last_sequence, 2);
      assert.equal(run.counters.profile_records_dropped, 2);
      assert.ok(run.gaps.every((gap) => gap.reason === 'queue_full'));
      assert.equal(run.counters.profile_queue_bytes, 0);
      assert.ok(run.counters.profile_peak_queue_bytes! <= 1);
    },
    { maxQueueBytes: 1 },
  );
  await withRecorder(
    async (recorder) => {
      const wrapped = recorder.wrapTransport(transport(), { transport: 'stdio', profile: 'full' });
      await wrapped.send({ jsonrpc: '2.0', id: 1, result: { content: 'oversize-marker'.repeat(1000) } });
      await recorder.close();
      const { run, raw } = await files(recorder);
      assert.equal(raw.includes('oversize-marker'), false);
      assert.ok(run.gaps.some((gap) => gap.reason === 'oversize' && gap.from_seq === 1));
      assert.equal(run.counters.profile_records_dropped, 1);
      assert.equal(run.counters.profile_records_written, 1);
    },
    { maxFileBytes: 512 },
  );
});

it('rotates bounded segments per unique run and drains every queued record on idempotent close', async () => {
  await withRecorder(
    async (recorder, directory) => {
      const other = await createProfileRecorder({ directory });
      assert.notEqual(other.runDirectory, recorder.runDirectory);
      await other.close();
      const wrapped = recorder.wrapTransport(transport(), { transport: 'stdio', profile: 'planner' });
      await Promise.all(Array.from({ length: 30 }, (_, id) => wrapped.send(ping(id))));
      const closing = recorder.close();
      assert.strictEqual(recorder.close(), closing);
      await closing;
      const { run, records } = await files(recorder);
      assert.equal(run.status, 'closed');
      assert.equal(run.last_sequence, 60);
      assert.equal(run.counters.profile_records_written, 60);
      assert.equal(run.counters.profile_records_dropped, 0);
      assert.equal(run.segments.length, 2);
      assert.ok(run.segments.every((segment) => segment.bytes <= 1024));
      assert.ok(run.counters.profile_records_evicted! > 0);
      assert.ok(records.length < 60);
      assert.equal(run.counters.profile_queue_bytes, 0);
      assert.deepEqual(
        (await readdir(recorder.runDirectory)).filter((name) => name.startsWith('events-')).sort(),
        run.segments.map((segment) => segment.file).sort(),
      );
      assert.equal(
        (JSON.parse(await readFile(join(other.runDirectory, 'run.json'), 'utf8')) as ProfileRun).run_id !==
          run.run_id,
        true,
      );
    },
    { maxFileBytes: 1024, maxFiles: 2 },
  );
});

it('fails open on disk errors and emits one fixed diagnostic without exposing error messages', async () => {
  const warnings: string[] = [];
  const stderr = mock.method(fs, 'write', ((_fd: unknown, chunk: unknown, callback: unknown) => {
    warnings.push(String(chunk));
    if (typeof callback === 'function') callback(null);
  }) as typeof fs.write);
  try {
    await withRecorder(async (recorder) => {
      await writeFile(join(recorder.runDirectory, 'events-000001.jsonl'), 'occupied');
      let sends = 0;
      const original = transport();
      original.send = async () => {
        sends++;
      };
      const wrapped = recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      await wrapped.send(ping(1));
      await recorder.close();
      assert.equal(sends, 1);
      const run = (await files(recorder)).run;
      assert.equal(run.status, 'error');
      assert.ok(run.error_codes?.includes('WRITE_FAILED'));
      assert.equal(run.counters.profile_records_dropped, 2);
      assert.equal(run.counters.profile_queue_bytes, 0);
      assert.equal(warnings.filter((line) => line.includes('WRITE_FAILED')).length, 1);
      assert.equal(
        warnings.some((line) => line.includes(recorder.runDirectory)),
        false,
      );
    });
  } finally {
    stderr.mock.restore();
  }
});

it('marks transport errors incomplete, forwards identical callbacks, and guards failing diagnostics', async () => {
  let diagnosticFailures = 0;
  const stderr = mock.method(fs, 'write', ((_fd: unknown, _chunk: unknown, callback: unknown) => {
    queueMicrotask(() => {
      diagnosticFailures++;
      if (typeof callback === 'function') callback(new Error('stderr unavailable'));
    });
  }) as typeof fs.write);
  try {
    await withRecorder(async (recorder) => {
      const original = transport(),
        failure = new Error('private-transport-error-text');
      let forwarded = 0;
      original.onerror = function (this: Transport, error) {
        assert.strictEqual(this, original);
        assert.strictEqual(error, failure);
        forwarded++;
      };
      const wrapped = recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      wrapped.onerror = function (this: Transport, error) {
        assert.strictEqual(this, wrapped);
        assert.strictEqual(error, failure);
        forwarded++;
      };
      assert.doesNotThrow(() => original.onerror!(failure));
      assert.doesNotThrow(() => original.onerror!(failure));
      assert.equal(forwarded, 4);
      const cyclic: any = ping(1);
      cyclic.params = cyclic;
      assert.doesNotThrow(() => original.onmessage!(cyclic));
      await recorder.close();
      const { run, raw } = await files(recorder);
      assert.equal(run.status, 'error');
      assert.ok(run.error_codes?.includes('TRANSPORT_ERROR'));
      assert.ok(run.error_codes?.includes('SERIALIZATION_FAILED'));
      assert.equal(JSON.stringify(run).includes('private-transport-error-text'), false);
      assert.equal(raw.includes('private-transport-error-text'), false);
      assert.equal(diagnosticFailures, 2);
    });
  } finally {
    stderr.mock.restore();
  }
});

it('persists transport error state when an original callback and diagnostic write both throw', async () => {
  const stderr = mock.method(fs, 'write', (() => {
    throw new Error('stderr unavailable');
  }) as unknown as typeof fs.write);
  try {
    await withRecorder(async (recorder) => {
      const original = transport(),
        failure = new Error('original callback sentinel');
      original.onerror = function () {
        assert.strictEqual(this, original);
        throw failure;
      };
      recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      assert.throws(
        () => original.onerror!(new Error('private transport error')),
        (error) => error === failure,
      );
      await recorder.close();
      const { run } = await files(recorder);
      assert.equal(run.status, 'error');
      assert.ok(run.error_codes?.includes('TRANSPORT_ERROR'));
    });
  } finally {
    stderr.mock.restore();
  }
});

it('returns a usable fail-open transport when profile initialization cannot create its directory', async () => {
  const warnings: string[] = [];
  const stderr = mock.method(fs, 'write', ((_fd: unknown, chunk: unknown, callback: unknown) => {
    warnings.push(String(chunk));
    if (typeof callback === 'function') callback(null);
  }) as typeof fs.write);
  try {
    await withRecorder(async (_recorder, directory) => {
      const blocked = join(directory, 'ordinary-file');
      await writeFile(blocked, 'not a directory');
      const failed = await createProfileRecorder({ directory: blocked });
      let sends = 0;
      const original = transport();
      original.send = async () => {
        sends++;
      };
      const wrapped = failed.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      await wrapped.start();
      await wrapped.send(ping(1));
      await wrapped.close();
      await failed.close();
      assert.equal(sends, 1);
      assert.ok(failed.metrics.profile_capture_errors! > 0);
      assert.equal(failed.metrics.profile_records_dropped, 2);
      assert.equal(failed.metrics.profile_queue_bytes, 0);
      assert.ok(warnings.some((line) => line.includes('INITIALIZATION_FAILED')));
      assert.equal(
        warnings.some((line) => line.includes(blocked)),
        false,
      );
    });
  } finally {
    stderr.mock.restore();
  }
});

it('leaves pending sends and late closed-loss explicit without changing the original send result', async () => {
  const stderr = mock.method(fs, 'write', ((_fd: unknown, _chunk: unknown, callback: unknown) => {
    if (typeof callback === 'function') callback(null);
  }) as typeof fs.write);
  try {
    await withRecorder(async (recorder) => {
      let release!: () => void;
      const original = transport();
      original.send = () =>
        new Promise<void>((done) => {
          release = done;
        });
      const wrapped = recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      const pending = wrapped.send(ping(1));
      await recorder.close();
      const before = await files(recorder);
      assert.equal(before.records.filter((row) => row.type === 'message').length, 1);
      assert.equal(before.records.filter((row) => row.type === 'send_result').length, 0);
      release();
      assert.equal(await pending, undefined);
      assert.equal(recorder.metrics.profile_records_dropped, 1);
      let after = await files(recorder);
      for (let attempt = 0; after.run.last_sequence !== 2 && attempt < 40; attempt++) {
        await delay(5);
        after = await files(recorder);
      }
      assert.equal(after.run.last_sequence, 2);
      assert.equal(after.run.status, 'error');
      assert.ok(after.run.gaps.some((gap) => gap.reason === 'closed' && gap.from_seq === 2));
      assert.ok(after.run.error_codes?.includes('CAPTURE_AFTER_CLOSE'));
    });
  } finally {
    stderr.mock.restore();
  }
});

it(
  'releases written payload buffers while a producer keeps the queue continuously nonempty',
  { timeout: 20000 },
  async () => {
    await withRecorder(async (recorder, directory) => {
      const probe = await open(join(directory, 'prototype-probe'), 'wx');
      const prototype = Object.getPrototypeOf(probe),
        write = prototype.write;
      await probe.close();
      const original = transport();
      recorder.wrapTransport(original, { transport: 'stdio', profile: 'worker' });
      let writes = 0,
        finish!: () => void;
      const completed = new Promise<void>((done) => {
        finish = done;
      });
      const writing = mock.method(prototype, 'write', async function (this: unknown, ...args: unknown[]) {
        const result = await write.apply(this, args);
        writes++;
        if (writes < 1100) original.onmessage!(ping(writes));
        if (writes === 1050) {
          const queue = (recorder as any).queue as ({ bytes: Buffer } | undefined)[];
          assert.equal(
            queue.reduce((sum, entry) => sum + (entry?.bytes.length ?? 0), 0),
            recorder.metrics.profile_queue_bytes,
          );
          assert.ok(queue.length < 1028, 'Consumed array storage must also be compacted.');
        }
        if (writes === 1100) finish();
        return result;
      });
      try {
        original.onmessage!(ping(0));
        await completed;
        await recorder.close();
      } finally {
        writing.mock.restore();
      }
      const { run } = await files(recorder);
      assert.equal(run.counters.profile_records_written, 1100);
      assert.equal(run.counters.profile_queue_bytes, 0);
    });
  },
);
