// Log scrubber tests — signing secret + signature header must be redacted
// from anything that passes through scrubForLog.

import { scrubForLog } from '../log-scrubber';

describe('scrubForLog', () => {
  it('redacts top-level secret-shaped keys', () => {
    const out = scrubForLog({
      tenantId: 't1',
      signing_secret: 'abc',
      authorization: 'Bearer x',
      cookie: 'session=x',
    });
    expect(out).toEqual({
      tenantId: 't1',
      signing_secret: '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
    });
  });

  it('redacts keys containing "secret" / "signature" / "token"', () => {
    const out = scrubForLog({
      mySecret: 'x',
      partial_signature: 'x',
      bearerToken: 'x',
      apiToken: 'x',
      ok: 'visible',
    });
    expect(out).toEqual({
      mySecret: '[redacted]',
      partial_signature: '[redacted]',
      bearerToken: '[redacted]',
      apiToken: '[redacted]',
      ok: 'visible',
    });
  });

  it('redacts signature-header-shaped string values', () => {
    const out = scrubForLog({
      header: 't=1234567890,v1=deadbeefcafebabe',
    });
    expect(out).toEqual({ header: '[redacted-signature]' });
  });

  it('walks nested objects', () => {
    const out = scrubForLog({
      level1: { level2: { signing_secret: 'x', name: 'ok' } },
    });
    const lvl2 = (out.level1 as Record<string, unknown>).level2 as Record<string, unknown>;
    expect(lvl2.signing_secret).toBe('[redacted]');
    expect(lvl2.name).toBe('ok');
  });

  it('walks arrays', () => {
    const out = scrubForLog({
      items: [{ secret: 'x' }, { name: 'ok' }],
    });
    expect(out.items).toEqual([{ secret: '[redacted]' }, { name: 'ok' }]);
  });

  it('does not mutate input', () => {
    const input = { secret: 'x', ok: 'y' };
    scrubForLog(input);
    expect(input).toEqual({ secret: 'x', ok: 'y' });
  });

  it('handles primitives and null', () => {
    expect(scrubForLog('hello')).toBe('hello');
    expect(scrubForLog(42)).toBe(42);
    expect(scrubForLog(null)).toBe(null);
    expect(scrubForLog(undefined)).toBe(undefined);
  });
});
