// Every model a request can resolve to must have a published rate.
//
// computeRowCost never bills $0 — an unknown model falls back to the
// conservative default rate — so an unpriced model does not break anything, and
// that is exactly the problem. It is charged at another model's price, on every
// row, indefinitely, and every surface looks healthy while it happens. The
// fallback is a floor against under-charging, not a substitute for knowing.
//
// A RATCHET, like known-orphan-exports and known-unreferenced-tables, for the
// same reason: the tree already carries models nobody has a published rate for,
// and demanding they be resolved first would mean not having the check at all.
// The existing set is frozen below as visible debt; anything new fails.
//
// This is the CODE-CONSTANT half. It runs in the unit suite, needs no database,
// and gates every model reachable from a provider tier map or the Workspace AI
// vendor map. The REGISTRY half — a row an operator adds without touching code
// — cannot be seen from here and is reported by reportPricingCoverage in
// src/scripts/sync-model-pricing.ts on every sync run.

import { MODEL_PRICING } from '../pricing';
import {
  TIER_MODELS as ANTHROPIC_TIER_MODELS,
  DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL,
} from '../providers/anthropic';
import {
  TIER_MODELS as GOOGLE_TIER_MODELS,
  DEFAULT_MODEL as GOOGLE_DEFAULT_MODEL,
} from '../providers/google';
import {
  TIER_MODELS as OPENAI_TIER_MODELS,
  DEFAULT_MODEL as OPENAI_DEFAULT_MODEL,
} from '../providers/openai';
import { OPENROUTER_TIER_MODELS } from '../providers/openrouter';
import {
  EMBEDDING_DEFAULTS,
  WORKSPACE_AI_VENDORS,
  type WorkspaceAiVendor,
} from '../../model-registry/workspace-ai-vendors';
import { PINNED_TYPESAFE_MODEL_IDS } from '../../typesafe/questions';

/**
 * Models with no published rate in this estate, frozen as debt.
 *
 * Each one is charged at the conservative default rate today. NONE of them is
 * acceptable long-term and none may be copied as precedent: the entry says "no
 * rate has been recorded", never "this model is free" or "the default is close
 * enough".
 *
 * A rate goes in MODEL_PRICING only from the vendor's own published price list,
 * the same discipline migration 343 applies to context windows — a number we are
 * unsure of is worse than none, because it silently becomes what a customer is
 * charged. Remove an entry here in the same change that records its rate.
 */
const MODELS_WITHOUT_A_PUBLISHED_RATE: readonly string[] = [
  // Empty, and worth keeping that way. Every model this platform can resolve to
  // is priced from its vendor's own published figures. An entry here is a model
  // being billed at another model's price on every row it produces.
];

/** Where each id comes from, so a failure says what to fix rather than just
 *  naming a string. */
function reachableModels(): Array<{ source: string; modelId: string; provider: string }> {
  const out: Array<{ source: string; modelId: string; provider: string }> = [];

  const addTierMap = (source: string, tiers: Record<string, string>, provider: string): void => {
    for (const [tier, modelId] of Object.entries(tiers)) {
      out.push({ source: `${source}.${tier}`, modelId, provider });
    }
  };

  addTierMap('providers/anthropic TIER_MODELS', ANTHROPIC_TIER_MODELS, 'anthropic');
  addTierMap('providers/google TIER_MODELS', GOOGLE_TIER_MODELS, 'google');
  addTierMap('providers/openai TIER_MODELS', OPENAI_TIER_MODELS, 'openai');
  addTierMap('providers/openrouter OPENROUTER_TIER_MODELS', OPENROUTER_TIER_MODELS, 'openrouter');

  out.push(
    { source: 'providers/anthropic DEFAULT_MODEL', modelId: ANTHROPIC_DEFAULT_MODEL, provider: 'anthropic' },
    { source: 'providers/google DEFAULT_MODEL', modelId: GOOGLE_DEFAULT_MODEL, provider: 'google' },
    { source: 'providers/openai DEFAULT_MODEL', modelId: OPENAI_DEFAULT_MODEL, provider: 'openai' },
    { source: 'WORKSPACE_AI_VENDORS EMBEDDING_DEFAULTS', modelId: EMBEDDING_DEFAULTS.model, provider: EMBEDDING_DEFAULTS.provider },
  );

  // The TypeSafe classifier pins its own concrete id outside every tier map,
  // so it is named here explicitly rather than reached through a provider.
  for (const modelId of PINNED_TYPESAFE_MODEL_IDS) {
    out.push({ source: 'typesafe/questions PINNED_TYPESAFE_MODEL_IDS', modelId, provider: 'typesafe' });
  }

  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    // The vendor spec's provider IS the runtime provider, which is what the
    // pricing key is built from.
    addTierMap(
      `WORKSPACE_AI_VENDORS.${vendor}`,
      WORKSPACE_AI_VENDORS[vendor].tiers,
      WORKSPACE_AI_VENDORS[vendor].provider,
    );
    // The Frontier model: routed to by no tier today, but a named model the
    // card offers, and a run that names it must not bill at another's price.
    const frontier = WORKSPACE_AI_VENDORS[vendor].frontier;
    if (frontier) {
      out.push({
        source: `WORKSPACE_AI_VENDORS.${vendor}.frontier`,
        modelId: frontier,
        provider: WORKSPACE_AI_VENDORS[vendor].provider,
      });
    }
  }
  return out;
}

/** computeRowCost's static resolution: the provider-qualified key, then the
 *  bare model key. The DB overlay is not visible from a unit test and is not
 *  the point — a model with no STATIC entry has no rate offline, on first boot,
 *  or whenever the overlay has not loaded. */
function hasStaticRate(provider: string, modelId: string): boolean {
  return (
    MODEL_PRICING[`${provider}:${modelId}`] !== undefined
    || MODEL_PRICING[modelId] !== undefined
  );
}

describe('every reachable model has a published rate', () => {
  const unpriced = reachableModels().filter((m) => !hasStaticRate(m.provider, m.modelId));
  const baseline = new Set(MODELS_WITHOUT_A_PUBLISHED_RATE);

  it('adds no new model that nothing knows the price of', () => {
    const fresh = unpriced.filter((m) => !baseline.has(m.modelId));
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} reachable model(s) have no rate in MODEL_PRICING:\n\n`
        + fresh.map((m) => `  ${m.source} → ${m.provider}:${m.modelId}`).join('\n')
        + '\n\nEvery usage row for these is billed at the conservative default\n'
        + "rate — another model's price, charged to a real customer.\n\n"
        + 'Fix it one of these ways:\n'
        + "  1. Record the vendor's published rate in src/llm/pricing.ts. This is\n"
        + '     almost always the answer.\n'
        + '  2. If the model is served through OpenRouter, confirm the sync job\n'
        + '     covers its registry provider (OPENROUTER_PROVIDERS) — those rates\n'
        + '     arrive from the vendor and need no static entry beyond a fallback.\n'
        + '  3. Add it to MODELS_WITHOUT_A_PUBLISHED_RATE with a comment saying\n'
        + '     why no rate can be recorded yet. This is debt, and a reviewer\n'
        + '     should ask when it will be paid.\n',
      );
    }
  });

  it('does not let the debt list rot', () => {
    // An entry that now has a rate has been paid off — good — and leaving it
    // listed means the next model that loses its rate at that name slips
    // through silently.
    const reachable = new Set(reachableModels().map((m) => m.modelId));
    const stale = [...baseline].filter(
      (id) => !unpriced.some((m) => m.modelId === id),
    );
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline entr(ies) are priced or no longer reachable and should be `
        + `removed from MODELS_WITHOUT_A_PUBLISHED_RATE:\n\n${stale.map((k) => `  ${k}`).join('\n')}\n\n`
        + 'Leaving them listed means a future unpriced model at the same name ships unnoticed.\n',
      );
    }
    // Every baseline entry must still name something a request can reach.
    // An id nobody routes to is not debt, it is a typo.
    for (const id of baseline) expect(reachable).toContain(id);
  });

  it('prices every model the estate does know the rate of', () => {
    // The positive half, so the ratchet cannot pass by knowing nothing: the
    // Anthropic and OpenRouter ladders are fully priced and must stay so.
    for (const m of reachableModels()) {
      if (m.provider === 'anthropic' || m.provider === 'openrouter') {
        expect({ model: m.modelId, priced: hasStaticRate(m.provider, m.modelId) })
          .toEqual({ model: m.modelId, priced: true });
      }
    }
  });
});
