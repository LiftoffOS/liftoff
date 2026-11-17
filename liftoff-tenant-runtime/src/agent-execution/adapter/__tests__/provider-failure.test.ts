// Reading a provider failure off the thrown error rather than out of its prose.
//
// Every fixture below is a shape one of our engines actually throws, taken from
// the installed SDKs. The point of the module is that these facts arrive
// structured and we were discarding them; a test built on invented shapes would
// prove nothing about that.

import { extractProviderFailure, classifyProviderFailure } from '../provider-failure';

describe('classifyProviderFailure — the provider names its own failure', () => {
  it.each([
    ['overloaded_error', 'overloaded'],
    ['rate_limit_error', 'rate_limit'],
    ['authentication_error', 'auth'],
    ['permission_error', 'auth'],
    ['invalid_api_key', 'auth'],
    ['insufficient_quota', 'quota'],
    ['billing_hard_limit_reached', 'quota'],
    ['SAFETY', 'safety'],
    ['PROHIBITED_CONTENT', 'safety'],
    ['content_filter', 'safety'],
    ['refusal', 'refusal'],
    ['invalid_request_error', 'invalid_request'],
    ['not_found_error', 'invalid_request'],
    ['api_error', 'server_error'],
    ['ECONNRESET', 'network'],
  ])('%s → %s', (type, expected) => {
    expect(classifyProviderFailure(type)).toBe(expected);
  });

  // invalid_request_error contains 'error', and a naive substring order would
  // read it as a server fault. It is a client mistake, and the difference
  // decides whether the run is retried.
  it('does not mistake invalid_request_error for a server error', () => {
    expect(classifyProviderFailure('invalid_request_error')).toBe('invalid_request');
  });
});

describe('classifyProviderFailure — status as the fallback', () => {
  it.each([
    [401, 'auth'], [403, 'auth'], [402, 'quota'], [429, 'rate_limit'],
    [529, 'overloaded'], [400, 'invalid_request'], [404, 'invalid_request'],
    [413, 'invalid_request'], [422, 'invalid_request'],
    [500, 'server_error'], [502, 'server_error'], [503, 'server_error'],
  ])('%i → %s', (status, expected) => {
    expect(classifyProviderFailure(undefined, status)).toBe(expected);
  });

  // The provider naming its own failure beats the status it arrived under:
  // Anthropic sends overloaded_error as a 529, Google sends SAFETY with a 200.
  it('prefers the provider type over the status', () => {
    expect(classifyProviderFailure('overloaded_error', 500)).toBe('overloaded');
    expect(classifyProviderFailure('SAFETY', 200)).toBe('safety');
  });

  it('is unknown when there is nothing to read', () => {
    expect(classifyProviderFailure()).toBe('unknown');
    expect(classifyProviderFailure('', undefined)).toBe('unknown');
  });
});

describe('extractProviderFailure — the shapes our engines throw', () => {
  it('reads an Anthropic APIError (one level of nesting)', () => {
    const err = Object.assign(new Error('Overloaded'), {
      status: 529,
      error: { type: 'overloaded_error', message: 'Overloaded' },
      headers: new Map([['request-id', 'req_anthropic_1']]),
      requestID: 'req_anthropic_1',
    });
    expect(extractProviderFailure(err)).toEqual({
      kind: 'overloaded',
      providerErrorType: 'overloaded_error',
      status: 529,
      requestId: 'req_anthropic_1',
      detail: 'Overloaded',
    });
  });

  // OpenAI nests one level deeper than Anthropic through the Agents SDK wrapper.
  it('reads an OpenAI error nested two levels deep', () => {
    const err = Object.assign(new Error('quota'), {
      status: 429,
      error: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } },
      request_id: 'req_openai_1',
    });
    const out = extractProviderFailure(err);
    expect(out.kind).toBe('quota');
    expect(out.providerErrorType).toBe('insufficient_quota');
    expect(out.requestId).toBe('req_openai_1');
  });

  it('reads a Bedrock/AWS $metadata request id', () => {
    const err = Object.assign(new Error('ThrottlingException'), {
      name: 'ThrottlingException',
      $metadata: { requestId: 'aws-req-9', httpStatusCode: 429 },
      statusCode: 429,
    });
    const out = extractProviderFailure(err);
    expect(out.requestId).toBe('aws-req-9');
    expect(out.status).toBe(429);
  });

  it('reads a request id from fetch Headers, under either spelling', () => {
    const withDash = { headers: new Headers({ 'request-id': 'h1' }) };
    const withX = { headers: new Headers({ 'x-request-id': 'h2' }) };
    expect(extractProviderFailure(withDash).requestId).toBe('h1');
    expect(extractProviderFailure(withX).requestId).toBe('h2');
  });

  it('reads a plain-object header bag too', () => {
    expect(extractProviderFailure({ headers: { 'x-request-id': 'plain' } }).requestId).toBe('plain');
  });

  it('reads an errno-style transport failure', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const out = extractProviderFailure(err);
    expect(out.kind).toBe('network');
    expect(out.providerErrorType).toBe('ECONNRESET');
  });

  // `name` names the CLASS, not the failure. Treating the generic 'Error' as a
  // provider error type would give every plain throw a classification.
  it('ignores the generic Error name', () => {
    expect(extractProviderFailure(new Error('something went wrong'))).toEqual({ kind: 'unknown' });
  });

  it('uses a specific error name when there is one', () => {
    const err = Object.assign(new Error('x'), { name: 'AuthenticationError' });
    expect(extractProviderFailure(err).kind).toBe('auth');
  });

  it('returns a bare unknown for anything with no structure', () => {
    expect(extractProviderFailure(undefined)).toEqual({ kind: 'unknown' });
    expect(extractProviderFailure('a string')).toEqual({ kind: 'unknown' });
    expect(extractProviderFailure(null)).toEqual({ kind: 'unknown' });
  });

  it('reads a numeric-string status', () => {
    expect(extractProviderFailure({ status: '503' }).status).toBe(503);
  });

  it('survives a Headers-shaped object whose get() throws', () => {
    const hostile = { headers: { get: () => { throw new Error('nope'); } } };
    expect(() => extractProviderFailure(hostile)).not.toThrow();
    expect(extractProviderFailure(hostile).requestId).toBeUndefined();
  });
});

describe('extractProviderFailure — what the provider SAID', () => {
  // A gateway wraps its upstream's refusal. OpenRouter's message is "Provider
  // returned error" for every upstream 400, and the upstream's actual
  // complaint sits under `metadata.raw`. Kind, type, status and request id were
  // all captured; the one field that says WHY was not, so a run on GLM could
  // die with a 400 nobody could read.
  it('keeps the upstream body an OpenRouter wrapper carries', () => {
    const e = Object.assign(new Error('400 Provider returned error'), {
      status: 400,
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: { provider_name: 'Z.AI', raw: '{"error":{"code":"1214","message":"tools[0].function.parameters invalid"}}' },
      },
    });
    const f = extractProviderFailure(e);
    expect(f.status).toBe(400);
    expect(f.detail).toContain('Provider returned error');
    expect(f.detail).toContain('Z.AI');
    expect(f.detail).toContain('tools[0].function.parameters invalid');
  });

  it('keeps a direct OpenAI message', () => {
    const e = Object.assign(new Error('400 Bad Request'), {
      status: 400,
      error: { message: "Invalid schema for function 'x': additionalProperties must be false", type: 'invalid_request_error' },
    });
    expect(extractProviderFailure(e).detail).toContain('additionalProperties must be false');
  });

  it('bounds it, because a provider can echo the request', () => {
    const e = Object.assign(new Error('400'), {
      status: 400,
      error: { message: 'x'.repeat(5000) },
    });
    const d = extractProviderFailure(e).detail ?? '';
    expect(d.length).toBeLessThanOrEqual(601);
    expect(d.endsWith('…')).toBe(true);
  });

  it('is absent when the provider said nothing', () => {
    const e = Object.assign(new Error('boom'), { status: 500 });
    expect(extractProviderFailure(e).detail).toBeUndefined();
  });
});
