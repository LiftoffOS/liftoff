import {
  REDACTION_VERSION,
  redactPii,
  redactPiiWithCounters,
  redactPiiDeep,
} from '../redaction';

describe('REDACTION_VERSION', () => {
  it('is a semver string', () => {
    expect(REDACTION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('redactPii — existing patterns (regression)', () => {
  it.each([
    ['Bearer abc.def.ghi', 'Bearer [REDACTED_TOKEN]'],
    ['AKIAIOSFODNN7EXAMPLE', '[REDACTED_AWS_KEY]'],
    ['123-45-6789', '[REDACTED_SSN]'],
    ['alice@example.com', '[REDACTED_EMAIL]'],
    ['+1 415-555-0123', '[REDACTED_PHONE]'],
  ])('redacts %p', (input, expected) => {
    expect(redactPii(input)).toContain(expected);
    expect(redactPii(input)).not.toContain(input);
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactPii(`token: ${jwt}`)).toContain('[REDACTED_JWT]');
  });
});

describe('redactPii — new patterns', () => {
  it('redacts an unformatted 9-digit SSN (not an ABA routing)', () => {
    // 555123987 → not a valid ABA (fails checksum), classified as SSN.
    expect(redactPii('EIN-like 555123987 here'))
      .toBe('EIN-like [REDACTED_SSN] here');
  });

  it('treats a checksum-valid 9-digit as a routing number', () => {
    // 026009593 = Bank of America ABA, passes the checksum.
    expect(redactPii('routing 026009593 confirmed'))
      .toBe('routing [REDACTED_ROUTING] confirmed');
  });

  it('does not match a 9-digit substring inside a longer numeric run', () => {
    const out = redactPii('order 1234567890123 confirmed');
    expect(out).not.toContain('[REDACTED_SSN]');
    expect(out).not.toContain('[REDACTED_ROUTING]');
  });

  it('redacts a Luhn-valid 16-digit card (spaced)', () => {
    // 4111 1111 1111 1111 — canonical Luhn-valid test card.
    expect(redactPii('card 4111 1111 1111 1111 expires 12/30'))
      .toContain('[REDACTED_CC]');
  });

  it('does not redact a 16-digit run that fails Luhn', () => {
    expect(redactPii('serial 1234567812345678'))
      .toContain('1234567812345678');
  });

  it('redacts an IBAN', () => {
    expect(redactPii('iban GB82WEST12345698765432 ok'))
      .toBe('iban [REDACTED_IBAN] ok');
  });
});

describe('redactPiiWithCounters', () => {
  it('reports per-pattern hit counts', () => {
    const { redacted, counters } = redactPiiWithCounters(
      'SSN 123-45-6789 and email alice@example.com'
    );
    expect(redacted).toContain('[REDACTED_SSN]');
    expect(redacted).toContain('[REDACTED_EMAIL]');
    expect(counters).toEqual({ ssn: 1, email: 1 });
  });
});

describe('redactPiiDeep', () => {
  it('returns primitives unchanged', () => {
    expect(redactPiiDeep(42)).toBe(42);
    expect(redactPiiDeep(true)).toBe(true);
    expect(redactPiiDeep(null)).toBe(null);
    expect(redactPiiDeep(undefined)).toBe(undefined);
  });

  it('walks nested objects and arrays', () => {
    const input = {
      employee: { ssn: '123-45-6789', name: 'Alice' },
      notes: 'Call 415-555-0123 for follow-up',
      attachments: [{ note: 'card 4111 1111 1111 1111' }],
      count: 7,
    };
    const out = redactPiiDeep(input);
    expect((out.employee as any).ssn).toBe('[REDACTED_SSN]');
    expect((out.employee as any).name).toBe('Alice'); // names not caught — acknowledged
    expect(out.notes).toContain('[REDACTED_PHONE]');
    expect((out.attachments as any[])[0].note).toContain('[REDACTED_CC]');
    expect(out.count).toBe(7);
  });

  it('does not mutate the input', () => {
    const input = { ssn: '123-45-6789' };
    const out = redactPiiDeep(input);
    expect(input.ssn).toBe('123-45-6789');
    expect(out.ssn).toBe('[REDACTED_SSN]');
  });
});
