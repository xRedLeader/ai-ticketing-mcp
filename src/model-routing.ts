import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const routeSchema = z.strictObject({
  id,
  provider: z.literal('openai'),
  model: id,
  effort: id,
  capabilities: z.array(id).min(1),
  evaluation: z.strictObject({ report: id, sha256: hash }).optional(),
});
export const modelRoutingPolicySchema = z.strictObject({
  revision: id,
  enabled: z.boolean(),
  baseline_route: id,
  scope: z.literal('protocol-workflows-v1'),
  reviewer: z.strictObject({ model: id, effort: id }),
  environment: z.strictObject({
    runtime_revision: id,
    runtime_sha256: hash,
    client_version: id,
    scenario_contract_sha256: hash,
    fixture_server_sha256: hash,
    measurement_source_sha256: z.record(id, hash),
  }),
  routes: z.array(routeSchema).min(1),
  minimum_token_reduction: z.number().min(0).max(1).default(0),
});
export const modelRoutingRequestSchema = z.strictObject({
  route_id: id,
  model_pin: id.optional(),
  effort_pin: id.optional(),
  required_capabilities: z.array(id).min(1),
});
export type ModelRoutingPolicy = z.input<typeof modelRoutingPolicySchema>;
export type ModelRoute = z.output<typeof routeSchema>;
export type ModelRoutingRequest = z.input<typeof modelRoutingRequestSchema>;
export type RoutingEvaluation = {
  report: string;
  sha256: string;
  environment: z.output<typeof modelRoutingPolicySchema>['environment'];
  reviewer: { model: string; effort: string };
  route: { model: string; effort: string };
  workflow_ids: string[];
  completed_workflows: number;
  failed_attempts: number;
  invocations: number;
  usage: Record<string, { known_total: number; unknown_invocations: number }>;
  workflow_usage: Record<string, Record<string, { known_total: number; unknown_invocations: number }>>;
  study_budget: { run_id: string; database: string; attempts: unknown[] };
  monetary_cost: unknown;
  approval_review_usage: { status: string; usage: null };
  attempts: {
    id: string;
    workflow: string;
    original_status: string;
    effective_status: string;
    errors: string[];
    artifact_sha256: Record<string, string>;
  }[];
};
export const routingWorkflows = ['short', 'long', 'history', 'review', 'blocked', 'requirements_change'];
export const routingCapabilities = [
  'coordination_claim',
  'coordination_resume',
  'coordination_review',
  'coordination_blockers',
  'coordination_changes',
];

/** Only the offline artifact verifier supplies evaluations. This never changes a default route. */
export function decideModelRoute(
  policyInput: ModelRoutingPolicy,
  requestInput: ModelRoutingRequest,
  evaluations: Record<string, RoutingEvaluation> = {},
) {
  const policy = modelRoutingPolicySchema.parse(policyInput);
  const request = modelRoutingRequestSchema.parse(requestInput);
  if (new Set(policy.routes.map((route) => route.id)).size !== policy.routes.length)
    throw new Error('Route IDs must be unique.');
  const baseline = policy.routes.find((route) => route.id === policy.baseline_route);
  if (!baseline) throw new Error('The baseline route must be allowlisted.');
  const selected = policy.routes.find((route) => route.id === request.route_id);
  const reasons: string[] = [];
  if (!selected) reasons.push('route_not_allowlisted');
  if (selected) {
    if (request.model_pin && request.model_pin !== selected.model) reasons.push('model_pin_mismatch');
    if (request.effort_pin && request.effort_pin !== selected.effort) reasons.push('effort_pin_mismatch');
    if (request.required_capabilities.some((capability) => !selected.capabilities.includes(capability)))
      reasons.push('capability_not_allowlisted');
    if (request.required_capabilities.some((capability) => !routingCapabilities.includes(capability)))
      reasons.push('capability_not_evaluated_by_scope');
  }
  if (selected && selected.id !== baseline.id) {
    if (!policy.enabled) reasons.push('alternate_routing_disabled');
    for (const route of [baseline, selected]) {
      const evaluation = evaluations[route.id];
      if (
        !evaluation ||
        !route.evaluation ||
        evaluation.sha256 !== route.evaluation.sha256 ||
        evaluation.report !== route.evaluation.report
      ) {
        reasons.push(`verified_evaluation_missing:${route.id}`);
        continue;
      }
      if (!isDeepStrictEqual(evaluation.environment, policy.environment))
        reasons.push(`evaluation_environment_mismatch:${route.id}`);
      if (
        evaluation.reviewer.model !== policy.reviewer.model ||
        evaluation.reviewer.effort !== policy.reviewer.effort
      )
        reasons.push(`fixed_reviewer_mismatch:${route.id}`);
      if (evaluation.route.model !== route.model || evaluation.route.effort !== route.effort)
        reasons.push(`evaluation_route_mismatch:${route.id}`);
      if (
        evaluation.completed_workflows !== routingWorkflows.length ||
        [...evaluation.workflow_ids].sort().join() !== [...routingWorkflows].sort().join()
      )
        reasons.push(`representative_completion_missing:${route.id}`);
      if (routingCapabilities.some((capability) => !route.capabilities.includes(capability)))
        reasons.push(`representative_capabilities_missing:${route.id}`);
      for (const field of ['input_tokens', 'output_tokens'])
        if (!evaluation.usage[field] || evaluation.usage[field].unknown_invocations !== 0)
          reasons.push(`provider_usage_unknown:${route.id}:${field}`);
    }
    const before = evaluations[baseline.id],
      after = evaluations[selected.id];
    if (before && after) {
      if (after.failed_attempts > before.failed_attempts) reasons.push('failed_attempts_regressed');
      const tokens = (evaluation: RoutingEvaluation) =>
        (evaluation.usage.input_tokens?.known_total ?? 0) +
        (evaluation.usage.output_tokens?.known_total ?? 0);
      if (tokens(before) <= 0 || tokens(after) > tokens(before) * (1 - policy.minimum_token_reduction))
        reasons.push('reported_token_reduction_not_met');
      for (const workflow of routingWorkflows) {
        const baselineUsage = before.workflow_usage[workflow],
          candidateUsage = after.workflow_usage[workflow];
        if (
          !baselineUsage ||
          !candidateUsage ||
          ['input_tokens', 'output_tokens'].some(
            (field) =>
              baselineUsage[field]?.unknown_invocations !== 0 ||
              candidateUsage[field]?.unknown_invocations !== 0,
          )
        )
          reasons.push(`workflow_provider_usage_unknown:${workflow}`);
        else if (
          candidateUsage.input_tokens!.known_total + candidateUsage.output_tokens!.known_total >
          baselineUsage.input_tokens!.known_total + baselineUsage.output_tokens!.known_total
        )
          reasons.push(`workflow_provider_tokens_regressed:${workflow}`);
      }
    }
  }
  return {
    status: reasons.length ? ('denied' as const) : ('eligible' as const),
    reasons,
    policy_revision: policy.revision,
    configuration: policy,
    request,
    selected_route: selected ?? null,
    evaluations,
    budget_admission: 'required_before_invocation' as const,
    limitations: [
      'Only the six declared coordination workflows are evaluated; no general coding qualification.',
      'Provider model identity, monetary cost, and approval-review usage remain unobserved when the client does not report them.',
    ],
  };
}
