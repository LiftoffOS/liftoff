// Per-model context windows, and the rule that separates a recorded window from
// a provider-family floor.
//
// The distinction is the whole point of the module. Anthropic's floor is 200,000
// and claude-opus-5[1m] holds 1,000,000, so a consumer that treats the floor as
// exact reads a healthy 300k-token run as an overflow — and wired to a session
// retirement, abandons a good conversation. Every assertion below exists to stop
// that regression.

import {
  setModelContextWindows,
  getModelContextWindow,
  contextWindowForModel,
  mayDriveRetirement,
} from '../context-window';
import { resolveModelForTier } from '../tiers';
import { normalizeModelId } from '../pricing';
import { RESOLVED_PROVIDERS } from '../../agent-execution/adapter/types';

// Every provider a run can resolve to, derived rather than listed. Listed, it
// held five of nine, so four providers' tier models were never checked for a
// window at all — and the check exists because a missing window is silent.
const PROVIDERS = RESOLVED_PROVIDERS;
const TIERS = ['small', 'medium', 'large'] as const;

/** A registry snapshot covering every model resolveModelForTier can return,
 *  plus the long-window Anthropic model whose floor is most wrong. */
function fullRegistrySnapshot(): Map<string, number> {
  const map = new Map<string, number>();
  // Keys are normalized exactly the way the loader normalizes them, so this
  // fixture cannot pass against a lookup that production would miss.
  for (const provider of PROVIDERS) {
    for (const tier of TIERS) {
      map.set(`${provider}:${normalizeModelId(resolveModelForTier(provider, tier))}`, 200_000);
    }
  }
  map.set(`anthropic:${normalizeModelId('claude-opus-5[1m]')}`, 1_000_000);
  return map;
}

afterEach(() => setModelContextWindows(null));

describe('the registry overlay', () => {
  it('returns undefined for every model before the first load', () => {
    setModelContextWindows(null);
    expect(getModelContextWindow('anthropic', 'claude-opus-5')).toBeUndefined();
  });

  it('resolves a recorded window once the overlay is installed', () => {
    setModelContextWindows(new Map([['anthropic:claude-opus-5', 200_000]]));
    expect(getModelContextWindow('anthropic', 'claude-opus-5')).toBe(200_000);
  });

  it('normalizes the model id the same way the pricing overlay does', () => {
    // Keyed dot-form; looked up dash-form. Both must land on the same entry, or
    // a version-slug variation silently falls back to the floor.
    setModelContextWindows(new Map([['openai:gpt-5.5', 400_000]]));
    expect(getModelContextWindow('openai', 'gpt-5-5')).toBe(400_000);
  });
});

describe('every model resolveModelForTier can return has a registry-backed window', () => {
  beforeEach(() => setModelContextWindows(fullRegistrySnapshot()));

  for (const provider of PROVIDERS) {
    for (const tier of TIERS) {
      it(`${provider} / ${tier}`, () => {
        const model = resolveModelForTier(provider, tier);
        const reading = contextWindowForModel(provider, model);
        expect(reading.source).toBe('registry');
        expect(reading.tokens).toBeGreaterThan(0);
      });
    }
  }
});

describe('the long-window model the floor gets wrong', () => {
  // The case that motivates the whole distinction: read against the Anthropic
  // floor, a 300k-token run on this model looks like an overflow.
  it('resolves claude-opus-5[1m] to 1M, not to the 200k Anthropic floor', () => {
    setModelContextWindows(fullRegistrySnapshot());
    const reading = contextWindowForModel('anthropic', 'claude-opus-5[1m]');
    expect(reading.tokens).toBe(1_000_000);
    expect(reading.source).toBe('registry');
  });

  it('falls back to the 200k floor when the model is not recorded', () => {
    setModelContextWindows(new Map());
    const reading = contextWindowForModel('anthropic', 'claude-opus-5[1m]');
    expect(reading.tokens).toBe(200_000);
    expect(reading.source).toBe('provider_floor');
  });
});

describe('a floor may never drive a destructive decision', () => {
  it('permits a recorded window', () => {
    expect(mayDriveRetirement({ tokens: 1_000_000, source: 'registry' })).toBe(true);
  });

  it('refuses a provider floor', () => {
    expect(mayDriveRetirement({ tokens: 200_000, source: 'provider_floor' })).toBe(false);
  });

  it('refuses a missing reading', () => {
    expect(mayDriveRetirement(undefined)).toBe(false);
  });

  // Without the overlay every reading is a floor, so nothing can be retired on
  // window evidence until the registry has actually loaded. That is the correct
  // failure direction: a run that is not retired continues, a run retired in
  // error loses its conversation.
  it('refuses everything before the registry has loaded', () => {
    setModelContextWindows(null);
    for (const provider of PROVIDERS) {
      expect(mayDriveRetirement(contextWindowForModel(provider, 'anything'))).toBe(false);
    }
  });
});

describe('unknown providers and models', () => {
  it('falls back to the default floor for a provider with no entry', () => {
    const reading = contextWindowForModel('some-new-vendor', 'their-model');
    expect(reading.source).toBe('provider_floor');
    expect(reading.tokens).toBe(128_000);
  });

  it('falls back when either provider or model is missing', () => {
    expect(contextWindowForModel(undefined, 'm').source).toBe('provider_floor');
    expect(contextWindowForModel('anthropic', undefined).source).toBe('provider_floor');
  });

  // A zero or negative recorded window is not a window. Treating it as one would
  // make every ratio infinite and every run look saturated.
  it('ignores a non-positive recorded window and uses the floor', () => {
    setModelContextWindows(new Map([['anthropic:claude-opus-5', 0]]));
    expect(contextWindowForModel('anthropic', 'claude-opus-5').source).toBe('provider_floor');
  });
});
