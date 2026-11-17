import type { LLMModelTier } from './types';
import { TIER_MODELS as ANTHROPIC_TIERS }        from './providers/anthropic';
import { TIER_MODELS as OPENAI_TIERS }            from './providers/openai';
import { TIER_MODELS as GOOGLE_TIERS }            from './providers/google';
import { TIER_MODELS as GLM_TIERS }               from './providers/glm';
import { TIER_MODELS as XAI_TIERS }               from './providers/xai';
import { TIER_MODELS as QWEN_TIERS }              from './providers/qwen';
import { TIER_MODELS as DEEPSEEK_TIERS }          from './providers/deepseek';
import { TIER_MODELS as KIMI_TIERS }              from './providers/kimi';
import { TIER_MODELS as MINIMAX_TIERS }           from './providers/minimax';
import { TIER_MODELS as XIAOMI_TIERS }            from './providers/xiaomi';

const PROVIDER_TIERS: Record<string, Record<LLMModelTier, string>> = {
  anthropic:          ANTHROPIC_TIERS,
  openai:             OPENAI_TIERS,
  google:             GOOGLE_TIERS,
  // Grok is its own provider, not an OpenRouter tenant. Its ids are NATIVE
  // (`grok-4.6`, not `x-ai/grok-4.6`) because they go to api.x.ai.
  xai:                XAI_TIERS,
  // The four open-weight families. They share OpenRouter's ENDPOINT and account
  // — the ids are namespaced and the calls bill there — and they are separate
  // providers because THIS MAP is what a provider selects: one entry per
  // provider, so a gateway serving four families could only ever answer with
  // one of them. It answered with GLM, for all four.
  glm:                GLM_TIERS,
  qwen:               QWEN_TIERS,
  deepseek:           DEEPSEEK_TIERS,
  kimi:               KIMI_TIERS,
  minimax:            MINIMAX_TIERS,
  xiaomi:             XIAOMI_TIERS,
};

/** The registry's answer, overlaid on the seeds above.
 *
 *  WHY THIS EXISTS. The maps above were the ONLY answer this plane had, and they
 *  are code — so every tier here was a second source of truth beside the
 *  control plane's registry with nothing keeping the two in step. They did not
 *  stay in step: `medium` sat on `claude-sonnet-4-6` while the control plane had
 *  moved to `claude-sonnet-5`, and the only reason it did not matter was that
 *  tenants carried a stamped model id that overrode this map. Removing that
 *  stamp — the point of the change this arrived with — is what makes these maps
 *  load-bearing, so they stop being the authority at the same moment.
 *
 *  The seeds remain as a BOOTSTRAP, exactly as the control plane treats its own:
 *  what resolves before the first snapshot lands, and what keeps resolving if a
 *  refresh fails. A (provider, tier) pair the registry does not mention keeps
 *  its seed rather than disappearing — an absent row is silence, not a decision
 *  to route nowhere. */
let registryTierModels: Record<string, Record<string, string>> = {};

/** Install the snapshot's tier rows. Called by model-registry-loader on every
 *  refresh; replaces the previous overlay wholesale so a model withdrawn from
 *  the registry stops resolving rather than lingering. */
export function setRegistryTierModels(
  rows: ReadonlyArray<{ provider: string; tier: string; model_id: string }>,
): void {
  const next: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    if (!r.provider || !r.tier || !r.model_id) continue;
    (next[r.provider] ??= {})[r.tier] = r.model_id;
  }
  registryTierModels = next;
}

/** Clear the overlay, returning every provider to its seed.
 *
 *  Underscore-prefixed because it exists for tests and the reachability ratchet
 *  is right to ask: production never clears the overlay deliberately. A refresh
 *  REPLACES it wholesale, which is how a withdrawn model stops resolving, and a
 *  failed refresh keeps the last good one rather than falling back to the seeds. */
export function _clearRegistryTierModels(): void {
  registryTierModels = {};
}

/** Whether this provider publishes a tier catalogue here.
 *
 *  A provider the registry knows counts, even with no seed of its own: that is
 *  what lets a vendor be onboarded by a registry row instead of a release. */
export function isKnownTierProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_TIERS, provider)
    || Object.prototype.hasOwnProperty.call(registryTierModels, provider);
}

/** The model a provider publishes for a tier, or undefined when that provider
 *  has no catalogue here.
 *
 *  A model id only means something to the provider that publishes it, so an
 *  unknown provider yields NOTHING rather than a stand-in from another
 *  provider's table. Use this where the caller can carry on without a model
 *  (letting the provider adapter pick its own default); use
 *  resolveModelForTier where a model is required.
 *
 *  Within a known provider an unrecognised tier still falls back to that same
 *  provider's `medium` — a tier gap is a naming question, not a routing one. */
export function modelForTierOrUndefined(provider: string, tier: string): string | undefined {
  const seed = PROVIDER_TIERS[provider] as Record<string, string> | undefined;
  const overlay = registryTierModels[provider];
  if (!seed && !overlay) return undefined;
  // The registry wins per (provider, tier); the seed answers what it has not
  // mentioned. `medium` is the within-provider fallback on the merged view
  // rather than on the seed alone, or a provider the registry has moved would
  // fall back to the generation the seed remembers.
  const merged = { ...(seed ?? {}), ...(overlay ?? {}) };
  return merged[tier] ?? merged.medium;
}

/** The model a provider publishes for a tier.
 *
 *  Throws for a provider with no catalogue. The previous behaviour — silently
 *  falling back to the Anthropic table — answered an unrecognised provider
 *  with a Claude model id, which that provider then rejected mid-run
 *  (`400 <model> is not a valid model ID`). Failing here names the mistake at
 *  its source instead of turning it into a vendor-side error. */
export function resolveModelForTier(provider: string, tier: string): string {
  const model = modelForTierOrUndefined(provider, tier);
  if (!model) {
    const known = [...new Set([...Object.keys(PROVIDER_TIERS), ...Object.keys(registryTierModels)])];
    throw new Error(
      `No model catalogue for provider '${provider}' (tier '${tier}'). `
      + `Known providers: ${known.join(', ')}. `
      + "Add a TIER_MODELS map for the provider rather than routing it to another provider's models.",
    );
  }
  return model;
}
