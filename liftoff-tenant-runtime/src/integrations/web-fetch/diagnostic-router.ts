import { Router } from 'express';
import { getPool } from '../../infrastructure/database';
import { requireServiceAuth } from '../../security/service-auth';
import { getAllVendorFlags } from './global-flags';
import { vendorHealthCache } from './router';
import type { WebVendor } from './types';

// Operator-facing diagnostic.
//
// Pre-BYOK the `enabled` field meant "operator hasn't disabled this vendor
// via the global feature flag". Post-BYOK that meaning is preserved for
// platform-managed vendors (perplexity, openai, google) but is augmented
// for the six BYOK vendors with a new `platformManaged` field so consumers
// can distinguish "globally allowed" from "tenant has a connector".
//
// We keep `enabled` in the response for back-compat with any existing
// monitoring dashboards / scripts; new consumers should read `platformManaged`
// alongside per-tenant connector state from connector-service's
// `ListTenantConnectors`. Per-tenant aggregation is intentionally NOT part
// of this endpoint — it would require an N-tenant scan and is better served
// by `ListErroredConnectors` for the failure case.
// browser_use is platform-managed AND connectable: the platform holds a key, and
// a workspace may bring its own. It belongs in this set because the question the
// field answers is "can this vendor serve a workspace that connected nothing",
// and for browser_use the answer is yes. Reporting false told an operator
// diagnosing a browser that availability was per-tenant connector state, which
// stopped being true the day the platform took a key.
// browserbase_x402 holds no key here at all: connector-service pays each
// call from the platform x402 wallet, so it serves any workspace on the
// same footing as the platform-key vendors.
const PLATFORM_VENDORS = new Set<WebVendor>(['perplexity', 'openai', 'google', 'browser_use', 'xai', 'steel', 'browserbase_x402', 'locus_web', 'locus_exa']);

interface VendorHealthRow {
  /** Operator global-flag state (back-compat with pre-BYOK consumers). */
  enabled: boolean;
  /** True for vendors the platform holds a key for (perplexity / openai /
   *  google / browser_use), so they serve a workspace that connected nothing.
   *  False for the BYOK-only vendors — their availability is per-tenant
   *  connector state, NOT visible from this endpoint. browser_use is BOTH: it
   *  reports true here and a workspace's own connector still wins when present. */
  platformManaged: boolean;
  /** VendorHealthCache state (60s TTL flap protection). */
  healthy: boolean;
  /** Open vendor browser sessions across all tenants. */
  activeSessions: number;
}

export const webToolsDiagnosticRouter = Router();

webToolsDiagnosticRouter.get('/vendor-health', requireServiceAuth(), async (_req, res) => {
  const vendors: WebVendor[] = [
    'webclaw', 'firecrawl', 'perplexity', 'anchor', 'browserbase',
    'tavily', 'exa', 'openai', 'google', 'browser_use', 'steel', 'browserbase_x402', 'locus_web', 'locus_exa',
  ];
  const flags = await getAllVendorFlags();
  const results = {} as Record<WebVendor, VendorHealthRow>;
  for (const v of vendors) {
    const count = await getPool().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM web_sessions WHERE vendor = $1 AND closed_at IS NULL`,
      [v],
    );
    results[v] = {
      enabled:         flags[v],
      platformManaged: PLATFORM_VENDORS.has(v),
      healthy:         vendorHealthCache.isHealthy(v),
      activeSessions:  parseInt(count.rows[0].n),
    };
  }
  res.json(results);
});
