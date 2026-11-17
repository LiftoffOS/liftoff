// Bearer proxy-auth parsing + conflicting-credential tests, and
// billing-policy cutoff classification.

import { extractProxyKey, ConflictingCredentialsError } from '../proxy/auth.js';

describe('extractProxyKey', () => {
  it('accepts x-api-key (Claude Code convention)', () => {
    const result = extractProxyKey({ 'x-api-key': 'liftoff_sk_abc' });
    expect(result).toEqual({ key: 'liftoff_sk_abc', source: 'x-api-key' });
  });

  it('accepts Authorization: Bearer (Codex convention)', () => {
    const result = extractProxyKey({ authorization: 'Bearer liftoff_sk_abc' });
    expect(result).toEqual({ key: 'liftoff_sk_abc', source: 'bearer' });
  });

  it('is case-insensitive on the Bearer scheme', () => {
    const result = extractProxyKey({ authorization: 'bearer liftoff_sk_abc' });
    expect(result?.key).toBe('liftoff_sk_abc');
  });

  it('rejects CONFLICTING credentials in both headers', () => {
    expect(() =>
      extractProxyKey({
        'x-api-key': 'liftoff_sk_one',
        authorization: 'Bearer liftoff_sk_two',
      }),
    ).toThrow(ConflictingCredentialsError);
  });

  it('accepts matching credentials in both headers', () => {
    const result = extractProxyKey({
      'x-api-key': 'liftoff_sk_same',
      authorization: 'Bearer liftoff_sk_same',
    });
    expect(result?.key).toBe('liftoff_sk_same');
  });

  it('returns null when no proxy credential is presented', () => {
    expect(extractProxyKey({})).toBeNull();
    expect(extractProxyKey({ 'x-api-key': 'sk-ant-realkey' })).toBeNull();
    expect(extractProxyKey({ authorization: 'Bearer some-firebase-jwt' })).toBeNull();
  });

  it('ignores a non-proxy Authorization header when x-api-key has the proxy key', () => {
    const result = extractProxyKey({
      'x-api-key': 'liftoff_sk_abc',
      authorization: 'Bearer firebase-jwt',
    });
    expect(result?.key).toBe('liftoff_sk_abc');
  });
});
