// The top tier is 'large'. It was 'flagship' from platform-backend migration 196
// until the rename back, and a value under the retired name can still arrive:
// from a control plane not yet redeployed, a cached routing policy not yet
// refreshed, a stored agent config, or deploy-time env. An unrecognised tier
// does not fail — it resolves to the provider's MEDIUM model — so a retired
// name that reached the tier table unnormalised would quietly downgrade every
// large-tier agent. These tests pin both halves: the rename changed no model,
// and the retired name still lands on the large one.

import { normalizeTier } from '../types';
import { modelForTierOrUndefined, resolveModelForTier } from '../tiers';

// Exactly what each provider's top tier resolved to under its previous name.
const LARGE_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-5-5',
  openai:    'gpt-6-astra',
  google:    'gemini-3.1-pro-preview',
  xai:       'grok-4.6',
  glm:       'z-ai/glm-5.3',
  qwen:      'qwen/qwen3.8-max-0902',
  deepseek:  'deepseek/deepseek-v4-pro',
  kimi:      'moonshotai/kimi-k3',
  minimax:   'minimax/minimax-m3',
};

describe('the large tier', () => {
  it.each(Object.entries(LARGE_MODELS))('%s resolves large to %s', (provider, model) => {
    expect(resolveModelForTier(provider, 'large')).toBe(model);
  });
});

describe('normalizeTier', () => {
  it('maps the retired top-tier name to large', () => {
    expect(normalizeTier('flagship')).toBe('large');
  });

  it('passes every current tier, an unknown value and an absence through unchanged', () => {
    for (const t of ['large', 'medium', 'small', 'bogus', '']) {
      expect(normalizeTier(t)).toBe(t);
    }
    expect(normalizeTier(undefined)).toBeUndefined();
    expect(normalizeTier(null)).toBeNull();
  });

  it.each(Object.keys(LARGE_MODELS))('%s: the retired name resolves the large model, not medium', (provider) => {
    expect(resolveModelForTier(provider, normalizeTier('flagship'))).toBe(LARGE_MODELS[provider]);
  });

  it('is needed: unnormalised, the retired name falls through to medium', () => {
    // The failure the normaliser exists to prevent, stated so a future change
    // to the fallback has to confront it.
    expect(modelForTierOrUndefined('anthropic', 'flagship')).toBe(resolveModelForTier('anthropic', 'medium'));
  });
});
