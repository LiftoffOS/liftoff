// Allowed Domains Tests
// Per implementation plan 1f: unit tests for isEmailDomainAllowed

import { isEmailDomainAllowed, isSignupOpen, _setCachedDomains, _stopRefreshTimer } from './allowedDomains';

describe('isEmailDomainAllowed', () => {
  beforeEach(() => {
    _setCachedDomains(['example.com', 'acme.com']);
  });

  afterAll(() => {
    _stopRefreshTimer();
  });

  it('should return true for whitelisted domain', () => {
    expect(isEmailDomainAllowed('user@example.com')).toBe(true);
  });

  it('should return true for second whitelisted domain', () => {
    expect(isEmailDomainAllowed('user@acme.com')).toBe(true);
  });

  it('should return false for non-whitelisted domain', () => {
    expect(isEmailDomainAllowed('person@example.org')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isEmailDomainAllowed('user@EXAMPLE.COM')).toBe(true);
    expect(isEmailDomainAllowed('user@Example.com')).toBe(true);
  });

  it('should return false for malformed email (no @)', () => {
    expect(isEmailDomainAllowed('userexample.com')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isEmailDomainAllowed('')).toBe(false);
  });

  it('should return false for email without domain part', () => {
    expect(isEmailDomainAllowed('user@')).toBe(false);
  });

  it('should handle email with multiple @ signs', () => {
    // split('@')[1] returns everything after the first @
    expect(isEmailDomainAllowed('user@name@example.com')).toBe(false);
  });

  describe('fallback behavior', () => {
    it('should use fallback domains when cache is set to fallback', () => {
      _setCachedDomains(['example.com']);
      expect(isEmailDomainAllowed('user@example.com')).toBe(true);
      expect(isEmailDomainAllowed('user@acme.com')).toBe(false);
    });
  });

  describe('open signup (the * entry)', () => {
    it('grants every domain while the entry is present, and a malformed email still fails', () => {
      _setCachedDomains(['*', 'example.com']);
      expect(isSignupOpen()).toBe(true);
      expect(isEmailDomainAllowed('anyone@example.org')).toBe(true);
      expect(isEmailDomainAllowed('person@example.com')).toBe(true);
      expect(isEmailDomainAllowed('not-an-email')).toBe(false);
    });

    it('is off again the moment the entry is removed, with the named domains intact', () => {
      _setCachedDomains(['example.com']);
      expect(isSignupOpen()).toBe(false);
      expect(isEmailDomainAllowed('anyone@example.org')).toBe(false);
      expect(isEmailDomainAllowed('me@example.com')).toBe(true);
    });
  });
});
