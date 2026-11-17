// Background loader for the `model_pricing` table (migration 285). Reads the
// synced open-weights rates into an in-memory Map and installs it on pricing.ts
// via setModelPricingRates(), so computeRowCost() — which is a pure, synchronous
// hot-path function — can consult DB-sourced rates without any per-call I/O.
//
// The sync JOB (src/scripts/sync-model-pricing.ts) WRITES the table; this loader
// READS it into the running service. Kept separate so pricing.ts stays a pure,
// dependency-free module (no DB import), matching its "single source of truth,
// imported everywhere" role.
import { getPool } from '../infrastructure/database';
import { setModelPricingRates, type ModelPricing } from './pricing';
import type { PricingOverride } from './pricing-tiers';
import { log } from '../infrastructure/logging';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min
let timer: NodeJS.Timeout | null = null;

interface PricingRow {
  provider: string;
  model_id: string;
  input_per_m: string;
  output_per_m: string;
  cache_read_per_m: string | null;
  pricing_overrides: PricingOverride[] | null;
}

/** Load model_pricing → install on pricing.ts. Returns the row count. */
export async function refreshModelPricingRates(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<PricingRow>(
    `SELECT provider, model_id, input_per_m, output_per_m, cache_read_per_m, pricing_overrides
       FROM model_pricing`,
  );
  const map = new Map<string, ModelPricing>();
  for (const r of rows) {
    // NUMERIC comes back as a string from node-postgres — coerce explicitly.
    // JSONB comes back already parsed, so pricing_overrides needs no JSON.parse;
    // it is null for every model whose vendor publishes no conditional rates.
    map.set(`${r.provider}:${r.model_id}`, {
      input: Number(r.input_per_m),
      output: Number(r.output_per_m),
      cacheWrite5m: 0, // open-weights via OpenRouter: no Anthropic-style cache-write tier
      cacheWrite1h: 0,
      cacheRead: r.cache_read_per_m == null ? 0 : Number(r.cache_read_per_m),
      ...(r.pricing_overrides ? { overrides: r.pricing_overrides } : {}),
    });
  }
  setModelPricingRates(map);
  return map.size;
}

/** Start the periodic refresh. Does an immediate best-effort load, then refreshes
 *  every ttlMs. Never throws — computeRowCost falls back to the static MODEL_PRICING
 *  table until (and if ever) the first load succeeds. */
export function startModelPricingRefresh(ttlMs: number = DEFAULT_TTL_MS): void {
  refreshModelPricingRates().then(
    (count) => log.info({ count }, 'model_pricing rates loaded'),
    (err) => log.warn({ err }, 'model_pricing initial load failed; using static MODEL_PRICING'),
  );
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refreshModelPricingRates()
      .then((count) => log.debug({ count }, 'model_pricing rates refreshed'))
      .catch((err) => log.warn({ err }, 'model_pricing refresh failed; keeping last-known rates'));
  }, ttlMs);
  if (typeof timer.unref === 'function') timer.unref(); // don't hold the event loop open
}

/** Stop the periodic refresh (tests / graceful shutdown). */
export function stopModelPricingRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
