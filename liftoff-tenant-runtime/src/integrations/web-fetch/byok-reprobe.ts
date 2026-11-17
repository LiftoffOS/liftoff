// Periodic worker that re-checks BYOK connectors flipped to
// status='error' / error_code='byok_insufficient_funds'. On healthy
// vendor balance response, calls ClearConnectorError so the next session's
// expose-tools palette includes the vendor's tools again.
//
// Recovery policy:
//   - Vendors with a balance probe endpoint (firecrawl, anchor_browser,
//     browserbase, browser_use) are auto-restored when the probe reports the
//     account is healthy.
//   - Vendors WITHOUT a balance probe endpoint (tavily, exa, webclaw) are
//     NOT auto-restored here. The tenant either (a) updates the credential
//     via /connections (the API-key update path clears the error_code by
//     creating a new connector row or by the operator calling
//     ClearConnectorError manually) or (b) waits for an operator to clear
//     it once they confirm the issue is resolved.
//   - error_code='byok_invalid_key' is NEVER auto-restored even for
//     probe-capable vendors. An invalid key needs a tenant-initiated
//     correction on /connections — auto-clearing on a single 2xx response
//     would risk flapping if the vendor is intermittently treating a
//     borderline key as valid.
//
// Rate limiting:
//   - MAX_CONNECTORS_PER_VENDOR caps the probes per cycle so a vendor
//     outage that flipped hundreds of tenants doesn't slam the vendor
//     /billing endpoint during recovery.
//   - INTER_PROBE_DELAY_MS spaces probes apart so we stay well under
//     vendor per-second rate limits (Firecrawl ~10 req/s, Anchor ~5 req/s,
//     Browserbase ~10 req/s — verified against current vendor docs).
//   - Connectors that aren't probed this cycle get picked up next cycle.

import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import { invalidateWebToolCredentialCache, type WebToolVendor } from './web-tool-secrets';
import { logger } from '../../infrastructure/logging';

const PROBE_VENDORS: readonly WebToolVendor[] = [
  'firecrawl', 'anchor_browser', 'browserbase', 'browser_use', 'steel',
];

/** Maximum probes per vendor per cycle. Tuned to stay well under the
 *  vendors' per-second rate caps when combined with INTER_PROBE_DELAY_MS:
 *  50 probes * 200ms = 10 seconds at 5 req/s sustained. */
const MAX_CONNECTORS_PER_VENDOR = 50;
const INTER_PROBE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runByokReprobeCycle(): Promise<void> {
  const client = getConnectorServiceClient();
  for (const vendor of PROBE_VENDORS) {
    let list;
    try {
      list = await client.listErroredConnectors({
        connectorType: vendor,
        errorCode: 'byok_insufficient_funds',
      });
    } catch (err) {
      logger.warn({ vendor, err: (err as Error).message },
        'byok_reprobe listErroredConnectors failed');
      continue;
    }
    const all = list.connectors ?? [];
    const probeBatch = all.slice(0, MAX_CONNECTORS_PER_VENDOR);
    if (all.length > MAX_CONNECTORS_PER_VENDOR) {
      logger.info(
        { vendor, total: all.length, probed: probeBatch.length },
        'byok_reprobe batch capped; remainder picked up next cycle',
      );
    }
    let restored = 0;
    let failed   = 0;
    for (let i = 0; i < probeBatch.length; i++) {
      const conn = probeBatch[i];
      try {
        const cred = await client.getCredentials({
          tenantContext: { tenantId: conn.tenantId },
          connectorId: conn.connectorId,
        });
        const apiKey = cred.apiKey?.apiKey ?? '';
        const extra: Record<string, string> = {};
        const extraStruct = cred.apiKey?.extra?.fields ?? {};
        for (const [field, v] of Object.entries(extraStruct)) {
          const s = (v as { stringValue?: string }).stringValue;
          if (typeof s === 'string') extra[field] = s;
        }
        const healthy = await probe(vendor, apiKey, extra);
        if (healthy) {
          await client.clearConnectorError({
            tenantContext: { tenantId: conn.tenantId },
            connectorId: conn.connectorId,
          });
          invalidateWebToolCredentialCache(conn.tenantId, vendor);
          restored++;
          logger.info(
            { tenantId: conn.tenantId, vendor, connectorId: conn.connectorId },
            'byok_reprobe restored connector',
          );
        }
      } catch (err) {
        failed++;
        logger.warn(
          { vendor, tenantId: conn.tenantId, err: (err as Error).message },
          'byok_reprobe failed for connector',
        );
      }
      // Pace between probes so the vendor's billing endpoint isn't pummelled
      // when restoring large batches. Skip the trailing delay on the last
      // probe in the batch.
      if (i < probeBatch.length - 1) await sleep(INTER_PROBE_DELAY_MS);
    }
    if (probeBatch.length > 0) {
      logger.info(
        { vendor, probed: probeBatch.length, restored, failed },
        'byok_reprobe cycle vendor summary',
      );
    }
  }
}

async function probe(
  vendor: typeof PROBE_VENDORS[number],
  apiKey: string,
  extra: Record<string, string>,
): Promise<boolean> {
  if (!apiKey) return false;
  if (vendor === 'firecrawl') {
    const r = await fetch('https://api.firecrawl.dev/v1/team/credit-usage', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return false;
    const j = await r.json() as { credits_remaining?: number };
    return (j.credits_remaining ?? 0) > 0;
  }
  if (vendor === 'browser_use') {
    // No balance endpoint. /profiles answers 200 on a valid key even at a
    // $0.00 balance and 402 only once a session is attempted, so a key that
    // was errored for insufficient_funds cannot be distinguished from a funded
    // one here. Probing the cheapest authenticated read at least restores a key
    // that was errored for invalid_key, which is the recoverable case; a funded
    // account recovers on its next successful session instead.
    const r = await fetch('https://api.browser-use.com/api/v2/profiles', {
      headers: { 'X-Browser-Use-API-Key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  if (vendor === 'steel') {
    // The same cheapest authenticated read the connect form uses: 200 on a
    // valid key, 401 on an invalid one. Steel auto-tops-up, so an account that
    // was errored for insufficient_funds (a failed card) recovers here too once
    // the key answers again.
    const r = await fetch('https://api.steel.dev/v1/sessions?limit=1', {
      headers: { 'steel-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  if (vendor === 'anchor_browser') {
    const r = await fetch('https://api.anchorbrowser.io/v1/billing', {
      headers: { 'anchor-api-key': apiKey },
    });
    if (!r.ok) return false;
    const j = await r.json() as { data?: { is_blocked?: boolean } };
    return !(j.data?.is_blocked ?? false);
  }
  if (vendor === 'browserbase') {
    const projectId = extra.projectId;
    if (!projectId) return false;
    const r = await fetch(
      `https://api.browserbase.com/v1/projects/${encodeURIComponent(projectId)}`,
      { headers: { 'X-BB-API-Key': apiKey } },
    );
    if (!r.ok) return false;
    const j = await r.json() as { status?: string };
    return j.status !== 'suspended';
  }
  return false;
}
