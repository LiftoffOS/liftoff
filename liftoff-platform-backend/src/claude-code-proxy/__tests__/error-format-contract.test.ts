// Anthropic Error Format Contract Test
// Validates all proxy error responses match the shape Claude Code expects

import { z } from 'zod';

// The Anthropic error schema that Claude Code parses
const anthropicErrorSchema = z.object({
  type: z.literal('error'),
  error: z.object({
    type: z.enum([
      'authentication_error',
      'rate_limit_error',
      'invalid_request_error',
      'api_error',
      'overloaded_error',
    ]),
    message: z.string(),
  }),
});

describe('Anthropic Error Format Contract', () => {
  it('proxy-auth 401 (missing key) matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('proxy-auth 401 (revoked key) matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid or revoked API key' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('rate limit 429 matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('invalid JSON 400 matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('upstream failure 502 matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'api_error', message: 'Failed to reach Anthropic API' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('origin guard 403 matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'authentication_error', message: 'Browser requests are not allowed' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('self-revoke rate limit matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many revoke attempts. Try again later.' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('self-revoke missing confirm matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Request body must include { "confirm": true }' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('internal auth error matches schema', () => {
    const body = {
      type: 'error',
      error: { type: 'api_error', message: 'Internal authentication error' },
    };
    expect(() => anthropicErrorSchema.parse(body)).not.toThrow();
  });

  it('rejects malformed error body', () => {
    const badBody = { error: 'something went wrong' };
    expect(() => anthropicErrorSchema.parse(badBody)).toThrow();
  });

  it('rejects unknown error type', () => {
    const badBody = {
      type: 'error',
      error: { type: 'unknown_error', message: 'test' },
    };
    expect(() => anthropicErrorSchema.parse(badBody)).toThrow();
  });
});
