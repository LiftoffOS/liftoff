// Background loader for the registry-derived branding overlay (Phase 3). Reads
// every approved (model_id, tier) from the `models` table and installs a
// model_id → codename map (codename = TIER_MAP[tier]) on registry.ts via
// setRegistryModelBranding(). This is what makes onboarding a model a registry
// INSERT — its customer-facing redaction derives from its tier, with no branding
// file edit. Refreshed every 60s so liftoffify* stay synchronous (no per-call I/O).
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { setRegistryModelBranding, TIER_MAP } from './registry';

const REFRESH_MS = 60 * 1000; // 60s, matching the other hot registry reads
let timer: NodeJS.Timeout | null = null;

interface ModelTierRow {
  model_id: string;
  tier: string;
}

/** Load (model_id, tier) → install model_id→codename overlay. Returns the count. */
export async function refreshRegistryModelBranding(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<ModelTierRow>(
    `SELECT model_id, tier FROM models WHERE status = 'approved' AND tier IS NOT NULL`,
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    const codename = TIER_MAP[r.tier];
    if (codename) map.set(r.model_id, codename); // skip unknown tiers rather than leak a raw id
  }
  setRegistryModelBranding(map);
  return map.size;
}

/** Start the 60s refresh. Immediate best-effort load, then periodic. Never throws —
 *  redaction falls back to the static MODEL_ID_MAP / STRING_REPLACEMENTS until loaded. */
export function startRegistryModelBrandingRefresh(ms: number = REFRESH_MS): void {
  refreshRegistryModelBranding().then(
    (count) => log.info({ count }, 'registry model→codename branding overlay loaded'),
    (err) => log.warn({ err }, 'registry branding overlay load failed; using static maps'),
  );
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refreshRegistryModelBranding()
      .then((count) => log.debug({ count }, 'registry branding overlay refreshed'))
      .catch((err) => log.warn({ err }, 'registry branding overlay refresh failed; keeping last-known map'));
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop the periodic refresh (tests / graceful shutdown). */
export function stopRegistryModelBrandingRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
