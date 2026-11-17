// Snapshot Service
//
// Rolls up cost_attribution_events into hourly and daily snapshots stored in
// cost_attribution_snapshots. Run once per hour (after the ingest cycle).
//
// Strategy: recompute the last 48 hours of hourly snapshots and the last
// 7 days of daily snapshots on every run. This is idempotent — the upsert
// handles re-runs gracefully. Recomputing a wider window than strictly
// necessary ensures late-arriving events (e.g. GCP billing export lag) are
// incorporated without a separate backfill step.
//
// Real-time OU billing flows through spend-subscriber.ts via billing.meterEvents.
// (A daily ou-reporting-service used to write reconciliation snapshots to
// stripe_usage_reports here; both are removed -- the snapshot was a lossy copy
// of a figure recomputable from billing_spend_events at any time.)

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { upsertSnapshot } from './repository';
import type { CostAttributionSnapshot } from './types';

interface SnapshotAggRow {
  tenant_id:          string;
  agent_id:           string | null;
  total_cost_usd:     string;
  llm_cost_usd:       string;
  connector_cost_usd: string;
  infra_cost_usd:     string;
  total_invocations:  string;
  total_actions:      string;
  total_input_tokens: string;
  total_output_tokens:string;
}

/**
 * Recompute one snapshot window from cost_attribution_events and upsert it.
 *
 * Exported so `scripts/backfill-attribution-agent-ids.ts` can rebuild the
 * windows whose events it re-keyed from the runtime id space into the
 * control-plane id space. Blind re-keying of the snapshot rows themselves is
 * unsafe — the partial unique indexes (idx_cas_agent_period_uniq /
 * idx_cas_noagent_period_uniq) would collide when a runtime-keyed row and an
 * internal-keyed row exist for the same (tenant, period) — so the backfill
 * deletes the stale rows and calls this to rebuild.
 */
export async function computeAndUpsertWindow(
  periodStart: Date,
  periodEnd:   Date,
  granularity: 'hour' | 'day' | 'month',
): Promise<number> {
  // cost_attribution_events is RLS-on (migration 200). Snapshot rollup
  // aggregates cross-tenant (GROUP BY tenant_id) so admin scope is the only
  // correct option for the read. The per-tenant upsertSnapshot below runs
  // under withTenantScope inside the repository.
  const result = await withAdminScope(
    {
      caller: 'cost-attribution.snapshot-service.computeAndUpsertWindow',
      reason: 'cross-tenant cost rollup for hourly/daily snapshots',
    },
    (client) =>
      client.query<SnapshotAggRow>(
        // Snapshots feed customer-facing cost displays via cost_attribution_snapshots
        // → /insights downstream. Sum customer_cost_usd (bucket-rated) so the
        // rollup matches what /insights shows live; raw cost_usd is no longer
        // displayed anywhere customer-facing after PR 1.
        `SELECT
           tenant_id,
           agent_id,
           COALESCE(SUM(customer_cost_usd),                                                    0) AS total_cost_usd,
           COALESCE(SUM(CASE WHEN event_type = 'llm_invocation' THEN customer_cost_usd END),   0) AS llm_cost_usd,
           COALESCE(SUM(CASE WHEN event_type = 'connector_call' THEN customer_cost_usd END),   0) AS connector_cost_usd,
           COALESCE(SUM(CASE WHEN event_type = 'infra_compute'  THEN customer_cost_usd END),   0) AS infra_cost_usd,
           COUNT(CASE WHEN event_type = 'llm_invocation' THEN 1 END)                              AS total_invocations,
           COUNT(CASE WHEN event_type = 'connector_call' THEN 1 END)                              AS total_actions,
           COALESCE(SUM(input_tokens),  0)                                                        AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)                                                        AS total_output_tokens
         FROM cost_attribution_events
         WHERE occurred_at >= $1
           AND occurred_at <  $2
         GROUP BY tenant_id, agent_id`,
        [periodStart, periodEnd],
      ),
  );

  let upserted = 0;
  for (const row of result.rows) {
    const snapshot: CostAttributionSnapshot = {
      tenantId:          row.tenant_id,
      agentId:           row.agent_id,
      workflowId:        null,
      periodStart,
      periodEnd,
      granularity,
      totalCostUsd:      parseFloat(row.total_cost_usd),
      llmCostUsd:        parseFloat(row.llm_cost_usd),
      connectorCostUsd:  parseFloat(row.connector_cost_usd),
      infraCostUsd:      parseFloat(row.infra_cost_usd),
      totalInvocations:  parseInt(row.total_invocations, 10),
      totalActions:      parseInt(row.total_actions, 10),
      totalInputTokens:  parseInt(row.total_input_tokens, 10),
      totalOutputTokens: parseInt(row.total_output_tokens, 10),
    };
    await upsertSnapshot(snapshot);
    upserted++;
  }
  return upserted;
}


export async function runSnapshotService(): Promise<{ hours: number; days: number }> {
  const now = new Date();
  let hours = 0;
  let days  = 0;

  // ── Hourly snapshots: last 48 hours ───────────────────────────────
  // Truncate to the start of the most recent completed hour
  const latestCompleteHour = new Date(now);
  latestCompleteHour.setMinutes(0, 0, 0);

  for (let i = 0; i < 48; i++) {
    const periodEnd   = new Date(latestCompleteHour.getTime() - i * 3_600_000);
    const periodStart = new Date(periodEnd.getTime()           - 3_600_000);

    try {
      const n = await computeAndUpsertWindow(periodStart, periodEnd, 'hour');
      hours += n;
    } catch (err) {
      log.error(
        { error: (err as Error).message, periodStart, periodEnd },
        'snapshot-service: hourly window failed',
      );
    }
  }

  // ── Daily snapshots: last 7 days ──────────────────────────────────
  // Use UTC day boundaries
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let i = 1; i <= 7; i++) {
    const periodStart = new Date(todayStart.getTime() - i * 86_400_000);
    const periodEnd   = new Date(todayStart.getTime() - (i - 1) * 86_400_000);

    try {
      const n = await computeAndUpsertWindow(periodStart, periodEnd, 'day');
      days += n;
    } catch (err) {
      log.error(
        { error: (err as Error).message, periodStart, periodEnd },
        'snapshot-service: daily window failed',
      );
    }
  }

  log.info({ hours, days }, 'snapshot-service: complete');
  return { hours, days };
}
