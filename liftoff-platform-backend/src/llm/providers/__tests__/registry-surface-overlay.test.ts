// The registry decides what a model accepts. The code table is a seed.
//
// WHY THIS MOVED. What a model will take — a temperature, a forced `tool_choice`,
// structured outputs, an effort, a thinking mode — was the last model fact that
// still needed a RELEASE, and a release in two repos: the tenant runtime carries
// its own copy and nothing compared them. Every other model fact already travels
// as data on the same 60-second overlay: the rate, the context window, the tier.
//
// It is also the fact least tolerant of being stale, and asymmetrically so. A
// wrong rate misprices a call that ran. A wrong surface is a 400 on the FIRST
// call, and all three instances in this estate were vendors REMOVING something:
// forced tool use on Opus 5.5 and Sonnet 5.5, `output_config` on the older
// models, `thinking.disabled` on Sonnet 5.5. A release cannot get ahead of that.
// A registry row can.
//
// THE DIRECTION IS THE SAFETY PROPERTY. An absent key means DO NOT SEND, so a
// registry row can only ever GRANT a capability — it cannot make the surface
// wider by omission. That is why a row is merged over the seed rather than
// replacing it, and why an unrecognised key is dropped instead of carried: this
// value comes out of a database row, and a typo'd key that quietly granted
// something is exactly the 400 the table exists to prevent.

import {
  anthropicModelSurface,
  applyRegistryModelSurfaces,
  _clearRegistryModelSurfaces,
  MODEL_SURFACES,
} from '../anthropic-shared';

afterEach(() => _clearRegistryModelSurfaces());

describe('the registry overlay wins, per key', () => {
  it('grants a capability the seed withholds', () => {
    // Sonnet 5.5 takes no forced tool choice today. A vendor that restored it
    // could be followed with a row, not a release.
    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsForcedToolChoice).toBe(false);

    applyRegistryModelSurfaces({ 'claude-sonnet-5-5': { acceptsForcedToolChoice: true } });

    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsForcedToolChoice).toBe(true);
  });

  it('REVOKES one the seed grants, which is the case that actually happens', () => {
    // The direction that matters. A vendor removing forced tool use is what this
    // estate has hit three times, and until now each one needed a release in two
    // repos before the next request stopped 400ing.
    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(true);

    applyRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsForcedToolChoice: false } });

    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(false);
  });

  it('leaves the keys it does not mention on the seed', () => {
    applyRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });

    const surface = anthropicModelSurface('claude-sonnet-5');
    expect(surface.acceptsTemperature).toBe(true);
    // Still from the seed, untouched.
    expect(surface.acceptsStructuredOutputs).toBe(true);
    expect(surface.acceptsForcedToolChoice).toBe(true);
  });

  it('leaves a model the registry never mentions entirely alone', () => {
    applyRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });

    expect(anthropicModelSurface('claude-haiku-4-5'))
      .toEqual({ ...MODEL_SURFACES['claude-haiku-4-5'], acceptsStructuredOutputs: false });
  });

  it('keeps an unlisted model conservative even when the registry speaks', () => {
    // The default an unreleased model gets, which is the reason the table was
    // inverted to an allow-list in the first place.
    applyRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });

    const surface = anthropicModelSurface('claude-not-released-yet');
    expect(surface.acceptsTemperature).toBe(false);
    expect(surface.acceptsForcedToolChoice).toBe(false);
    expect(surface.acceptsStructuredOutputs).toBe(false);
    expect(surface.effort).toBeUndefined();
    expect(surface.thinking).toBeUndefined();
  });

  it('replaces the whole overlay each refresh, so a withdrawn row stops applying', () => {
    applyRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });
    expect(anthropicModelSurface('claude-sonnet-5').acceptsTemperature).toBe(true);

    applyRegistryModelSurfaces({ 'claude-opus-5': { acceptsTemperature: true } });

    expect(anthropicModelSurface('claude-sonnet-5').acceptsTemperature).toBe(false);
    expect(anthropicModelSurface('claude-opus-5').acceptsTemperature).toBe(true);
  });

  it('carries the effort and the thinking mode', () => {
    applyRegistryModelSurfaces({
      'claude-sonnet-5': { effort: 'low', thinking: 'between_tools' },
    });

    const surface = anthropicModelSurface('claude-sonnet-5');
    expect(surface.effort).toBe('low');
    expect(surface.thinking).toBe('between_tools');
  });
});

describe('a row this build does not understand cannot widen the surface', () => {
  it('drops an unrecognised key instead of spreading it onto the surface', () => {
    applyRegistryModelSurfaces({
      'claude-sonnet-5': { acceptsSomethingInvented: true } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5'))
      .toEqual(anthropicModelSurface('claude-sonnet-5'));
    expect(anthropicModelSurface('claude-sonnet-5')).not.toHaveProperty('acceptsSomethingInvented');
  });

  it('refuses an effort level the API does not take', () => {
    // A row saying `xhigh` would be sent verbatim into `output_config` and
    // rejected. The type union is not enforced at a database boundary, so it is
    // enforced here.
    applyRegistryModelSurfaces({ 'claude-sonnet-5': { effort: 'xhigh' } });

    expect(anthropicModelSurface('claude-sonnet-5').effort).toBeUndefined();
  });

  it('refuses a thinking mode that is not between_tools', () => {
    // `disabled` is a 400 on Sonnet 5.5 and the reason `between_tools` exists.
    // A row asking for it must not reach the wire.
    applyRegistryModelSurfaces({ 'claude-sonnet-5-5': { thinking: 'disabled' } });

    expect(anthropicModelSurface('claude-sonnet-5-5').thinking).toBe('between_tools');
  });

  it('ignores a non-boolean where a boolean belongs', () => {
    applyRegistryModelSurfaces({
      'claude-sonnet-5-5': { acceptsForcedToolChoice: 'yes' } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsForcedToolChoice).toBe(false);
  });

  it('ignores a row whose every key is unusable, rather than emptying the seed', () => {
    applyRegistryModelSurfaces({
      'claude-sonnet-5': { nonsense: 1 } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(true);
  });
});
