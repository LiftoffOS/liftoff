// Background loader for the platform-backend model-registry snapshot (GET
// /api/internal/model-registry). The tenant-runtime has no direct access to the
// control-plane DB, so it polls PB and installs SIX overlays from one snapshot.
//
// One of them is different in kind and worth naming first: `tiers` is the
// ROUTING authority — which model a (provider, tier) resolves to — where the
// others are attributes of a model already chosen. It arrived when the control
// plane stopped storing a resolved model id in each tenant's policy, because
// until then this plane's only tier→model answer was a hard-coded map per
// provider, and those maps had drifted a generation behind the registry with
// nothing comparing them.
//
// The rest:
//   - synced open-weights RATES → pricing.ts (setModelPricingRates), so cost
//     attribution matches PB; and
//   - tier-derived model→codename BRANDING → branding/registry.ts
//     (setRegistryModelBranding), so a model onboarded via a registry row is
//     redacted in the TR plane too — no static branding-file edit, no vendor leak;
//   - per-model CONTEXT WINDOWS → context-window.ts (setModelContextWindows), so
//     a reading can be labelled `registry` rather than falling back to a
//     provider-family floor that understates every long-window model;
//   - per-model REQUEST SURFACES → providers/anthropic-model-surface.ts, so what
//     a model accepts stops being a constant this repo keeps its own copy of; and
//   - the platform VENDOR LEVERS → platform-vendor-policy.ts.
// Best-effort + TTL refresh; every overlay falls back to its static table until
// the first load succeeds. Keeps the hot-path lookups synchronous (no per-call
// I/O).
import { fetchModelRegistry } from '../clients/platform-backend-client';
import { setModelPricingRates, normalizeModelId, type ModelPricing } from './pricing';
import { setRegistryModelBranding } from '../branding/registry';
import { setModelContextWindows } from './context-window';
import { setPlatformVendorPolicy } from './platform-vendor-policy';
import { setRegistryTierModels } from './tiers';
import { setRegistryModelSurfaces } from './providers/anthropic-model-surface';
import { logger } from '../infrastructure/logging';

// 60 seconds, down from fifteen minutes.
//
// This is now a BACKSTOP rather than the delivery mechanism: an admin moving a
// platform vendor lever publishes `platform.vendor_policy.updated`, and the
// push handler refreshes on arrival. The poll matters only when a push is lost
// — which is not hypothetical here, model-config-reconciler.ts exists because
// one was and it names the tenant it caught.
//
// A minute bounds how long a lost push can leave the two planes routing the
// same purpose to different vendors. Fifteen would not be worth calling fast.
// The cost is one request per instance per minute against an endpoint already
// serving four overlays in a single round trip.
const DEFAULT_TTL_MS = 60 * 1000; // 60s — backstop; pushes carry the urgency
let timer: NodeJS.Timeout | null = null;

/** Fetch the snapshot → install every overlay. Returns the row counts. */
export async function refreshModelRegistry(): Promise<{ pricing: number; branding: number; windows: number; tiers: number; surfaces: number }> {
  const snap = await fetchModelRegistry();

  const priceMap = new Map<string, ModelPricing>();
  for (const r of snap.pricing) {
    // Key by the NORMALIZED model id so it matches getModelPricing()'s lookup
    // (which normalizes before building the key). For dot-form slugs this is a
    // no-op; it makes the overlay robust to any dash-form version slug.
    priceMap.set(`${r.provider}:${normalizeModelId(r.model_id)}`, {
      inputPricePerMillion: Number(r.input_per_m),
      outputPricePerMillion: Number(r.output_per_m),
      cachedInputPricePerMillion: r.cache_read_per_m == null ? null : Number(r.cache_read_per_m),
      cacheWrite5mPricePerMillion: 0, // open-weights via OpenRouter: no cache-write tier
      cacheWrite1hPricePerMillion: 0,
      // Conditional rate bands travel WITH the base rate. Dropping them here
      // would have this plane charge the base for a request the control plane
      // charges a threshold band for, and nothing compares the two.
      ...(r.pricing_overrides ? { overrides: r.pricing_overrides } : {}),
    });
  }
  setModelPricingRates(priceMap);

  const brandMap = new Map<string, string>();
  for (const b of snap.branding) brandMap.set(b.model_id, b.codename);
  setRegistryModelBranding(brandMap);

  // Same key shape and normalization as the pricing overlay, so a dash-form
  // version slug resolves identically in both.
  const windowMap = new Map<string, number>();
  for (const r of snap.windows ?? []) {
    if (r.context_window) windowMap.set(`${r.provider}:${normalizeModelId(r.model_id)}`, Number(r.context_window));
  }
  setModelContextWindows(windowMap);

  // The tier→model map. This one is the ROUTING authority, not an attribute of
  // a model already chosen, which makes it different in kind from the three
  // above: get it wrong and this plane runs a different model than the control
  // plane believes it is running. Installed from the same snapshot for exactly
  // that reason — the static maps it overlays were a second source of truth and
  // drifted a generation.
  //
  // An absent feed leaves the seeds in place rather than clearing them: a
  // platform-backend that predates it must not be read as "no tiers exist".
  if (snap.tiers) setRegistryTierModels(snap.tiers);

  // What each model ACCEPTS. The last model fact that still needed a release in
  // two repos, and the one least able to survive being stale: a wrong rate
  // misprices a call that ran, a wrong surface is a 400 on the first call.
  //
  // An absent feed leaves the static table answering, which is conservative by
  // construction — so an older control plane costs a capability, never a 400.
  if (snap.surfaces) setRegistryModelSurfaces(snap.surfaces);

  // The platform vendor levers. Installed from the same snapshot so this plane
  // and the control plane cannot disagree about which vendor powers a purpose.
  setPlatformVendorPolicy(snap.platformVendors);

  return {
    pricing: priceMap.size,
    branding: brandMap.size,
    windows: windowMap.size,
    tiers: snap.tiers?.length ?? 0,
    surfaces: Object.keys(snap.surfaces ?? {}).length,
  };
}

/** Start the periodic refresh. Immediate best-effort load, then every ttlMs. Never
 *  throws — pricing + branding fall back to their static tables until (and if ever)
 *  the first load succeeds. */
export function startModelRegistryRefresh(ttlMs: number = DEFAULT_TTL_MS): void {
  refreshModelRegistry().then(
    (counts) => logger.info(counts, 'model-registry snapshot loaded from platform-backend'),
    (err) => logger.warn({ err }, 'model-registry initial load failed; using static tables'),
  );
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refreshModelRegistry()
      .then((counts) => logger.debug(counts, 'model-registry snapshot refreshed'))
      .catch((err) => logger.warn({ err }, 'model-registry refresh failed; keeping last-known'));
  }, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop the periodic refresh (tests / graceful shutdown). */
export function stopModelRegistryRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
