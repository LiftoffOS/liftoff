// Phase C — per-tenant reactive subscription quotas.
//
// Zod schemas enforce per-agent limits (max 10 subs). Per-tenant aggregate
// limits require a DB query: total <=200 reactive_subscriptions, total <=20
// computed_metric variants. Called from agent create/update API handlers
// BEFORE persisting trigger config. Mirrored in tenant-runtime when the
// activation lifecycle runs (defense in depth).

import { getPool } from '../infrastructure/database';

const PER_TENANT_REACTIVE_SUBSCRIPTIONS_MAX = 200;
const PER_TENANT_COMPUTED_METRIC_MAX = 20;

export interface ReactiveSubscriptionShape {
  label: string;
  source: { kind: 'connector_event' | 'system_event' | 'computed_metric' };
}

export class QuotaExceededError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'QuotaExceededError';
  }
}

export async function assertReactiveSubscriptionQuotas(
  tenantId: string,
  proposed: ReactiveSubscriptionShape[],
  excludeAgentId?: string,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ total: string; computed_metric: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE jsonb_path_query_array(trigger_config, '$.reactiveSubscriptions[*].source.kind')
                              @> '["computed_metric"]'::jsonb) AS computed_metric
     FROM agents
     WHERE tenant_id = $1
       AND ($2::uuid IS NULL OR id <> $2)
       AND jsonb_array_length(COALESCE(trigger_config->'reactiveSubscriptions', '[]'::jsonb)) > 0`,
    [tenantId, excludeAgentId ?? null]
  );

  const existingTotal = Number(rows[0]?.total ?? 0);
  const existingComputed = Number(rows[0]?.computed_metric ?? 0);
  const proposedTotal = proposed.length;
  const proposedComputed = proposed.filter(s => s.source.kind === 'computed_metric').length;

  if (existingTotal + proposedTotal > PER_TENANT_REACTIVE_SUBSCRIPTIONS_MAX) {
    throw new QuotaExceededError(
      `tenant ${tenantId} would exceed ${PER_TENANT_REACTIVE_SUBSCRIPTIONS_MAX} reactive subscriptions ` +
      `(existing=${existingTotal}, proposed=${proposedTotal})`
    );
  }
  if (existingComputed + proposedComputed > PER_TENANT_COMPUTED_METRIC_MAX) {
    throw new QuotaExceededError(
      `tenant ${tenantId} would exceed ${PER_TENANT_COMPUTED_METRIC_MAX} computed_metric subscriptions ` +
      `(existing=${existingComputed}, proposed=${proposedComputed})`
    );
  }
}
