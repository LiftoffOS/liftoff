// Composio quota governance — reads.
//
// RLS scope: `cost_attribution_events` and `tenants` are both RLS-on. Every
// read here is deliberately CROSS-TENANT — the whole point of an org-wide
// meter is that no single tenant's scope can see it — so withAdminScope is the
// correct primitive, the same one the cost-attribution ingesters use on this
// exact table (see cost-attribution/repository.ts::insertEvents). No tenant
// data leaves this module: the service turns these counts into one tenant's
// allocation and returns nothing else.

import { withAdminScope } from '../infrastructure/database';

/** Org-wide Composio consumption for one monthly window. */
export interface OrgConsumption {
  /** Every Composio tool call recorded in the window, all tenants. */
  orgCalls: number;
  /** Per-tenant breakdown. A tenant with no calls is absent, not zero. */
  perTenant: Map<string, number>;
  /** Start of the window (UTC). */
  periodStart: Date;
  /** Start of the NEXT window (UTC). */
  periodEnd: Date;
}

/** First instant of the current calendar month, UTC. Composio's quota is
 *  monthly; anchoring on UTC keeps every runtime's window identical regardless
 *  of where its Cloud Run region is. */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the next calendar month, UTC. */
export function currentPeriodEnd(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Count Composio tool calls in the current monthly window, org-wide and per
 * tenant.
 *
 * Source of truth is `cost_attribution_events` with `source='composio_mcp'` —
 * one row per Composio dispatch ATTEMPT, written by the runtime's own reporter
 * and deduped by the (source, source_id, event_type, occurred_at) unique
 * index. Attempts are the right unit: Composio bills per attempt and the
 * dispatcher reports transport failures too, so a failing tenant still counts
 * against the org budget exactly as the vendor counts it.
 *
 * KNOWN UNDERCOUNT: connector-service also authenticates against Composio
 * (connection linking, the hosted Connect Link, the stranded-connection
 * reconciler) and those calls consume the same org meter without landing in
 * this ledger. The number here is therefore a LOWER BOUND on org consumption.
 * The reserved headroom is what absorbs the difference.
 */
export async function getOrgConsumption(now: Date = new Date()): Promise<OrgConsumption> {
  const periodStart = currentPeriodStart(now);
  const periodEnd = currentPeriodEnd(now);

  const result = await withAdminScope(
    { caller: 'composio-quota/getOrgConsumption', reason: 'org-wide Composio meter is cross-tenant by definition' },
    (client) =>
    client.query<{ tenant_id: string; calls: string }>(
      `SELECT tenant_id, COUNT(*)::bigint AS calls
         FROM cost_attribution_events
        WHERE source = 'composio_mcp'
          AND occurred_at >= $1
          AND occurred_at <  $2
        GROUP BY tenant_id`,
        [periodStart, periodEnd],
      ),
  );

  const perTenant = new Map<string, number>();
  let orgCalls = 0;
  for (const row of result.rows) {
    const n = Number.parseInt(row.calls, 10) || 0;
    perTenant.set(row.tenant_id, n);
    orgCalls += n;
  }

  return { orgCalls, perTenant, periodStart, periodEnd };
}

/**
 * Number of provisioned tenants the monthly quota is divided between.
 *
 * `tenants.status = 'active'` is the denominator the control plane actually
 * owns. Counting "tenants with a Composio connector" would be more precise and
 * is not available here: connector ids belong to connector-service's database
 * and this repo's `connectors` table is a pre-cutover remnant that returns
 * zero rows for a real connector id (ADR-049). Dividing by active tenants
 * over-provisions slices for tenants that never call Composio, which is what
 * the shared burst pool exists to reclaim.
 *
 * Floored at 1 so a fresh install never divides by zero.
 */
export async function getActiveTenantCount(): Promise<number> {
  const result = await withAdminScope(
    { caller: 'composio-quota/getActiveTenantCount', reason: 'quota denominator spans every tenant' },
    (client) =>
      client.query<{ n: string }>(`SELECT COUNT(*)::bigint AS n FROM tenants WHERE status = 'active'`),
  );
  return Math.max(1, Number.parseInt(result.rows[0]?.n ?? '0', 10) || 0);
}
