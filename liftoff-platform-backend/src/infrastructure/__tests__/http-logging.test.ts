/**
 * D-2.10 — shared redacting HTTP logger tests.
 */

import { redactHeaders, redactUrl } from '../http-logging';

describe('D-2.10 — redactHeaders', () => {
  it('redacts X-Service-Auth', () => {
    const result = redactHeaders({ 'X-Service-Auth': 'secret-token-123' });
    expect(result['X-Service-Auth']).toBe('<redacted>');
  });

  it('redacts Authorization Bearer token but preserves scheme', () => {
    const result = redactHeaders({ Authorization: 'Bearer eyJhbGciOiJSUzI1NiIs...' });
    expect(result.Authorization).toBe('Bearer <redacted>');
  });

  it('redacts Authorization non-Bearer', () => {
    const result = redactHeaders({ Authorization: 'Basic dXNlcjpwYXNz' });
    expect(result.Authorization).toBe('<redacted>');
  });

  it('redacts x-api-key (case-insensitive)', () => {
    const result = redactHeaders({ 'x-api-key': 'my-api-key' });
    expect(result['x-api-key']).toBe('<redacted>');
  });

  it('redacts cookie header', () => {
    const result = redactHeaders({ cookie: 'session=abc123' });
    expect(result.cookie).toBe('<redacted>');
  });

  it('redacts values that look like JWTs', () => {
    const result = redactHeaders({
      'X-Custom': 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3',
    });
    expect(result['X-Custom']).toBe('<redacted-jwt>');
  });

  it('passes through non-sensitive headers unchanged', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant-123',
      'x-trace-id': 'trace-abc',
    });
    expect(result['Content-Type']).toBe('application/json');
    expect(result['x-tenant-id']).toBe('tenant-123');
    expect(result['x-trace-id']).toBe('trace-abc');
  });

  it('skips undefined values', () => {
    const result = redactHeaders({ 'X-Service-Auth': undefined, 'x-tenant-id': 'ok' });
    expect(result['X-Service-Auth']).toBeUndefined();
    expect(result['x-tenant-id']).toBe('ok');
  });
});

describe('D-2.10 — redactUrl', () => {
  it('redacts ?token= in URL', () => {
    expect(redactUrl('https://example.com/api?token=secret123')).toBe(
      'https://example.com/api?token=<redacted>',
    );
  });

  it('redacts &key= in URL', () => {
    expect(redactUrl('https://example.com/api?foo=bar&key=my-api-key')).toBe(
      'https://example.com/api?foo=bar&key=<redacted>',
    );
  });

  it('redacts ?secret= and ?password=', () => {
    expect(redactUrl('https://example.com?secret=xyz')).toContain('secret=<redacted>');
    expect(redactUrl('https://example.com?password=abc')).toContain('password=<redacted>');
  });

  it('leaves clean URLs unchanged', () => {
    expect(redactUrl('https://example.com/api/v1/resource')).toBe(
      'https://example.com/api/v1/resource',
    );
  });
});
