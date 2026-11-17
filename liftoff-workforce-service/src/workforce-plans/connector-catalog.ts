// The platform's connector catalog, read live from connector-service.
//
// A hand-maintained array of connectors falls behind the real catalog as soon
// as the product gains an integration, and every connector missing from it does
// not exist as far as the CAIO is concerned.
//
// The damage is not a missing label. Asked about a connector that is
// `status: 'available'` and connectable, the CAIO would say "We do not have a
// webclaw connector" and talk the person out of it. A connector absent from the
// snapshot does not come back as `connected: false`; it is not in the output at
// all, so the model reasonably concludes the platform has never heard of it.
//
// connector-service's own projections.ts states the rule this module exists to
// keep: "Hand-written copies of these sets/maps must not exist elsewhere — they
// are fixed-at-boot projections of src/catalog/connectors.ts." That applies
// across repository boundaries.
//
// Transport: GET {PB}/api/internal/connectors/catalog. platform-backend mounts
// /api/internal/connectors behind workforceServiceAuth and its proxy re-prepends
// /api/connectors to the subpath, so the request lands on connector-service's
// catalogRouter. That route takes no tenant context (the catalog is platform-wide
// metadata) and advertises Cache-Control: max-age=300, which is the TTL used here.
//
// ── Why there is no hardcoded fallback ──────────────────────────────────
//
// A hardcoded array kept as a cold-start net for when the fetch fails is the
// same defect one layer down: a constant that only refreshes when somebody
// remembers to edit it, in a repo that gives them no reason to. It drifts every
// time the product gains an integration.
//
// The fallback is now the last catalog this process successfully read. It costs
// about 16KB, it needs no maintenance, and it grows on its own as the catalog
// does: a connector added today is in the fallback as soon as any fetch succeeds
// after it ships. There is no list in this repo that can fall behind
// /dashboard/connections.
//
// Three answers, because the caller has to be able to tell them apart:
//   live             — read just now (or within the TTL). Safe to conclude that
//                      an app absent from it is genuinely unsupported.
//   last_known_good  — the refresh failed and this is the previous answer. It is
//                      complete as of `ageMs` ago, so it is good for planning but
//                      NOT for denying an app, which may have shipped since.
//   unavailable      — this process has never had a successful read. No list.
//
// "The catalog does not list it" and "I could not find out" are the same empty
// array to a caller that only gets a list, and stating the first when the truth is
// the second is the exact defect above.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';

/** The only fields the CAIO needs. The wire response also carries auth config,
 *  polling descriptors, capabilities and per-connector entity schemas, which
 *  together run to hundreds of kilobytes; none of it survives past the parse. */
export interface CatalogConnector {
  type: string;
  displayName: string;
  category: string;
}

export type ConnectorCatalogResult =
  | { source: 'live'; connectors: CatalogConnector[] }
  | {
      source: 'last_known_good';
      connectors: CatalogConnector[];
      /** How old the copy is, so the caller can say so rather than imply it is current. */
      ageMs: number;
      reason: string;
    }
  | { source: 'unavailable'; reason: string };

/** Matches the endpoint's own Cache-Control: public, max-age=300. */
const CACHE_TTL_MS = 300_000;

/** The current answer, valid until it expires. */
let fresh: { connectors: CatalogConnector[]; expiresAt: number } | null = null;

/** The most recent successful read, kept indefinitely. Never expires on its own:
 *  a catalog from an hour ago is a far better answer than no catalog, and an
 *  order of magnitude better than the three-month-old constant it replaced. */
let lastGood: { connectors: CatalogConnector[]; fetchedAt: number } | null = null;

interface CatalogWireEntry {
  type?: string;
  displayName?: string;
  category?: string;
  status?: string;
}

/**
 * The connector types a user can actually connect today, with their catalog
 * labels and categories.
 *
 * Filtered to `status === 'available'`. connector-service already downgrades a
 * statically-available Composio entry to 'coming_soon' when its auth config or
 * MCP server is still a bootstrap placeholder, so this filter is what keeps the
 * CAIO from recommending a connector whose OAuth start would 503.
 */
export async function fetchConnectorCatalog(): Promise<ConnectorCatalogResult> {
  if (fresh && fresh.expiresAt > Date.now()) {
    return { source: 'live', connectors: fresh.connectors };
  }

  try {
    const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const url = `${baseUrl}/api/internal/connectors/catalog`;
    const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);

    const res = await fetch(url, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from platform-backend /api/internal/connectors/catalog`);
    }

    const body = (await res.json()) as { connectors?: CatalogWireEntry[] };
    const connectors: CatalogConnector[] = [];

    for (const entry of body.connectors ?? []) {
      if (!entry.type || entry.status !== 'available') continue;
      connectors.push({
        type: entry.type,
        displayName: entry.displayName || entry.type,
        category: entry.category || 'other',
      });
    }

    // An empty catalog is not a catalog. connector-service always serves well
    // over a hundred available types, so zero means the shape changed under us
    // and the parse silently matched nothing. Reporting that as "the platform
    // supports no connectors" is the failure this module exists to prevent, and
    // caching it would poison the fallback too.
    if (connectors.length === 0) {
      throw new Error('connector catalog came back with no available entries');
    }

    const now = Date.now();
    fresh = { connectors, expiresAt: now + CACHE_TTL_MS };
    lastGood = { connectors, fetchedAt: now };
    return { source: 'live', connectors };
  } catch (err) {
    const reason = (err as Error).message;

    if (lastGood) {
      const ageMs = Date.now() - lastGood.fetchedAt;
      log.warn(
        { event: 'workforce_plans_connector_catalog_stale', error: reason, ageMs },
        'connector catalog refresh failed — serving the last good copy, flagged as stale',
      );
      return { source: 'last_known_good', connectors: lastGood.connectors, ageMs, reason };
    }

    log.warn(
      { event: 'workforce_plans_connector_catalog_fetch_failed', error: reason },
      'connector catalog fetch failed and nothing cached — reporting a lookup failure, not an empty catalog',
    );
    return { source: 'unavailable', reason };
  }
}

/** For tests only. Clears both the TTL cache and the last-known-good copy. */
export function _resetConnectorCatalogCache(): void {
  fresh = null;
  lastGood = null;
}
