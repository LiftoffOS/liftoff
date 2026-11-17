import { getEntitlementsClient } from '../../entitlements-client/service';
import { logger } from '../../infrastructure/logging';
import { getCachedSentinelFlags } from './limits-config';
import type { WebVendor } from './types';

/** Sentinel tenant_id used to store global (non-tenant-scoped) feature flag rows
 *  in cached_feature_flags. The all-zero UUID is never a real tenant id (UUID v4
 *  has 122 random bits; collision probability is effectively zero). */
export const GLOBAL_TENANT_SENTINEL = '00000000-0000-0000-0000-000000000000';

const DEFAULT_ENABLED = true;

// VendorFlags is keyed by every WebVendor — a single source of truth lives
// in ./types so adding a vendor only requires the union update there.
export interface VendorFlags {
  webclaw: boolean; firecrawl: boolean; perplexity: boolean;
  anchor: boolean; browserbase: boolean; tavily: boolean; exa: boolean;
  openai: boolean; google: boolean; browser_use: boolean; xai: boolean; steel: boolean;
  browserbase_x402: boolean;
  locus_web: boolean;
  locus_exa: boolean;
}

/** One DB read returns all ten vendor enabled-states. Callers that need
 *  multiple vendor decisions in the same request use this — see WebFetchRouter. */
export async function getAllVendorFlags(): Promise<VendorFlags> {
  const flags = await getEntitlementsClient().getFeatureFlags(GLOBAL_TENANT_SENTINEL);
  const read = (k: string) =>
    typeof (flags as Record<string, unknown>)?.[k] === 'boolean'
      ? ((flags as Record<string, unknown>)[k] as boolean)
      : DEFAULT_ENABLED;
  return {
    webclaw:     read('web_fetch_vendor_webclaw'),
    firecrawl:   read('web_fetch_vendor_firecrawl'),
    perplexity:  read('web_fetch_vendor_perplexity'),
    anchor:      read('web_fetch_vendor_anchor'),
    browserbase: read('web_fetch_vendor_browserbase'),
    tavily:      read('web_fetch_vendor_tavily'),
    exa:         read('web_fetch_vendor_exa'),
    openai:      read('web_fetch_vendor_openai'),
    google:      read('web_fetch_vendor_google'),
    browser_use: read('web_fetch_vendor_browser_use'),
    steel: read('web_fetch_vendor_steel'),
    xai: read('web_fetch_vendor_xai'),
    browserbase_x402: read('web_fetch_vendor_browserbase_x402'),
    locus_web: read('web_fetch_vendor_locus_web'),
    locus_exa: read('web_fetch_vendor_locus_exa'),
  };
}

/** Single-vendor convenience for handlers that only check one flag. */
export async function isVendorEnabled(vendor: WebVendor): Promise<boolean> {
  const all = await getAllVendorFlags();
  return all[vendor];
}

const TENANT_EXCLUSION_CACHE_TTL_MS = 60_000;
const tenantExclusionCache = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Per-tenant vendor exclusion (D12). Reads `web_fetch_vendor_{vendor}_disabled`
 * from the tenant's own feature-flag row (NOT the global sentinel). 60s
 * in-memory cache so deep-research calls (minutes apart) don't slam the DB.
 * Operators can flip the flag and call invalidateTenantExclusionCache() for
 * sub-60s propagation.
 */
export async function isVendorExcludedForTenant(
  tenantId: string,
  vendor: WebVendor,
): Promise<boolean> {
  const cacheKey = `${tenantId}:${vendor}`;
  const cached = tenantExclusionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const flags = await getEntitlementsClient().getFeatureFlags(tenantId);
    const excluded = (flags as Record<string, unknown>)[`web_fetch_vendor_${vendor}_disabled`] === true;
    tenantExclusionCache.set(cacheKey, {
      value: excluded,
      expiresAt: Date.now() + TENANT_EXCLUSION_CACHE_TTL_MS,
    });
    return excluded;
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenant_id: tenantId, vendor },
      'isVendorExcludedForTenant_lookup_failed');
    return false;
  }
}

export function invalidateTenantExclusionCache(): void {
  tenantExclusionCache.clear();
}

/**
 * D21 migration flag — when false, `web_deep_research` routes all effort
 * levels to Perplexity at the agent's effort value (legacy behavior).
 * When true, the four-tier effort→vendor mapping applies (Perplexity for
 * `low`, Google preview for `medium`, OpenAI for `high`, Google max for
 * `highest`). Sentinel-scoped (global), default false.
 *
 * Re-uses the same 10s `getCachedSentinelFlags` cache that other limits
 * flags use, so flipping the flag propagates at event-delivery latency
 * via `invalidateFlagsCache()` (the runtime subscriber calls it after
 * the sentinel row write).
 */
export async function isEffortRoutingEnabled(): Promise<boolean> {
  const flags = await getCachedSentinelFlags();
  return flags['web_deep_research_effort_routing_enabled'] === true;
}
