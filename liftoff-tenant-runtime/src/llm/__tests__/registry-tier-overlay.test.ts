// The registry decides which model a tier resolves to. The static maps are a
// bootstrap.
//
// WHY. Until this overlay existed, every tier in this plane was answered by a
// hard-coded map — a second source of truth beside the control plane's registry,
// with nothing keeping the two in step. They did not stay in step: `medium` sat
// on `claude-sonnet-4-6` while the control plane had moved to `claude-sonnet-5`,
// and the only reason no run took the wrong model was that each tenant's policy
// carried a RESOLVED model id that overrode this map entirely.
//
// Removing that stored id is the point of the change this arrived with, and it
// is what makes these maps load-bearing. So they stop being the authority at the
// same moment: the registry's answer wins, and the seed is what answers before
// the first snapshot lands and if a refresh fails.
//
// The two directions both matter. An overlay that did not win would leave the
// drift in place. An overlay that CLEARED what it does not mention would take a
// provider offline the moment a snapshot arrived without it — silence read as a
// decision to route nowhere.

import {
  modelForTierOrUndefined,
  resolveModelForTier,
  isKnownTierProvider,
  setRegistryTierModels,
  _clearRegistryTierModels,
} from '../tiers';
import { TIER_MODELS as ANTHROPIC_TIERS } from '../providers/anthropic';
import { TIER_MODELS as QWEN_TIERS } from '../providers/qwen';

afterEach(() => _clearRegistryTierModels());

describe('the registry overlay wins over the seed', () => {
  it('answers with the registry model, not the compiled-in one', () => {
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);

    expect(modelForTierOrUndefined('anthropic', 'medium')).toBe('claude-sonnet-9-9');
    // And the seed is what it displaced, so this test fails for the right reason
    // if the seed is what changed.
    expect(ANTHROPIC_TIERS.medium).not.toBe('claude-sonnet-9-9');
  });

  it('overlays ONE tier without disturbing its siblings', () => {
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);

    expect(modelForTierOrUndefined('anthropic', 'large')).toBe(ANTHROPIC_TIERS.large);
    expect(modelForTierOrUndefined('anthropic', 'small')).toBe(ANTHROPIC_TIERS.small);
  });

  it('leaves a provider the snapshot never mentions on its seed', () => {
    // An absent row is silence, not an instruction to route nowhere.
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);

    expect(modelForTierOrUndefined('qwen', 'medium')).toBe(QWEN_TIERS.medium);
  });

  it('replaces the whole overlay on each refresh, so a withdrawn model stops resolving', () => {
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);
    expect(modelForTierOrUndefined('anthropic', 'medium')).toBe('claude-sonnet-9-9');

    // A later snapshot no longer carries that row: the answer must fall back to
    // the seed rather than linger on a model the registry has dropped.
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'large', model_id: 'claude-opus-9-9' },
    ]);

    expect(modelForTierOrUndefined('anthropic', 'medium')).toBe(ANTHROPIC_TIERS.medium);
    expect(modelForTierOrUndefined('anthropic', 'large')).toBe('claude-opus-9-9');
  });

  it('lets a provider with no seed at all be onboarded by the registry alone', () => {
    // The point of the feed: a new vendor is a registry row, not a release.
    expect(isKnownTierProvider('brand-new-vendor')).toBe(false);

    setRegistryTierModels([
      { provider: 'brand-new-vendor', tier: 'medium', model_id: 'bnv-2-pro' },
    ]);

    expect(isKnownTierProvider('brand-new-vendor')).toBe(true);
    expect(resolveModelForTier('brand-new-vendor', 'medium')).toBe('bnv-2-pro');
  });

  it('falls back within the MERGED view, not the seed, for an unrecognised tier', () => {
    // A tier gap is a naming question and still lands on `medium`. Reading that
    // fallback off the seed would answer with the generation the seed remembers,
    // which is the precise bug this overlay exists to end.
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);

    expect(modelForTierOrUndefined('anthropic', 'mystery-tier')).toBe('claude-sonnet-9-9');
  });

  it('ignores a malformed row rather than installing an empty answer', () => {
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: '' },
      { provider: '', tier: 'medium', model_id: 'nowhere' },
    ]);

    expect(modelForTierOrUndefined('anthropic', 'medium')).toBe(ANTHROPIC_TIERS.medium);
  });

  it('still throws for a provider neither the seed nor the registry knows', () => {
    setRegistryTierModels([
      { provider: 'anthropic', tier: 'medium', model_id: 'claude-sonnet-9-9' },
    ]);

    expect(() => resolveModelForTier('not-a-vendor', 'medium'))
      .toThrow(/No model catalogue for provider 'not-a-vendor'/);
  });
});
