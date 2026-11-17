// Unit tests for the temperature-support helper that lets the Anthropic
// providers (direct-API + Vertex) survive Claude 5+ models which reject the
// `temperature` parameter with a 400. The error-detection predicate is the part
// most likely to silently break (SDK error shape drift), so it gets the bulk of
// the coverage; the discovered-model cache round-trip is also asserted.

import {
  isTemperatureUnsupportedError,
  modelRejectsTemperature,
  markTemperatureUnsupported,
  __resetTemperatureSupportForTests,
} from '../providers/temperature-support';

describe('isTemperatureUnsupportedError', () => {
  it('matches the real 400 when the reason is only in the message string', () => {
    // The Anthropic SDK APIError stringifies the body into `message`.
    const err = {
      status: 400,
      message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
    };
    expect(isTemperatureUnsupportedError(err)).toBe(true);
  });

  it('matches the 400 when the reason is in the parsed nested error body', () => {
    const err = {
      status: 400,
      message: 'Bad Request',
      error: { error: { message: '`temperature` is deprecated for this model.' } },
    };
    expect(isTemperatureUnsupportedError(err)).toBe(true);
  });

  it('does NOT match a 400 that is unrelated to temperature', () => {
    const err = {
      status: 400,
      message: '400 {"error":{"message":"max_tokens: must be >= 1"}}',
    };
    expect(isTemperatureUnsupportedError(err)).toBe(false);
  });

  it('does NOT match non-400 statuses even if they mention temperature', () => {
    expect(isTemperatureUnsupportedError({ status: 429, message: 'temperature overload' })).toBe(false);
    expect(isTemperatureUnsupportedError({ status: 500, message: 'temperature' })).toBe(false);
  });

  it('is safe on null/undefined/empty errors', () => {
    expect(isTemperatureUnsupportedError(null)).toBe(false);
    expect(isTemperatureUnsupportedError(undefined)).toBe(false);
    expect(isTemperatureUnsupportedError({})).toBe(false);
  });
});

describe('temperature-unsupported model cache', () => {
  beforeEach(() => __resetTemperatureSupportForTests());

  it('remembers a model once marked, and does not affect others', () => {
    expect(modelRejectsTemperature('claude-opus-5')).toBe(false);
    markTemperatureUnsupported('claude-opus-5');
    expect(modelRejectsTemperature('claude-opus-5')).toBe(true);
    // A different model is unaffected.
    expect(modelRejectsTemperature('claude-sonnet-4-6')).toBe(false);
  });

  it('reset clears the cache', () => {
    markTemperatureUnsupported('claude-opus-5');
    __resetTemperatureSupportForTests();
    expect(modelRejectsTemperature('claude-opus-5')).toBe(false);
  });
});
