// The per-model request surface here, and the responseSchema routing it gates.
//
// THIS CLOSES A LATENT BREAK. The responseSchema path forced a single tool
// UNCONDITIONALLY — `tool_choice: {type:'tool'}` — which Opus 5.5 rejects with a
// 400. The large tier now resolves there, so any caller whose tier landed on
// it would have failed outright, not degraded. Both callers in this repo are
// affected in principle: reflection pins `medium`, but chat-feedback-extraction
// takes its tier from workspace routing policy and can resolve large.
//
// The fix is the same shape as the control plane's, because the two planes call
// the same vendor with the same model ids and a capability they disagree about
// is a call that works on one and fails on the other.
//
// The table is an ALLOW-LIST and the direction of its default is the point: a
// model this file has never heard of gets the narrow modern surface — no
// temperature, no forced tool choice, no output_config. Defaulting the other
// way is what turned a vendor removal into a production 400 in the first place.

import {
  anthropicModelSurface,
  anthropicStructuredOutputFormat,
} from '../anthropic-model-surface';
import { TIER_MODELS } from '../anthropic';

describe('an unrecognised model gets the narrow modern surface', () => {
  const s = anthropicModelSurface('claude-something-not-released-yet');

  it('assumes nothing may be sent that a model could reject', () => {
    expect(s.acceptsTemperature).toBe(false);
    expect(s.acceptsForcedToolChoice).toBe(false);
    expect(s.acceptsStructuredOutputs).toBe(false);
    expect(s.effort).toBeUndefined();
  });
});

describe('the models this runtime actually resolves', () => {
  it('Opus 5.5 refuses a forced tool choice — the break this closes', () => {
    expect(anthropicModelSurface('claude-opus-5-5').acceptsForcedToolChoice).toBe(false);
  });

  it('Sonnet 5.5 refuses one too, and takes no temperature', () => {
    // The medium tier. Both are 400s on this model, and the forced choice is
    // rejected on count_tokens as well as on a completion — so the surface has
    // to say no before a request is built, not recover after one fails.
    const surface = anthropicModelSurface('claude-sonnet-5-5');
    expect(surface.acceptsForcedToolChoice).toBe(false);
    expect(surface.acceptsTemperature).toBe(false);
  });

  it('Sonnet 5.5 accepts structured outputs, which is what replaces the forced tool', () => {
    // A responseSchema caller on the medium tier has no forced-tool route left.
    // Without this opt-in it would fall back to `auto` plus an instruction — a
    // request rather than a guarantee — on every structured call.
    expect(anthropicModelSurface('claude-sonnet-5-5').acceptsStructuredOutputs).toBe(true);
  });

  it('sends Sonnet 5.5 no effort, because its vendor default did not move', () => {
    // Opus 5.5 is pinned because ITS default dropped to `medium`. Sonnet 5.5
    // defaults to `high`, the same as Sonnet 5, so there is nothing to correct
    // and the rule is to send the parameter only where a default moved.
    expect(anthropicModelSurface('claude-sonnet-5-5').effort).toBeUndefined();
  });

  it('every earlier model still accepts one, so nothing else changed', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect(anthropicModelSurface(m).acceptsForcedToolChoice).toBe(true);
    }
  });

  it('every tier-resolved model has an entry, so none silently downgrades', () => {
    for (const modelId of Object.values(TIER_MODELS)) {
      // An entry is what keeps the allow-list a no-op for a model in service.
      const surface = anthropicModelSurface(modelId);
      const isModernDefault =
        !surface.acceptsTemperature && !surface.acceptsForcedToolChoice
        && !surface.acceptsStructuredOutputs && surface.effort === undefined;
      expect(isModernDefault).toBe(false);
    }
  });
});

describe('anthropicStructuredOutputFormat', () => {
  const SIMPLE = {
    type: 'object',
    properties: { verdict: { type: 'string' }, score: { type: 'number' } },
    required: ['verdict'],
  };

  it('accepts a plain schema on a model that supports it, and closes the object', () => {
    const out = anthropicStructuredOutputFormat('claude-opus-5-5', SIMPLE);
    expect(out?.type).toBe('json_schema');
    expect(out?.schema.additionalProperties).toBe(false);
  });

  it('refuses where the decoder would reject the schema, so the tool route runs', () => {
    // A whitelist of keywords, not a blacklist: an unnecessary fallback is
    // free, a rejected request is not.
    const withMaxLength = { type: 'object', properties: { a: { type: 'string', maxLength: 10 } } };
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', withMaxLength)).toBeNull();
  });

  it('refuses on a model without structured-output support', () => {
    expect(anthropicStructuredOutputFormat('claude-haiku-4-5', SIMPLE)).toBeNull();
    expect(anthropicStructuredOutputFormat('claude-not-released-yet', SIMPLE)).toBeNull();
  });
});
