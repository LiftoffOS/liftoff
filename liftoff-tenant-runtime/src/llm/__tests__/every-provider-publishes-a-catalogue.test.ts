// Every provider a run can resolve to publishes a tier catalogue and a rate.
//
// This is the gap that let four vendors share one name. `PROVIDER_TIERS` is
// `Record<string, …>`, so a provider with no entry is not a compile error — it
// is a run that reaches `resolveModelForTier` and throws mid-flight, or worse
// resolves through a path that quietly answers with another vendor's model.
// Qwen, DeepSeek and Kimi were approved in the control-plane registry and had
// no catalogue here for weeks, which is exactly how long "set the workspace to
// Qwen" meant "run GLM".
//
// The rate half is the same shape with a quieter failure. `getModelPricing`
// returns null on a miss and logs a warning nobody reads, so an unpriced model
// bills at nothing at all — for every row, indefinitely.

import { RESOLVED_PROVIDERS } from '../../agent-execution/adapter/types';
import { isKnownTierProvider, resolveModelForTier } from '../tiers';
import { getModelPricing } from '../pricing';
import type { LLMProvider } from '../types';

const TIERS = ['small', 'medium', 'large'] as const;

describe('every provider a run can resolve to is fully described', () => {
  it('publishes a tier catalogue', () => {
    const missing = RESOLVED_PROVIDERS.filter((p) => !isKnownTierProvider(p));
    expect({
      missing,
      hint: missing.length
        ? 'Add a TIER_MODELS map under src/llm/providers/ and register it in tiers.ts. '
          + 'Without one, resolveModelForTier throws mid-run for this provider.'
        : '',
    }).toEqual({ missing: [], hint: '' });
  });

  it.each(RESOLVED_PROVIDERS)('%s resolves a distinct model for every tier', (provider) => {
    for (const tier of TIERS) {
      const model = resolveModelForTier(provider, tier);
      expect({ provider, tier, empty: !model }).toEqual({ provider, tier, empty: false });
    }
  });

  // The failure this rules out is not a missing model but a SHARED one: four
  // providers pointing at one catalogue is indistinguishable from four
  // providers until you read what each returns.
  it('gives each family its own models, not a neighbour’s', () => {
    const largeModels = new Map<string, string>();
    for (const provider of RESOLVED_PROVIDERS) {
      // The two Anthropic entries are one vendor over two transports and
      // deliberately share a catalogue; every other pair sharing one is the
      // defect.
      if (provider === 'anthropic-vertex') continue;
      largeModels.set(provider, resolveModelForTier(provider, 'large'));
    }
    const byModel = new Map<string, string[]>();
    for (const [provider, model] of largeModels) {
      byModel.set(model, [...(byModel.get(model) ?? []), provider]);
    }
    const shared = [...byModel.entries()].filter(([, ps]) => ps.length > 1);
    expect(shared).toEqual([]);
  });

  it.each(RESOLVED_PROVIDERS)('%s has a published rate for every tier model', (provider) => {
    for (const tier of TIERS) {
      const model = resolveModelForTier(provider, tier);
      const rate = getModelPricing(model, provider as LLMProvider);
      expect({ provider, tier, model, priced: rate !== null })
        .toEqual({ provider, tier, model, priced: true });
    }
  });
});
