// Operator-side periodic monitor of the platform tenant's Anchor account.
// The operator's platform tenant can own an Anchor connector seeded from a
// platform key — the runtime's anchor-client reads from per-tenant
// connectors, but the operator still wants visibility into that account's
// credit utilization for capacity planning. Per-tenant Anchor quota is the
// tenant's own problem (we surface insufficient_funds via the BYOK error
// envelope when their connector hits 402).

import { logger } from '../../infrastructure/logging';
import { ANY_CONNECTOR } from './credential-scope';
import { getWebToolCredential } from './web-tool-secrets';

/** The operator's platform tenant, which holds the platform seed connectors. */
const PLATFORM_TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const ALERT_THRESHOLD_PCT = 80;

export async function pollAnchorQuota(): Promise<void> {
  let cred;
  try {
    // The platform tenant's own account; no team's binding is in play.
    cred = await getWebToolCredential(PLATFORM_TENANT_ID, 'anchor_browser', ANY_CONNECTOR);
  } catch {
    // Platform tenant has no Anchor connector — nothing to monitor.
    return;
  }
  let res: Response;
  try {
    res = await fetch('https://api.anchorbrowser.io/v1/billing', {
      headers: { 'anchor-api-key': cred.apiKey },
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'anchor quota poll failed');
    return;
  }
  if (!res.ok) { logger.warn({ status: res.status }, 'anchor quota poll non-2xx'); return; }
  const data = (await res.json() as { data: {
    credits: number; credits_used: number; included_credits: number;
    cost_limit?: number; billing_period: string; tier: string;
  }}).data;
  const utilPct = (data.credits_used / Math.max(data.credits, 1)) * 100;
  if (utilPct >= ALERT_THRESHOLD_PCT) {
    logger.warn({
      event: 'anchor_quota_high',
      util_pct: utilPct,
      credits_used: data.credits_used,
      credits_total: data.credits,
      tier: data.tier,
      billing_period: data.billing_period,
      cost_limit_usd: data.cost_limit,
    }, 'anchor_quota_high');
  }
}
