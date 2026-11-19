import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { HostCapacity } from './host-capacity.js';
import { ensure, type ExecutionLocalStatus, type ExecutionStatusProvider } from './contracts.js';

/** Operator configuration only; return this run's sanitized observations, never a host-wide report. */
export function createExecutionStatusProvider(filename: string, hostId: string): ExecutionStatusProvider {
  ensure(
    isAbsolute(filename) && hostId.trim().length > 0 && hostId.length <= 256,
    'INVALID_CONFIG',
    'Execution status requires an absolute ledger path and bounded host ID.',
  );
  return {
    observe(projectId, runId) {
      if (!existsSync(filename)) return null;
      let host: HostCapacity | undefined;
      try {
        host = new HostCapacity(filename);
        const status: ExecutionLocalStatus = {
          observed_at: new Date().toISOString(),
          capacity: null,
          budget: null,
        };
        try {
          const entry = host
            .inspect(hostId)
            .entries.find(
              (entry) => entry.queue_id === runId && entry.run_id === runId && entry.project_id === projectId,
            );
          if (entry) {
            const reason = entry.reason;
            status.capacity = {
              state: entry.state,
              reason:
                reason === null
                  ? null
                  : reason.startsWith('needs_attention:')
                    ? 'budget_needs_attention'
                    : [
                          'capacity',
                          'fair_capacity_wait',
                          'lease_expired',
                          'cancel_requested',
                          'restart_reconciliation',
                        ].includes(reason)
                      ? (reason as NonNullable<ExecutionLocalStatus['capacity']>['reason'])
                      : 'other',
              lease_expires_at: entry.lease_until === null ? null : new Date(entry.lease_until).toISOString(),
              timeout_at:
                entry.admitted_at === null
                  ? null
                  : new Date(entry.admitted_at + entry.timeout_ms).toISOString(),
            };
          }
        } catch {
          /* Unobserved capacity never means a free slot. */
        }
        try {
          const report = host.report(runId);
          if (report.config.run_id === runId && report.config.project_id === projectId) {
            const used = report.budget_charged_or_reserved,
              limits = report.config.limits;
            status.budget = {
              status: report.status as 'ready' | 'needs_attention',
              basis: 'charged_or_reserved',
              remaining: {
                attempts: Math.max(0, limits.max_attempts - used.attempts),
                provider_tokens: Math.max(0, limits.max_provider_tokens - used.provider_tokens),
                runtime_ms: Math.max(0, limits.max_runtime_ms - used.runtime_ms),
                cost_usd_micros:
                  limits.max_cost_usd_micros === null
                    ? null
                    : Math.max(0, limits.max_cost_usd_micros - used.cost_usd_micros),
              },
              unknown_usage_invocations: report.totals.provider_usage.total_tokens.unknown_invocations,
              in_flight: report.totals.in_flight,
            };
          }
        } catch {
          /* A script need not have an agent-usage budget. */
        }
        return status;
      } catch {
        return null;
      } finally {
        host?.close();
      }
    },
  };
}
