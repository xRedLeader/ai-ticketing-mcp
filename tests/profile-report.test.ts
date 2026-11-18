import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { analyzeProfile } from '../src/profile-report.js';
import { countReferenceTokens } from '../src/tokens.js';

const message = (
  seq: number,
  connection: string,
  direction: 'incoming' | 'outgoing',
  payload: any,
  extra: any = {},
) => ({
  v: 1,
  type: 'message',
  seq,
  at_ms: 1000 + seq,
  monotonic_ms: seq,
  connection_id: connection,
  transport: 'stdio',
  profile: 'worker',
  direction,
  payload: JSON.stringify(payload),
  ...extra,
});
const sent = (
  seq: number,
  messageSeq: number,
  connection = 'private-connection',
  outcome = 'sent',
  extra: any = {},
) => ({
  v: 1,
  type: 'send_result',
  seq,
  at_ms: 1000 + seq,
  monotonic_ms: seq,
  connection_id: connection,
  message_seq: messageSeq,
  outcome,
  ...extra,
});
const request = (id: string | number, name = 'ticket_get', args: any = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const result = (id: string | number, data: any = {}) => {
  const envelope = { ok: true, data, error: null };
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope },
  };
};
async function recording(
  records: any[],
  work: (directory: string, metadata: any) => Promise<void>,
  modify: (metadata: any) => void = () => {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'profile-report-test-'));
  const text = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
  const last = Math.max(0, ...records.map((record) => record.seq));
  const metadata = {
    v: 1,
    run_id: 'PRIVATE_RUN_ID',
    started_at: '2026-11-18T00:00:00.000Z',
    status: 'closed',
    last_sequence: last,
    limits: { max_file_bytes: 8388608, max_files: 8, max_queue_bytes: 16777216 },
    gaps: [],
    gap_ranges_omitted: 0,
    error_codes: [],
    counters: {
      profile_records_seen: last,
      profile_records_written: records.length,
      profile_records_dropped: 0,
      profile_records_evicted: 0,
      profile_messages_seen: records.filter((record) => record.type === 'message').length,
      profile_messages_written: records.filter((record) => record.type === 'message').length,
      profile_bytes_written: Buffer.byteLength(text),
      profile_bytes_evicted: 0,
      profile_segments_evicted: 0,
      profile_queue_bytes: 0,
      profile_peak_queue_bytes: Buffer.byteLength(text),
      profile_capture_errors: 0,
    },
    segments: records.length
      ? [
          {
            file: 'events-000001.jsonl',
            first_seq: records[0].seq,
            last_seq: records.at(-1).seq,
            records: records.length,
            bytes: Buffer.byteLength(text),
          },
        ]
      : [],
  };
  modify(metadata);
  try {
    await writeFile(join(directory, 'run.json'), JSON.stringify(metadata));
    if (records.length)
      await writeFile(join(directory, metadata.segments[0]?.file ?? 'events-000001.jsonl'), text);
    await work(directory, metadata);
  } finally {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('profile-report-test-'));
    await rm(directory, { recursive: true });
  }
}

it('counts exact ordinary-text Unicode projections without emitting recorded content or identities', async () => {
  const req = request('PRIVATE_RPC_ID', 'ticket_get', {
    ticket_id: 'PRIVATE_ARGUMENT',
    bearer: 'PRIVATE_AUTHORIZATION',
  });
  const reply = result('PRIVATE_RPC_ID', { body: 'PRIVATE_CONTENT <|endoftext|> 🧪' });
  const records = [
    message(1, 'private-connection', 'incoming', req, { actor_id: 'PRIVATE_ACTOR' }),
    message(2, 'private-connection', 'outgoing', reply),
    sent(3, 2),
  ];
  await recording(records, async (directory) => {
    const report = await analyzeProfile(directory);
    assert.equal(report.complete, true);
    assert.equal(report.totals.matched_calls, 1);
    assert.equal(
      report.messages[0]!.serialized_rpc.reference_tokens,
      countReferenceTokens(JSON.stringify(req)),
    );
    assert.equal(report.messages[1]!.serialized_rpc.bytes, Buffer.byteLength(JSON.stringify(reply)));
    assert.equal(
      report.totals.sdk_tool_results.reference_tokens,
      countReferenceTokens(JSON.stringify(reply.result)),
    );
    assert.equal(
      report.totals.canonical_text.reference_tokens,
      countReferenceTokens(reply.result.content[0]!.text),
    );
    assert.ok(
      report.totals.sdk_tool_results.reference_tokens > report.totals.canonical_text.reference_tokens,
    );
    assert.equal(report.calls[0]!.response_snapshot_elapsed_ms, 1);
    assert.equal(report.calls[0]!.response_send_completed_elapsed_ms, 2);
    const serialized = JSON.stringify(report);
    for (const secret of [
      'PRIVATE_RPC_ID',
      'PRIVATE_ARGUMENT',
      'PRIVATE_AUTHORIZATION',
      'PRIVATE_CONTENT',
      'PRIVATE_ACTOR',
      'private-connection',
      'PRIVATE_RUN_ID',
    ])
      assert.ok(!serialized.includes(secret));
    assert.deepEqual((await readFile(join(directory, 'run.json'), 'utf8')).includes('PRIVATE_RUN_ID'), true);
  });
});

it('separates typed IDs, connections, bidirectional origins, and notifications', async () => {
  const records = [
    message(1, 'a', 'incoming', request(1)),
    message(2, 'a', 'incoming', request('1')),
    message(3, 'b', 'incoming', request(1)),
    message(4, 'a', 'outgoing', { jsonrpc: '2.0', id: 1, method: 'ping' }),
    sent(5, 4, 'a'),
    message(6, 'a', 'outgoing', result(1)),
    sent(7, 6, 'a'),
    message(8, 'a', 'outgoing', result('1')),
    sent(9, 8, 'a'),
    message(10, 'b', 'outgoing', result(1)),
    sent(11, 10, 'b'),
    message(12, 'a', 'incoming', { jsonrpc: '2.0', id: 1, result: {} }),
    message(13, 'a', 'incoming', { jsonrpc: '2.0', method: 'notifications/initialized' }),
  ];
  await recording(records, async (directory) => {
    const report = await analyzeProfile(directory);
    assert.equal(report.complete, true);
    assert.equal(report.totals.matched_calls, 4);
    assert.equal(report.totals.notifications, 1);
    assert.equal(report.totals.unanswered_requests, 0);
    assert.equal(report.totals.orphan_replies, 0);
    assert.equal(new Set(report.calls.map((call) => call.connection)).size, 2);
  });
});

it('allows sequential ID reuse but flags overlapping requests, duplicate replies, unanswered and orphan messages', async () => {
  const records = [
    message(1, 'private-connection', 'incoming', request(1)),
    message(2, 'private-connection', 'outgoing', result(1)),
    sent(3, 2),
    message(4, 'private-connection', 'incoming', request(1)),
    message(5, 'private-connection', 'outgoing', result(1)),
    sent(6, 5),
    message(7, 'private-connection', 'incoming', request(2)),
    message(8, 'private-connection', 'outgoing', result(99)),
    sent(9, 8),
    message(10, 'private-connection', 'incoming', request(3)),
    message(11, 'private-connection', 'outgoing', result(3)),
    sent(12, 11),
    message(13, 'private-connection', 'outgoing', result(3)),
    sent(14, 13),
    message(15, 'private-connection', 'incoming', request(4)),
    message(16, 'private-connection', 'incoming', request(4)),
    message(17, 'private-connection', 'outgoing', result(4)),
    sent(18, 17),
    message(19, 'private-connection', 'outgoing', result(4)),
    sent(20, 19),
  ];
  await recording(records, async (directory) => {
    const report = await analyzeProfile(directory);
    assert.equal(report.complete, false);
    assert.equal(report.capture_complete, true);
    assert.equal(report.totals.ambiguous_calls, 3);
    assert.equal(report.totals.matched_calls, 2);
    assert.equal(report.totals.unanswered_requests, 1);
    assert.equal(report.totals.orphan_replies, 1);
    assert.ok(
      report.calls
        .filter((call) => call.status === 'ambiguous')
        .every((call) => call.response_sequence === null && call.response_snapshot_elapsed_ms === null),
    );
  });
});

it('separates outgoing attempts, send completion, failed sends, and pending sends', async () => {
  await recording(
    [
      message(1, 'private-connection', 'incoming', request(1)),
      message(2, 'private-connection', 'outgoing', result(1)),
      sent(3, 2, 'private-connection', 'failed'),
      message(4, 'private-connection', 'outgoing', {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {},
      }),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.equal(report.totals.failed_sends, 1);
      assert.equal(report.totals.pending_sends, 1);
      assert.equal(report.calls[0]!.response_snapshot_elapsed_ms, 1);
      assert.equal(report.calls[0]!.response_send_completed_elapsed_ms, null);
      assert.equal(report.calls[0]!.response_send_finished_elapsed_ms, 2);
      assert.equal(report.messages[1]!.send_status, 'failed');
      assert.equal(report.totals.unanswered_requests, 0);
    },
  );
});

it('classifies only identical mutation retries within known actor or otherwise one connection', async () => {
  const records: any[] = [];
  const push = (connection: string, tool: string, args: any, actor?: string) => {
    const seq = records.length + 1;
    records.push(
      message(seq, connection, 'incoming', request(seq, tool, args), actor ? { actor_id: actor } : {}),
      message(seq + 1, connection, 'outgoing', result(seq)),
      sent(seq + 2, seq + 1, connection),
    );
  };
  push('a', 'ticket_note', { idempotency_key: 'PRIVATE_KEY', body: 'Same prose.' }, 'actor-one');
  push('b', 'ticket_note', { body: 'Same prose.', idempotency_key: 'PRIVATE_KEY' }, 'actor-one');
  push('b', 'ticket_note', { idempotency_key: 'PRIVATE_KEY', body: 'Changed prose.' }, 'actor-one');
  push('c', 'ticket_note', { idempotency_key: 'PRIVATE_KEY', body: 'Same prose.' }, 'actor-two');
  push('d', 'ticket_note', { idempotency_key: 'unknown', body: 'Same prose.' });
  push('e', 'ticket_note', { idempotency_key: 'unknown', body: 'Same prose.' });
  push('d', 'ticket_note', { idempotency_key: 'unknown', body: 'Same prose.' });
  push('d', 'changes_since', { cursor: 0, idempotency_key: 'invalid-read-key' });
  push('d', 'changes_since', { cursor: 0, idempotency_key: 'invalid-read-key' });
  await recording(records, async (directory) => {
    const report = await analyzeProfile(directory);
    assert.equal(report.complete, true);
    assert.equal(report.totals.derived_retries, 2);
    assert.equal(report.calls[1]!.retry_of_request_sequence, 1);
    assert.equal(report.calls[2]!.retry_of_request_sequence, null);
    assert.ok(report.calls.slice(-2).every((call) => call.retry_of_request_sequence === null));
  });
});

it('keeps sent protocol and ordinary invalid-tool errors complete without exposing their messages', async () => {
  const records = [
    message(1, 'private-connection', 'incoming', request(1)),
    message(2, 'private-connection', 'outgoing', {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'PRIVATE_VALIDATION_ERROR' },
    }),
    sent(3, 2),
    message(4, 'private-connection', 'incoming', request(2)),
    message(5, 'private-connection', 'outgoing', {
      jsonrpc: '2.0',
      id: 2,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              data: null,
              error: { code: 'NOT_FOUND', message: 'PRIVATE_TOOL_ERROR' },
            }),
          },
        ],
        structuredContent: {
          ok: false,
          data: null,
          error: { code: 'NOT_FOUND', message: 'PRIVATE_TOOL_ERROR' },
        },
      },
    }),
    sent(6, 5),
  ];
  await recording(records, async (directory) => {
    const report = await analyzeProfile(directory);
    assert.equal(report.complete, true);
    assert.equal(report.calls[0]!.protocol_error, true);
    assert.equal(report.calls[1]!.tool_error, true);
    assert.ok(!JSON.stringify(report).includes('PRIVATE_'));
  });
});

it('separates discovery projections and safely rejects malformed discovery elements', async () => {
  const tools = [
    {
      name: 'ticket_get',
      description: 'Read current ticket.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { duplicated: { type: 'string' } } },
    },
  ];
  await recording(
    [
      message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      message(2, 'private-connection', 'outgoing', { jsonrpc: '2.0', id: 1, result: { tools } }),
      sent(3, 2),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, true);
      assert.ok(
        report.totals.discovery_results.reference_tokens >
          report.totals.input_catalog_projection.reference_tokens,
      );
      assert.equal(report.totals.sdk_tool_results.reference_tokens, 0);
      assert.equal(report.totals.canonical_text_samples, 0);
    },
  );
  await recording(
    [
      message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      message(2, 'private-connection', 'outgoing', { jsonrpc: '2.0', id: 1, result: { tools: [null] } }),
      sent(3, 2),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.ok(report.incomplete_reasons.includes('malformed_discovery_result'));
      assert.ok(report.totals.discovery_results.reference_tokens > 0);
    },
  );
});

it('retains valid prefix measurements for a truncated tail and rejects unknown formats safely', async () => {
  await recording(
    [message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', method: 'notifications/initialized' })],
    async (directory) => {
      const path = join(directory, 'events-000001.jsonl');
      await writeFile(path, (await readFile(path, 'utf8')) + '{"PRIVATE_TRUNCATED_CONTENT"');
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.equal(report.run.malformed_records, 1);
      assert.equal(report.totals.messages, 1);
      assert.ok(report.incomplete_reasons.includes('unterminated_segment'));
      assert.ok(!JSON.stringify(report).includes('PRIVATE_TRUNCATED_CONTENT'));
      const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
      run.v = 99;
      await writeFile(join(directory, 'run.json'), JSON.stringify(run));
      await assert.rejects(analyzeProfile(directory), /^Error: Profile run metadata is invalid\.$/);
    },
  );
});

it('flags open, dropped, rotated, omitted-gap, and tampered segment metadata', async () => {
  await recording(
    [message(11, 'private-connection', 'incoming', { jsonrpc: '2.0', method: 'notifications/initialized' })],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.equal(report.capture_complete, false);
      assert.equal(report.run.missing_sequences, 10);
      for (const reason of [
        'run_not_closed',
        'profile_records_dropped',
        'profile_records_evicted',
        'profile_segments_evicted',
        'gap_ranges_omitted',
      ])
        assert.ok(report.incomplete_reasons.includes(reason));
    },
    (metadata) => {
      metadata.status = 'open';
      metadata.counters.profile_records_dropped = 1;
      metadata.counters.profile_records_evicted = 10;
      metadata.counters.profile_segments_evicted = 1;
      metadata.gap_ranges_omitted = 1;
    },
  );
  await recording(
    [message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', method: 'notifications/initialized' })],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.ok(report.incomplete_reasons.includes('segment_metadata_mismatch'));
    },
    (metadata) => {
      metadata.segments[0].bytes++;
    },
  );
});

it('does not expose unknown route/profile metadata and refuses negative observed durations', async () => {
  await recording(
    [
      message(
        1,
        'private-connection',
        'incoming',
        { jsonrpc: '2.0', id: 1, method: 'PRIVATE_METHOD' },
        { profile: 'PRIVATE_PROFILE', monotonic_ms: 10 },
      ),
      message(2, 'private-connection', 'outgoing', result(1), { monotonic_ms: 5 }),
      sent(3, 2, 'private-connection', 'sent', { monotonic_ms: 20 }),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.equal(report.calls[0]!.response_snapshot_elapsed_ms, null);
      assert.equal(report.messages[0]!.method, 'other');
      assert.equal(report.messages[0]!.profile, 'other');
      assert.ok(!JSON.stringify(report).includes('PRIVATE_'));
      assert.ok(report.totals.invalid_durations > 0);
    },
  );
});

it('validates required manifest fields and reconciles closed-run record and message counters', async () => {
  const mutations = [
    (run: any) => {
      delete run.gaps;
    },
    (run: any) => {
      run.gaps = [{ from_seq: 2, to_seq: 1, count: 0, reason: 'queue_full' }];
    },
    (run: any) => {
      run.gap_ranges_omitted = 'unknown';
    },
    (run: any) => {
      delete run.limits;
    },
    (run: any) => {
      delete run.started_at;
    },
    (run: any) => {
      run.counters.profile_messages_written = 0;
    },
    (run: any) => {
      run.counters.profile_records_dropped = 1;
    },
    (run: any) => {
      run.error_codes = ['TRANSPORT_ERROR'];
      run.counters.profile_capture_errors = 1;
    },
  ];
  for (const mutate of mutations)
    await recording(
      [message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', method: 'notifications/initialized' })],
      async (directory) => {
        const report = await analyzeProfile(directory);
        assert.equal(report.complete, false);
        assert.equal(report.capture_complete, false);
      },
      mutate,
    );
});

it('rejects completion timestamps before their outgoing snapshot and mixed request/response envelopes', async () => {
  await recording(
    [
      message(1, 'private-connection', 'incoming', request(1), { monotonic_ms: 1 }),
      message(2, 'private-connection', 'outgoing', result(1), { monotonic_ms: 10 }),
      sent(3, 2, 'private-connection', 'sent', { monotonic_ms: 5 }),
      message(4, 'private-connection', 'incoming', { jsonrpc: '2.0', id: 2, method: 'ping', result: {} }),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, false);
      assert.equal(report.calls[0]!.response_send_completed_elapsed_ms, null);
      assert.equal(report.totals.invalid_durations, 1);
      assert.equal(report.totals.malformed_messages, 1);
    },
  );
});

it('recognizes modern server discovery as discovery without exposing its instructions', async () => {
  await recording(
    [
      message(1, 'private-connection', 'incoming', { jsonrpc: '2.0', id: 1, method: 'server/discover' }),
      message(2, 'private-connection', 'outgoing', {
        jsonrpc: '2.0',
        id: 1,
        result: { instructions: 'PRIVATE_DISCOVERY_INSTRUCTIONS', tools: [] },
      }),
      sent(3, 2),
    ],
    async (directory) => {
      const report = await analyzeProfile(directory);
      assert.equal(report.complete, true);
      assert.equal(report.calls[0]!.method, 'server/discover');
      assert.ok(report.totals.discovery_results.reference_tokens > 0);
      assert.ok(!JSON.stringify(report).includes('PRIVATE_DISCOVERY_INSTRUCTIONS'));
    },
  );
});
