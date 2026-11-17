// The registry decides what a model accepts here too. The table is a seed.
//
// WHY THIS FILE MATTERS MORE THAN ITS CONTROL-PLANE TWIN. `anthropic-model-surface.ts`
// is a deliberate COPY of the control plane's `anthropic-shared.ts`. Its own header
// says a drifting copy is a visible diff — but nothing compared the two, and the
// tier map in this same directory drifted a generation exactly that way, unnoticed,
// for as long as tenants carried a stamped model id that made the map irrelevant.
//
// What a model accepts is the fact least able to survive being stale, and
// asymmetrically: a wrong rate misprices a call that ran, a wrong surface is a 400
// on the FIRST call. Every instance in this estate was a vendor REMOVING something
// — forced tool use, `output_config`, `thinking.disabled` — which a release in two
// repos cannot get ahead of and a registry row can.

import {
  anthropicModelSurface,
  setRegistryModelSurfaces,
  _clearRegistryModelSurfaces,
} from '../anthropic-model-surface';

afterEach(() => _clearRegistryModelSurfaces());

describe('the registry overlay wins, per key', () => {
  it('REVOKES a capability the seed grants — the case that actually happens', () => {
    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(true);

    setRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsForcedToolChoice: false } });

    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(false);
  });

  it('grants one the seed withholds', () => {
    setRegistryModelSurfaces({ 'claude-sonnet-5-5': { acceptsForcedToolChoice: true } });

    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsForcedToolChoice).toBe(true);
  });

  it('leaves the keys it does not mention, and the models it does not name, alone', () => {
    setRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });

    const touched = anthropicModelSurface('claude-sonnet-5');
    expect(touched.acceptsTemperature).toBe(true);
    expect(touched.acceptsStructuredOutputs).toBe(true);

    expect(anthropicModelSurface('claude-haiku-4-5').acceptsForcedToolChoice).toBe(true);
    expect(anthropicModelSurface('claude-haiku-4-5').acceptsStructuredOutputs).toBe(false);
  });

  it('keeps an unreleased model conservative even while the registry speaks', () => {
    setRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });

    const surface = anthropicModelSurface('claude-not-released-yet');
    expect(surface.acceptsTemperature).toBe(false);
    expect(surface.acceptsForcedToolChoice).toBe(false);
    expect(surface.acceptsStructuredOutputs).toBe(false);
    expect(surface.effort).toBeUndefined();
  });

  it('replaces the whole overlay each refresh', () => {
    setRegistryModelSurfaces({ 'claude-sonnet-5': { acceptsTemperature: true } });
    setRegistryModelSurfaces({ 'claude-opus-5': { acceptsTemperature: true } });

    expect(anthropicModelSurface('claude-sonnet-5').acceptsTemperature).toBe(false);
    expect(anthropicModelSurface('claude-opus-5').acceptsTemperature).toBe(true);
  });
});

describe('a row this build does not understand cannot widen the surface', () => {
  it('drops an unrecognised key', () => {
    setRegistryModelSurfaces({
      'claude-sonnet-5': { acceptsSomethingInvented: true } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5')).not.toHaveProperty('acceptsSomethingInvented');
    expect(anthropicModelSurface('claude-sonnet-5').acceptsForcedToolChoice).toBe(true);
  });

  it('refuses an effort level this plane cannot send', () => {
    setRegistryModelSurfaces({ 'claude-sonnet-5': { effort: 'xhigh' } });

    expect(anthropicModelSurface('claude-sonnet-5').effort).toBeUndefined();
  });

  it('ignores a non-boolean where a boolean belongs', () => {
    setRegistryModelSurfaces({
      'claude-sonnet-5-5': { acceptsForcedToolChoice: 'yes' } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsForcedToolChoice).toBe(false);
  });

  it('takes no `thinking` key, because this plane cannot send one', () => {
    // The control plane's copy carries `thinking: 'between_tools'` — the setting
    // that returns a model's between-tool prose as readable text. The Claude
    // Agent SDK's ThinkingConfig union has no such member at any version, so a row
    // carrying it must not install anything here rather than be plumbed toward a
    // parameter this plane has no way to send.
    setRegistryModelSurfaces({
      'claude-sonnet-5-5': { thinking: 'between_tools' } as Record<string, unknown>,
    });

    expect(anthropicModelSurface('claude-sonnet-5-5')).not.toHaveProperty('thinking');
  });
});
