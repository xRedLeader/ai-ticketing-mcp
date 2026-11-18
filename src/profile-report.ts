import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { countReferenceTokens } from './tokens.js';
import { schemas, readOperations } from './schemas.js';

export interface ProfileMeasure {
  bytes: number;
  reference_tokens: number;
}
export type ProfileSendStatus = 'not_applicable' | 'pending' | 'sent' | 'failed' | 'ambiguous';
export interface ProfileMessageReport {
  sequence: number;
  connection: number;
  transport: 'stdio' | 'http';
  profile: 'worker' | 'planner' | 'reviewer' | 'full' | 'other';
  direction: 'incoming' | 'outgoing';
  kind: 'request' | 'notification' | 'response' | 'malformed';
  method: string | null;
  operation: string | null;
  serialized_rpc: ProfileMeasure;
  payload_sha256: string;
  send_status: ProfileSendStatus;
  sdk_tool_result: ProfileMeasure | null;
  canonical_text: ProfileMeasure | null;
  canonical_text_status: 'matched' | 'missing' | 'mismatch' | 'not_applicable';
  discovery_result: ProfileMeasure | null;
  input_catalog_projection: ProfileMeasure | null;
}
export interface ProfileCallReport {
  index: number;
  connection: number;
  transport: ProfileMessageReport['transport'];
  profile: ProfileMessageReport['profile'];
  origin: 'incoming' | 'outgoing';
  method: string;
  operation: string | null;
  request_sequence: number;
  response_sequence: number | null;
  status: 'matched' | 'unanswered' | 'ambiguous';
  request_send_status: ProfileSendStatus;
  response_send_status: ProfileSendStatus | null;
  response_snapshot_elapsed_ms: number | null;
  response_send_completed_elapsed_ms: number | null;
  response_send_finished_elapsed_ms: number | null;
  protocol_error: boolean;
  tool_error: boolean;
  retry_of_request_sequence: number | null;
  request_fingerprint_sha256: string;
}
export interface ProfileOperationReport {
  method: string;
  operation: string | null;
  requests: number;
  matched: number;
  unanswered: number;
  ambiguous: number;
  retries: number;
  protocol_errors: number;
  tool_errors: number;
  serialized_rpc_requests: ProfileMeasure;
  serialized_rpc_responses: ProfileMeasure;
  sdk_tool_results: ProfileMeasure;
  canonical_text: ProfileMeasure;
  canonical_text_samples: number;
  discovery_results: ProfileMeasure;
  input_catalog_projection: ProfileMeasure;
  response_snapshot_elapsed_ms: { samples: number; total: number; min: number | null; max: number | null };
}
export interface ProfileReport {
  v: 1;
  complete: boolean;
  capture_complete: boolean;
  incomplete_reasons: string[];
  run: {
    status: 'open' | 'closed' | 'error';
    metadata_sha256: string;
    run_id_sha256: string;
    segments: number;
    records: number;
    last_sequence: number;
    counters: Record<string, number>;
    missing_sequences: number;
    duplicate_sequences: number;
    malformed_records: number;
  };
  measurement: {
    tokenizer: 'js-tiktoken 1.0.21 / o200k_base / ordinary text';
    surface: string;
    projections: string;
    duration: string;
    retries: string;
    provider_usage: null;
    monetary_cost_usd: null;
  };
  totals: {
    messages: number;
    requests: number;
    notifications: number;
    responses: number;
    malformed_messages: number;
    matched_calls: number;
    unanswered_requests: number;
    orphan_replies: number;
    ambiguous_calls: number;
    derived_retries: number;
    pending_sends: number;
    failed_sends: number;
    ambiguous_sends: number;
    orphan_send_results: number;
    invalid_durations: number;
    incoming_serialized_rpc: ProfileMeasure;
    outgoing_serialized_rpc: ProfileMeasure;
    sdk_tool_results: ProfileMeasure;
    canonical_text: ProfileMeasure;
    canonical_text_samples: number;
    discovery_results: ProfileMeasure;
    input_catalog_projection: ProfileMeasure;
  };
  messages: ProfileMessageReport[];
  calls: ProfileCallReport[];
  operations: ProfileOperationReport[];
}

type Direction = 'incoming' | 'outgoing';
type Event = {
  v: 1;
  type: 'message' | 'send_result';
  seq: number;
  at_ms: number;
  monotonic_ms: number;
  connection_id: string;
  transport?: string;
  profile?: string;
  actor_id?: string;
  direction?: Direction;
  payload?: string;
  message_seq?: number;
  outcome?: 'sent' | 'failed';
};
type Message = { event: Event; parsed: any; report: ProfileMessageReport; sends: Event[] };
const counterNames = [
  'profile_records_seen',
  'profile_records_written',
  'profile_records_dropped',
  'profile_records_evicted',
  'profile_messages_seen',
  'profile_messages_written',
  'profile_bytes_written',
  'profile_bytes_evicted',
  'profile_segments_evicted',
  'profile_queue_bytes',
  'profile_peak_queue_bytes',
  'profile_capture_errors',
] as const;
const methods = new Set([
  'initialize',
  'server/discover',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
  'sampling/createMessage',
  'elicitation/create',
  'roots/list',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/message',
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
  'notifications/prompts/list_changed',
  'notifications/roots/list_changed',
]);
const discoveryMethods = new Set([
  'initialize',
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);
const operations = new Set(Object.keys(schemas));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const measure = (value: string): ProfileMeasure => ({
  bytes: Buffer.byteLength(value),
  reference_tokens: countReferenceTokens(value),
});
const empty = (): ProfileMeasure => ({ bytes: 0, reference_tokens: 0 });
const add = (target: ProfileMeasure, value: ProfileMeasure | null) => {
  if (value) {
    target.bytes += value.bytes;
    target.reference_tokens += value.reference_tokens;
  }
};
const stable = (value: any): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: any) => Number.isSafeInteger(value) && value >= 0;
const id = (value: any) =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const opposite = (direction: Direction): Direction => (direction === 'incoming' ? 'outgoing' : 'incoming');
const route = (value: any) => (methods.has(value) ? (value as string) : 'other');
const operation = (value: any) => (operations.has(value) ? (value as string) : 'other');
const key = (message: Message, origin: Direction) =>
  JSON.stringify([message.event.connection_id, origin, typeof message.parsed.id, message.parsed.id]);

function validEvent(value: any): value is Event {
  if (
    !object(value) ||
    value.v !== 1 ||
    !integer(value.seq) ||
    value.seq < 1 ||
    !Number.isFinite(value.at_ms) ||
    !Number.isFinite(value.monotonic_ms) ||
    value.monotonic_ms < 0 ||
    typeof value.connection_id !== 'string' ||
    !value.connection_id
  )
    return false;
  if (value.type === 'message')
    return (
      ['incoming', 'outgoing'].includes(value.direction) &&
      ['stdio', 'http'].includes(value.transport) &&
      typeof value.profile === 'string' &&
      typeof value.payload === 'string' &&
      (value.actor_id === undefined || typeof value.actor_id === 'string')
    );
  return (
    value.type === 'send_result' &&
    integer(value.message_seq) &&
    value.message_seq > 0 &&
    ['sent', 'failed'].includes(value.outcome)
  );
}

/** Reads only the selected recording directory. Output contains no captured content or identifiers. */
export async function analyzeProfile(directory: string): Promise<ProfileReport> {
  const metadataBytes = await readFile(join(directory, 'run.json'));
  if (!isUtf8(metadataBytes)) throw new Error('Profile run metadata is invalid.');
  let metadata: any;
  try {
    metadata = JSON.parse(metadataBytes.toString('utf8'));
  } catch {
    throw new Error('Profile run metadata is invalid.');
  }
  if (
    !object(metadata) ||
    metadata.v !== 1 ||
    !['open', 'closed', 'error'].includes(metadata.status) ||
    typeof metadata.run_id !== 'string' ||
    !integer(metadata.last_sequence) ||
    !object(metadata.counters)
  )
    throw new Error('Profile run metadata is invalid.');
  const reasons = new Set<string>();
  if (metadata.status !== 'closed') reasons.add('run_not_closed');
  const timestamp = (value: any) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (
    !timestamp(metadata.started_at) ||
    (metadata.ended_at !== undefined &&
      (!timestamp(metadata.ended_at) || Date.parse(metadata.ended_at) < Date.parse(metadata.started_at)))
  )
    reasons.add('invalid_run_timestamps');
  if (
    !object(metadata.limits) ||
    !['max_file_bytes', 'max_files', 'max_queue_bytes'].every(
      (name) => integer(metadata.limits[name]) && metadata.limits[name] > 0,
    )
  )
    reasons.add('invalid_capture_limits');
  if (
    !Array.isArray(metadata.gaps) ||
    !metadata.gaps.every(
      (gap: any) =>
        object(gap) &&
        integer(gap.from_seq) &&
        gap.from_seq > 0 &&
        integer(gap.to_seq) &&
        gap.to_seq >= gap.from_seq &&
        gap.count === gap.to_seq - gap.from_seq + 1 &&
        typeof gap.reason === 'string',
    ) ||
    !integer(metadata.gap_ranges_omitted)
  )
    reasons.add('invalid_gap_metadata');
  if (
    metadata.error_codes !== undefined &&
    (!Array.isArray(metadata.error_codes) ||
      !metadata.error_codes.every((code: any) => typeof code === 'string'))
  )
    reasons.add('invalid_error_metadata');
  const counters: Record<string, number> = {};
  for (const name of counterNames) {
    if (!integer(metadata.counters[name])) reasons.add('invalid_capture_counters');
    else counters[name] = metadata.counters[name];
  }
  for (const name of [
    'profile_records_dropped',
    'profile_records_evicted',
    'profile_segments_evicted',
    'profile_capture_errors',
    'profile_queue_bytes',
  ])
    if ((counters[name] ?? 0) > 0) reasons.add(name);
  if (Array.isArray(metadata.gaps) && metadata.gaps.length) reasons.add('recorded_gaps');
  if (metadata.gap_ranges_omitted > 0) reasons.add('gap_ranges_omitted');
  if (Array.isArray(metadata.error_codes) && metadata.error_codes.length)
    reasons.add('recorded_capture_errors');

  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^events-\d{6,}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
  const declared = Array.isArray(metadata.segments) ? metadata.segments : [];
  if (!Array.isArray(metadata.segments)) reasons.add('missing_segment_manifest');
  if (
    !declared.every(
      (segment: any) =>
        object(segment) &&
        typeof segment.file === 'string' &&
        /^events-\d{6,}\.jsonl$/.test(segment.file) &&
        integer(segment.records) &&
        integer(segment.bytes) &&
        integer(segment.first_seq) &&
        segment.first_seq > 0 &&
        integer(segment.last_seq) &&
        segment.last_seq >= segment.first_seq,
    )
  )
    reasons.add('invalid_segment_manifest');
  const declaredNames = declared.map((segment: any) => segment?.file);
  if (stable(names) !== stable(declaredNames)) reasons.add('segment_manifest_mismatch');
  const events: Event[] = [];
  let malformedRecords = 0,
    fileBytes = 0,
    rows = 0;
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    if (!isUtf8(bytes)) reasons.add('invalid_segment_utf8');
    fileBytes += bytes.length;
    const text = bytes.toString('utf8');
    if (text && !text.endsWith('\n')) reasons.add('unterminated_segment');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    rows += lines.length;
    const segmentEvents: Event[] = [];
    for (const line of lines) {
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        malformedRecords++;
        continue;
      }
      if (!validEvent(value)) {
        malformedRecords++;
        continue;
      }
      events.push(value);
      segmentEvents.push(value);
    }
    const segment = declared.find((item: any) => item?.file === name);
    if (
      metadata.status === 'closed' &&
      (!segment ||
        segment.bytes !== bytes.length ||
        segment.records !== lines.length ||
        segment.first_seq !== segmentEvents[0]?.seq ||
        segment.last_seq !== segmentEvents.at(-1)?.seq)
    )
      reasons.add('segment_metadata_mismatch');
  }
  if (malformedRecords) reasons.add('malformed_records');
  const sequences = new Set<number>();
  let duplicates = 0,
    previous = 0;
  for (const event of events) {
    if (sequences.has(event.seq)) duplicates++;
    if (event.seq <= previous) reasons.add('non_monotonic_record_sequences');
    sequences.add(event.seq);
    previous = event.seq;
  }
  const sorted = [...sequences].sort((a, b) => a - b);
  let missing = 0,
    cursor = 0;
  for (const sequence of sorted) {
    missing += Math.max(0, sequence - cursor - 1);
    cursor = sequence;
  }
  missing += Math.max(0, metadata.last_sequence - cursor);
  if (missing) reasons.add('missing_sequences');
  if (duplicates) reasons.add('duplicate_sequences');
  if (cursor > metadata.last_sequence) reasons.add('metadata_last_sequence_lags');
  if (
    metadata.status === 'closed' &&
    (rows !== (counters.profile_records_written ?? 0) - (counters.profile_records_evicted ?? 0) ||
      fileBytes !== (counters.profile_bytes_written ?? 0) - (counters.profile_bytes_evicted ?? 0) ||
      metadata.last_sequence !== counters.profile_records_seen)
  )
    reasons.add('capture_counter_mismatch');
  const retainedMessages = events.filter((event) => event.type === 'message').length;
  if (
    metadata.status === 'closed' &&
    (counters.profile_records_seen !==
      (counters.profile_records_written ?? 0) + (counters.profile_records_dropped ?? 0) ||
      (counters.profile_records_evicted ?? 0) > (counters.profile_records_written ?? 0) ||
      (counters.profile_bytes_evicted ?? 0) > (counters.profile_bytes_written ?? 0) ||
      (counters.profile_messages_written ?? 0) > (counters.profile_records_written ?? 0) ||
      (counters.profile_messages_seen ?? 0) > (counters.profile_records_seen ?? 0) ||
      (counters.profile_messages_written ?? 0) > (counters.profile_messages_seen ?? 0) ||
      (counters.profile_messages_seen ?? 0) - (counters.profile_messages_written ?? 0) >
        (counters.profile_records_dropped ?? 0) ||
      retainedMessages > (counters.profile_messages_written ?? 0) ||
      ((counters.profile_records_evicted ?? 0) === 0 &&
        retainedMessages !== counters.profile_messages_written))
  )
    reasons.add('capture_message_counter_mismatch');

  const connections = new Map<string, number>();
  const messages: Message[] = [];
  for (const event of events.filter((event) => event.type === 'message')) {
    let parsed: any;
    try {
      parsed = JSON.parse(event.payload!);
    } catch {
      parsed = null;
    }
    const rpc = object(parsed) && parsed.jsonrpc === '2.0';
    let kind: ProfileMessageReport['kind'] = 'malformed';
    if (
      rpc &&
      typeof parsed.method === 'string' &&
      !Object.hasOwn(parsed, 'result') &&
      !Object.hasOwn(parsed, 'error')
    )
      kind = !Object.hasOwn(parsed, 'id') ? 'notification' : id(parsed.id) ? 'request' : 'malformed';
    else if (
      rpc &&
      !Object.hasOwn(parsed, 'method') &&
      Object.hasOwn(parsed, 'id') &&
      (id(parsed.id) || parsed.id === null) &&
      Object.hasOwn(parsed, 'result') !== Object.hasOwn(parsed, 'error')
    )
      kind = 'response';
    if (!connections.has(event.connection_id)) connections.set(event.connection_id, connections.size + 1);
    messages.push({
      event,
      parsed,
      sends: [],
      report: {
        sequence: event.seq,
        connection: connections.get(event.connection_id)!,
        direction: event.direction!,
        kind,
        transport: event.transport as 'stdio' | 'http',
        profile: ['worker', 'planner', 'reviewer', 'full'].includes(event.profile!)
          ? (event.profile as ProfileMessageReport['profile'])
          : 'other',
        method: ['request', 'notification'].includes(kind) ? route(parsed.method) : null,
        operation: parsed?.method === 'tools/call' ? operation(parsed.params?.name) : null,
        serialized_rpc: measure(event.payload!),
        payload_sha256: sha256(event.payload!),
        send_status: event.direction === 'incoming' ? 'not_applicable' : 'pending',
        sdk_tool_result: null,
        canonical_text: null,
        canonical_text_status: 'not_applicable',
        discovery_result: null,
        input_catalog_projection: null,
      },
    });
  }
  const bySequence = new Map<number, Message[]>();
  for (const message of messages) {
    const group = bySequence.get(message.event.seq);
    if (group) group.push(message);
    else bySequence.set(message.event.seq, [message]);
  }
  let orphanSends = 0,
    invalidDurations = 0;
  const invalidSendTimes = new Set<Event>();
  for (const send of events.filter((event) => event.type === 'send_result')) {
    const candidates = bySequence.get(send.message_seq!) ?? [];
    if (
      candidates.length !== 1 ||
      candidates[0]!.event.direction !== 'outgoing' ||
      candidates[0]!.event.connection_id !== send.connection_id ||
      send.seq <= send.message_seq!
    ) {
      orphanSends++;
      continue;
    }
    if (send.monotonic_ms < candidates[0]!.event.monotonic_ms) {
      invalidDurations++;
      invalidSendTimes.add(send);
    }
    candidates[0]!.sends.push(send);
  }
  for (const message of messages.filter((message) => message.event.direction === 'outgoing'))
    message.report.send_status =
      message.sends.length === 0
        ? 'pending'
        : message.sends.length > 1
          ? 'ambiguous'
          : message.sends[0]!.outcome!;

  const pending = new Map<string, Message[]>(),
    pairs = new Map<Message, Message>(),
    ambiguousRequests = new Set<Message>(),
    lastAnswered = new Map<string, Message>();
  let orphanReplies = 0;
  for (const message of messages) {
    if (message.report.kind === 'request') {
      const group = key(message, message.event.direction!);
      const existing = pending.get(group) ?? [];
      if (existing.length) {
        for (const request of existing) ambiguousRequests.add(request);
        ambiguousRequests.add(message);
      }
      existing.push(message);
      pending.set(group, existing);
    } else if (message.report.kind === 'response') {
      const group = key(message, opposite(message.event.direction!));
      const existing = pending.get(group) ?? [];
      const request = existing.shift();
      if (request) {
        if (!ambiguousRequests.has(request)) pairs.set(request, message);
        lastAnswered.set(group, request);
      } else {
        const previousRequest = lastAnswered.get(group);
        if (previousRequest) {
          ambiguousRequests.add(previousRequest);
          pairs.delete(previousRequest);
        } else orphanReplies++;
      }
    }
  }
  const calls: ProfileCallReport[] = [];
  const retries = new Map<string, number>();
  const elapsed = (start: Event, end: Event | undefined) => {
    if (!end) return null;
    const value = end.monotonic_ms - start.monotonic_ms;
    if (value < 0) {
      invalidDurations++;
      return null;
    }
    return value;
  };
  for (const message of messages.filter((message) => message.report.kind === 'request')) {
    const ambiguous = ambiguousRequests.has(message);
    const response = !ambiguous ? pairs.get(message) : undefined;
    const fingerprint = sha256(stable({ method: message.parsed.method, params: message.parsed.params }));
    let retryOf: number | null = null;
    const idempotency = message.parsed.params?.arguments?.idempotency_key;
    if (
      message.parsed.method === 'tools/call' &&
      operations.has(message.parsed.params?.name) &&
      !readOperations.has(message.parsed.params.name) &&
      typeof idempotency === 'string' &&
      idempotency
    ) {
      const identity = message.event.actor_id
        ? ['actor', message.event.actor_id]
        : ['connection', message.event.connection_id];
      const retryKey = stable([identity, message.event.direction, idempotency, fingerprint]);
      retryOf = retries.get(retryKey) ?? null;
      if (retryOf === null) retries.set(retryKey, message.event.seq);
    }
    if (response) {
      response.report.method = message.report.method;
      response.report.operation = message.report.operation;
      const result = response.parsed.result;
      if (message.parsed.method === 'tools/call' && result !== undefined) {
        response.report.sdk_tool_result = measure(JSON.stringify(result));
        const text = Array.isArray(result?.content)
          ? result.content.find((block: any) => block?.type === 'text')?.text
          : undefined;
        response.report.canonical_text_status = 'missing';
        if (typeof text === 'string') {
          let envelope: any;
          try {
            envelope = JSON.parse(text);
          } catch {
            envelope = null;
          }
          if (
            object(envelope) &&
            typeof envelope.ok === 'boolean' &&
            Object.hasOwn(envelope, 'data') &&
            Object.hasOwn(envelope, 'error')
          ) {
            if (
              result.structuredContent === undefined ||
              stable(envelope) === stable(result.structuredContent)
            ) {
              response.report.canonical_text = measure(text);
              response.report.canonical_text_status = 'matched';
            } else response.report.canonical_text_status = 'mismatch';
          }
        }
      }
      if (discoveryMethods.has(message.parsed.method) && result !== undefined) {
        response.report.discovery_result = measure(JSON.stringify(result));
        if (message.parsed.method === 'tools/list') {
          if (
            Array.isArray(result?.tools) &&
            result.tools.every(
              (tool: any) => object(tool) && typeof tool.name === 'string' && object(tool.inputSchema),
            )
          )
            response.report.input_catalog_projection = measure(
              stable(
                result.tools.map((tool: any) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              ),
            );
          else reasons.add('malformed_discovery_result');
        }
      }
    }
    let send = response?.sends.length === 1 ? response.sends[0] : undefined;
    if (send && invalidSendTimes.has(send)) send = undefined;
    const sendFinished = response ? elapsed(message.event, send) : null;
    calls.push({
      index: calls.length + 1,
      connection: message.report.connection,
      transport: message.report.transport,
      profile: message.report.profile,
      origin: message.event.direction!,
      method: message.report.method!,
      operation: message.report.operation,
      request_sequence: message.event.seq,
      response_sequence: response?.event.seq ?? null,
      status: ambiguous ? 'ambiguous' : response ? 'matched' : 'unanswered',
      request_send_status: message.report.send_status,
      response_send_status: response?.report.send_status ?? null,
      response_snapshot_elapsed_ms: response ? elapsed(message.event, response.event) : null,
      response_send_completed_elapsed_ms: send?.outcome === 'sent' ? sendFinished : null,
      response_send_finished_elapsed_ms: sendFinished,
      protocol_error: !!response && Object.hasOwn(response.parsed, 'error'),
      tool_error:
        !!response &&
        message.parsed.method === 'tools/call' &&
        (response.parsed.result?.isError === true || response.parsed.result?.structuredContent?.ok === false),
      retry_of_request_sequence: retryOf,
      request_fingerprint_sha256: fingerprint,
    });
  }
  const captureComplete = reasons.size === 0;
  const totals: ProfileReport['totals'] = {
    messages: messages.length,
    requests: calls.length,
    notifications: messages.filter((message) => message.report.kind === 'notification').length,
    responses: messages.filter((message) => message.report.kind === 'response').length,
    malformed_messages: messages.filter((message) => message.report.kind === 'malformed').length,
    matched_calls: calls.filter((call) => call.status === 'matched').length,
    unanswered_requests: calls.filter((call) => call.status === 'unanswered').length,
    orphan_replies: orphanReplies,
    ambiguous_calls: calls.filter((call) => call.status === 'ambiguous').length,
    derived_retries: calls.filter((call) => call.retry_of_request_sequence !== null).length,
    pending_sends: messages.filter((message) => message.report.send_status === 'pending').length,
    failed_sends: messages.filter((message) => message.report.send_status === 'failed').length,
    ambiguous_sends: messages.filter((message) => message.report.send_status === 'ambiguous').length,
    orphan_send_results: orphanSends,
    invalid_durations: invalidDurations,
    incoming_serialized_rpc: empty(),
    outgoing_serialized_rpc: empty(),
    sdk_tool_results: empty(),
    canonical_text: empty(),
    canonical_text_samples: 0,
    discovery_results: empty(),
    input_catalog_projection: empty(),
  };
  const grouped = new Map<string, ProfileOperationReport>();
  for (const message of messages) {
    const row = message.report;
    add(
      row.direction === 'incoming' ? totals.incoming_serialized_rpc : totals.outgoing_serialized_rpc,
      row.serialized_rpc,
    );
    add(totals.sdk_tool_results, row.sdk_tool_result);
    add(totals.canonical_text, row.canonical_text);
    if (row.canonical_text) totals.canonical_text_samples++;
    add(totals.discovery_results, row.discovery_result);
    add(totals.input_catalog_projection, row.input_catalog_projection);
  }
  for (const call of calls) {
    const groupKey = stable([call.method, call.operation]);
    let group = grouped.get(groupKey);
    if (!group) {
      group = {
        method: call.method,
        operation: call.operation,
        requests: 0,
        matched: 0,
        unanswered: 0,
        ambiguous: 0,
        retries: 0,
        protocol_errors: 0,
        tool_errors: 0,
        serialized_rpc_requests: empty(),
        serialized_rpc_responses: empty(),
        sdk_tool_results: empty(),
        canonical_text: empty(),
        canonical_text_samples: 0,
        discovery_results: empty(),
        input_catalog_projection: empty(),
        response_snapshot_elapsed_ms: { samples: 0, total: 0, min: null, max: null },
      };
      grouped.set(groupKey, group);
    }
    group.requests++;
    group[call.status]++;
    if (call.retry_of_request_sequence !== null) group.retries++;
    if (call.protocol_error) group.protocol_errors++;
    if (call.tool_error) group.tool_errors++;
    const request = bySequence.get(call.request_sequence)![0]!;
    const response =
      call.response_sequence === null ? undefined : bySequence.get(call.response_sequence)?.[0];
    add(group.serialized_rpc_requests, request.report.serialized_rpc);
    if (response) {
      add(group.serialized_rpc_responses, response.report.serialized_rpc);
      add(group.sdk_tool_results, response.report.sdk_tool_result);
      add(group.canonical_text, response.report.canonical_text);
      if (response.report.canonical_text) group.canonical_text_samples++;
      add(group.discovery_results, response.report.discovery_result);
      add(group.input_catalog_projection, response.report.input_catalog_projection);
    }
    const duration = call.response_snapshot_elapsed_ms;
    if (duration !== null) {
      const stats = group.response_snapshot_elapsed_ms;
      stats.samples++;
      stats.total += duration;
      stats.min = Math.min(stats.min ?? duration, duration);
      stats.max = Math.max(stats.max ?? duration, duration);
    }
  }
  for (const name of [
    'malformed_messages',
    'unanswered_requests',
    'orphan_replies',
    'ambiguous_calls',
    'pending_sends',
    'failed_sends',
    'ambiguous_sends',
    'orphan_send_results',
    'invalid_durations',
  ] as const)
    if (totals[name]) reasons.add(name);
  if (messages.some((message) => message.report.canonical_text_status === 'mismatch'))
    reasons.add('canonical_text_mismatch');
  return {
    v: 1,
    complete: reasons.size === 0,
    capture_complete: captureComplete,
    incomplete_reasons: [...reasons].sort(),
    run: {
      status: metadata.status,
      metadata_sha256: sha256(metadataBytes),
      run_id_sha256: sha256(metadata.run_id),
      segments: names.length,
      records: rows,
      last_sequence: metadata.last_sequence,
      counters,
      missing_sequences: missing,
      duplicate_sequences: duplicates,
      malformed_records: malformedRecords,
    },
    measurement: {
      tokenizer: 'js-tiktoken 1.0.21 / o200k_base / ordinary text',
      surface:
        'Serialized parsed JSON-RPC payload snapshots. Not original transport bytes, headers, framing, SSE, or client-rendered/model input.',
      projections:
        'Full RPC, SDK tool result including duplication, exact matching envelope text, and discovery are separate overlapping projections; never add them as a bill. Tool projections require unambiguous tools/call correlation. Input catalog projection recursively sorts name/description/inputSchema keys. Hashes fingerprint analyzed input; manifest consistency is not cryptographic authenticity.',
      duration:
        'Server-observed monotonic intervals from request snapshot to response snapshot or outgoing send completion. Not client/network/provider latency; sent means transport send returned, not exactly-once client delivery.',
      retries:
        'Derived identical idempotency-keyed full method/params requests, scoped to known actor or otherwise one connection and origin. Read polling is not a retry; unknown cross-connection actors are not merged.',
      provider_usage: null,
      monetary_cost_usd: null,
    },
    totals,
    messages: messages.map((message) => message.report),
    calls,
    operations: [...grouped.values()],
  };
}
