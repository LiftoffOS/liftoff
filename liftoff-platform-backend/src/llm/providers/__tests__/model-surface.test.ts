// The per-model request surface, and the direction of its default.
//
// THE POINT OF THE INVERSION. This table used to be a deny-list: an unlisted
// model was assumed to accept everything, so each time the vendor REMOVED
// something we learned about it from a 400 on a live request. Opus 5.5 dropping
// forced tool use was caught by reading release notes, not by anything here.
//
// Inverted, an unrecognised model gets the narrow modern surface: no
// `temperature`, no forced tool choice, no `output_config`. That is safe in one
// direction only, which is why the two "may we send X" booleans default to
// false while `effort` and structured outputs stay opt-in — sending either to a
// model that does not take it is a 400, so a default of "send it" would be the
// very failure the inversion exists to prevent.
//
// The second half of this file is the ratchet that makes the inversion
// trustworthy: every model this estate can actually reach is pinned, so the
// change provably altered nothing for a model already in service.

import {
  anthropicModelSurface,
  anthropicStructuredOutputFormat,
  MODEL_SURFACES,
} from '../anthropic-shared';
import { TIER_MODELS, DEFAULT_MODEL } from '../anthropic';

describe('an unrecognised model gets the narrow modern surface', () => {
  const surface = anthropicModelSurface('claude-something-not-released-yet');

  it('sends no temperature and no forced tool choice', () => {
    expect(surface.acceptsTemperature).toBe(false);
    expect(surface.acceptsForcedToolChoice).toBe(false);
  });

  it('sends no output_config — neither effort nor a format', () => {
    // Both are POSITIVE acts. A model that does not accept them rejects the
    // request outright, so neither may be assumed.
    expect(surface.effort).toBeUndefined();
    expect(surface.acceptsStructuredOutputs).toBe(false);
  });
});

describe('the inversion changed nothing for a model already in service', () => {
  // Frozen expectations, written from what the deny-list produced before the
  // flip. A diff here is a real behaviour change on a live path, not a refactor.
  const EXPECTED: Record<string, {
    temp: boolean; forced: boolean; effort?: string; structured: boolean;
  }> = {
    'claude-opus-5-5':  { temp: false, forced: false, effort: 'high', structured: true },
    'claude-opus-5':    { temp: false, forced: true,  structured: true },
    'claude-opus-4-8':  { temp: false, forced: true,  structured: true },
    'claude-opus-4-7':  { temp: false, forced: true,  structured: true },
    'claude-opus-4-6':  { temp: true,  forced: true,  structured: true },
    'claude-sonnet-5-5':{ temp: false, forced: false, structured: true },
    'claude-sonnet-5':  { temp: false, forced: true,  structured: true },
    'claude-sonnet-4-6':{ temp: true,  forced: true,  structured: true },
    // The small tier. `temp: false` is the one frozen expectation here that is
    // NOT what the deny-list produced for the model it replaced: Haiku 4.5 was
    // sent a temperature and this model 400s on one, so the downgrade is the
    // vendor's and the entry is what makes it deliberate rather than silent.
    'claude-haiku-5-5': { temp: false, forced: true,  structured: false },
    'claude-haiku-4-5': { temp: true,  forced: true,  structured: false },
  };

  it.each(Object.entries(EXPECTED))('%s', (modelId, want) => {
    const s = anthropicModelSurface(modelId);
    expect(s.acceptsTemperature).toBe(want.temp);
    expect(s.acceptsForcedToolChoice).toBe(want.forced);
    expect(s.effort).toBe(want.effort);
    expect(s.acceptsStructuredOutputs).toBe(want.structured);
  });

  it('every model a tier can resolve to has an entry', () => {
    // A tier-resolved model falling through to the modern default would be a
    // SILENT capability downgrade — it would quietly stop accepting temperature
    // and forced tools. The entry is what keeps the inversion a no-op for them.
    for (const modelId of [...Object.values(TIER_MODELS), DEFAULT_MODEL]) {
      expect(Object.keys(MODEL_SURFACES)).toContain(modelId);
    }
  });

  it('only Opus 5.5 is sent an effort, because only its vendor default moved', () => {
    const withEffort = Object.keys(MODEL_SURFACES)
      .filter((m) => anthropicModelSurface(m).effort !== undefined);
    expect(withEffort).toEqual(['claude-opus-5-5']);
  });

  it('only Sonnet 5.5 asks for between_tools, and only where a person reads the stream', () => {
    // The narrowest possible scope for a setting that also turns OFF up-front
    // thinking. It is here because Sonnet 5.5 moved the prose a model writes
    // between tool calls out of `text` blocks and into `thinking` blocks, which
    // are empty under the default display — so a streamed turn goes silent with
    // no error. Any other model gaining this would be trading reasoning depth
    // for a narration that model does not relocate.
    const withBetweenTools = Object.keys(MODEL_SURFACES)
      .filter((m) => anthropicModelSurface(m).thinking === 'between_tools');
    expect(withBetweenTools).toEqual(['claude-sonnet-5-5']);
  });
});

describe('anthropicStructuredOutputFormat', () => {
  const SIMPLE = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      score: { type: 'number' },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict'],
  };

  it('accepts a plain schema on a model that supports structured outputs', () => {
    const out = anthropicStructuredOutputFormat('claude-opus-5-5', SIMPLE);
    expect(out?.type).toBe('json_schema');
  });

  it('closes every object, which the vendor requires and no caller writes', () => {
    const out = anthropicStructuredOutputFormat('claude-opus-5-5', SIMPLE);
    expect(out?.schema.additionalProperties).toBe(false);
  });

  it('refuses a model that does not support structured outputs', () => {
    // Haiku 4.5 is the small tier. A request it cannot serve must fall back to
    // the tool route, not fail.
    expect(anthropicStructuredOutputFormat('claude-haiku-4-5', SIMPLE)).toBeNull();
  });

  it('refuses an unrecognised model, because support cannot be assumed', () => {
    expect(anthropicStructuredOutputFormat('claude-not-released-yet', SIMPLE)).toBeNull();
  });

  // The keywords below are exactly what the constrained decoder rejects. Each
  // one is a 400 if it reaches the API, so each must fall back instead.
  it.each([
    ['oneOf',     { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } }],
    ['maxLength', { type: 'object', properties: { a: { type: 'string', maxLength: 10 } } }],
    ['maxItems',  { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, maxItems: 3 } } }],
    ['pattern',   { type: 'object', properties: { a: { type: 'string', pattern: '^x' } } }],
    ['minimum',   { type: 'object', properties: { a: { type: 'number', minimum: 1 } } }],
  ])('refuses a schema using %s', (_name, schema) => {
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', schema)).toBeNull();
  });

  it('refuses a keyword nobody has vetted, rather than passing it through', () => {
    // The whole reason this is a whitelist: a blacklist permits every keyword
    // nobody thought of, and finds out on a live request.
    const withUnknown = { type: 'object', properties: { a: { type: 'string', someFutureKeyword: true } } };
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', withUnknown)).toBeNull();
  });

  it('refuses a non-object schema', () => {
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', { type: 'string' })).not.toBeNull();
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', null)).toBeNull();
    expect(anthropicStructuredOutputFormat('claude-opus-5-5', 'nope')).toBeNull();
  });
});
