// The top routing tier is 'large' (migration 534, reversing 196's rename to
// 'flagship'). Two halves are asserted here:
//
//   - READERS: normalizeTier and the helpers built on it map the old name to
//     'large' at a read boundary, and leave every other value for the caller's
//     own validation.
//   - WRITERS: nothing this process builds emits the old name. The seeds, the
//     provider tier maps and the policy builder are the values that reach the
//     database and the tenant runtimes, so they are checked directly.

import { LLM_MODEL_TIERS, normalizeTier, withNormalizedTier } from '../types';
import { normalizePolicyTiers, type RoutingPolicy } from '../../model-registry/types';
import {
  WORKSPACE_AI_SELECTIONS,
  WORKSPACE_AI_VENDORS,
  buildWorkspaceAiPolicy,
  effectiveModelConfig,
} from '../../model-registry/workspace-ai-vendors';
import { TIER_MODELS as ANTHROPIC_TIER_MODELS } from '../providers/anthropic';
import { TIER_MODELS as GOOGLE_TIER_MODELS } from '../providers/google';
import { TIER_MODELS as OPENAI_TIER_MODELS } from '../providers/openai';
import { OPENROUTER_TIER_MODELS } from '../providers/openrouter';
import { TIER_MAP } from '../../branding/registry';

const OLD = 'flagship';

describe('normalizeTier', () => {
  it('reads the old name of the top tier as large', () => {
    expect(normalizeTier(OLD)).toBe('large');
  });

  it('passes every current tier through unchanged', () => {
    for (const tier of LLM_MODEL_TIERS) expect(normalizeTier(tier)).toBe(tier);
  });

  it('leaves anything else for the caller to validate', () => {
    expect(normalizeTier(undefined)).toBeUndefined();
    expect(normalizeTier(null)).toBeNull();
    expect(normalizeTier('frontier')).toBe('frontier');
    expect(normalizeTier('Flagship')).toBe('Flagship');
    expect(normalizeTier(42)).toBe(42);
  });
});

describe('withNormalizedTier', () => {
  it('rewrites only the tier, keeping every other field', () => {
    expect(withNormalizedTier({ tier: OLD, modelId: 'ft:acme', maxTokens: 10 })).toEqual({
      tier: 'large',
      modelId: 'ft:acme',
      maxTokens: 10,
    });
  });

  it('returns the same object when there is nothing to change', () => {
    const current = { tier: 'medium' };
    const empty = {};
    expect(withNormalizedTier(current)).toBe(current);
    expect(withNormalizedTier(empty)).toBe(empty);
  });
});

describe('normalizePolicyTiers', () => {
  it('rewrites defaultTier and every taskTierOverrides value', () => {
    const stored = {
      defaultTier: OLD,
      defaultModel: 'claude-sonnet-5',
      taskTierOverrides: { retrieval_hyde: 'small', planning: OLD },
      taskOverrides: { retrieval_hyde: 'claude-haiku-4-5' },
    } as unknown as RoutingPolicy;
    expect(normalizePolicyTiers(stored)).toEqual({
      defaultTier: 'large',
      defaultModel: 'claude-sonnet-5',
      taskTierOverrides: { retrieval_hyde: 'small', planning: 'large' },
      taskOverrides: { retrieval_hyde: 'claude-haiku-4-5' },
    });
  });

  it('does not add tier keys a policy did not have', () => {
    const noDefault = { taskTierOverrides: { planning: OLD } } as unknown as RoutingPolicy;
    expect(normalizePolicyTiers(noDefault)).toEqual({ taskTierOverrides: { planning: 'large' } });
  });

  it('returns the same object when there is nothing to change', () => {
    const current: RoutingPolicy = { defaultTier: 'medium', taskTierOverrides: { a: 'small' } };
    const untiered: RoutingPolicy = { defaultModel: '', taskOverrides: {} };
    expect(normalizePolicyTiers(current)).toBe(current);
    expect(normalizePolicyTiers(untiered)).toBe(untiered);
  });
});

describe('writers emit only the current tier names', () => {
  const tierKeys = [...LLM_MODEL_TIERS].sort();

  it('every provider tier map is keyed large / medium / small', () => {
    for (const map of [ANTHROPIC_TIER_MODELS, GOOGLE_TIER_MODELS, OPENAI_TIER_MODELS, OPENROUTER_TIER_MODELS]) {
      expect(Object.keys(map).sort()).toEqual(tierKeys);
    }
  });

  it('every Workspace AI vendor is keyed large / medium / small', () => {
    for (const spec of Object.values(WORKSPACE_AI_VENDORS)) {
      expect(Object.keys(spec.tiers).sort()).toEqual(tierKeys);
    }
  });

  it("Anthropic's large tier is still Opus 5.5, and Fable is still Frontier only", () => {
    expect(ANTHROPIC_TIER_MODELS.large).toBe('claude-opus-5-5');
    expect(WORKSPACE_AI_VENDORS.anthropic.tiers.large).toBe('claude-opus-5-5');
    expect(WORKSPACE_AI_VENDORS.anthropic.frontier).toBe('claude-fable-5-2');
    expect(Object.values(WORKSPACE_AI_VENDORS.anthropic.tiers)).not.toContain('claude-fable-5-2');
    // The model it succeeds is in no tier either, so a stale read of either one
    // cannot reach a route.
    expect(Object.values(WORKSPACE_AI_VENDORS.anthropic.tiers)).not.toContain('claude-fable-5-1');
  });

  it('branding knows the large tier', () => {
    expect(TIER_MAP.large).toBe('hyperion');
    expect(TIER_MAP[OLD]).toBeUndefined();
  });

  it('buildWorkspaceAiPolicy never writes the old name, for any selection', () => {
    for (const selection of WORKSPACE_AI_SELECTIONS) {
      // A stale stored policy as the current one: its tiers must not leak into
      // the rebuilt policy.
      const stale = { defaultTier: OLD, taskTierOverrides: { planning: OLD } } as unknown as RoutingPolicy;
      const json = JSON.stringify(buildWorkspaceAiPolicy(selection, stale));
      expect(json).not.toContain(OLD);
    }
  });

  it('effectiveModelConfig keeps a large agent on large under a vendor override', () => {
    const out = effectiveModelConfig({ modelConfig: { tier: 'large' }, aiVendorOverride: 'qwen' });
    expect(out.tier).toBe('large');
  });
});
