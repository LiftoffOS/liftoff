import { redactPii } from '../redact';

describe('redactPii', () => {
  it('replaces email addresses with [REDACTED_EMAIL]', () => {
    const out = redactPii('contact me at alice@example.com please');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('alice@example.com');
  });

  it('replaces phone numbers with [REDACTED_PHONE]', () => {
    const out = redactPii('call +1 415-555-0123 for info');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).not.toContain('415-555-0123');
  });

  it('replaces SSN 123-45-6789 with [REDACTED_SSN]', () => {
    const out = redactPii('SSN: 123-45-6789 confidential');
    expect(out).toContain('[REDACTED_SSN]');
    expect(out).not.toContain('123-45-6789');
  });

  it('replaces AWS access key with [REDACTED_AWS_KEY]', () => {
    const out = redactPii('key=AKIAIOSFODNN7EXAMPLE here');
    expect(out).toContain('[REDACTED_AWS_KEY]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('replaces Bearer token with [REDACTED_TOKEN] keeping Bearer prefix', () => {
    const out = redactPii('Authorization: Bearer abc.def.ghi');
    expect(out).toContain('Bearer [REDACTED_TOKEN]');
    expect(out).not.toContain('abc.def.ghi');
  });

  it('replaces JWT with [REDACTED_JWT]', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactPii(`token: ${jwt}`);
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).not.toContain(jwt);
  });

  it('redacts multiple PII types in the same string', () => {
    const input = 'alice@example.com SSN 123-45-6789 key AKIAIOSFODNN7EXAMPLE';
    const out = redactPii(input);
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_SSN]');
    expect(out).toContain('[REDACTED_AWS_KEY]');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('leaves plain text without PII unchanged', () => {
    const input = 'This is just a regular sentence about pasta.';
    expect(redactPii(input)).toBe(input);
  });

  it('redacts an unformatted 9-digit SSN', () => {
    expect(redactPii('EIN-like 555123987 here')).toContain('[REDACTED_SSN]');
  });

  it('redacts a Luhn-valid credit card with spaces', () => {
    expect(redactPii('card 4111 1111 1111 1111')).toContain('[REDACTED_CC]');
  });

  it('does not redact a 16-digit run that fails Luhn', () => {
    expect(redactPii('serial 1234567812345678')).toContain('1234567812345678');
  });

  it('redacts an ABA routing number ahead of SSN classification', () => {
    expect(redactPii('routing 026009593')).toContain('[REDACTED_ROUTING]');
  });

  it('redacts an IBAN', () => {
    expect(redactPii('iban GB82WEST12345698765432')).toContain('[REDACTED_IBAN]');
  });
});
