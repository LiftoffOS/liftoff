import { isKnownTierProvider, modelForTierOrUndefined, resolveModelForTier } from '../tiers';

describe('resolveModelForTier', () => {
  it('resolves each known provider to its own tier map', () => {
    expect(resolveModelForTier('anthropic', 'small')).toBe('claude-haiku-4-5');
    expect(resolveModelForTier('openai', 'small')).toBe('gpt-6-luna');
    expect(resolveModelForTier('google', 'small')).toBe('gemini-3.1-flash-lite');
  });

  it('resolves openrouter tiers to OpenRouter model slugs, NOT the Anthropic fallback', () => {
    // Regression: openrouter was absent from PROVIDER_TIERS, so the live cert
    // (and any openrouter run) got a Claude model id that an OpenRouter endpoint
    // rejects. It must now resolve to a real OpenRouter slug.
    expect(resolveModelForTier('glm', 'small')).toBe('z-ai/glm-5.3-flash');
    expect(resolveModelForTier('glm', 'large')).toBe('z-ai/glm-5.3');
    expect(resolveModelForTier('glm', 'small')).not.toBe(resolveModelForTier('anthropic', 'small'));
  });

  it('throws for a provider with no catalogue rather than substituting another provider', () => {
    // This case previously fell back to the Anthropic map. That is the same
    // defect the openrouter test above describes, one level up: an
    // unrecognised provider was answered with a Claude model id, which the
    // real vendor then rejected mid-run with
    // `400 claude-sonnet-4-6 is not a valid model ID`. A model id is only
    // meaningful to the provider that publishes it, so there is no honest
    // stand-in — name the mistake at its source instead.
    expect(() => resolveModelForTier('nonexistent', 'small'))
      .toThrow(/No model catalogue for provider 'nonexistent'/);
    expect(() => resolveModelForTier('nonexistent', 'small')).toThrow(/Known providers:/);
  });

  it('reports undefined from the optional form, never a foreign model', () => {
    // For callers that can carry on without a model (the provider adapter
    // picks its own default) — still never another provider's id.
    expect(modelForTierOrUndefined('nonexistent', 'small')).toBeUndefined();
    expect(isKnownTierProvider('nonexistent')).toBe(false);
    expect(isKnownTierProvider('glm')).toBe(true);
  });

  it('never answers a non-Anthropic provider with a Claude model, at any tier', () => {
    for (const provider of ['glm', 'openai', 'google']) {
      for (const tier of ['large', 'medium', 'small', 'bogus']) {
        expect(modelForTierOrUndefined(provider, tier)).not.toMatch(/^claude-/);
      }
    }
  });

  it('falls back to the provider medium for an unknown tier', () => {
    expect(resolveModelForTier('glm', 'bogus')).toBe('z-ai/glm-5.3');
  });
});
