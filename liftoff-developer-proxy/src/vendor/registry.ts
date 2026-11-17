// Vendor registry — maps vendor names to adapters and loads VendorConfig from DB.

import type { Pool } from 'pg';
import type { VendorAdapter, VendorConfig, ModelPricing } from './adapter.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';

const ADAPTERS = new Map<string, VendorAdapter>([
  ['anthropic', anthropicAdapter],
  ['openai', openaiAdapter],
]);

// In-process config cache (refreshed every 5 min)
const configCache = new Map<string, { config: VendorConfig; fetchedAt: number }>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

export function getAdapter(vendor: string): VendorAdapter {
  const adapter = ADAPTERS.get(vendor);
  if (!adapter) throw Object.assign(new Error(`Unsupported vendor: ${vendor}`), { statusCode: 400 });
  return adapter;
}

// Resolve vendor from request headers or URL path prefix.
// X-Liftoff-Vendor header takes precedence; URL prefix is the fallback.
// The route vendor is resolved BEFORE credential use; the handler
// rejects route/credential vendor mismatches with a stable 403.
export function resolveVendorFromRequest(
  headers: Record<string, string | string[] | undefined>,
  path: string,
): string {
  const headerVendor = headers['x-vendor'];
  if (headerVendor) {
    const v = Array.isArray(headerVendor) ? headerVendor[0] : headerVendor;
    if (!ADAPTERS.has(v)) throw Object.assign(new Error(`Unknown vendor: ${v}`), { statusCode: 400 });
    return v;
  }

  if (path.startsWith('/codex/'))       return 'openai';
  if (path.startsWith('/claude-code/')) return 'anthropic';

  return 'anthropic'; // default for /v1/* paths
}

export function invalidateVendorConfigCache(vendor?: string): void {
  if (vendor) configCache.delete(vendor);
  else configCache.clear();
}

// Load VendorConfig from developer_proxy_vendor_config, with in-process TTL cache.
// Vendor enablement is the proxy hot-path kill switch.
// NOTE: the pricing blob on this row is legacy dual-read data during
// the pricing-history migration window only; developer_proxy_model_pricing is
// the authoritative source.
export async function getVendorConfig(pool: Pool, vendor: string): Promise<VendorConfig> {
  const now = Date.now();
  const cached = configCache.get(vendor);
  if (cached && now - cached.fetchedAt < CONFIG_TTL_MS) return cached.config;

  const result = await pool.query<{
    vendor: string;
    base_url: string;
    allowed_models: string[];
    pricing: Record<string, { in_micros: number; out_micros: number; cache_read_micros?: number; cache_write_micros?: number }>;
    model_catalog: Record<string, Record<string, unknown>> | null;
  }>(
    `SELECT vendor, base_url, allowed_models, pricing, model_catalog
       FROM developer_proxy_vendor_config WHERE vendor = $1 AND enabled = true`,
    [vendor],
  );

  if (result.rowCount === 0) throw Object.assign(new Error(`Vendor config not found: ${vendor}`), { statusCode: 400 });

  const row = result.rows[0];
  const pricing: Record<string, ModelPricing> = {};
  for (const [model, p] of Object.entries(row.pricing)) {
    pricing[model] = {
      inMicros:        p.in_micros,
      outMicros:       p.out_micros,
      cacheReadMicros:  p.cache_read_micros,
      cacheWriteMicros: p.cache_write_micros,
    };
  }

  const config: VendorConfig = {
    vendor:        row.vendor,
    baseUrl:       row.base_url,
    allowedModels: row.allowed_models,
    pricing,
    modelCatalog:  row.model_catalog ?? {},
  };

  configCache.set(vendor, { config, fetchedAt: now });
  return config;
}
