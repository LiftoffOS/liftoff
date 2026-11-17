// §7.3: the live adapter recovery path parses the TOOL_ERROR envelope the MCP
// server stamps on classified connector failures. This exercises the parser it
// relies on.

import { parseToolErrorEnvelope, formatToolErrorEnvelope, envelopeRawToolError } from '../tool-error-envelope';

describe('parseToolErrorEnvelope', () => {
  it('parses a well-formed TOOL_ERROR envelope', () => {
    const text = `TOOL_ERROR ${JSON.stringify({
      error: 'boom', code: 'auth_expired', retryable: false, recovery: 'reconnect it',
    })}`;
    const p = parseToolErrorEnvelope(text);
    expect(p).not.toBeNull();
    expect(p!.code).toBe('auth_expired');
    expect(p!.retryable).toBe(false);
    expect(p!.recovery).toBe('reconnect it');
    expect(p!.error).toBe('boom');
  });

  it('honors retry_after_ms on retryable errors', () => {
    const text = `TOOL_ERROR ${JSON.stringify({
      error: 'slow', code: 'rate_limited', retryable: true, retry_after_ms: 1500, recovery: 'wait',
    })}`;
    expect(parseToolErrorEnvelope(text)!.retryAfterMs).toBe(1500);
  });

  it('derives retryable + recovery from the code when the fields are absent', () => {
    const p = parseToolErrorEnvelope(`TOOL_ERROR ${JSON.stringify({ code: 'rate_limited' })}`)!;
    expect(p.retryable).toBe(true); // rate_limited is retryable per the taxonomy
    expect(p.recovery.length).toBeGreaterThan(0);
  });

  it('returns null for legacy / unstructured errors', () => {
    expect(parseToolErrorEnvelope('Error: something went wrong')).toBeNull();
    expect(parseToolErrorEnvelope('')).toBeNull();
    expect(parseToolErrorEnvelope(undefined)).toBeNull();
    expect(parseToolErrorEnvelope(null)).toBeNull();
  });

  it('returns null when the code is not a known ToolErrorCode', () => {
    expect(parseToolErrorEnvelope(`TOOL_ERROR ${JSON.stringify({ code: 'bogus', retryable: false })}`)).toBeNull();
  });

  it('returns null when the JSON body is malformed', () => {
    expect(parseToolErrorEnvelope('TOOL_ERROR {not valid json')).toBeNull();
  });

  it('tolerates the envelope embedded in a larger string', () => {
    const text = `Prefixed: TOOL_ERROR ${JSON.stringify({
      code: 'not_found', retryable: false, recovery: 'check id', error: 'nope',
    })}`;
    expect(parseToolErrorEnvelope(text)!.code).toBe('not_found');
  });
});

describe('formatToolErrorEnvelope + envelopeRawToolError (adapter-layer producers)', () => {
  it('format → parse round-trips the contract', () => {
    const p = parseToolErrorEnvelope(
      formatToolErrorEnvelope({ message: 'boom', code: 'not_found', recovery: 'check the id' }),
    )!;
    expect(p.code).toBe('not_found');
    expect(p.retryable).toBe(false);
    expect(p.recovery).toBe('check the id');
    expect(p.error).toBe('boom');
  });

  it('format derives retryable + recovery from the code when omitted', () => {
    const p = parseToolErrorEnvelope(formatToolErrorEnvelope({ message: 'slow', code: 'rate_limited' }))!;
    expect(p.retryable).toBe(true);
    expect(p.recovery.length).toBeGreaterThan(0);
  });

  it('envelopeRawToolError classifies a raw vendor error (404 → not_found)', () => {
    const p = parseToolErrorEnvelope(envelopeRawToolError('failed to get commit: 404 No commit found')!)!;
    expect(p.code).toBe('not_found');
    expect(p.retryable).toBe(false);
  });

  it('envelopeRawToolError maps a 429 to retryable rate_limited', () => {
    const p = parseToolErrorEnvelope(envelopeRawToolError('HTTP 429 Too Many Requests')!)!;
    expect(p.code).toBe('rate_limited');
    expect(p.retryable).toBe(true);
  });

  it('envelopeRawToolError is idempotent — returns null for already-enveloped / empty text', () => {
    expect(envelopeRawToolError(formatToolErrorEnvelope({ message: 'x', code: 'not_found' }))).toBeNull();
    expect(envelopeRawToolError('')).toBeNull();
  });
});
