// PR 1.2 #5 — tenant-runtime tier→model resolution lives in the provider.
//
// After PR 1.2 the caller in agent-execution leaves `model` undefined when
// the caller has a tier preference, and the provider's complete() method
// consults its TIER_MODELS map. These tests assert that contract for each
// provider's resolution helper without booting the full provider class.

import { TIER_MODELS as ANTHROPIC_TIERS } from '../providers/anthropic';
import { TIER_MODELS as OPENAI_TIERS } from '../providers/openai';
import { TIER_MODELS as GOOGLE_TIERS } from '../providers/google';
import { resolveModelForTier } from '../tiers';

// The same priority `provider.complete()` uses: `request.model` wins; else
// `request.tier` → TIER_MODELS lookup; else DEFAULT_MODEL.
function resolveLikeProvider(
  tiers: Record<string, string>,
  defaultModel: string,
  request: { model?: string; tier?: string },
): string {
  if (request.model) return request.model;
  if (request.tier && tiers[request.tier]) return tiers[request.tier];
  return defaultModel;
}

describe('tier→model resolution per provider', () => {
  describe('anthropic', () => {
    const DEFAULT = 'claude-sonnet-5-5';
    it('large → claude-opus-5-5', () => {
      expect(resolveLikeProvider(ANTHROPIC_TIERS, DEFAULT, { tier: 'large' })).toBe('claude-opus-5-5');
    });
    it('medium → claude-sonnet-5-5', () => {
      expect(resolveLikeProvider(ANTHROPIC_TIERS, DEFAULT, { tier: 'medium' })).toBe('claude-sonnet-5-5');
    });
    it('small → claude-haiku-4-5', () => {
      expect(resolveLikeProvider(ANTHROPIC_TIERS, DEFAULT, { tier: 'small' })).toBe('claude-haiku-4-5');
    });
    it('explicit model wins over tier', () => {
      expect(resolveLikeProvider(ANTHROPIC_TIERS, DEFAULT, { model: 'claude-opus-4-7', tier: 'small' }))
        .toBe('claude-opus-4-7');
    });
    it('falls back to DEFAULT_MODEL when neither model nor tier set', () => {
      expect(resolveLikeProvider(ANTHROPIC_TIERS, DEFAULT, {})).toBe(DEFAULT);
    });
  });

  describe('openai', () => {
    it('large → gpt-6-astra', () => {
      expect(OPENAI_TIERS.large).toBe('gpt-6-astra');
    });
    it('medium → gpt-6.1-sol (medium on GPT-6, where gpt-5.6-sol was large)', () => {
      expect(OPENAI_TIERS.medium).toBe('gpt-6.1-sol');
    });
    it('small → gpt-6-luna', () => {
      expect(OPENAI_TIERS.small).toBe('gpt-6-luna');
    });
  });

  describe('google', () => {
    it('large → gemini-3.1-pro-preview', () => {
      expect(GOOGLE_TIERS.large).toBe('gemini-3.1-pro-preview');
    });
    it('medium → gemini-3.5-flash', () => {
      expect(GOOGLE_TIERS.medium).toBe('gemini-3.5-flash');
    });
    it('small → gemini-3.1-flash-lite', () => {
      expect(GOOGLE_TIERS.small).toBe('gemini-3.1-flash-lite');
    });
  });

  describe('resolveModelForTier helper', () => {
    it('resolves through the provider map', () => {
      expect(resolveModelForTier('anthropic', 'large')).toBe('claude-opus-5-5');
      expect(resolveModelForTier('openai', 'small')).toBe('gpt-6-luna');
      expect(resolveModelForTier('google', 'medium')).toBe('gemini-3.5-flash');
    });
    it('throws for an unknown provider instead of defaulting to Anthropic', () => {
      // Previously this returned a Claude model id for ANY provider string.
      // That is how `claude-sonnet-4-6` reached OpenRouter, which rejected it
      // mid-run — a model id is only meaningful to the provider that
      // publishes it, so there is no safe stand-in.
      expect(() => resolveModelForTier('unknown', 'large'))
        .toThrow(/No model catalogue for provider 'unknown'/);
    });
    it('defaults to medium when tier is unknown', () => {
      expect(resolveModelForTier('anthropic', 'mystery')).toBe('claude-sonnet-5-5');
    });
  });
});
