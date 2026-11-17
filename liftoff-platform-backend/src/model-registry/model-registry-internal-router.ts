// Internal endpoint: GET /api/internal/model-registry
//
// Serves the tenant-runtime a registry-derived snapshot it can't compute itself
// (TR has no access to the control-plane DB): the synced open-weights RATES from
// `model_pricing` (migration 285), the model→codename BRANDING derived from
// each approved model's tier (codename = TIER_MAP[tier]), and each model's
// CONTEXT WINDOW (migration 342). TR installs all three as overlays so its cost
// attribution, its customer-facing redaction AND its context accounting are
// driven by the same single source of truth as PB — a model onboarded via a
// registry row is priced, branded and sized correctly in BOTH planes with no
// per-repo edit.
//
// `capabilities` is deliberately NOT served. The vision gate that reads it
// (src/llm/vision.ts) is control-plane only — the tenant runtime has no image
// path at all, so a capabilities array here would be a field with no consumer,
// which is the one defect this estate reports most often and the reason the
// reachability ratchets exist. Add it in the change that gives the runtime
// something to do with it, not before.
//
// Models with no recorded window are OMITTED from `windows` rather than sent
// with a null. The runtime has to distinguish a known window from a fallback,
// because only a known one may drive a destructive decision, and an explicit
// absence carries that better than a null the consumer has to remember to check.
//
// `tiers` is the fifth overlay and the one that lets a model id stop being
// stored per tenant. Until it existed, the runtime could not answer
// "(provider, tier) → model" from this snapshot at all: `branding` carries a
// CODENAME, which is the tier's redaction label and is many-to-one (fourteen
// ids map to `hyperion`), and it carries no provider. So the runtime fell back
// to its own hard-coded tier maps, which is how its `medium` came to sit a
// generation behind the control plane's with nothing comparing the two. A tier
// is a routing fact and has to travel as one.
//
// Auth: shared X-Service-Auth bearer (TENANT_RUNTIME_SERVICE_TOKEN), the same
// secret TR already uses for its other PB callbacks.
import { Router, type Request, type Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { getPool } from '../infrastructure/database';
import { TIER_MAP } from '../branding/registry';
import { WORKSPACE_AI_VENDORS } from './workspace-ai-vendors';
import { log } from '../infrastructure/logging';

export const modelRegistryInternalRouter = Router();

/** The provider a model EXECUTES on, given the registry's vendor key.
 *
 *  An identity for every current row: migration 450 made `models.provider` the
 *  execution provider, so the registry key and the lookup key are one value.
 *  It is kept because the vendor record is still the authority on the one pair
 *  that differs ('grok' is the model line, 'xai' the company that serves it),
 *  and because a row can arrive under an older key — a restored backup, a
 *  script not yet updated — where mapping it is the difference between a
 *  recorded window and a family floor.
 *
 *  A key that names no vendor passes through unchanged. */
function executionProviderFor(registryProvider: string): string {
  const vendor = WORKSPACE_AI_VENDORS[registryProvider as keyof typeof WORKSPACE_AI_VENDORS];
  return vendor?.provider ?? registryProvider;
}


const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

modelRegistryInternalRouter.get('/', svcAuth, async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const [pricingResult, brandingResult, windowResult, surfaceResult, tierResult] = await Promise.all([
      // pricing_overrides rides along with the flat rates rather than in a
      // separate feed: a rate and the conditions that replace it are one fact.
      // Sending the base alone would have TR charge the base for a request PB
      // charges a threshold band for — the two planes disagreeing about the
      // cost of the same call, which is exactly what this endpoint exists to
      // prevent.
      pool.query(
        `SELECT provider, model_id, input_per_m, output_per_m, cache_read_per_m, pricing_overrides
           FROM model_pricing`,
      ),
      pool.query<{ model_id: string; tier: string }>(
        `SELECT model_id, tier FROM models WHERE status = 'approved' AND tier IS NOT NULL`,
      ),
      pool.query<{ provider: string; model_id: string; context_window: number }>(
        `SELECT provider, model_id, context_window
           FROM models
          WHERE status = 'approved' AND context_window IS NOT NULL`,
      ),
      // Per-model REQUEST SURFACES (migration 560): what each model accepts.
      // The runtime kept its own copy of this in code, which is a second source
      // of truth for the fact least able to survive being stale — a wrong surface
      // is a 400 on the first call, not a mispriced row.
      pool.query<{ model_id: string; request_surface: Record<string, unknown> | null }>(
        `SELECT model_id, request_surface
           FROM models
          WHERE status = 'approved' AND request_surface IS NOT NULL`,
      ),
      // The newest approved model per (provider, tier) — the same selection
      // `registry-tier-loader` makes for this plane's own providers and
      // `workspace-ai-vendor-loader` makes for the vendor map, so all three
      // answer identically by construction rather than by agreement.
      pool.query<{ provider: string; tier: string; model_id: string }>(
        `SELECT DISTINCT ON (provider, tier) provider, tier, model_id
           FROM models
          WHERE status = 'approved' AND tier IS NOT NULL
          ORDER BY provider, tier, created_at DESC`,
      ),
    ]);
    // Codename derives from tier; drop rows whose tier has no codename rather than
    // leak a raw model id downstream.
    const branding = brandingResult.rows
      .map((r) => ({ model_id: r.model_id, codename: TIER_MAP[r.tier] }))
      .filter((b): b is { model_id: string; codename: string } => Boolean(b.codename));
    // Both feeds go out keyed the way the runtime asks: `provider:model`, by
    // execution provider. They were keyed two different ways — `models.provider`
    // as a vendor key, `model_pricing.provider` as the execution one — and four
    // of the five open-weights vendors missed, only GLM hitting because its rows
    // happened to be filed under 'openrouter'. A miss is silent: the reading
    // degrades to a provider-family FLOOR, which understates every long-window
    // model, and `mayDriveRetirement` then refuses to act on it. Mapped through
    // the vendor record so the mapping has one home.
    const windows = windowResult.rows.map((r) => ({
      ...r,
      provider: executionProviderFor(r.provider),
    }));
    // Keyed by MODEL ID ALONE, unlike every other feed here, and the difference
    // is the point: what a model accepts is a property of the model, not of the
    // door it is reached through. The same Claude id served directly and through
    // a gateway takes the same parameters. Keying it by provider would mean a row
    // filed under one key silently failing to answer for the other — the shape of
    // the window bug migration 450 exists because of.
    const surfaces: Record<string, Record<string, unknown>> = {};
    for (const r of surfaceResult.rows) {
      if (r.request_surface && typeof r.request_surface === 'object' && !Array.isArray(r.request_surface)) {
        surfaces[r.model_id] = r.request_surface;
      }
    }
    // Keyed by the EXECUTION provider, like `windows` and for the same reason:
    // the runtime resolves a tier under the provider it dispatches on ('xai',
    // not the 'grok' model line), so a feed keyed the registry's way would miss
    // for exactly the vendors whose keys differ, silently, leaving them on the
    // static seed — the failure this feed exists to end.
    const tiers = tierResult.rows.map((r) => ({
      provider: executionProviderFor(r.provider),
      tier: r.tier,
      model_id: r.model_id,
    }));
    // The platform vendor policy rides along as a fourth overlay. The runtime
    // holds its own copy of the levers because it makes its own platform-side
    // LLM calls (compression, DLP scanning, HITL cards), and two planes reading
    // two sources is how they come to disagree. One feed, one answer.
    //
    // Read from the table rather than from this process's installed policy, so
    // a control-plane instance whose own poll has not landed yet still serves
    // the current rows rather than its stale copy.
    const policyResult = await pool.query<{ area: string; vendor: string }>(
      `SELECT area, vendor FROM platform_vendor_policy`,
    );
    const platformVendors: Record<string, string> = {};
    for (const row of policyResult.rows) platformVendors[row.area] = row.vendor;

    res.json({ pricing: pricingResult.rows, branding, windows, tiers, surfaces, platformVendors });
  } catch (err) {
    log.error({ err }, 'model-registry internal endpoint failed');
    res.status(500).json({ error: 'internal error' });
  }
});
