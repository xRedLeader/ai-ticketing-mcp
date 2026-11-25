import { countReferenceTokens } from '../src/tokens.js';
import { serializeSuccessEnvelope } from '../src/envelope.js';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { artifactIdentity } from '../src/execution-artifacts.js';
import { verifiedRecoveryEvidence } from '../src/verification-pipeline.js';

export function createMaintenanceLedger(path: string) {
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  return (kind: 'wire' | 'call', record: any) => {
    appendFileSync(path, JSON.stringify({ kind, ...record }) + '\n', { flush: true });
  };
}
export function parsePartialMaintenanceLedger(text: string) {
  const calls: any[] = [],
    wire: any[] = [],
    errors: string[] = [];
  for (const [position, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const { kind, ...record } = JSON.parse(line);
      if (record.consumer !== 'maintenance' || !['wire', 'call'].includes(kind))
        throw new Error('Unexpected consumer or record kind.');
      (kind === 'wire' ? wire : calls).push(record);
    } catch {
      errors.push(`Incomplete maintenance ledger record at line ${position + 1}.`);
    }
  }
  return {
    consumer: 'maintenance',
    success: false,
    evidence_complete: false,
    failure: 'Maintenance final summary unavailable; retained observations are incomplete.',
    calls,
    wire,
    errors,
    reference: null,
    rpc_round_trips: null,
    completed_intervals: null,
  };
}

export const usageFields = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const;
export type Usage = Record<(typeof usageFields)[number], number | null>;
export type ObservedCall = {
  id: string;
  tool: string;
  arguments: any;
  started: number;
  completed: number;
  result: any;
  envelope: any;
  error: unknown;
};
export function parseCodexInvocation(stdout: string, exitCode: number | null) {
  const calls: ObservedCall[] = [];
  const starts = new Map<string, any>();
  const completed = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  let usage: Usage = Object.fromEntries(usageFields.map((field) => [field, null])) as Usage;
  let terminal: string | undefined;
  let terminals = 0;
  let duplicateEvents = 0;
  let turnStarted = false;
  let setupNotices = 0;
  for (const [position, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      errors.push(`Invalid JSONL at line ${position + 1}.`);
      continue;
    }
    if (event.consumer && event.consumer !== 'model') {
      errors.push('Non-model observations cannot establish model delivery.');
      continue;
    }
    if (event.type === 'turn.started') turnStarted = true;
    if (event.type === 'error' || event.type === 'warning')
      errors.push(event.message ?? `Codex reported ${event.type}.`);
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      turnStarted = true;
      terminal = event.type;
      terminals++;
      if (event.usage)
        usage = Object.fromEntries(
          usageFields.map((field) => [
            field,
            Number.isSafeInteger(event.usage[field]) && event.usage[field] >= 0 ? event.usage[field] : null,
          ]),
        ) as Usage;
      if (event.type === 'turn.failed') errors.push(event.error?.message ?? 'Codex turn failed.');
    }
    const item = event.item;
    if (!item) continue;
    if (item.type === 'error') {
      if (item.message) warnings.push(item.message);
      const knownSetupNotice =
        !turnStarted &&
        setupNotices === 0 &&
        event.type === 'item.completed' &&
        Object.keys(event).sort().join(',') === 'item,type' &&
        Object.keys(item).sort().join(',') === 'id,message,type' &&
        typeof item.id === 'string' &&
        item.message ===
          'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
      if (knownSetupNotice) setupNotices++;
      else errors.push(item.message ?? 'Codex reported an item error.');
      continue;
    }
    if (item.type !== 'mcp_tool_call') {
      if (!['agent_message', 'reasoning', 'plan'].includes(item.type))
        errors.push(`Unexpected non-MCP item: ${item.type}.`);
      continue;
    }
    if (item.server !== 'ai-ticketing') errors.push(`Unexpected MCP server: ${item.server}.`);
    if (event.type === 'item.started') starts.set(item.id, { ...item, position });
    if (event.type !== 'item.completed') continue;
    if (completed.has(item.id)) {
      duplicateEvents++;
      continue;
    }
    completed.add(item.id);
    const start = starts.get(item.id);
    if (!start) errors.push(`MCP completion ${item.id} has no observed start.`);
    let envelope = item.result?.structured_content ?? item.result?.structuredContent;
    if (!envelope) {
      const text = item.result?.content?.find((block: any) => block.type === 'text')?.text;
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = null;
      }
    }
    calls.push({
      id: item.id,
      tool: item.tool,
      arguments: item.arguments ?? {},
      started: start?.position ?? position,
      completed: position,
      result: item.result,
      envelope,
      error: item.error ?? null,
    });
  }
  if (exitCode !== 0) errors.push(`Codex exited with ${exitCode === null ? 'no exit code' : exitCode}.`);
  if (terminal !== 'turn.completed') errors.push('No successful completed Codex turn.');
  if (terminals > 1) errors.push('More than one terminal turn event in one invocation.');
  const mutations = new Set([
    'work_claim',
    'work_heartbeat',
    'work_release',
    'ticket_checkpoint',
    'ticket_note',
    'ticket_submit',
    'ticket_review',
  ]);
  const requests = new Map<string, number>();
  let retries = 0;
  for (const call of calls) {
    if (!mutations.has(call.tool) || !call.arguments.idempotency_key) continue;
    const key = JSON.stringify([call.tool, call.arguments.idempotency_key, call.arguments]);
    retries += requests.has(key) ? 1 : 0;
    requests.set(key, (requests.get(key) ?? 0) + 1);
  }
  const reference = {
    request_tokens: 0,
    sdk_result_tokens: 0,
    canonical_result_tokens: 0,
    catalog_tokens: null,
  };
  for (const call of calls) {
    reference.request_tokens += countReferenceTokens(
      JSON.stringify({ name: call.tool, arguments: call.arguments }),
    );
    if (call.result !== undefined && call.result !== null)
      reference.sdk_result_tokens += countReferenceTokens(JSON.stringify(call.result));
    if (call.envelope)
      reference.canonical_result_tokens += countReferenceTokens(
        call.envelope.ok ? serializeSuccessEnvelope(call.envelope.data) : JSON.stringify(call.envelope),
      );
  }
  return {
    calls,
    usage,
    errors,
    warnings,
    setup_notice_count: setupNotices,
    duplicate_completion_events: duplicateEvents,
    identical_mutation_retries: retries,
    provider_retry_count: null,
    approval_review_usage: { status: 'not_separately_reported_by_cli', usage: null },
    approval_denials: calls
      .filter(
        (call) =>
          typeof (call.error as any)?.message === 'string' && /approval/i.test((call.error as any).message),
      )
      .map((call) => ({
        item_id: call.id,
        tool: call.tool,
        message: (call.error as any).message,
        classification:
          (call.error as any).message === 'MCP tool call requires approval, but approval policy is never'
            ? 'client_approval_policy_never_before_review'
            : 'client_approval_error_unclassified',
      })),
    reference,
  };
}

export type ExpectedWorkflow = {
  workflow: any;
  project: any;
  ticket: any;
  description: string;
  workerId: string;
  reviewerId: string;
  prerequisiteId?: string;
  contract: any;
};

export function observeArtifactEvidence(item: any, args: any, data: any) {
  const pending = { pending: item, unverified: false };
  if (data?.artifact_id !== item.arguments.artifact_id) return pending;
  if (data.status !== 'available') return { pending: null, unverified: true };
  const range = data.range,
    bytes = Buffer.from(range?.data ?? '', 'base64');
  const offset = item.nextOffset ?? item.arguments.offset ?? 0;
  const valid =
    (args.offset ?? 0) === offset &&
    range?.offset === offset &&
    range.returned_length === bytes.length &&
    bytes.length <= (args.length ?? 4096) &&
    range.data === bytes.toString('base64') &&
    range.sha256 === createHash('sha256').update(bytes).digest('hex') &&
    Number.isSafeInteger(data.size_bytes) &&
    data.size_bytes >= 0 &&
    (item.sha256 === undefined || item.sha256 === data.sha256) &&
    (item.size === undefined || item.size === data.size_bytes);
  if (!valid) return pending;
  const chunks = [...(item.chunks ?? []), bytes],
    nextOffset = offset + bytes.length;
  if (nextOffset === data.size_bytes) {
    let unverified =
      data.truncated ||
      data.omitted_bytes !== 0 ||
      data.total_bytes !== data.size_bytes ||
      createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !== data.sha256;
    if (data.artifact_id.endsWith(':result')) {
      try {
        const outcome = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        unverified ||=
          outcome.exit_code !== 0 ||
          !!outcome.signal ||
          !!outcome.error_code ||
          (!!outcome.verification &&
            (outcome.verification.status !== 'passed' ||
              outcome.verification.error_code !== null ||
              outcome.verification.cleanup_verified !== true ||
              !Array.isArray(outcome.verification.steps) ||
              !outcome.verification.steps.length ||
              !outcome.verification.steps.every(
                (step: any) =>
                  step.status === 'passed' &&
                  step.exit_code === 0 &&
                  step.signal === null &&
                  step.error_code === null &&
                  Array.isArray(step.blocked_by) &&
                  step.blocked_by.length === 0 &&
                  verifiedRecoveryEvidence(step),
              )));
      } catch {
        unverified = true;
      }
    }
    return { pending: null, unverified };
  }
  if (!bytes.length || nextOffset > data.size_bytes) return pending;
  return {
    pending: { ...item, chunks, nextOffset, sha256: data.sha256, size: data.size_bytes },
    unverified: false,
  };
}

export function submissionArtifactProof(calls: ObservedCall[], submission: any, projectId: string) {
  const references = [
    ...new Set<string>(
      (submission?.evidence ?? []).flatMap((item: any) =>
        (item.references ?? []).filter((reference: string) => artifactIdentity.test(reference)),
      ),
    ),
  ];
  const missing: string[] = [],
    unverified: string[] = [];
  for (const reference of references) {
    let item: any = { arguments: { project_id: projectId, artifact_id: reference, offset: 0 } };
    let complete = false,
      verified = false;
    for (const call of calls) {
      if (
        call.tool !== 'artifact_read' ||
        !call.envelope?.ok ||
        call.arguments.project_id !== projectId ||
        call.arguments.artifact_id !== reference
      )
        continue;
      if (!item) item = { arguments: { project_id: projectId, artifact_id: reference, offset: 0 } };
      const result = observeArtifactEvidence(item, call.arguments, call.envelope.data);
      item = result.pending;
      complete = !item;
      verified = complete && !result.unverified;
    }
    if (!complete) missing.push(reference);
    else if (!verified) unverified.push(reference);
  }
  return { references, missing, unverified };
}
function delivered(calls: ObservedCall[], expected: ExpectedWorkflow, role: 'worker' | 'reviewer') {
  const state: any = {
    ticket: {},
    criteria: [],
    blockers: undefined,
    dependencies: undefined,
    projectInstructions: undefined,
    policy: undefined,
    checkpoint: null,
    submission: null,
    submissionObservedAt: Infinity,
    resumeReceived: false,
    requirementsFloor: 0,
    pending: [],
    reviewBlockers: [],
    githubEvidence: null,
  };
  const target = (ticket: any) =>
    ticket?.id === expected.ticket.id && (!ticket.project_id || ticket.project_id === expected.project.id);
  const targetReference = (call: ObservedCall) =>
    call.arguments.project_id === expected.project.id &&
    [expected.ticket.id, expected.ticket.key].filter(Boolean).includes(call.arguments.ticket_id);
  const mergeTicket = (ticket: any) => {
    if (!target(ticket)) return false;
    const revision = ticket.requirements_revision;
    if (revision !== undefined && revision < (state.ticket.requirements_revision ?? 0)) return false;
    if (revision !== undefined && revision > (state.ticket.requirements_revision ?? 0)) {
      state.ticket = {};
      state.criteria = [];
      state.blockers = undefined;
      state.dependencies = undefined;
      state.resumeReceived = false;
      state.checkpoint = null;
      state.submission = null;
      state.submissionObservedAt = Infinity;
      state.pending = [];
      state.reviewBlockers = [];
      state.githubEvidence = null;
      state.requirementsFloor = revision > 1 ? (ticket.revision ?? Number.MAX_SAFE_INTEGER) : 0;
    }
    if (state.requirementsFloor === Number.MAX_SAFE_INTEGER && ticket.revision !== undefined)
      state.requirementsFloor = ticket.revision;
    state.ticket = { ...state.ticket, ...ticket };
    return true;
  };
  for (const call of calls) {
    if (!call.envelope?.ok) continue;
    const data = call.envelope.data;
    const candidate = data?.context ?? (data?.project_instructions ? data : null);
    let context = target(candidate?.ticket) && !candidate.not_modified ? candidate : null;
    if (context) {
      if (mergeTicket(context.ticket)) {
        state.criteria = context.criteria ?? state.criteria;
        state.projectInstructions = context.project_instructions?.text;
        state.policy = context.approval_policy;
        state.blockers = context.blockers;
        state.dependencies = context.dependencies;
        state.githubEvidence = context.github_evidence ?? null;
        if (role === 'reviewer') {
          state.reviewBlockers = context.review_blockers ?? [];
          state.pending = (context.omitted ?? [])
            .filter(
              (item: any) => item.required_before === 'review' && item.retrieve_with !== 'artifact_read',
            )
            .map((item: any) => ({ ...item, nextOffset: item.arguments?.offset ?? 0 }));
        }
      } else context = null;
    }
    if (call.tool === 'project_get' && data.project?.id === expected.project.id) {
      state.projectInstructions = data.project.instructions;
      state.policy = data.project.policy;
    }
    if (data?.ticket && mergeTicket(data.ticket)) {
      if (data.criteria) state.criteria = data.criteria;
      if (data.blockers) state.blockers = data.blockers;
      if (data.links) state.dependencies = data.links;
      if (data.github_evidence) state.githubEvidence = data.github_evidence;
    }
    const notes = [
      ...(context?.latest_checkpoint ? [context.latest_checkpoint] : []),
      ...(call.tool === 'checkpoint_get' &&
      data.project_id === expected.project.id &&
      data.ticket_id === expected.ticket.id &&
      call.arguments.project_id === expected.project.id &&
      call.arguments.checkpoint_id === data.id
        ? [data]
        : []),
    ];
    const items = [
      ...(context?.submissions ?? []),
      ...(call.tool === 'ticket_history' && targetReference(call) ? (data.items ?? []) : []),
    ];
    for (const note of [...notes, ...items.filter((item: any) => item.kind === 'checkpoint')]) {
      if (note.ticket_id && note.ticket_id !== expected.ticket.id) continue;
      if (note.ticket_revision < state.requirementsFloor) continue;
      if (
        JSON.stringify(note.metadata?.decisions) ===
          JSON.stringify(expected.contract.project.checkpoint_decisions) &&
        JSON.stringify(note.metadata?.remaining) ===
          JSON.stringify(expected.contract.project.checkpoint_remaining)
      )
        state.resumeReceived = true;
      if (!state.checkpoint || note.ticket_revision > state.checkpoint.ticket_revision)
        state.checkpoint = note;
    }
    for (const submission of items.filter((item: any) => Array.isArray(item.evidence))) {
      if (submission.ticket_id && submission.ticket_id !== expected.ticket.id) continue;
      if (!state.submission || submission.ticket_revision > state.submission.ticket_revision) {
        state.submission = submission;
        state.submissionObservedAt = call.completed;
      }
    }
    for (const evidence of items.filter((item: any) => Array.isArray(item.checks)))
      if (
        evidence.ticket_id === expected.ticket.id &&
        evidence.project_id === expected.project.id &&
        (!state.githubEvidence || evidence.ticket_revision >= state.githubEvidence.ticket_revision)
      )
        state.githubEvidence = evidence;
    state.pending = state.pending.flatMap((item: any) => {
      if (call.tool !== item.retrieve_with) return [item];
      const paged = call.tool === 'ticket_history' && !item.arguments.item_id;
      if (
        !Object.keys({ ...item.arguments, ...call.arguments }).every(
          (key) => (paged && key === 'offset') || item.arguments[key] === call.arguments[key],
        )
      )
        return [item];
      if (call.tool === 'ticket_history') {
        if (!Array.isArray(data?.items)) return [item];
        if (item.arguments.item_id)
          return data.items.some((entry: any) => entry.id === item.arguments.item_id) ? [] : [item];
        if ((call.arguments.offset ?? 0) !== item.nextOffset) return [item];
        const seen = [...(item.seen ?? []), ...data.items.map((entry: any) => entry.id)];
        if (new Set(seen).size !== seen.length) return [item];
        const more = data.has_more ?? data.items.length >= (item.arguments.limit ?? 10);
        return more ? [{ ...item, seen, nextOffset: item.nextOffset + data.items.length }] : [];
      }
      return item.arguments.checkpoint_id === data?.id ? [] : [item];
    });
  }
  const changed = expected.workflow.change && state.ticket.requirements_revision > 1;
  const criterion = changed
    ? 'The access check also rejects a revoked project member without revealing ticket data.'
    : expected.contract.project.criterion;
  const facts = {
    requirements:
      state.ticket.id === expected.ticket.id &&
      state.ticket.description === expected.description &&
      (expected.contract.project.criteria
        ? state.criteria.length === expected.contract.project.criteria.length &&
          state.criteria.every(
            (item: any, index: number) =>
              item.id === expected.contract.project.criteria[index].id &&
              item.text === expected.contract.project.criteria[index].text,
          )
        : state.criteria.length === 1 &&
          typeof state.criteria[0].id === 'string' &&
          state.criteria[0].text === criterion),
    instructions_policy:
      state.projectInstructions === expected.contract.project.instructions &&
      state.policy === expected.workflow.policy,
    blockers_dependencies:
      Array.isArray(state.blockers) &&
      Array.isArray(state.dependencies) &&
      (!expected.prerequisiteId ||
        state.dependencies.some((item: any) => item.source_id === expected.prerequisiteId)),
    resume_decisions: !expected.workflow.resume_checkpoint || state.resumeReceived,
  };
  return { state, facts };
}
export function validateRole(
  observation: ReturnType<typeof parseCodexInvocation>,
  role: 'worker' | 'reviewer',
  expected: ExpectedWorkflow,
  attempt?: Pick<ObservedCall, 'tool' | 'arguments' | 'started'>,
) {
  const errors = [...observation.errors];
  const proofs: any[] = [];
  const calls = attempt ? [{ ...attempt, id: 'pending-attempt', envelope: null }] : observation.calls;
  for (const call of calls) {
    if (!['ticket_checkpoint', 'ticket_submit', 'ticket_review', 'ticket_note'].includes(call.tool)) continue;
    if (call.tool === 'ticket_note' && call.arguments.kind !== 'answer') continue;
    const { state, facts } = delivered(
      observation.calls.filter((prior) => prior.completed < call.started),
      expected,
      role,
    );
    const missing = Object.entries(facts)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    let artifacts: ReturnType<typeof submissionArtifactProof> | undefined;
    if (role === 'reviewer') {
      const submission = state.submission;
      artifacts = submissionArtifactProof(
        observation.calls.filter(
          (prior) => prior.started > state.submissionObservedAt && prior.completed < call.started,
        ),
        submission,
        expected.project.id,
      );
      if (artifacts.missing.length) missing.push('submitted_artifact_bytes');
      if (call.arguments.decision === 'approve' && artifacts.unverified.length)
        missing.push('submitted_artifact_failed');
      if (state.pending.length) missing.push('required_review_omission_recovery');
      if (call.arguments.decision === 'approve' && state.reviewBlockers.length)
        missing.push('review_evidence_unverified');
      if (call.arguments.decision === 'approve' && state.ticket.github_pull_request) {
        const github = state.githubEvidence;
        if (
          !github ||
          github.stale ||
          github.status !== 'passed' ||
          github.requirements_revision !== state.ticket.requirements_revision ||
          github.repository !== state.ticket.github_pull_request.repository ||
          github.pull_request_number !== state.ticket.github_pull_request.number ||
          github.head_sha !== github.observed_head_sha ||
          !github.checks?.length ||
          !github.checks.every(
            (check: any) =>
              check.head_sha === github.head_sha &&
              check.app_id === check.required_app_id &&
              check.run_id &&
              check.status === 'completed' &&
              check.conclusion === 'success',
          )
        )
          missing.push('github_evidence_unverified');
      }
      if (
        !submission ||
        submission.id !== call.arguments.submission_id ||
        submission.requirements_revision !== state.ticket.requirements_revision ||
        submission.actor_id === expected.reviewerId ||
        submission.evidence.length !== state.criteria.length ||
        new Set(submission.evidence.map((item: any) => item.criterion_id)).size !== state.criteria.length ||
        !state.criteria.every((criterion: any) =>
          submission.evidence.some(
            (item: any) =>
              item.criterion_id === criterion.id &&
              typeof item.summary === 'string' &&
              item.summary.length > 0 &&
              ['pass', 'fail'].includes(item.result) &&
              (call.arguments.decision !== 'approve' || item.result === 'pass') &&
              item.references?.length &&
              item.references.every(
                (reference: any) => typeof reference === 'string' && reference.length > 0,
              ),
          ),
        )
      )
        missing.push('current_submission_evidence');
    }
    if (call.tool === 'ticket_submit') {
      if (
        !Array.isArray(call.arguments.evidence) ||
        !state.criteria.every((criterion: any) =>
          call.arguments.evidence.some((item: any) => item.criterion_id === criterion.id),
        )
      )
        missing.push('submitted_criterion_identity');
      if (expected.workflow.change && state.ticket.requirements_revision < 2)
        missing.push('replacement_requirements');
    }
    if (call.tool === 'ticket_checkpoint' && call.envelope?.ok) {
      const last = expected.description.match(/[^.!?]+[.!?](?=\s*$)/u)?.[0].trim() ?? expected.description;
      const first =
        expected.contract.project.instructions.match(/^[^.!?]+[.!?]/u)?.[0].trim() ??
        expected.contract.project.instructions;
      if (
        !call.arguments.progress?.includes(last) ||
        !call.arguments.progress?.includes(first) ||
        !call.arguments.progress?.includes(`approval_policy=${expected.workflow.policy}`)
      )
        missing.push('model_requirement_instruction_policy_acknowledgement');
      if (
        expected.workflow.resume_checkpoint &&
        !expected.contract.project.checkpoint_decisions.every((decision: string) =>
          call.arguments.decisions?.includes(decision),
        )
      )
        missing.push('model_resume_decision_acknowledgement');
    }
    if (call.tool === 'ticket_review' && call.envelope?.ok && state.submission) {
      if (
        !state.criteria.every((criterion: any) => call.arguments.feedback?.includes(criterion.id)) ||
        !state.submission.evidence.every((item: any) =>
          item.references.every((reference: string) => call.arguments.feedback?.includes(reference)),
        )
      )
        missing.push('model_submission_reference_acknowledgement');
    }
    if (
      call.tool === 'ticket_note' &&
      !state.blockers?.some(
        (item: any) => item.code === 'QUESTION_BLOCKED' && item.reference === call.arguments.answer_to,
      )
    )
      missing.push('received_blocking_question');
    if (missing.length) errors.push(`${role}/${call.tool} started before receiving: ${missing.join(', ')}.`);
    proofs.push({
      tool: call.tool,
      item_id: call.id,
      all_required_received_before_start: missing.length === 0,
      missing,
      ...(artifacts ? { artifacts } : {}),
    });
  }
  const successful = (tool: string) =>
    observation.calls.filter((call) => call.tool === tool && call.envelope?.ok);
  if (!attempt && role === 'worker') {
    for (const tool of ['work_claim', 'ticket_checkpoint', 'ticket_submit'])
      if (!successful(tool).length) errors.push(`Worker did not successfully complete ${tool}.`);
    if (
      expected.workflow.blocking &&
      !observation.calls.some(
        (call) =>
          call.tool === 'work_claim' &&
          ['DEPENDENCY_BLOCKED', 'NO_ELIGIBLE_WORK'].includes(call.envelope?.error?.code),
      )
    )
      errors.push('Blocked workflow did not observe a rejected initial claim.');
    if (
      expected.workflow.change &&
      !observation.calls.some(
        (call) => call.tool === 'ticket_checkpoint' && call.envelope?.error?.code === 'CLAIM_EXPIRED',
      )
    )
      errors.push('Requirement-change workflow did not observe its forced stale checkpoint failure.');
  } else if (!attempt && !successful('ticket_review').length)
    errors.push('Reviewer did not successfully review the submission.');
  return { success: errors.length === 0, errors, proofs };
}
export function aggregateUsage(invocations: { usage: Usage }[]) {
  return Object.fromEntries(
    usageFields.map((field) => [
      field,
      {
        known_total: invocations.reduce((sum, item) => sum + (item.usage[field] ?? 0), 0),
        unknown_invocations: invocations.filter((item) => item.usage[field] === null).length,
      },
    ]),
  );
}
function toml(value: any): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`)
    .join(', ')} }`;
}
export function codexArguments(options: {
  model: string;
  effort: string;
  cwd: string;
  node: string;
  server: string;
  config: string;
  database: string;
  actor: string;
}) {
  const mcp = {
    'ai-ticketing': {
      command: options.node,
      args: [options.server],
      env: {
        MCP_BENCH_FIXTURE: options.config,
        STORAGE_ADAPTER: 'sqlite',
        SQLITE_PATH: options.database,
        ACTOR_ID: options.actor,
        EMBEDDING_PROVIDER: 'none',
      },
      enabled: true,
      required: true,
    },
  };
  return [
    '--no-daemon',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--strict-config',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    options.cwd,
    '--model',
    options.model,
    '--config',
    `model_reasoning_effort=${toml(options.effort)}`,
    '--config',
    'approval_policy="on-request"',
    '--config',
    'approvals_reviewer="auto_review"',
    '--config',
    'tool_output_token_limit=32768',
    '--config',
    'project_doc_max_bytes=0',
    '--config',
    'web_search="disabled"',
    '--config',
    'suppress_unstable_features_warning=true',
    '--enable',
    'skip_host_skill_discovery',
    ...[
      'plugins',
      'apps',
      'shell_tool',
      'unified_exec',
      'multi_agent',
      'multi_agent_v2',
      'code_mode',
      'code_mode_host',
      'browser_use',
      'computer_use',
      'image_generation',
      'view_image',
      'sleep_tool',
      'goals',
      'memories',
      'remote_plugin',
      'recommended_plugins',
      'skill_search',
      'hooks',
      'workspace_dependencies',
      'in_app_browser',
      'unbounded_connection_retries',
    ].flatMap((feature) => ['--disable', feature]),
    '--config',
    `mcp_servers=${toml(mcp)}`,
    '-',
  ];
}
